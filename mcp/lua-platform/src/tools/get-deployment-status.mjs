import { apiRequest } from '../api-client.mjs';
import { extractList, extractVersions } from '../response-shapes.mjs';

// Composes deployment status from existing per-type lua-api endpoints.
// We deliberately do NOT depend on a `/agents/:id/production` route — that
// endpoint doesn't exist in lua-api today and the read pattern is rare
// enough that adding it would add surface area for marginal value (per the
// v1.25 architectural decision). If aggregate latency becomes a real
// bottleneck, revisit at v1.1 with measured evidence.
//
// Per-type response shape extraction lives in response-shapes.mjs because
// lua-api's DTOs are inconsistent across primitive types.

const PRIMITIVE_TYPES = [
  { type: 'skill',         path: 'skills' },
  { type: 'webhook',       path: 'webhooks' },
  { type: 'job',           path: 'jobs' },
  { type: 'preprocessor',  path: 'preprocessors' },
  { type: 'postprocessor', path: 'postprocessors' },
];

export const getDeploymentStatus = {
  spec: {
    name: 'get_deployment_status',
    description: 'Get the current production deployment status for an agent — what version of each primitive (skill/webhook/job/preprocessor/postprocessor) is live right now. Composed from per-type version endpoints.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
      },
      required: ['agentId'],
    },
  },
  async handler({ agentId }, deps = {}) {
    if (!agentId) throw new Error('agentId is required');
    const id = encodeURIComponent(agentId);

    const result = { agentId, primitives: {} };

    for (const { type, path } of PRIMITIVE_TYPES) {
      result.primitives[type] = [];
      let listResponse;
      try {
        listResponse = await apiRequest(`/developer/${path}/${id}`, { fetchFn: deps.fetchFn });
      } catch (err) {
        result.primitives[type] = { error: err.message };
        continue;
      }

      const items = extractList(type, listResponse);
      for (const p of items) {
        // Iteration-13 audit: the URL slot is :skillId / :webhookId / :jobId
        // etc. (verified against lua-api skills/base.controller.ts:335). The
        // earlier code preferred `p.name` and produced 404s for every item.
        // Use the primitive's id; fall back to name only as a last resort for
        // forward-compat with hypothetical future dual-lookup endpoints.
        const primId = p.id ?? p._id ?? p.name;
        const name = p.name ?? primId;
        if (!primId) continue;
        let versionsResponse;
        try {
          versionsResponse = await apiRequest(
            `/developer/${path}/${id}/${encodeURIComponent(primId)}/versions`,
            { fetchFn: deps.fetchFn }
          );
        } catch (err) {
          result.primitives[type].push({ name, error: err.message });
          continue;
        }

        const versions = extractVersions(type, versionsResponse);
        const deployed = versions
          .filter((v) => v.deployedAt)
          .sort((a, b) => new Date(b.deployedAt) - new Date(a.deployedAt))[0];

        result.primitives[type].push({
          name,
          deployedVersion: deployed?.version ?? null,
          deployedAt: deployed?.deployedAt ?? null,
        });
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
};

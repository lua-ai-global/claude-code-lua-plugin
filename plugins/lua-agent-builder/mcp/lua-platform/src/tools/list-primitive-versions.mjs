import { apiRequest } from '../api-client.mjs';
import { extractList, extractVersions, SUPPORTED_VERSION_TYPES } from '../response-shapes.mjs';

const VALID_TYPES = new Set(SUPPORTED_VERSION_TYPES);

export const listPrimitiveVersions = {
  spec: {
    name: 'list_primitive_versions',
    description: 'List versions of a primitive (skill/webhook/job/preprocessor/postprocessor/persona) for an agent. Returns [{version, deployed, createdAt, sourceHash}].',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        type: { type: 'string', enum: [...VALID_TYPES] },
        name: { type: 'string', description: 'Primitive name (omit for persona — agent has only one)' },
      },
      required: ['agentId', 'type'],
    },
  },
  async handler({ agentId, type, name }, deps = {}) {
    if (!agentId || !type) throw new Error('agentId and type are required');
    if (!VALID_TYPES.has(type)) throw new Error(`Invalid type: ${type}. Valid: ${[...VALID_TYPES].join(', ')}`);
    if (type !== 'persona' && !name) throw new Error('name is required for all types except persona');

    // Per the v10 lua-api audit: versions live under /developer/<type>s/:agentId/:id/versions,
    // EXCEPT persona which lives under /developer/agents/:agentId/persona/versions (no :id).
    //
    // Iteration-13 audit: the path slot is :skillId / :webhookId / :jobId etc.
    // (verified against lua-api skills/base.controller.ts:335 and lua-agents
    // skills.service.ts:218 — `findOne({ id: skillId, agentId })`). Sending
    // `name` here returned 404 every time. Resolve name → id by listing first.
    let path;
    if (type === 'persona') {
      path = `/developer/agents/${encodeURIComponent(agentId)}/persona/versions`;
    } else {
      const id = await resolveNameToId({ agentId, type, name, fetchFn: deps.fetchFn });
      path = `/developer/${type}s/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}/versions`;
    }

    const data = await apiRequest(path, { fetchFn: deps.fetchFn });
    const versions = extractVersions(type, data);
    const compact = versions.map((v) => ({
      version: v.version,
      deployed: !!v.deployedAt,
      createdAt: v.createdAt,
      sourceHash: v.sourceHash ?? null,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] };
  },
};

async function resolveNameToId({ agentId, type, name, fetchFn }) {
  const listPath = `/developer/${type}s/${encodeURIComponent(agentId)}`;
  const listResponse = await apiRequest(listPath, { fetchFn });
  const items = extractList(type, listResponse);
  const match = items.find((p) => p.name === name);
  if (!match) {
    const available = items.map((p) => p.name).filter(Boolean).join(', ') || '(none)';
    throw new Error(`list_primitive_versions: no ${type} named "${name}" on agent ${agentId}. Available: ${available}`);
  }
  const id = match.id ?? match._id;
  if (!id) throw new Error(`list_primitive_versions: ${type} "${name}" exists but has no id field`);
  return id;
}

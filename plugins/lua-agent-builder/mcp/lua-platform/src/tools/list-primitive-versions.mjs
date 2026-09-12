import { apiRequest } from '../api-client.mjs';
import {
  extractList,
  extractVersions,
  extractActiveVersionId,
  isActiveVersion,
  versionCreatedAt,
  versionId,
  LIST_PATHS,
  SUPPORTED_VERSION_TYPES,
} from '../response-shapes.mjs';

const VALID_TYPES = new Set(SUPPORTED_VERSION_TYPES);

export const listPrimitiveVersions = {
  spec: {
    name: 'list_primitive_versions',
    // Which families carry a per-entry id — verified in lua-api's service
    // mappers (packages/lua-api/src/services/):
    //   developer.trigger.service.ts getTriggerVersions            → { version, versionId: v.id, createdAt, isActive }
    //   developer.preprocessor.service.ts getPreProcessorVersions  → { versionId: v.id, version, isActive, createdAt }
    //   developer.postprocessor.service.ts getPostProcessorVersions→ same as preprocessor
    //   developer.workflow.service.ts toVersionDto                 → { id, version, active, ... }
    //   dto/job.dto.ts JobVersionDto                               → { id, version, active, ... }
    //   developer.webhook.service.ts getWebhookVersions            → { version, webhookId: v.id, createdAt, isActive }
    //       (NO versionId/id key — the row id is stashed under the misnamed
    //        `webhookId`, which we deliberately do not read as a version id)
    //   dto/skill.dto.ts SkillVersionDto                           → { version, createdDate, createdBy, isCurrent } (no id)
    //   persona/base.controller.ts                                 → { version: number, createdDate, isCurrent, persona } (no id)
    description: 'List the server-side versions of one primitive (skill, webhook, job, trigger, preprocessor, postprocessor, workflow) or the agent persona. Returns { activeVersionId, versions: [{version, versionId, active, createdAt}] } — `active` is the version currently live. `versionId` is null for types whose versions route carries no per-entry id: skill, persona and webhook (the webhook route exposes the row id only under a misnamed `webhookId` key). For those, identify a version by `version`; for webhooks the live row id is the top-level `activeVersionId`. `activeVersionId` is populated only for webhook, trigger, preprocessor and postprocessor envelopes and is null for skill, job, workflow and persona.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        type: { type: 'string', enum: [...VALID_TYPES] },
        name: { type: 'string', description: 'Primitive name as written in lua.skill.yaml (omit for persona — an agent has only one)' },
      },
      required: ['agentId', 'type'],
    },
  },
  async handler({ agentId, type, name }, deps = {}) {
    if (!agentId || !type) throw new Error('agentId and type are required');
    if (!VALID_TYPES.has(type)) throw new Error(`Invalid type: ${type}. Valid: ${[...VALID_TYPES].join(', ')}`);
    if (type !== 'persona' && !name) throw new Error('name is required for all types except persona');

    // Versions live under /developer/<plural>/:agentId/:id/versions, EXCEPT
    // persona which lives under /developer/agents/:agentId/persona/versions
    // (no :id). The :id slot is the server id (skillId / webhookId / ...),
    // never the name — so resolve name → id by listing first.
    let path;
    if (type === 'persona') {
      path = `/developer/agents/${encodeURIComponent(agentId)}/persona/versions`;
    } else {
      const id = await resolveNameToId({ agentId, type, name, fetchFn: deps.fetchFn });
      path = `/developer/${LIST_PATHS[type]}/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}/versions`;
    }

    const data = await apiRequest(path, { fetchFn: deps.fetchFn });
    const versions = extractVersions(type, data);
    const compact = versions.map((v) => ({
      version: v.version,
      versionId: versionId(v),
      active: isActiveVersion(type, v, data),
      createdAt: versionCreatedAt(v),
    }));
    const result = { agentId, type, name: type === 'persona' ? null : name, activeVersionId: extractActiveVersionId(data), versions: compact };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};

async function resolveNameToId({ agentId, type, name, fetchFn }) {
  const listPath = `/developer/${LIST_PATHS[type]}/${encodeURIComponent(agentId)}`;
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

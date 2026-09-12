// Per-type response-shape extractors.
//
// lua-api's developer endpoints have INCONSISTENT response shapes across
// primitive types. Verified against packages/lua-api/src/dto/*.dto.ts and
// packages/lua-api/src/controllers/developer/**/base.controller.ts, plus
// packages/lua-cli/src/interfaces/workflows.ts (lua-cli 3.33.0):
//
//   Skills         GET /developer/skills/:agentId                      → { skills: SkillDto[] }
//                  GET /developer/skills/:agentId/:skillId/versions    → { versions: [{ version, createdDate, isCurrent, ... }] }
//   Webhooks       GET /developer/webhooks/:agentId                    → { success, data: { webhooks } }
//                  GET .../:webhookId/versions                         → { success, data: { versions: [{ version, webhookId, createdAt, isActive }], activeVersionId? } }
//                                                                        (services/developer.webhook.service.ts sets `webhookId: v.id` — the
//                                                                         version ROW id under a misnamed key; there is no versionId/id, so
//                                                                         versionId() is null and the envelope's activeVersionId is the only id)
//   Jobs           GET /developer/jobs/:agentId                        → { success, data: { jobs } }
//                  GET .../:jobId/versions                             → { success, data: JobVersionDto[] }   ← array under data; `active`
//   Triggers       GET /developer/triggers/:agentId                    → { success, data: { triggers } }
//                  GET .../:triggerId/versions                         → { success, data: { versions: [{ version, versionId, createdAt, isActive }], activeVersionId? } }
//   Preprocessors  GET /developer/preprocessors/:agentId               → { success, data: { preprocessors } }
//                  GET .../:preprocessorId/versions                    → { success, data: { versions: [{ versionId, version, isActive, createdAt }], activeVersionId? } }
//   Postprocessors GET /developer/postprocessors/:agentId              → { success, data: { postprocessors } }
//                  GET .../:postprocessorId/versions                   → same family as preprocessors
//   Workflows      GET /developer/workflows/:agentId                   → { success, data: { workflows } }   (code/script projected out)
//                  GET .../:workflowId/versions                        → { success, data: WorkflowVersion[] }   ← array under data; `active`
//   Persona        GET /developer/agents/:agentId/persona/versions     → { status, message, versions: [{ version: number, createdDate: number, isCurrent, persona }] }
//
// No version DTO carries `deployedAt` or `sourceHash`. The "live" flag is
// `isCurrent` (skill, persona), `active` (job, workflow) or `isActive` /
// `activeVersionId` (webhook, trigger, pre/postprocessor). Creation time is
// `createdAt` (ISO string) everywhere except skill/persona (`createdDate`;
// persona's is an epoch-ms number).

const LIST_EXTRACTORS = {
  skill:         (r) => r?.skills ?? [],
  webhook:       (r) => r?.data?.webhooks ?? [],
  job:           (r) => r?.data?.jobs ?? [],
  trigger:       (r) => r?.data?.triggers ?? [],
  preprocessor:  (r) => r?.data?.preprocessors ?? [],
  postprocessor: (r) => r?.data?.postprocessors ?? [],
  workflow:      (r) => r?.data?.workflows ?? [],
};

const VERSIONS_EXTRACTORS = {
  skill:         (r) => r?.versions ?? [],
  webhook:       (r) => r?.data?.versions ?? [],
  job:           (r) => (Array.isArray(r?.data) ? r.data : []),
  trigger:       (r) => r?.data?.versions ?? [],
  preprocessor:  (r) => r?.data?.versions ?? [],
  postprocessor: (r) => r?.data?.versions ?? [],
  workflow:      (r) => (Array.isArray(r?.data) ? r.data : []),
  persona:       (r) => r?.versions ?? [],
};

/** URL path segment under /developer/ for each listable type. */
export const LIST_PATHS = {
  skill: 'skills',
  webhook: 'webhooks',
  job: 'jobs',
  trigger: 'triggers',
  preprocessor: 'preprocessors',
  postprocessor: 'postprocessors',
  workflow: 'workflows',
};

/**
 * Extract a list of primitives from a list-endpoint response.
 * @throws if the type is unknown.
 */
export function extractList(type, response) {
  const fn = LIST_EXTRACTORS[type];
  if (!fn) throw new Error(`extractList: unknown primitive type "${type}". Valid: ${Object.keys(LIST_EXTRACTORS).join(', ')}`);
  return fn(response);
}

/**
 * Extract a list of versions from a versions-endpoint response.
 * @throws if the type is unknown.
 */
export function extractVersions(type, response) {
  const fn = VERSIONS_EXTRACTORS[type];
  if (!fn) throw new Error(`extractVersions: unknown primitive type "${type}". Valid: ${Object.keys(VERSIONS_EXTRACTORS).join(', ')}`);
  return fn(response);
}

/**
 * The `activeVersionId` a versions envelope may carry beside its array
 * (webhook, trigger, pre/postprocessor). Null for the other families.
 */
export function extractActiveVersionId(response) {
  const id = response?.data?.activeVersionId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Is this version the one that is live? Each family spells it differently.
 *
 * @param {string} type
 * @param {object} version - one element of extractVersions()
 * @param {object} [response] - the versions envelope (for activeVersionId)
 */
export function isActiveVersion(type, version, response) {
  if (!version || typeof version !== 'object') return false;
  switch (type) {
    case 'skill':
    case 'persona':
      return version.isCurrent === true;
    case 'job':
    case 'workflow':
      return version.active === true;
    case 'webhook':
    case 'trigger':
    case 'preprocessor':
    case 'postprocessor': {
      if (version.isActive === true) return true;
      const activeId = extractActiveVersionId(response);
      const ownId = version.versionId ?? version.id ?? null;
      return !!activeId && ownId === activeId;
    }
    default:
      return false;
  }
}

/**
 * ISO-8601 creation time of a version, or null. Normalises skill/persona's
 * `createdDate` (persona: epoch ms) onto the `createdAt` name.
 */
export function versionCreatedAt(version) {
  if (!version || typeof version !== 'object') return null;
  const raw = version.createdAt ?? version.createdDate ?? null;
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? new Date(raw).toISOString() : null;
  return String(raw);
}

/** Identifier of a version row (the slot lua-api keys `activeVersionId` on). */
export function versionId(version) {
  if (!version || typeof version !== 'object') return null;
  return version.versionId ?? version.id ?? null;
}

export const SUPPORTED_LIST_TYPES = Object.keys(LIST_EXTRACTORS);
export const SUPPORTED_VERSION_TYPES = Object.keys(VERSIONS_EXTRACTORS);

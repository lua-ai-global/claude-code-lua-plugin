// Per-type response-shape extractors.
//
// lua-api's developer endpoints have INCONSISTENT response shapes across
// primitive types (verified against packages/lua-api/src/dto/*.dto.ts):
//
//   Skills        list:     { skills: SkillDto[] }
//                 versions: { versions: SkillVersionDto[] }
//   Webhooks      list:     { success, data: { webhooks: WebhookDto[] } }
//                 versions: { success, data: { versions, activeVersionId? } }  (assumed — same family)
//   Jobs          list:     { success, data: { jobs: JobDto[] } }
//                 versions: { success, data: JobVersionDto[] }                 ← array under data!
//   Preprocessors list:     { success, data: { preprocessors: PreProcessorDto[] } }
//                 versions: { success, data: { versions, activeVersionId? } }
//   Postprocessors list:    { success, data: { postprocessors: PostProcessorDto[] } }
//                 versions: { success, data: { versions, activeVersionId? } }
//   Persona       (no list, single per agent)
//                 versions: { status, message, versions: PersonaVersionDto[] } ← no envelope
//
// Without per-type extractors, the MCP tools silently return empty arrays
// when the actual shape doesn't match a generic `data.items ?? []` pattern.

const LIST_EXTRACTORS = {
  skill:         (r) => r?.skills ?? [],
  webhook:       (r) => r?.data?.webhooks ?? [],
  job:           (r) => r?.data?.jobs ?? [],
  preprocessor:  (r) => r?.data?.preprocessors ?? [],
  postprocessor: (r) => r?.data?.postprocessors ?? [],
};

const VERSIONS_EXTRACTORS = {
  skill:         (r) => r?.versions ?? [],
  webhook:       (r) => r?.data?.versions ?? [],
  job:           (r) => Array.isArray(r?.data) ? r.data : [],
  preprocessor:  (r) => r?.data?.versions ?? [],
  postprocessor: (r) => r?.data?.versions ?? [],
  persona:       (r) => r?.versions ?? [],
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

export const SUPPORTED_LIST_TYPES = Object.keys(LIST_EXTRACTORS);
export const SUPPORTED_VERSION_TYPES = Object.keys(VERSIONS_EXTRACTORS);

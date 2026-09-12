import { apiRequest } from '../api-client.mjs';
import {
  extractList,
  extractVersions,
  extractActiveVersionId,
  isActiveVersion,
  versionCreatedAt,
  versionId,
  LIST_PATHS,
} from '../response-shapes.mjs';

// Composes "what is live" from the per-type lua-api list + versions routes.
// There is no single `/agents/:id/production` route; `lua status --json`
// gives the same picture for the CURRENT project (local vs deployed) and is
// the better tool when a lua.skill.yaml is at hand. This tool works for any
// agent the credential can reach, project or not.
//
// Per-type envelope handling lives in response-shapes.mjs.
//
// Request fan-out (1 + 7 + N version lookups) is parallelised in two phases:
//   1. the persona call and the seven list calls run together;
//   2. per type, item version lookups run in chunks of VERSIONS_CHUNK_SIZE.
// Output order is deterministic regardless of completion order: types in
// PRIMITIVE_TYPES order, items in the order the list route returned them.
// A wall-clock budget (BUDGET_MS, injectable as deps.budgetMs) stops NEW
// requests once exceeded; already-issued requests still complete. Items that
// could not be looked up are still listed, with `error: "skipped: …"`, and
// the result carries `partial: true` + `partialReason`.

const PRIMITIVE_TYPES = ['skill', 'webhook', 'job', 'trigger', 'preprocessor', 'postprocessor', 'workflow'];
const VERSIONS_CHUNK_SIZE = 5;
const DEFAULT_BUDGET_MS = 45_000;

export const getDeploymentStatus = {
  spec: {
    name: 'get_deployment_status',
    description: 'What is live right now for an agent: for every skill, webhook, job, trigger, preprocessor, postprocessor and workflow the active (deployed) version, plus the active persona version. Composed from the per-type lua-api version routes (list calls in parallel, then per-item version lookups in chunks of 5). Bounded by a 45 s wall-clock budget: if exceeded, remaining items are listed with `error: "skipped: …"` and the result carries `partial: true` + `partialReason`. Inside a project, `lua status --json` additionally compares local vs deployed.',
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
    const budgetMs = Number.isFinite(deps.budgetMs) ? deps.budgetMs : DEFAULT_BUDGET_MS;
    const startedAt = Date.now();
    const overBudget = () => Date.now() - startedAt > budgetMs;
    const get = (path) => apiRequest(path, { fetchFn: deps.fetchFn });

    const result = { agentId, persona: null, primitives: {} };
    // Seed keys up front so the output key order never depends on timing.
    for (const type of PRIMITIVE_TYPES) result.primitives[type] = [];

    // Phase 1: persona + every list route, all in flight at once.
    // Persona: one per agent, versions under /developer/agents/:agentId/persona/versions.
    const [personaOutcome, ...listOutcomes] = await Promise.allSettled([
      get(`/developer/agents/${id}/persona/versions`),
      ...PRIMITIVE_TYPES.map((type) => get(`/developer/${LIST_PATHS[type]}/${id}`)),
    ]);

    if (personaOutcome.status === 'fulfilled') {
      const personaResponse = personaOutcome.value;
      const versions = extractVersions('persona', personaResponse);
      const active = versions.find((v) => isActiveVersion('persona', v, personaResponse)) ?? null;
      result.persona = {
        activeVersion: active?.version ?? null,
        activeVersionCreatedAt: versionCreatedAt(active),
        versionCount: versions.length,
      };
    } else {
      result.persona = { error: personaOutcome.reason?.message ?? String(personaOutcome.reason) };
    }

    // Phase 2: per type, resolve each item's versions in chunks. Types are
    // visited sequentially (canonical order); within a type up to
    // VERSIONS_CHUNK_SIZE lookups are in flight together.
    let budgetExhausted = false;
    let skipped = 0;
    let total = 0;

    for (let t = 0; t < PRIMITIVE_TYPES.length; t++) {
      const type = PRIMITIVE_TYPES[t];
      const path = LIST_PATHS[type];
      const outcome = listOutcomes[t];
      if (outcome.status !== 'fulfilled') {
        result.primitives[type] = { error: outcome.reason?.message ?? String(outcome.reason) };
        continue;
      }

      // The URL slot is the server id (:skillId / :webhookId / ...), never
      // the name. Items without an id are dropped, as before.
      const targets = extractList(type, outcome.value)
        .map((p) => ({ p, primId: p.id ?? p._id, name: p.name ?? p.id ?? p._id }))
        .filter((tgt) => tgt.primId);
      total += targets.length;

      for (let i = 0; i < targets.length; i += VERSIONS_CHUNK_SIZE) {
        const chunk = targets.slice(i, i + VERSIONS_CHUNK_SIZE);

        if (budgetExhausted || overBudget()) {
          budgetExhausted = true;
          skipped += chunk.length;
          for (const { name, primId } of chunk) {
            result.primitives[type].push({
              name, id: primId,
              error: `skipped: wall-clock budget of ${budgetMs}ms exhausted before this version lookup was issued`,
            });
          }
          continue;
        }

        const outcomes = await Promise.allSettled(
          chunk.map(({ primId }) => get(`/developer/${path}/${id}/${encodeURIComponent(primId)}/versions`))
        );

        outcomes.forEach((vo, j) => {
          const { p, primId, name } = chunk[j];
          if (vo.status !== 'fulfilled') {
            result.primitives[type].push({ name, id: primId, error: vo.reason?.message ?? String(vo.reason) });
            return;
          }
          const versionsResponse = vo.value;
          const versions = extractVersions(type, versionsResponse);
          const active = versions.find((v) => isActiveVersion(type, v, versionsResponse)) ?? null;

          const entry = {
            name,
            id: primId,
            activeVersion: active?.version ?? null,
            activeVersionId: versionId(active) ?? extractActiveVersionId(versionsResponse),
            activeVersionCreatedAt: versionCreatedAt(active),
            versionCount: versions.length,
          };
          // Records that carry their own enabled/disabled switch.
          if (typeof p.active === 'boolean') entry.enabled = p.active;
          if (type === 'workflow' && typeof p.dynamic === 'boolean') entry.dynamic = p.dynamic;
          result.primitives[type].push(entry);
        });
      }
    }

    if (skipped > 0) {
      result.partial = true;
      result.partialReason =
        `Wall-clock budget of ${budgetMs}ms exceeded after ${Date.now() - startedAt}ms; ` +
        `${skipped} of ${total} version lookups were not issued (entries carry error: "skipped: …").`;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
};

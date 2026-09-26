// Thin HTTP wrapper around lua-api. Per tech spec §8.
//
// We do NOT import lua-cli's HttpClient classes at runtime (would force
// the entire lua-cli package to be bundled). Instead, this minimal client
// hits the same REST endpoints lua-cli does. Every route, query parameter
// and envelope used by the tools is verified against packages/lua-api
// (controllers/developer/**, dto/**) — see response-shapes.mjs.

import { resolveApiKey } from './auth.mjs';

const DEFAULT_BASE_URL = 'https://api.heylua.ai';
const DEFAULT_TIMEOUT_MS = 10_000;

// Scope each route family the tools call actually requires — read from the
// `@RequireScope(...)` decorator on every GET the tools hit, under
// lua-core-services packages/lua-api/src/controllers/developer/:
//   skills/base.controller.ts, webhooks/base.controller.ts,
//   jobs/base.controller.ts, triggers/base.controller.ts,
//   preprocessors/base.controller.ts, postprocessors/base.controller.ts
//                                  → 'automations:read' (list + :id/versions)
//   workflows/base.controller.ts   → 'workflows:read'   (GET :agentId, GET :agentId/:workflowId/versions)
//   persona/base.controller.ts     → 'agents:read'      (GET :agentId/persona/versions)
//   base.controller.ts             → 'knowledge:read'   (GET agents/:agentId/logs)
// Workflows are NOT under automations:read — they have their own scope pair
// (workflows:read / workflows:write).
export const ROUTE_SCOPES = Object.freeze({
  skills: 'automations:read',
  webhooks: 'automations:read',
  jobs: 'automations:read',
  triggers: 'automations:read',
  preprocessors: 'automations:read',
  postprocessors: 'automations:read',
  workflows: 'workflows:read',
  persona: 'agents:read',
  logs: 'knowledge:read',
});

const ROUTE_SCOPE_SUMMARY =
  'skills/webhooks/jobs/triggers/preprocessors/postprocessors need automations:read, workflows need ' +
  'workflows:read, persona needs agents:read, logs need knowledge:read';

/**
 * @param {string} path - API path (with leading slash)
 * @param {{method?: string, body?: object, query?: Record<string,string|number>, fetchFn?: typeof fetch, baseUrl?: string, timeoutMs?: number}} [opts]
 */
export async function apiRequest(path, {
  method = 'GET',
  body,
  query,
  fetchFn = globalThis.fetch,
  baseUrl = process.env.LUA_API_URL || DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const apiKey = await resolveApiKey();
  // Join by string concatenation, NOT `new URL(path, baseUrl)`: the WHATWG
  // resolver treats a leading-slash path as host-absolute and would drop any
  // path prefix on LUA_API_URL (https://host/api + /developer/x →
  // https://host/developer/x). `path` always starts with '/', so strip one
  // trailing slash from the base and concatenate.
  const url = new URL(baseUrl.replace(/\/$/, '') + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url.toString(), {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Lua-Client': 'claude-plugin/1.6.0',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (res.status === 401) {
      throw new Error(
        'MCP_AUTH_STALE: lua-api returned 401. The credential is missing, expired, or the session was signed out ' +
        '(signing out of the Lua dashboard or apps also ends CLI sessions). Run `lua auth configure` in a terminal, ' +
        'or re-run /lua-doctor.'
      );
    }
    if (res.status === 403) {
      throw new Error(
        `MCP_FORBIDDEN: lua-api returned 403 for ${path}. The credential cannot access this agent or org, or it lacks ` +
        `the route scope (${ROUTE_SCOPE_SUMMARY} — typed keys are scoped to the agents and role chosen at ` +
        '`lua auth configure`). Re-run /lua-doctor or check the LUA_API_KEY env var.'
      );
    }
    if (!res.ok) {
      // Try to parse lua-api's structured error envelope:
      //   { success: false, error: { message, statusCode, code?, ... } }
      // Falls back to raw text on parse failure (e.g. proxy 502 with HTML body).
      const raw = await res.text();
      let friendlyMsg = raw;
      try {
        const parsed = JSON.parse(raw);
        friendlyMsg = parsed?.error?.message ?? parsed?.message ?? raw;
        const code = parsed?.error?.code;
        if (typeof code === 'string' && code && !String(friendlyMsg).includes(code)) friendlyMsg = `${code}: ${friendlyMsg}`;
      } catch { /* not JSON; raw is fine */ }
      throw new Error(`lua-api ${res.status}: ${friendlyMsg}`);
    }

    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`MCP_TIMEOUT: ${path} did not respond in ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

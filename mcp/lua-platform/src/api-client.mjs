// Thin HTTP wrapper around lua-api. Per tech spec §8.
//
// We do NOT import lua-cli's HttpClient classes at runtime (would force
// the entire lua-cli package to be bundled). Instead, this minimal client
// hits the same REST endpoints lua-cli does. Endpoint mapping is verified
// against packages/lua-api source by the M4 contract tests.

import { resolveApiKey } from './auth.mjs';

const DEFAULT_BASE_URL = 'https://api.heylua.ai';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @param {string} path - API path (with leading slash)
 * @param {{method?: string, body?: object, query?: Record<string,string|number>, fetchFn?: typeof fetch}} [opts]
 */
export async function apiRequest(path, {
  method = 'GET',
  body,
  query,
  fetchFn = globalThis.fetch,
  baseUrl = process.env.LUA_API_URL ?? DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const apiKey = await resolveApiKey();
  const url = new URL(path, baseUrl);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url.toString(), {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (res.status === 401) throw new Error('MCP_AUTH_STALE: lua-api returned 401. Re-run /lua-doctor.');
    if (res.status === 403) {
      throw new Error(`MCP_FORBIDDEN: lua-api returned 403 for ${path}. Your API key likely belongs to a different agent or org. Re-run /lua-doctor or check the LUA_API_KEY env var.`);
    }
    if (!res.ok) {
      // Try to parse lua-api's structured error envelope:
      //   { success: false, error: { message, statusCode, ... } }
      // Falls back to raw text on parse failure (e.g. proxy 502 with HTML body).
      const raw = await res.text();
      let friendlyMsg = raw;
      try {
        const parsed = JSON.parse(raw);
        friendlyMsg = parsed?.error?.message ?? parsed?.message ?? raw;
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

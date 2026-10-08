// Platform HTTP access for the QA helpers (pattern of mcp/lua-platform/src/api-client.mjs).
// Bearer comes from the same credential chain as the MCP server and is never logged.

import { readFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { resolveApiKey } from '../../mcp/lua-platform/src/auth.mjs';
import { QaError } from './io.mjs';

function readPluginVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
export const PLUGIN_VERSION = readPluginVersion();

export async function resolveBearer() {
  try {
    return await resolveApiKey();
  } catch {
    throw new QaError('NO_CREDENTIAL', 4, 'No lua credential found', 'Log in from your own terminal (lua auth), or run /lua-auth.');
  }
}

/**
 * @param {string} path starts with '/'
 * @returns {Promise<any>} parsed JSON body
 */
export async function qaApiRequest(path, {
  method = 'GET', body, query, deps = {}, timeoutMs = 20_000,
  baseUrl = process.env.LUA_API_URL || 'https://api.heylua.ai',
} = {}) {
  const bearer = await (deps.resolveBearer ?? resolveBearer)();
  const url = new URL(baseUrl.replace(/\/$/, '') + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await (deps.fetch ?? globalThis.fetch)(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        'X-Lua-Client': `claude-plugin-qa/${PLUGIN_VERSION}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 401) throw new QaError('AUTH_STALE', 5, 'lua-api returned 401', 'The credential is missing or expired. Log in again from your own terminal.');
    if (res.status === 403) throw new QaError('FORBIDDEN', 5, `lua-api returned 403 for ${path}`, 'The credential cannot access this agent or lacks the route scope.');
    if (!res.ok) {
      const raw = await res.text();
      let msg = raw;
      try {
        const parsed = JSON.parse(raw);
        msg = parsed?.error?.message ?? parsed?.message ?? raw;
      } catch { /* raw is fine */ }
      const err = new QaError(res.status >= 500 ? 'PLATFORM' : `API_${res.status}`, 5, `lua-api ${res.status}: ${String(msg).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err instanceof QaError) throw err;
    if (err && err.name === 'AbortError') throw new QaError('PLATFORM', 5, `${path} did not respond in ${timeoutMs} ms`);
    throw new QaError('PLATFORM', 5, `network error calling ${path}: ${String(err && err.message).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- credential detection (sources only, never values)

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which tier of lua-cli's credential chain would win, plus whether a stored credential exists.
 * @returns {Promise<{source:'env'|'dotenv'|'session'|'credentials-file'|'none', hasStoredCredential:boolean, dotenvKeys:string[], hasLuaApiKeyInDotenv:boolean}>}
 */
export async function detectCredential({ env = process.env, cwd = process.cwd(), home = homedir() } = {}) {
  const credentialsPath = env.LUA_CREDENTIALS_PATH ?? join(home, '.lua-cli', 'credentials');
  const sessionsDir = env.LUA_SESSIONS_DIR ?? join(dirname(credentialsPath), 'sessions');
  let dotenvKeys = [];
  let dotenvHasKey = false;
  try {
    const text = await readFile(join(cwd, '.env'), 'utf8');
    dotenvKeys = [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]);
    dotenvHasKey = /^\s*(?:export\s+)?LUA_API_KEY\s*=\s*\S+/m.test(text);
  } catch { /* no .env */ }
  let hasSession = false;
  try {
    hasSession = (await readdir(sessionsDir)).some((f) => f.endsWith('.json'));
  } catch { /* none */ }
  const hasFile = await exists(credentialsPath);
  const hasStoredCredential = hasSession || hasFile;
  let source = 'none';
  if (env.LUA_API_KEY && env.LUA_API_KEY.trim()) source = 'env';
  else if (dotenvHasKey) source = 'dotenv';
  else if (hasSession) source = 'session';
  else if (hasFile) source = 'credentials-file';
  return { source, hasStoredCredential, dotenvKeys: [...new Set(dotenvKeys)], hasLuaApiKeyInDotenv: dotenvHasKey };
}

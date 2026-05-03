// Per tech spec §8.3 (v8 I5 fix).
// Resolves API key on EVERY call, not at server startup — supports the
// flow where a user re-runs `lua auth configure` mid-session.
//
// Three-tier resolution chain — MUST match lua-cli's behaviour and the
// plugin's lib/credentials.mjs. Iteration-8 audit (2026-05-02) caught
// the missing .env fallback that caused users with only `.env`-based
// credentials to have working slash commands but failing MCP tool calls.
//
// Tier 1: LUA_API_KEY env var          (CI/Docker/server)
// Tier 2: ~/.lua-cli/credentials file  (interactive local dev — written by `lua auth configure`)
// Tier 3: .env file in CWD             (local dev shorthand)
//
// Note: this file deliberately duplicates lib/credentials.mjs because
// the MCP server is a separate npm package and can't reach into the
// plugin's lib/. Drift is guarded against by the api-client.test.mjs
// + per-tier tests in this directory.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * @returns {Promise<string>} The resolved API key
 * @throws {Error} MCP_AUTH_STALE if no key resolvable from any tier
 */
export async function resolveApiKey({
  env = process.env,
  credentialsPath = env.LUA_CREDENTIALS_PATH ?? join(homedir(), '.lua-cli', 'credentials'),
  cwd = process.cwd(),
} = {}) {
  // Tier 1: env
  if (env.LUA_API_KEY) return env.LUA_API_KEY;

  // Tier 2: ~/.lua-cli/credentials (plain text — see lib/credentials.mjs)
  // Iteration-13 audit: the previous JSON.parse call threw on every real
  // lua-cli credentials file (which is the raw API key string, verified
  // against packages/lua-cli/src/services/auth.ts:65-67). Every MCP tool
  // call from a user authenticated via `lua auth configure` failed with
  // MCP_AUTH_STALE.
  try {
    const raw = (await readFile(credentialsPath, 'utf8')).trim();
    if (raw) {
      if (raw.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.apiKey) return parsed.apiKey;
        } catch { /* not JSON despite leading brace */ }
      }
      return raw;
    }
  } catch { /* missing / unreadable — fall through */ }

  // Tier 3: .env in current working directory
  try {
    const envFile = await readFile(join(cwd, '.env'), 'utf8');
    const match = envFile.match(/^LUA_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* no .env — fall through */ }

  throw new Error('MCP_AUTH_STALE: No lua-cli credentials found in env, ~/.lua-cli/credentials, or .env. Run /lua-doctor in Claude Code.');
}

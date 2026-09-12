// Per tech spec §17.5.
// Mirrors lua-cli 3.33.0's credential resolution
// (packages/lua-cli/src/services/request-credential.ts, resolveRequestCredential):
//   1. LUA_API_KEY in the environment — lua-cli runs `import 'dotenv/config'`
//      first, so a `.env` in the working directory is part of this tier.
//   2. The renewable first-party session `lua auth configure` (email + OTP)
//      writes to ~/.lua-cli/sessions/<env-hash>.json. This is the default
//      login since lua-cli 3.29; it DELETES ~/.lua-cli/credentials. The
//      session holds a refresh token, not a bearer — this helper reports the
//      source without deriving a key (hooks never need the bearer; the MCP
//      server refreshes it itself in mcp/lua-platform/src/auth.mjs).
//   3. ~/.lua-cli/credentials — a plain-text API key.

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_API_URL = 'https://api.heylua.ai';

/**
 * Parse a dotenv-style file for LUA_API_KEY the way dotenv does (optional
 * `export `, surrounding quotes stripped, trailing ` # comment` dropped from
 * unquoted values).
 *
 * @param {string} content
 * @returns {string|null}
 */
export function parseDotenvApiKey(content) {
  for (const rawLine of content.split(/\r?\n/)) {
    const m = rawLine.match(/^\s*(?:export\s+)?LUA_API_KEY\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[1].trim();
    const quoted = value.match(/^(['"`])(.*?)\1(?:\s+#.*)?\s*$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    return value || null;
  }
  return null;
}

/**
 * @returns {Promise<{key: string|null, source: 'env'|'dotenv'|'session'|'credentials-file', sessionPath?: string}|null>}
 */
export async function resolveApiKey({
  env = process.env,
  credentialsPath = env.LUA_CREDENTIALS_PATH ?? join(homedir(), '.lua-cli', 'credentials'),
  sessionsDir = env.LUA_SESSIONS_DIR ?? join(dirname(credentialsPath), 'sessions'),
  cwd = process.cwd(),
  apiUrl = env.LUA_API_URL || DEFAULT_API_URL,
} = {}) {
  if (env.LUA_API_KEY && env.LUA_API_KEY.trim()) {
    return { key: env.LUA_API_KEY.trim(), source: 'env' };
  }

  try {
    const fromDotenv = parseDotenvApiKey(await readFile(join(cwd, '.env'), 'utf8'));
    if (fromDotenv) return { key: fromDotenv, source: 'dotenv' };
  } catch { /* no .env */ }

  try {
    for (const name of await readdir(sessionsDir)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const path = join(sessionsDir, name);
      try {
        const session = JSON.parse(await readFile(path, 'utf8'));
        if (session?.kind === 'firebase-session' && session?.version === 1 && session.apiUrl === apiUrl && session.refreshToken) {
          return { key: null, source: 'session', sessionPath: path };
        }
      } catch { /* malformed — skip */ }
    }
  } catch { /* no sessions dir */ }

  try {
    const raw = (await readFile(credentialsPath, 'utf8')).trim();
    if (raw) {
      // Forward-compat: also accept a JSON envelope `{ "apiKey": "..." }`
      // in case lua-cli's storage format ever changes. Today it is the bare key.
      if (raw.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.apiKey) return { key: parsed.apiKey, source: 'credentials-file' };
        } catch { /* not JSON despite leading brace — fall through to plain-text */ }
      }
      return { key: raw, source: 'credentials-file' };
    }
  } catch { /* file missing or unreadable */ }

  return null;
}

/**
 * Redact for display: keep last 4 chars only, replace rest with asterisks.
 * Last-4 matches lua-cli's redaction pattern.
 *
 * @param {string|null|undefined} key
 * @returns {string}
 */
export function redactKey(key) {
  if (!key || typeof key !== 'string' || key.length < 8) return '****';
  return `${'*'.repeat(key.length - 4)}${key.slice(-4)}`;
}

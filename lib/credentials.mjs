// Per tech spec §17.5.
// Mirrors lua-cli's three-tier credential resolution:
//   1. LUA_API_KEY env var (CI/Docker/server)
//   2. ~/.lua-cli/credentials file (interactive local dev)
//   3. .env file in CWD (local dev shorthand)

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * @returns {Promise<{key: string, source: 'env'|'credentials-file'|'dotenv'}|null>}
 */
export async function resolveApiKey({
  env = process.env,
  credentialsPath = env.LUA_CREDENTIALS_PATH ?? join(homedir(), '.lua-cli', 'credentials'),
  cwd = process.cwd(),
} = {}) {
  if (env.LUA_API_KEY) {
    return { key: env.LUA_API_KEY, source: 'env' };
  }

  // Iteration-13 audit: lua-cli writes the credentials file as PLAIN TEXT
  // — just the bare API key string (verified against
  // packages/lua-cli/src/services/auth.ts:65-67:
  // `writeFileSync(CREDENTIALS_FILE, apiKey, { mode: 0o600 })`). The
  // earlier code did `JSON.parse(raw)` which threw on every real lua-cli
  // credentials file, silently dropped through to the .env fallback, and
  // failed for users authenticated via `lua auth configure`.
  try {
    const raw = (await readFile(credentialsPath, 'utf8')).trim();
    if (raw) {
      // Forward-compat: also accept a JSON envelope `{ "apiKey": "..." }`
      // in case lua-cli's storage format ever changes.
      if (raw.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.apiKey) return { key: parsed.apiKey, source: 'credentials-file' };
        } catch { /* not JSON despite leading brace — fall through to plain-text */ }
      }
      return { key: raw, source: 'credentials-file' };
    }
  } catch { /* file missing or unreadable */ }

  try {
    const envFile = await readFile(join(cwd, '.env'), 'utf8');
    const match = envFile.match(/^LUA_API_KEY=(.+)$/m);
    if (match) return { key: match[1].trim(), source: 'dotenv' };
  } catch { /* no .env */ }

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

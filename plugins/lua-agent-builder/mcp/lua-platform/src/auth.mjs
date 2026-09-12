// Credential resolution for the MCP server. Resolved on EVERY call, not at
// server startup — supports the flow where a user re-runs `lua auth configure`
// mid-session.
//
// The chain MUST match lua-cli's `resolveRequestCredential()`
// (packages/lua-cli/src/services/request-credential.ts, lua-cli 3.33.0):
//
//   1. LUA_API_KEY in the process environment. lua-cli loads `./.env` into
//      process.env first (`import 'dotenv/config'`), so a `.env` value in the
//      working directory is part of this tier — it beats a stored session.
//   2. The renewable first-party session `lua auth configure` (email + OTP)
//      writes to ~/.lua-cli/sessions/<env-hash>.json. This is the DEFAULT
//      login since lua-cli 3.29 and it DELETES ~/.lua-cli/credentials, so an
//      MCP server that only read the credentials file failed for every
//      session user. The file holds a Firebase refresh token; the bearer is
//      a short-lived ID token obtained from Google's securetoken endpoint.
//   3. ~/.lua-cli/credentials — a plain-text API key (typed `api_<uuid>.<43>`
//      or legacy), written when the user picks the API-key option of
//      `lua auth configure`.
//
// This file deliberately duplicates lib/credentials.mjs because the MCP
// server is a separate npm package and can't reach into the plugin's lib/.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_API_URL = 'https://api.heylua.ai';
const FIREBASE_REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';
const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_SKEW_MS = 60_000;

// Google's verdicts that the stored refresh token can never work again.
// Mirrors lua-cli's REJECTED_REFRESH_REASONS (services/firebase-session.ts).
const REJECTED_REFRESH_REASONS = [
  'TOKEN_EXPIRED',
  'USER_DISABLED',
  'USER_NOT_FOUND',
  'INVALID_REFRESH_TOKEN',
  'INVALID_GRANT_TYPE',
  'MISSING_REFRESH_TOKEN',
];

// In-process cache of refreshed ID tokens, keyed by session file path.
const tokenCache = new Map();

/** Exported for tests. */
export function clearTokenCache() {
  tokenCache.clear();
}

/**
 * Parse a dotenv-style file for LUA_API_KEY the way dotenv does: optional
 * `export ` prefix, surrounding single/double quotes stripped, a trailing
 * ` # comment` dropped from unquoted values.
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
 * Locate the lua-cli session file for the API base URL in use. lua-cli names
 * the file by a hash of (apiUrl, authUrl, firebaseWebApiKey); rather than
 * recompute it we scan the directory for a `firebase-session` record whose
 * `apiUrl` matches, newest first.
 *
 * @returns {Promise<{path: string, session: object}|null>}
 */
export async function findSessionFile({ sessionsDir, apiUrl }) {
  let names;
  try {
    names = await readdir(sessionsDir);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const path = join(sessionsDir, name);
    try {
      const session = JSON.parse(await readFile(path, 'utf8'));
      if (session?.kind !== 'firebase-session' || session?.version !== 1) continue;
      if (typeof session.refreshToken !== 'string' || !session.refreshToken) continue;
      if (typeof session.firebaseWebApiKey !== 'string' || !session.firebaseWebApiKey) continue;
      if (session.apiUrl !== apiUrl) continue;
      const { mtimeMs } = await stat(path);
      candidates.push({ path, session, mtimeMs });
    } catch {
      // unreadable / malformed — skip, lua-cli will complain on its own
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { path: candidates[0].path, session: candidates[0].session };
}

/**
 * Exchange the stored refresh token for a Firebase ID token (the bearer
 * lua-api accepts). Cached in-process until 60 s before expiry. The session
 * file is never written: lua-cli owns it.
 *
 * @returns {Promise<string>} bearer token
 */
export async function refreshSessionBearer({ path, session, fetchFn = globalThis.fetch, now = Date.now }) {
  const cached = tokenCache.get(path);
  if (cached && cached.expiresAt - now() > REFRESH_SKEW_MS) return cached.idToken;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  let res;
  try {
    res = await fetchFn(`${FIREBASE_REFRESH_URL}?key=${encodeURIComponent(session.firebaseWebApiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }).toString(),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(
      `MCP_AUTH_UNAVAILABLE: could not refresh the lua-cli session (${err?.name === 'AbortError' ? 'timed out' : err.message}). ` +
      'Check your network, or set LUA_API_KEY to bypass the session.'
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let reason = res.statusText ?? String(res.status);
    try {
      const body = await res.json();
      const message = body?.error?.message;
      if (typeof message === 'string' && message) reason = message.split(':')[0].trim();
    } catch { /* keep statusText */ }
    const rejected = res.status < 500 && REJECTED_REFRESH_REASONS.find((r) => reason.toUpperCase().includes(r));
    if (rejected) {
      throw new Error(
        `MCP_AUTH_STALE: your lua-cli session was signed out (${rejected}). ` +
        'Signing out of the Lua dashboard, desktop or mobile app also ends CLI sessions. ' +
        'Run `lua auth configure` in a terminal to sign in again.'
      );
    }
    throw new Error(`MCP_AUTH_UNAVAILABLE: lua-cli session refresh failed (${res.status} ${reason}). Retry in a moment.`);
  }

  const body = await res.json();
  const idToken = body?.id_token;
  const expiresIn = Number(body?.expires_in);
  if (typeof idToken !== 'string' || !idToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('MCP_AUTH_UNAVAILABLE: the session refresh returned an invalid token. Run `lua auth configure` again.');
  }
  tokenCache.set(path, { idToken, expiresAt: now() + expiresIn * 1000 });
  return idToken;
}

/**
 * Resolve the bearer token every lua-api request should carry.
 *
 * @returns {Promise<string>}
 * @throws {Error} MCP_AUTH_STALE when no credential resolves from any tier
 */
export async function resolveApiKey({
  env = process.env,
  credentialsPath = env.LUA_CREDENTIALS_PATH ?? join(homedir(), '.lua-cli', 'credentials'),
  sessionsDir = env.LUA_SESSIONS_DIR ?? join(dirname(credentialsPath), 'sessions'),
  cwd = process.cwd(),
  apiUrl = env.LUA_API_URL || DEFAULT_API_URL,
  fetchFn = globalThis.fetch,
  now = Date.now,
} = {}) {
  // Tier 1a: process environment
  if (env.LUA_API_KEY && env.LUA_API_KEY.trim()) return env.LUA_API_KEY.trim();

  // Tier 1b: .env in the working directory (lua-cli loads it into process.env
  // before reading LUA_API_KEY, so it ranks above the stored session)
  try {
    const fromDotenv = parseDotenvApiKey(await readFile(join(cwd, '.env'), 'utf8'));
    if (fromDotenv) return fromDotenv;
  } catch { /* no .env — fall through */ }

  // Tier 2: renewable first-party session
  const found = await findSessionFile({ sessionsDir, apiUrl });
  if (found) return refreshSessionBearer({ ...found, fetchFn, now });

  // Tier 3: ~/.lua-cli/credentials (plain text API key)
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

  throw new Error(
    'MCP_AUTH_STALE: No lua-cli credentials found in LUA_API_KEY, .env, ~/.lua-cli/sessions, or ~/.lua-cli/credentials. ' +
    'Run `lua auth configure` in a terminal (or /lua-auth in Claude Code).'
  );
}

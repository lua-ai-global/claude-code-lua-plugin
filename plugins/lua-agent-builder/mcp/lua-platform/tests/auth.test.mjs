// Tests for the MCP server's resolveApiKey — must match lua-cli 3.33.0's
// resolveRequestCredential() chain (packages/lua-cli/src/services/
// request-credential.ts): LUA_API_KEY (env, then .env in cwd) → stored
// renewable session (~/.lua-cli/sessions/*.json, refreshed at Google) →
// ~/.lua-cli/credentials (plain-text API key).

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveApiKey,
  parseDotenvApiKey,
  findSessionFile,
  refreshSessionBearer,
  clearTokenCache,
} from '../src/auth.mjs';

let tmpDir;
let sessionsDir;

const API_URL = 'https://api.heylua.ai';

function sessionRecord(overrides = {}) {
  return {
    version: 1,
    kind: 'firebase-session',
    generation: 'gen-1',
    refreshToken: 'rt_abc',
    firebaseUid: 'uid_1',
    apiUrl: API_URL,
    authUrl: 'https://auth.heylua.ai',
    firebaseWebApiKey: 'AIzaTestKey',
    ...overrides,
  };
}

function writeSession(name, record) {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, name), JSON.stringify(record));
}

function mockFetch(scripted) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof scripted === 'function' ? scripted({ url, init }) : scripted;
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function baseOpts(extra = {}) {
  return {
    env: {},
    credentialsPath: join(tmpDir, 'credentials'),
    sessionsDir,
    cwd: tmpDir,
    fetchFn: mockFetch(() => { throw new Error('fetch should not be called'); }),
    ...extra,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-auth-test-'));
  sessionsDir = join(tmpDir, 'sessions');
  clearTokenCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Tier 1a: LUA_API_KEY env var', () => {
  test('returns key from env when set', async () => {
    expect(await resolveApiKey(baseOpts({ env: { LUA_API_KEY: 'lk_from_env' } }))).toBe('lk_from_env');
  });

  test('trims the env value', async () => {
    expect(await resolveApiKey(baseOpts({ env: { LUA_API_KEY: '  lk_padded \n' } }))).toBe('lk_padded');
  });

  test('env wins over credentials file, .env and session', async () => {
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file');
    writeFileSync(join(tmpDir, '.env'), 'LUA_API_KEY=lk_from_dotenv\n');
    writeSession('abc.json', sessionRecord());
    expect(await resolveApiKey(baseOpts({ env: { LUA_API_KEY: 'lk_from_env' } }))).toBe('lk_from_env');
  });
});

describe('Tier 1b: .env in the working directory', () => {
  // lua-cli does `import 'dotenv/config'` before reading LUA_API_KEY, so a
  // .env value ranks as part of tier 1 — above the stored session and the
  // credentials file.
  test('reads LUA_API_KEY from .env when env is unset', async () => {
    writeFileSync(join(tmpDir, '.env'), 'OTHER=x\nLUA_API_KEY=lk_from_dotenv\nMORE=y\n');
    expect(await resolveApiKey(baseOpts())).toBe('lk_from_dotenv');
  });

  test('.env wins over the credentials file and the session', async () => {
    writeFileSync(join(tmpDir, '.env'), 'LUA_API_KEY=lk_from_dotenv\n');
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file\n');
    writeSession('abc.json', sessionRecord());
    expect(await resolveApiKey(baseOpts())).toBe('lk_from_dotenv');
  });

  test.each([
    ['LUA_API_KEY=  lk_padded  \n', 'lk_padded'],
    ['LUA_API_KEY="lk_quoted"\n', 'lk_quoted'],
    ["LUA_API_KEY='lk_single'\n", 'lk_single'],
    ['export LUA_API_KEY=lk_exported\n', 'lk_exported'],
    ['LUA_API_KEY=lk_commented # the key\n', 'lk_commented'],
    ['LUA_API_KEY="lk_hash#inside" # comment\n', 'lk_hash#inside'],
  ])('parses %j like dotenv → %s', (content, expected) => {
    expect(parseDotenvApiKey(content)).toBe(expected);
  });

  test('ignores an empty LUA_API_KEY line and falls through', async () => {
    writeFileSync(join(tmpDir, '.env'), 'LUA_API_KEY=\n');
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file\n');
    expect(await resolveApiKey(baseOpts())).toBe('lk_from_file');
  });
});

describe('Tier 2: stored renewable session (~/.lua-cli/sessions/*.json)', () => {
  test('findSessionFile picks the firebase-session record matching the API URL', async () => {
    writeSession('other-env.json', sessionRecord({ apiUrl: 'https://api-staging.heylua.ai' }));
    writeSession('prod.json', sessionRecord());
    const found = await findSessionFile({ sessionsDir, apiUrl: API_URL });
    expect(found.path).toBe(join(sessionsDir, 'prod.json'));
    expect(found.session.refreshToken).toBe('rt_abc');
  });

  test('findSessionFile ignores malformed, foreign-kind and dotfile entries', async () => {
    writeSession('.tmp.json', sessionRecord());
    writeSession('garbage.json', { kind: 'firebase-session' });
    writeFileSync(join(sessionsDir, 'notjson.json'), '{');
    expect(await findSessionFile({ sessionsDir, apiUrl: API_URL })).toBeNull();
  });

  test('findSessionFile returns null when the directory is missing', async () => {
    expect(await findSessionFile({ sessionsDir: join(tmpDir, 'nope'), apiUrl: API_URL })).toBeNull();
  });

  test('refreshes the session at Google and returns the ID token as the bearer', async () => {
    writeSession('prod.json', sessionRecord());
    const fetchFn = mockFetch(jsonResponse({ id_token: 'id_1', refresh_token: 'rt_abc', expires_in: '3600', user_id: 'uid_1' }));
    const bearer = await resolveApiKey(baseOpts({ fetchFn }));
    expect(bearer).toBe('id_1');
    expect(fetchFn.calls).toHaveLength(1);
    const { url, init } = fetchFn.calls[0];
    expect(url).toBe('https://securetoken.googleapis.com/v1/token?key=AIzaTestKey');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('grant_type=refresh_token&refresh_token=rt_abc');
  });

  test('session wins over the credentials file (lua-cli deletes the file on session login anyway)', async () => {
    writeSession('prod.json', sessionRecord());
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file\n');
    const fetchFn = mockFetch(jsonResponse({ id_token: 'id_1', refresh_token: 'rt_abc', expires_in: 3600, user_id: 'uid_1' }));
    expect(await resolveApiKey(baseOpts({ fetchFn }))).toBe('id_1');
  });

  test('caches the refreshed token until 60 s before expiry', async () => {
    writeSession('prod.json', sessionRecord());
    let clock = 1_000_000;
    const now = () => clock;
    const fetchFn = mockFetch(jsonResponse({ id_token: 'id_1', refresh_token: 'rt_abc', expires_in: 3600, user_id: 'uid_1' }));
    expect(await resolveApiKey(baseOpts({ fetchFn, now }))).toBe('id_1');
    expect(await resolveApiKey(baseOpts({ fetchFn, now }))).toBe('id_1');
    expect(fetchFn.calls).toHaveLength(1);
    clock += 3600 * 1000 - 30_000; // inside the 60 s skew → refresh again
    expect(await resolveApiKey(baseOpts({ fetchFn, now }))).toBe('id_1');
    expect(fetchFn.calls).toHaveLength(2);
  });

  test.each(['TOKEN_EXPIRED', 'USER_DISABLED', 'USER_NOT_FOUND', 'INVALID_REFRESH_TOKEN'])(
    'a %s refusal is MCP_AUTH_STALE with the lua auth configure remedy',
    async (reason) => {
      writeSession('prod.json', sessionRecord());
      const fetchFn = mockFetch(jsonResponse({ error: { message: `${reason}: extra` } }, { status: 400 }));
      await expect(resolveApiKey(baseOpts({ fetchFn }))).rejects.toThrow(/MCP_AUTH_STALE/);
      await expect(resolveApiKey(baseOpts({ fetchFn }))).rejects.toThrow(new RegExp(reason));
      await expect(resolveApiKey(baseOpts({ fetchFn }))).rejects.toThrow(/lua auth configure/);
    }
  );

  test('a 5xx from Google is MCP_AUTH_UNAVAILABLE, never a sign-out', async () => {
    writeSession('prod.json', sessionRecord());
    const fetchFn = mockFetch(jsonResponse({ error: { message: 'TOKEN_EXPIRED' } }, { status: 503 }));
    await expect(resolveApiKey(baseOpts({ fetchFn }))).rejects.toThrow(/MCP_AUTH_UNAVAILABLE/);
    await expect(resolveApiKey(baseOpts({ fetchFn }))).rejects.not.toThrow(/MCP_AUTH_STALE/);
  });

  test('a throttled 400 without a rejection reason is MCP_AUTH_UNAVAILABLE', async () => {
    writeSession('prod.json', sessionRecord());
    const fetchFn = mockFetch(jsonResponse({ error: { message: 'TOO_MANY_ATTEMPTS_TRY_LATER' } }, { status: 400 }));
    await expect(resolveApiKey(baseOpts({ fetchFn }))).rejects.toThrow(/MCP_AUTH_UNAVAILABLE/);
  });

  test('a network failure during refresh is MCP_AUTH_UNAVAILABLE', async () => {
    writeSession('prod.json', sessionRecord());
    const fetchFn = mockFetch(() => { throw new Error('ECONNRESET'); });
    await expect(resolveApiKey(baseOpts({ fetchFn }))).rejects.toThrow(/MCP_AUTH_UNAVAILABLE.*ECONNRESET/);
  });

  test('an invalid refresh payload is MCP_AUTH_UNAVAILABLE', async () => {
    writeSession('prod.json', sessionRecord());
    const fetchFn = mockFetch(jsonResponse({ nope: true }));
    await expect(refreshSessionBearer({ path: join(sessionsDir, 'prod.json'), session: sessionRecord(), fetchFn }))
      .rejects.toThrow(/MCP_AUTH_UNAVAILABLE/);
  });

  test('a session for a different API URL is ignored', async () => {
    writeSession('staging.json', sessionRecord({ apiUrl: 'https://api-staging.heylua.ai' }));
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file\n');
    expect(await resolveApiKey(baseOpts())).toBe('lk_from_file');
  });

  test('LUA_API_URL selects which session environment is used', async () => {
    writeSession('staging.json', sessionRecord({ apiUrl: 'https://api-staging.heylua.ai', refreshToken: 'rt_staging' }));
    const fetchFn = mockFetch(jsonResponse({ id_token: 'id_staging', refresh_token: 'rt_staging', expires_in: 3600, user_id: 'uid_1' }));
    const bearer = await resolveApiKey(baseOpts({ env: { LUA_API_URL: 'https://api-staging.heylua.ai' }, fetchFn }));
    expect(bearer).toBe('id_staging');
    expect(fetchFn.calls[0].init.body).toContain('refresh_token=rt_staging');
  });
});

describe('Tier 3: ~/.lua-cli/credentials (plain text)', () => {
  test('returns the trimmed API key from plain-text credentials', async () => {
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file\n');
    expect(await resolveApiKey(baseOpts())).toBe('lk_from_file');
  });

  test('forward-compat: accepts JSON envelope { apiKey } if lua-cli ever switches', async () => {
    writeFileSync(join(tmpDir, 'credentials'), JSON.stringify({ apiKey: 'lk_envelope' }));
    expect(await resolveApiKey(baseOpts())).toBe('lk_envelope');
  });

  test('treats a JSON-looking-but-malformed payload as plain text', async () => {
    writeFileSync(join(tmpDir, 'credentials'), '{not valid json');
    expect(await resolveApiKey(baseOpts())).toBe('{not valid json');
  });

  test('respects LUA_CREDENTIALS_PATH env override (and derives sessions/ beside it)', async () => {
    const customDir = join(tmpDir, 'custom');
    mkdirSync(customDir);
    const customPath = join(customDir, 'creds');
    writeFileSync(customPath, 'lk_custom');
    const key = await resolveApiKey({ env: { LUA_CREDENTIALS_PATH: customPath }, cwd: tmpDir });
    expect(key).toBe('lk_custom');
  });
});

describe('No source resolves', () => {
  test('throws MCP_AUTH_STALE naming every source', async () => {
    writeFileSync(join(tmpDir, '.env'), 'OTHER=x\n');
    await expect(resolveApiKey(baseOpts())).rejects.toThrow(/MCP_AUTH_STALE/);
    await expect(resolveApiKey(baseOpts())).rejects.toThrow(/LUA_API_KEY, \.env, ~\/\.lua-cli\/sessions, or ~\/\.lua-cli\/credentials/);
    await expect(resolveApiKey(baseOpts())).rejects.toThrow(/lua auth configure/);
  });
});

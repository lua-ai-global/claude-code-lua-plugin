import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApiKey, redactKey, parseDotenvApiKey } from '../../lib/credentials.mjs';

let tmpDir;
let sessionsDir;

function sessionRecord(overrides = {}) {
  return {
    version: 1,
    kind: 'firebase-session',
    generation: 'g1',
    refreshToken: 'rt_1',
    firebaseUid: 'uid_1',
    apiUrl: 'https://api.heylua.ai',
    authUrl: 'https://auth.heylua.ai',
    firebaseWebApiKey: 'AIzaTest',
    ...overrides,
  };
}

function base(extra = {}) {
  return { env: {}, credentialsPath: join(tmpDir, 'credentials'), sessionsDir, cwd: tmpDir, ...extra };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'creds-test-'));
  sessionsDir = join(tmpDir, 'sessions');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveApiKey — order mirrors lua-cli 3.33.0 resolveRequestCredential()', () => {
  test('returns env-source when LUA_API_KEY is set', async () => {
    expect(await resolveApiKey(base({ env: { LUA_API_KEY: 'lk_from_env' } })))
      .toEqual({ key: 'lk_from_env', source: 'env' });
  });

  test('env wins over .env, session and credentials file', async () => {
    writeFileSync(join(tmpDir, '.env'), 'LUA_API_KEY=lk_from_dotenv\n');
    mkdirSync(sessionsDir);
    writeFileSync(join(sessionsDir, 'a.json'), JSON.stringify(sessionRecord()));
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file');
    expect((await resolveApiKey(base({ env: { LUA_API_KEY: 'lk_from_env' } }))).source).toBe('env');
  });

  test('.env ranks above the session and the credentials file (dotenv/config loads it into process.env first)', async () => {
    writeFileSync(join(tmpDir, '.env'), 'OTHER=x\nLUA_API_KEY=lk_from_dotenv\nMORE=y\n');
    mkdirSync(sessionsDir);
    writeFileSync(join(sessionsDir, 'a.json'), JSON.stringify(sessionRecord()));
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file\n');
    expect(await resolveApiKey(base())).toEqual({ key: 'lk_from_dotenv', source: 'dotenv' });
  });

  test.each([
    ['LUA_API_KEY=  lk_padded  \n', 'lk_padded'],
    ['LUA_API_KEY="lk_quoted"\n', 'lk_quoted'],
    ["export LUA_API_KEY='lk_exported'\n", 'lk_exported'],
    ['LUA_API_KEY=lk_value # comment\n', 'lk_value'],
  ])('parses %j like dotenv', (content, expected) => {
    expect(parseDotenvApiKey(content)).toBe(expected);
  });

  test('detects the renewable session (no key — the bearer is derived by lua-cli / the MCP server)', async () => {
    mkdirSync(sessionsDir);
    writeFileSync(join(sessionsDir, 'a.json'), JSON.stringify(sessionRecord()));
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file\n');
    expect(await resolveApiKey(base())).toEqual({ key: null, source: 'session', sessionPath: join(sessionsDir, 'a.json') });
  });

  test('ignores a session for another API environment', async () => {
    mkdirSync(sessionsDir);
    writeFileSync(join(sessionsDir, 'a.json'), JSON.stringify(sessionRecord({ apiUrl: 'https://api-staging.heylua.ai' })));
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file\n');
    expect(await resolveApiKey(base())).toEqual({ key: 'lk_from_file', source: 'credentials-file' });
  });

  test('ignores malformed session files', async () => {
    mkdirSync(sessionsDir);
    writeFileSync(join(sessionsDir, 'a.json'), '{');
    writeFileSync(join(sessionsDir, 'b.json'), JSON.stringify({ kind: 'other' }));
    writeFileSync(join(sessionsDir, '.tmp.json'), JSON.stringify(sessionRecord()));
    expect(await resolveApiKey(base())).toBeNull();
  });

  // lua-cli writes the credentials file as PLAIN TEXT — the bare API key,
  // no JSON envelope (packages/lua-cli/src/services/auth.ts saveApiKey).
  test('reads plain-text credentials file when env/.env/session are absent', async () => {
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file\n');
    expect(await resolveApiKey(base())).toEqual({ key: 'lk_from_file', source: 'credentials-file' });
  });

  test('forward-compat: accepts JSON envelope { apiKey } if lua-cli ever switches', async () => {
    writeFileSync(join(tmpDir, 'credentials'), JSON.stringify({ apiKey: 'lk_from_envelope' }));
    expect(await resolveApiKey(base())).toEqual({ key: 'lk_from_envelope', source: 'credentials-file' });
  });

  test('treats a JSON-looking-but-malformed payload as plain text', async () => {
    writeFileSync(join(tmpDir, 'credentials'), '{not valid json');
    expect(await resolveApiKey(base())).toEqual({ key: '{not valid json', source: 'credentials-file' });
  });

  test('returns null if credentials file is empty and nothing else resolves', async () => {
    writeFileSync(join(tmpDir, 'credentials'), '   \n');
    expect(await resolveApiKey(base())).toBeNull();
  });

  test('returns null when no source has the key', async () => {
    expect(await resolveApiKey(base())).toBeNull();
  });

  test('returns null when .env exists but has no LUA_API_KEY line', async () => {
    writeFileSync(join(tmpDir, '.env'), 'OTHER_KEY=x\n');
    expect(await resolveApiKey(base())).toBeNull();
  });

  test('respects LUA_CREDENTIALS_PATH override in env (sessions/ is derived beside it)', async () => {
    const customDir = join(tmpDir, 'custom');
    mkdirSync(customDir);
    const customPath = join(customDir, 'creds');
    writeFileSync(customPath, 'lk_custom');
    expect(await resolveApiKey({ env: { LUA_CREDENTIALS_PATH: customPath }, cwd: tmpDir }))
      .toEqual({ key: 'lk_custom', source: 'credentials-file' });
  });

  test('uses defaults when no opts provided', async () => {
    // Should not throw — just returns whatever the real environment produces
    const result = await resolveApiKey();
    // Either resolved (any source) or null, both are valid
    expect(result === null || typeof result.source === 'string').toBeTruthy();
  });
});

describe('redactKey', () => {
  test('keeps last 4 chars', () => {
    expect(redactKey('lk_abcdefgh1234')).toBe('***********1234');
  });

  test('returns **** for null', () => {
    expect(redactKey(null)).toBe('****');
  });

  test('returns **** for undefined', () => {
    expect(redactKey(undefined)).toBe('****');
  });

  test('returns **** for empty string', () => {
    expect(redactKey('')).toBe('****');
  });

  test('returns **** for short string (<8 chars)', () => {
    expect(redactKey('lk_ab')).toBe('****');
    expect(redactKey('1234567')).toBe('****');
  });

  test('returns **** for non-string', () => {
    expect(redactKey(12345)).toBe('****');
    expect(redactKey({})).toBe('****');
  });

  test('handles long keys', () => {
    const long = 'lk_' + 'a'.repeat(60);
    expect(redactKey(long)).toBe('*'.repeat(59) + 'aaaa');
  });
});

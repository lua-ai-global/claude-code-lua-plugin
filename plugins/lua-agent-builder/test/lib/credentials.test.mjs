import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApiKey, redactKey } from '../../lib/credentials.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'creds-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveApiKey', () => {
  test('returns env-source when LUA_API_KEY is set', async () => {
    const result = await resolveApiKey({
      env: { LUA_API_KEY: 'lk_from_env' },
      credentialsPath: join(tmpDir, 'nonexistent'),
      cwd: tmpDir,
    });
    expect(result).toEqual({ key: 'lk_from_env', source: 'env' });
  });

  test('env wins over credentials file', async () => {
    const credPath = join(tmpDir, 'credentials');
    writeFileSync(credPath, 'lk_from_file');
    const result = await resolveApiKey({
      env: { LUA_API_KEY: 'lk_from_env' },
      credentialsPath: credPath,
      cwd: tmpDir,
    });
    expect(result.source).toBe('env');
  });

  // Iteration-13 audit: lua-cli writes the credentials file as PLAIN TEXT
  // (the bare API key, no JSON envelope) — verified against
  // packages/lua-cli/src/services/auth.ts:65-67. Earlier tests fed JSON
  // to the resolver, mirroring the bug exactly.
  test('reads plain-text credentials file when env is unset', async () => {
    const credPath = join(tmpDir, 'credentials');
    writeFileSync(credPath, 'lk_from_file\n');
    const result = await resolveApiKey({
      env: {},
      credentialsPath: credPath,
      cwd: tmpDir,
    });
    expect(result).toEqual({ key: 'lk_from_file', source: 'credentials-file' });
  });

  test('forward-compat: accepts JSON envelope { apiKey } if lua-cli ever switches', async () => {
    const credPath = join(tmpDir, 'credentials');
    writeFileSync(credPath, JSON.stringify({ apiKey: 'lk_from_envelope' }));
    const result = await resolveApiKey({
      env: {},
      credentialsPath: credPath,
      cwd: tmpDir,
    });
    expect(result).toEqual({ key: 'lk_from_envelope', source: 'credentials-file' });
  });

  test('treats a JSON-looking-but-malformed payload as plain text', async () => {
    const credPath = join(tmpDir, 'credentials');
    writeFileSync(credPath, '{not valid json');
    const result = await resolveApiKey({
      env: {},
      credentialsPath: credPath,
      cwd: tmpDir,
    });
    expect(result).toEqual({ key: '{not valid json', source: 'credentials-file' });
  });

  test('falls through if credentials file is empty', async () => {
    const credPath = join(tmpDir, 'credentials');
    writeFileSync(credPath, '   \n');
    const result = await resolveApiKey({
      env: {},
      credentialsPath: credPath,
      cwd: tmpDir,
    });
    expect(result).toBeNull();
  });

  test('reads .env file when credentials file is missing', async () => {
    writeFileSync(join(tmpDir, '.env'), 'OTHER=x\nLUA_API_KEY=lk_from_dotenv\nMORE=y\n');
    const result = await resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'nonexistent'),
      cwd: tmpDir,
    });
    expect(result).toEqual({ key: 'lk_from_dotenv', source: 'dotenv' });
  });

  test('trims whitespace from .env value', async () => {
    writeFileSync(join(tmpDir, '.env'), 'LUA_API_KEY=  lk_padded  \n');
    const result = await resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'nonexistent'),
      cwd: tmpDir,
    });
    expect(result.key).toBe('lk_padded');
  });

  test('returns null when no source has the key', async () => {
    const result = await resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'nonexistent'),
      cwd: tmpDir,
    });
    expect(result).toBeNull();
  });

  test('returns null when .env exists but has no LUA_API_KEY line', async () => {
    writeFileSync(join(tmpDir, '.env'), 'OTHER_KEY=x\n');
    const result = await resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'nonexistent'),
      cwd: tmpDir,
    });
    expect(result).toBeNull();
  });

  test('respects LUA_CREDENTIALS_PATH override in env', async () => {
    const customPath = join(tmpDir, 'custom-creds');
    writeFileSync(customPath, 'lk_custom');
    const result = await resolveApiKey({
      env: { LUA_CREDENTIALS_PATH: customPath },
      cwd: tmpDir,
    });
    expect(result).toEqual({ key: 'lk_custom', source: 'credentials-file' });
  });

  test('uses defaults when no opts provided', async () => {
    // Should not throw — just returns whatever the real environment produces
    const result = await resolveApiKey();
    // Either resolved or null, both are valid
    expect(result === null || (result.key && result.source)).toBeTruthy();
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

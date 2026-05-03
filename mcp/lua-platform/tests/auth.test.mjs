// Tests for the MCP server's resolveApiKey — must match the 3-tier chain
// in lib/credentials.mjs. Iteration-8 audit (2026-05-02) caught a missing
// .env fallback that diverged behaviour between MCP and slash commands.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApiKey } from '../src/auth.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-auth-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Tier 1: LUA_API_KEY env var', () => {
  test('returns key from env when set', async () => {
    const key = await resolveApiKey({
      env: { LUA_API_KEY: 'lk_from_env' },
      credentialsPath: join(tmpDir, 'nonexistent'),
      cwd: tmpDir,
    });
    expect(key).toBe('lk_from_env');
  });

  test('env wins over credentials file', async () => {
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file');
    const key = await resolveApiKey({
      env: { LUA_API_KEY: 'lk_from_env' },
      credentialsPath: join(tmpDir, 'credentials'),
      cwd: tmpDir,
    });
    expect(key).toBe('lk_from_env');
  });

  test('env wins over .env file', async () => {
    writeFileSync(join(tmpDir, '.env'), 'LUA_API_KEY=lk_from_dotenv\n');
    const key = await resolveApiKey({
      env: { LUA_API_KEY: 'lk_from_env' },
      credentialsPath: join(tmpDir, 'nonexistent'),
      cwd: tmpDir,
    });
    expect(key).toBe('lk_from_env');
  });
});

describe('Tier 2: ~/.lua-cli/credentials (plain text)', () => {
  // Iteration-13 audit: lua-cli writes the file as plain text — just the
  // bare API key, no JSON envelope (verified against
  // packages/lua-cli/src/services/auth.ts:65-67). The earlier JSON.parse
  // path threw on every real credentials file and silently fell through
  // to .env or MCP_AUTH_STALE.
  test('returns the trimmed API key from plain-text credentials when env unset', async () => {
    writeFileSync(join(tmpDir, 'credentials'), 'lk_from_file\n');
    const key = await resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'credentials'),
      cwd: tmpDir,
    });
    expect(key).toBe('lk_from_file');
  });

  test('forward-compat: accepts JSON envelope { apiKey } if lua-cli ever switches', async () => {
    writeFileSync(join(tmpDir, 'credentials'), JSON.stringify({ apiKey: 'lk_envelope' }));
    const key = await resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'credentials'),
      cwd: tmpDir,
    });
    expect(key).toBe('lk_envelope');
  });

  test('treats a JSON-looking-but-malformed payload as plain text', async () => {
    writeFileSync(join(tmpDir, 'credentials'), '{not valid json');
    const key = await resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'credentials'),
      cwd: tmpDir,
    });
    expect(key).toBe('{not valid json');
  });

  test('falls through to .env when credentials file is empty', async () => {
    writeFileSync(join(tmpDir, 'credentials'), '   \n');
    writeFileSync(join(tmpDir, '.env'), 'LUA_API_KEY=lk_from_dotenv\n');
    const key = await resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'credentials'),
      cwd: tmpDir,
    });
    expect(key).toBe('lk_from_dotenv');
  });

  test('respects LUA_CREDENTIALS_PATH env override', async () => {
    const customPath = join(tmpDir, 'custom-creds');
    writeFileSync(customPath, 'lk_custom');
    const key = await resolveApiKey({
      env: { LUA_CREDENTIALS_PATH: customPath },
      cwd: tmpDir,
    });
    expect(key).toBe('lk_custom');
  });
});

describe('Tier 3: .env file (regression test for iteration-8 fix)', () => {
  test('reads LUA_API_KEY from .env when env + credentials missing', async () => {
    writeFileSync(join(tmpDir, '.env'), 'OTHER=x\nLUA_API_KEY=lk_from_dotenv\nMORE=y\n');
    const key = await resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'nonexistent'),
      cwd: tmpDir,
    });
    expect(key).toBe('lk_from_dotenv');
  });

  test('trims whitespace from .env value', async () => {
    writeFileSync(join(tmpDir, '.env'), 'LUA_API_KEY=  lk_padded  \n');
    const key = await resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'nonexistent'),
      cwd: tmpDir,
    });
    expect(key).toBe('lk_padded');
  });

  test('throws when .env exists but has no LUA_API_KEY line', async () => {
    writeFileSync(join(tmpDir, '.env'), 'OTHER=x\n');
    await expect(resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'nonexistent'),
      cwd: tmpDir,
    })).rejects.toThrow(/MCP_AUTH_STALE/);
  });
});

describe('No source resolves', () => {
  test('throws MCP_AUTH_STALE with all three sources mentioned', async () => {
    await expect(resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'nonexistent'),
      cwd: tmpDir,
    })).rejects.toThrow(/MCP_AUTH_STALE/);
    await expect(resolveApiKey({
      env: {},
      credentialsPath: join(tmpDir, 'nonexistent'),
      cwd: tmpDir,
    })).rejects.toThrow(/env, ~\/\.lua-cli\/credentials, or \.env/);
  });
});

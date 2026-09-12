import { describe, test, expect } from '@jest/globals';
import { decide, AUTH_PROBE_ARGS } from '../../hooks/check-lua-auth.mjs';

const versionOK = { exitCode: 0, stdout: '3.33.0\n', stderr: '' };

describe('check-lua-auth decide()', () => {
  test('probes with the cheap authenticated catalog call, never `lua auth key` or the slow `lua agents`', () => {
    expect(AUTH_PROBE_ARGS).toEqual(['models', 'list', '--json', '--ci']);
  });

  test('returns null silently when authenticated (probe exits 0)', () => {
    expect(decide(versionOK, { exitCode: 0, stdout: '{"models":[]}', stderr: '' })).toBeNull();
  });

  test('treats exit 10 (scoped typed key, forbidden on the catalog route) as authenticated', () => {
    expect(decide(versionOK, { exitCode: 10, stdout: '', stderr: '✖ forbidden' })).toBeNull();
  });

  test('warns and recommends /lua-auth on lua-cli exit 9 (auth class)', () => {
    const result = decide(versionOK, { exitCode: 9, stdout: '', stderr: '✖ auth: Authentication failed.' });
    expect(result?.warn).toContain('not authenticated');
    expect(result?.warn).toContain('/lua-auth');
    expect(result?.warn).not.toContain('exited 9');
  });

  test('warns (naming the exit code) on an unexpected non-zero exit', () => {
    const result = decide(versionOK, { exitCode: 1, stdout: '', stderr: 'boom' });
    expect(result?.warn).toContain('not authenticated');
    expect(result?.warn).toContain('exited 1');
    expect(result?.warn).toContain('/lua-auth');
  });

  // If lua-cli isn't installed, check-lua-version already warned the user.
  // check-lua-auth must NOT double-warn.
  test('returns null silently when lua-cli is not installed (avoids double-warn)', () => {
    const versionMissing = { exitCode: -1, stdout: '', stderr: 'ENOENT' };
    expect(decide(versionMissing, { exitCode: -1, stdout: '', stderr: 'ENOENT' })).toBeNull();
  });

  // Live E2E 2026-09-12: a slow probe told an authenticated user they were
  // signed out. A timeout must read as "could not confirm", never as
  // "not authenticated".
  test('a timed-out probe is reported as unconfirmed, pointing at /lua-status, not /lua-auth', () => {
    for (const authTimeout of [
      { exitCode: null, stdout: '', stderr: '', timedOut: true, classification: 'STUCK_COMMAND' },
      { exitCode: null, stdout: '', stderr: 'timed out' },
    ]) {
      const result = decide(versionOK, authTimeout);
      expect(result?.warn).toContain('Could not confirm');
      expect(result?.warn).toContain('/lua-status');
      expect(result?.warn).not.toContain('not authenticated');
    }
  });

  test('lua-cli exit 11 (API unavailable) is a reachability note, not an auth warning', () => {
    const result = decide(versionOK, { exitCode: 11, stdout: '', stderr: '✖ unavailable: …' });
    expect(result?.warn).toContain('could not be reached');
    expect(result?.warn).toContain('/lua-status');
    expect(result?.warn).not.toContain('not authenticated');
  });

  test('warning keeps the new login outside the conversation', () => {
    const result = decide(versionOK, { exitCode: 9, stdout: '', stderr: '' });
    expect(result?.warn).toContain('typed credential');
    expect(result?.warn).toContain('private terminal');
    expect(result?.warn).not.toMatch(/paste.*key/i);
  });

  test('warning explains the user-visible consequence', () => {
    const result = decide(versionOK, { exitCode: 9, stdout: '', stderr: '' });
    expect(result?.warn).toMatch(/will fail|won't work|every|until/i);
  });
});

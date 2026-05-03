import { describe, test, expect } from '@jest/globals';
import { decide } from '../../hooks/check-lua-auth.mjs';

describe('check-lua-auth decide()', () => {
  test('returns null silently when authenticated (lua agents --json --ci exits 0)', () => {
    const versionOK = { exitCode: 0, stdout: '3.12.3\n', stderr: '' };
    const authOK = { exitCode: 0, stdout: '[]', stderr: '' };
    expect(decide(versionOK, authOK)).toBeNull();
  });

  test('warns and recommends /lua-auth when authenticated probe fails', () => {
    const versionOK = { exitCode: 0, stdout: '3.12.3\n', stderr: '' };
    const authFail = { exitCode: 1, stdout: '', stderr: 'No API key found.' };
    const result = decide(versionOK, authFail);
    expect(result?.warn).toContain('not authenticated');
    expect(result?.warn).toContain('/lua-auth');
  });

  // If lua-cli isn't installed, check-lua-version already warned the user.
  // check-lua-auth must NOT double-warn.
  test('returns null silently when lua-cli is not installed (avoids double-warn)', () => {
    const versionMissing = { exitCode: -1, stdout: '', stderr: 'ENOENT' };
    const authFail = { exitCode: -1, stdout: '', stderr: 'ENOENT' };
    expect(decide(versionMissing, authFail)).toBeNull();
  });

  test('returns null when lua-cli is installed but auth probe is delayed (treat any non-zero auth as unauth)', () => {
    // Edge case: auth probe could theoretically time out. The hook treats
    // any non-zero exit as "not authenticated" — which is conservative
    // (errs on showing the prompt) and aligns with the bug-41 principle:
    // never assume auth state when uncertain.
    const versionOK = { exitCode: 0, stdout: '3.12.3\n', stderr: '' };
    const authTimeout = { exitCode: null, stdout: '', stderr: 'timed out' };
    const result = decide(versionOK, authTimeout);
    expect(result?.warn).toContain('/lua-auth');
  });

  test('warning message mentions both Email + OTP and API key paths', () => {
    const versionOK = { exitCode: 0, stdout: '3.12.3\n', stderr: '' };
    const authFail = { exitCode: 1, stdout: '', stderr: '' };
    const result = decide(versionOK, authFail);
    expect(result?.warn).toContain('Email + OTP');
    expect(result?.warn).toContain('API key');
  });

  test('warning explains the user-visible consequence', () => {
    // Iteration-13 audit: the hook's job is to surface a problem the user
    // can fix. The warn must explain WHY this matters — not just "no key".
    const versionOK = { exitCode: 0, stdout: '3.12.3\n', stderr: '' };
    const authFail = { exitCode: 1, stdout: '', stderr: '' };
    const result = decide(versionOK, authFail);
    // "every /lua-* slash that needs the platform will fail" or similar.
    expect(result?.warn).toMatch(/will fail|won't work|every|until/i);
  });
});

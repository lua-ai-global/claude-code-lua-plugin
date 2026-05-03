import { describe, test, expect } from '@jest/globals';
import {
  decide,
  parseSemver,
  compareSemver,
  PINNED_MIN_LUA_CLI,
} from '../../hooks/check-lua-version.mjs';

describe('parseSemver', () => {
  test.each([
    ['3.13.0', [3, 13, 0]],
    ['3.13.0\n', [3, 13, 0]],
    ['  4.2.5  ', [4, 2, 5]],
    ['3.13.0-beta.1', [3, 13, 0]],   // ignores prerelease suffix
    ['10.20.30', [10, 20, 30]],
  ])('parses %s', (input, expected) => {
    expect(parseSemver(input)).toEqual(expected);
  });

  test.each(['', 'foo', 'v3.13', '3.13', 'lua-cli 3.13.0'])('returns null on %s', (input) => {
    expect(parseSemver(input)).toBeNull();
  });
});

describe('compareSemver', () => {
  test('equal versions', () => {
    expect(compareSemver([3, 13, 0], [3, 13, 0])).toBe(0);
  });

  test('lower major', () => {
    expect(compareSemver([2, 99, 99], [3, 0, 0])).toBe(-1);
  });

  test('higher major', () => {
    expect(compareSemver([4, 0, 0], [3, 99, 99])).toBe(1);
  });

  test('minor differences', () => {
    expect(compareSemver([3, 12, 9], [3, 13, 0])).toBe(-1);
    expect(compareSemver([3, 14, 0], [3, 13, 99])).toBe(1);
  });

  test('patch differences', () => {
    expect(compareSemver([3, 13, 0], [3, 13, 1])).toBe(-1);
    expect(compareSemver([3, 13, 5], [3, 13, 4])).toBe(1);
  });
});

describe('check-lua-version decide()', () => {
  test('allows silently when version equals pinned minimum', () => {
    expect(decide({ exitCode: 0, stdout: PINNED_MIN_LUA_CLI })).toBeNull();
  });

  test('allows silently when version is newer', () => {
    expect(decide({ exitCode: 0, stdout: '4.0.0\n' })).toBeNull();
  });

  test('warns when version is older than minimum', () => {
    // Pick a version one minor below the pin so the assertion stays
    // accurate as the pin moves over time.
    const [major, minor] = PINNED_MIN_LUA_CLI.split('.').map(Number);
    const tooOld = `${major}.${Math.max(0, minor - 1)}.0`;
    const result = decide({ exitCode: 0, stdout: `${tooOld}\n` });
    expect(result?.warn).toContain(`requires lua-cli ≥${PINNED_MIN_LUA_CLI}`);
    expect(result?.warn).toContain(`you have ${tooOld}`);
    expect(result?.warn).toContain('/lua-update');
  });

  test('warns when lua --version exits non-zero', () => {
    const result = decide({ exitCode: 1, stdout: '' });
    expect(result?.warn).toContain('Could not detect lua-cli version');
    expect(result?.warn).toContain('/lua-doctor');
  });

  test('warns when output is unparseable', () => {
    const result = decide({ exitCode: 0, stdout: 'not a version\n' });
    expect(result?.warn).toContain("Couldn't parse");
    expect(result?.warn).toContain('/lua-doctor');
  });
});

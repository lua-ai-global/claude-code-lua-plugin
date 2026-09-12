import { describe, test, expect } from '@jest/globals';
import { decide } from '../../hooks/warn-version-zero.mjs';

describe('warn-version-zero decide()', () => {
  test('warns on lua push --set-version 0.x.y', () => {
    const result = decide({ tool_input: { command: 'lua push skill --set-version 0.1.0 --force' } });
    expect(result?.warn).toContain('0.x.y');
    expect(result?.warn).toContain('1.x.y');
  });

  test('warns on 0.0.1', () => {
    expect(decide({ tool_input: { command: 'lua push all --set-version 0.0.1' } })?.warn).toBeTruthy();
  });

  test('does not warn on 1.x.y', () => {
    expect(decide({ tool_input: { command: 'lua push skill --set-version 1.0.0' } })).toBeNull();
  });

  test('does not warn on 2.0.0', () => {
    expect(decide({ tool_input: { command: 'lua push skill --set-version 2.0.0' } })).toBeNull();
  });

  test('does not warn on commands other than push', () => {
    expect(decide({ tool_input: { command: 'lua deploy skill --set-version 0.1.0' } })).toBeNull();
  });

  test('does not fire when --set-version is absent', () => {
    expect(decide({ tool_input: { command: 'lua push skill --force' } })).toBeNull();
  });

  test('handles missing input gracefully', () => {
    expect(decide(null)).toBeNull();
    expect(decide({})).toBeNull();
  });

  test('handles leading whitespace', () => {
    expect(decide({ tool_input: { command: '   lua push --set-version 0.5.0' } })?.warn).toBeTruthy();
  });

  // Architect review F2: the old message claimed "deploy picks the highest
  // semver". lua-cli's deploy.ts sortVersionsByDate picks the most recently
  // CREATED version for `--set-version latest`, so the warning must say that.
  test('states the real lua-cli semantics: latest = most recently created, not highest semver', () => {
    const warn = decide({ tool_input: { command: 'lua push skill --set-version 0.1.0 --force' } })?.warn ?? '';
    expect(warn).toMatch(/most recently CREATED/);
    expect(warn).toMatch(/not the highest semver/);
    expect(warn).not.toMatch(/pre-release/i);
  });

  test('also fires for the alternative binaries', () => {
    expect(decide({ tool_input: { command: 'heylua push all --set-version 0.2.0 --force' } })?.warn).toBeTruthy();
    expect(decide({ tool_input: { command: 'lua-ai push skill --set-version 0.2.0' } })?.warn).toBeTruthy();
  });
});

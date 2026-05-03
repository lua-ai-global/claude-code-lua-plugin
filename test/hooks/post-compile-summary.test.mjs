import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide } from '../../hooks/post-compile-summary.mjs';

let tmpDir;
const MANIFEST = ['dist-v2', 'manifest.json'];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'compile-test-'));
  mkdirSync(join(tmpDir, 'dist-v2'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Iteration-13 audit: lua-cli writes the manifest at dist-v2/manifest.json
// (verified against packages/lua-cli/src/commands/compile.ts:82). The agent
// is itself a primitive entry with kind: 'agent' and is excluded from the
// user-facing count. There is no `warnings` field in the persisted manifest.
describe('post-compile-summary decide()', () => {
  test('prints summary with non-agent primitive count', () => {
    writeFileSync(
      join(tmpDir, ...MANIFEST),
      JSON.stringify({ primitives: [
        { kind: 'agent' },
        { kind: 'skill' },
        { kind: 'webhook' },
        { kind: 'job' },
      ] })
    );
    const result = decide(
      { tool_input: { command: 'lua compile --ci' } },
      { cwd: tmpDir }
    );
    expect(result?.warn).toBe('✓ Compiled 3 primitive(s).');
  });

  test('counts zero when only the agent primitive is present', () => {
    writeFileSync(
      join(tmpDir, ...MANIFEST),
      JSON.stringify({ primitives: [{ kind: 'agent' }] })
    );
    const result = decide(
      { tool_input: { command: 'lua compile' } },
      { cwd: tmpDir }
    );
    expect(result?.warn).toContain('0 primitive(s)');
  });

  test('returns null when not a compile command', () => {
    const result = decide({ tool_input: { command: 'lua test --ci' } }, { cwd: tmpDir });
    expect(result).toBeNull();
  });

  test('returns null when tool_response.success is false', () => {
    writeFileSync(
      join(tmpDir, ...MANIFEST),
      JSON.stringify({ primitives: [{ kind: 'skill' }] })
    );
    const result = decide(
      { tool_input: { command: 'lua compile' }, tool_response: { success: false } },
      { cwd: tmpDir }
    );
    expect(result).toBeNull();
  });

  test('returns null when manifest is missing', () => {
    const result = decide({ tool_input: { command: 'lua compile' } }, { cwd: tmpDir });
    expect(result).toBeNull();
  });

  test('returns null when manifest is malformed', () => {
    writeFileSync(join(tmpDir, ...MANIFEST), 'not json');
    const result = decide({ tool_input: { command: 'lua compile' } }, { cwd: tmpDir });
    expect(result).toBeNull();
  });

  test('handles manifest with no primitives field', () => {
    writeFileSync(join(tmpDir, ...MANIFEST), JSON.stringify({}));
    const result = decide({ tool_input: { command: 'lua compile' } }, { cwd: tmpDir });
    expect(result?.warn).toContain('0 primitive(s)');
  });

  test('handles missing input', () => {
    expect(decide(null, { cwd: tmpDir })).toBeNull();
  });

  test('uses process.cwd() when cwd not injected', () => {
    const result = decide({ tool_input: { command: 'lua compile' } });
    expect(result === null || (result && typeof result.warn === 'string')).toBe(true);
  });

  // Iteration-13 audit: hooks must prefer input.cwd (the Claude Code hook
  // payload field) over process.cwd() so the manifest is found relative to
  // the user's actual CWD, not Claude Code's startup CWD.
  test('prefers input.cwd over process.cwd() to locate the manifest', () => {
    writeFileSync(
      join(tmpDir, ...MANIFEST),
      JSON.stringify({ primitives: [{ kind: 'agent' }, { kind: 'skill' }] })
    );
    // Pass NO opts.cwd, but pass input.cwd — should resolve to tmpDir.
    const result = decide(
      { tool_input: { command: 'lua compile --ci' }, cwd: tmpDir }
    );
    expect(result?.warn).toBe('✓ Compiled 1 primitive(s).');
  });

  test('opts.cwd takes precedence over input.cwd (test-injection contract)', () => {
    writeFileSync(
      join(tmpDir, ...MANIFEST),
      JSON.stringify({ primitives: [{ kind: 'skill' }] })
    );
    const result = decide(
      { tool_input: { command: 'lua compile --ci' }, cwd: '/nonexistent' },
      { cwd: tmpDir }
    );
    expect(result?.warn).toContain('1 primitive(s)');
  });
});

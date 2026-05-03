import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide } from '../../hooks/inject-context.mjs';

let tmpDir;

const CONFIG = 'lua.skill.yaml';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'inject-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Iteration-13 audit: real lua-cli writes lua.skill.yaml at project root
// with nested `agent:` block — the previous test fixtures used a fictional
// `.lua/lua.config.yaml` with top-level `agentName:`/`model:` that don't
// exist in the real schema. These tests now mirror lua-cli's actual output.
describe('inject-context decide()', () => {
  test('returns null when no lua.skill.yaml exists', () => {
    expect(decide(null, { cwd: tmpDir })).toBeNull();
  });

  test('injects agent and org IDs from nested agent: block', () => {
    writeFileSync(join(tmpDir, CONFIG), [
      'agent:',
      '  agentId: "shopify_66564128837"',
      '  orgId: "org_acme"',
      '',
      'skills: []',
      '',
    ].join('\n'));
    const result = decide(null, { cwd: tmpDir });
    expect(result?.warn).toContain('[lua] agent: shopify_66564128837');
    expect(result?.warn).toContain('[lua] org:   org_acme');
  });

  test('injects agent only when orgId is missing', () => {
    writeFileSync(join(tmpDir, CONFIG), 'agent:\n  agentId: solo-bot\n');
    const result = decide(null, { cwd: tmpDir });
    expect(result?.warn).toContain('[lua] agent: solo-bot');
    expect(result?.warn).not.toContain('[lua] org:');
  });

  test('returns null when agentId is missing', () => {
    writeFileSync(join(tmpDir, CONFIG), 'agent:\n  orgId: "no-agent-here"\n');
    expect(decide(null, { cwd: tmpDir })).toBeNull();
  });

  test('handles unquoted values', () => {
    writeFileSync(join(tmpDir, CONFIG), 'agent:\n  agentId: bareword-id\n');
    const result = decide(null, { cwd: tmpDir });
    expect(result?.warn).toContain('[lua] agent: bareword-id');
  });

  test('does NOT match per-primitive ID fields (e.g. skillId)', () => {
    // Skills/webhooks/jobs each carry their own *Id fields that must NOT
    // be confused with agentId. The hook's regex anchors to `agentId:`.
    writeFileSync(join(tmpDir, CONFIG), [
      'agent:',
      '  agentId: real-agent',
      'skills:',
      '  - name: weather',
      '    skillId: not-an-agent',
      '',
    ].join('\n'));
    const result = decide(null, { cwd: tmpDir });
    expect(result?.warn).toContain('[lua] agent: real-agent');
    expect(result?.warn).not.toContain('not-an-agent');
  });

  test('uses process.cwd() when cwd not injected', () => {
    const result = decide(null);
    expect(result === null || (result && typeof result.warn === 'string')).toBe(true);
  });

  // Iteration-13 audit: hooks must prefer the cwd in the Claude Code hook
  // payload — process.cwd() is Claude Code's startup CWD, not the user's
  // actual command CWD when the project lives elsewhere.
  test('prefers input.cwd (the Claude Code hook payload) over process.cwd()', () => {
    writeFileSync(join(tmpDir, CONFIG), 'agent:\n  agentId: from-input-cwd\n');
    // Pass NO opts.cwd, but pass input.cwd — should use input.cwd.
    const result = decide({ cwd: tmpDir });
    expect(result?.warn).toContain('from-input-cwd');
  });

  test('opts.cwd takes precedence over input.cwd (test-injection contract)', () => {
    writeFileSync(join(tmpDir, CONFIG), 'agent:\n  agentId: from-opts-cwd\n');
    // input.cwd points at a fictional path; opts.cwd should win.
    const result = decide({ cwd: '/nonexistent' }, { cwd: tmpDir });
    expect(result?.warn).toContain('from-opts-cwd');
  });
});

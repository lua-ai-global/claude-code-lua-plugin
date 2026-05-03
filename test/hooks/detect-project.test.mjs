import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide } from '../../hooks/detect-project.mjs';

let tmpDir;
const CONFIG = 'lua.skill.yaml';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lua-plugin-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Iteration-13 audit: real lua-cli writes lua.skill.yaml at project root
// with a nested `agent.agentId` field (verified against
// packages/lua-cli/src/utils/files.ts and yaml.types.ts). Earlier fixtures
// used a fictional `.lua/lua.config.yaml` with top-level `agentName:` —
// neither matched reality, so the hook produced nothing for real projects.
describe('detect-project decide()', () => {
  test('returns null when no lua.skill.yaml exists', () => {
    const result = decide(null, { cwd: tmpDir });
    expect(result).toBeNull();
  });

  test('warns with the agentId when present', () => {
    writeFileSync(join(tmpDir, CONFIG), 'agent:\n  agentId: my-bot\n');
    const result = decide(null, { cwd: tmpDir });
    expect(result?.warn).toContain('Lua agent project detected: my-bot');
    expect(result?.warn).toContain('/lua-doctor');
  });

  test('handles double-quoted agentId', () => {
    writeFileSync(join(tmpDir, CONFIG), 'agent:\n  agentId: "Quoted Bot"\n');
    const result = decide(null, { cwd: tmpDir });
    expect(result?.warn).toContain('Quoted Bot');
  });

  test('handles single-quoted agentId', () => {
    writeFileSync(join(tmpDir, CONFIG), "agent:\n  agentId: 'Single Quoted'\n");
    const result = decide(null, { cwd: tmpDir });
    expect(result?.warn).toContain('Single Quoted');
  });

  test('returns generic warn when config exists but has no agentId', () => {
    writeFileSync(join(tmpDir, CONFIG), 'agent:\n  orgId: org_only\n');
    const result = decide(null, { cwd: tmpDir });
    expect(result?.warn).toBe('✓ Lua agent project detected. Run /lua-doctor or /lua-test to begin.');
  });

  test('does NOT match per-primitive ID fields (e.g. webhookId)', () => {
    writeFileSync(join(tmpDir, CONFIG), [
      'agent:',
      '  agentId: real-agent',
      'webhooks:',
      '  - name: pay',
      '    webhookId: hook-id',
      '',
    ].join('\n'));
    const result = decide(null, { cwd: tmpDir });
    expect(result?.warn).toContain('real-agent');
    expect(result?.warn).not.toContain('hook-id');
  });

  test('uses process.cwd() when cwd not injected', () => {
    const result = decide(null);
    expect(result === null || (result && typeof result.warn === 'string')).toBe(true);
  });

  // Iteration-13 audit: prefer the cwd in the Claude Code hook payload.
  test('prefers input.cwd (Claude Code hook payload) over process.cwd()', () => {
    writeFileSync(join(tmpDir, CONFIG), 'agent:\n  agentId: from-input-cwd\n');
    const result = decide({ cwd: tmpDir });
    expect(result?.warn).toContain('from-input-cwd');
  });

  test('opts.cwd takes precedence over input.cwd (test-injection contract)', () => {
    writeFileSync(join(tmpDir, CONFIG), 'agent:\n  agentId: from-opts-cwd\n');
    const result = decide({ cwd: '/nonexistent' }, { cwd: tmpDir });
    expect(result?.warn).toContain('from-opts-cwd');
  });
});

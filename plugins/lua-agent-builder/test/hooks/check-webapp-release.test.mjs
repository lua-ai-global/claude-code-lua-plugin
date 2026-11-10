// 1.20.5 — the static web-app check before stage_for_test / request_release (warn only, session only).

import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allAgentsNote, decide } from '../../hooks/check-webapp-release.mjs';
import { runHook } from '../helpers/run-hook.mjs';

const SESSION = { LUA_BUILD_SESSION: '1' };
const STAGE = 'mcp__lua-session__stage_for_test';
const RELEASE = 'mcp__lua-session__request_release';
const ONE = [{ rule: 'tabs-width', file: 'src/apps/desk/web/src/App.tsx', line: 3, message: 'a <TabsList> is `inline-flex w-fit`' }];

describe('decide', () => {
  test('warns before stage_for_test and request_release in a session', () => {
    const stage = decide({ tool_name: STAGE, cwd: '/w' }, SESSION, () => ONE);
    expect(stage.warn).toContain('Fix these before you request a release');
    expect(stage.warn).toContain('src/apps/desk/web/src/App.tsx:3 [tabs-width]');
    expect(stage.block).toBeUndefined();
    const release = decide({ tool_name: RELEASE, cwd: '/w' }, SESSION, () => ONE);
    expect(release.warn).toContain('before this release');
    expect(release.warn).toContain('Never say the page fits a phone');
  });

  test('passes the hook cwd to the check, else the process cwd', () => {
    const seen = [];
    decide({ tool_name: STAGE, cwd: '/workspace/fleet/a' }, SESSION, (cwd) => (seen.push(cwd), []));
    decide({ tool_name: STAGE }, SESSION, (cwd) => (seen.push(cwd), []));
    expect(seen).toEqual(['/workspace/fleet/a', process.cwd()]);
  });

  test('says nothing with no findings, outside a session, or for other tools', () => {
    expect(decide({ tool_name: STAGE, cwd: '/w' }, SESSION, () => [])).toBeNull();
    expect(decide({ tool_name: STAGE, cwd: '/w' }, { LUA_BUILD_SESSION: '' }, () => ONE)).toBeNull();
    expect(decide({ tool_name: 'mcp__lua-session__test_chat', cwd: '/w' }, SESSION, () => ONE)).toBeNull();
    expect(decide({ tool_name: 'Bash', cwd: '/w' }, SESSION, () => ONE)).toBeNull();
    expect(decide(null, SESSION, () => ONE)).toBeNull();
  });

  test('defaults: the process env and the real check', () => {
    const empty = mkdtempSync(join(tmpdir(), 'lua-webapp-empty-'));
    try {
      expect(decide({ tool_name: STAGE, cwd: empty }, SESSION)).toBeNull();
      expect(decide({ tool_name: 'Bash' })).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('fleet speed note (1.20.8, build-session.md §2a)', () => {
  const two = () => ['/w/a', '/w/b'];
  test('a fleet call with no agentIds names the cost; with agentIds or one agent it says nothing', () => {
    const stage = decide({ tool_name: STAGE, cwd: '/w', tool_input: {} }, SESSION, () => [], two);
    expect(stage.warn).toContain('restages every editable agent');
    expect(stage.warn).toContain('2 agent folders');
    const release = decide({ tool_name: RELEASE, cwd: '/w', tool_input: { summary: 's' } }, SESSION, () => [], two);
    expect(release.warn).toContain('compile, npm test, push');
    expect(release.warn).toContain('since the last release');
    expect(decide({ tool_name: STAGE, cwd: '/w', tool_input: { agentIds: ['a'] } }, SESSION, () => [], two)).toBeNull();
    expect(decide({ tool_name: STAGE, cwd: '/w', tool_input: {} }, SESSION, () => [], () => ['/w'])).toBeNull();
  });
  test('joins with the web-app findings; an empty agentIds list counts as none', () => {
    const both = decide({ tool_name: STAGE, cwd: '/w', tool_input: { agentIds: [] } }, SESSION, () => ONE, two);
    expect(both.warn).toContain('[tabs-width]');
    expect(both.warn).toContain('[lua] Speed');
    expect(allAgentsNote(undefined, 3, 'stage')).toContain('3 agent folders');
    expect(allAgentsNote(null, 1, 'release')).toBeNull();
  });
});

describe('hooks.json', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const doc = JSON.parse(readFileSync(join(here, '..', '..', 'hooks', 'hooks.json'), 'utf8'));
  test('runs on the two session tools, with no `if` filter', () => {
    const entry = doc.hooks.PreToolUse.find((m) => m.hooks.some((h) => h.command.endsWith('/hooks/check-webapp-release.mjs')));
    expect(entry.matcher).toBe(`${STAGE}|${RELEASE}`);
    expect(entry.hooks[0].if).toBeUndefined();
  });
});

describe('script entry point (spawned)', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lua-webapp-hook-'));
    const web = join(dir, 'src', 'apps', 'desk', 'web');
    mkdirSync(join(web, 'src'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<html><head></head></html>');
    writeFileSync(join(web, 'src', 'App.tsx'), "import { Toaster } from '@lua-ai-global/ui/sonner';\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('PreToolUse context in a session, never a block', async () => {
    const r = await runHook('check-webapp-release.mjs', { tool_name: RELEASE, cwd: dir }, { env: SESSION });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('[csp-toast]');
    expect(out.hookSpecificOutput.additionalContext).toContain('[viewport]');
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test('nothing outside a session', async () => {
    const r = await runHook('check-webapp-release.mjs', { tool_name: RELEASE, cwd: dir }, { env: { LUA_BUILD_SESSION: '' } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });
});

// EM-WS8 (1.6.0): LUA_PLUGIN_HEADLESS=1 — the hooks in an unattended run
// (`claude -p` in the Lua Job tier). Two invariants:
//   1. no message a hook injects or returns points at a slash command — the
//      slashes need AskUserQuestion or the Agent tool, unavailable headless;
//   2. nothing that is blocked interactively is allowed headless, and the
//      LUA_DEPLOY_CONFIRMED=1 prefix is void (the model would confirm to itself).

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isHeadless, HEADLESS_NOTE } from '../../lib/headless.mjs';
import { decide as confirmDeploy } from '../../hooks/confirm-deploy.mjs';
import { decide as blockAutoDeploy } from '../../hooks/block-auto-deploy.mjs';
import { decide as checkAuth } from '../../hooks/check-lua-auth.mjs';
import { decide as checkVersion, PINNED_MIN_LUA_CLI } from '../../hooks/check-lua-version.mjs';
import { decide as detectProject } from '../../hooks/detect-project.mjs';
import { decide as postDeploySmoke } from '../../hooks/post-deploy-smoke.mjs';
import { runHook } from '../helpers/run-hook.mjs';

const HEADLESS = { LUA_PLUGIN_HEADLESS: '1' };
const INTERACTIVE = {};
const SLASH = /\/lua-[a-z]/;
const versionOK = { exitCode: 0, stdout: `${PINNED_MIN_LUA_CLI}\n`, stderr: '' };

describe('isHeadless()', () => {
  test.each([
    ['1', true], ['true', true], ['TRUE', true], [' yes ', true], ['on', true],
    ['0', false], ['false', false], ['', false], [undefined, false], ['headless', false],
  ])('LUA_PLUGIN_HEADLESS=%p → %p', (value, expected) => {
    expect(isHeadless({ LUA_PLUGIN_HEADLESS: value })).toBe(expected);
  });

  test('defaults to process.env and tolerates a missing env', () => {
    expect(typeof isHeadless()).toBe('boolean');
    expect(isHeadless(undefined)).toBe(isHeadless(process.env));
    expect(isHeadless(null)).toBe(false);
  });

  test('the shared note names no slash command', () => {
    expect(HEADLESS_NOTE).not.toMatch(SLASH);
  });
});

describe('check-lua-auth headless: a neutral note, never "run /lua-auth"', () => {
  test.each([
    [{ exitCode: 9, stdout: '', stderr: '✖ auth' }, 'exited 9'],
    [{ exitCode: 1, stdout: '', stderr: 'boom' }, 'exited 1'],
    [{ exitCode: 11, stdout: '', stderr: '✖ unavailable' }, 'exited 11'],
    [{ exitCode: 403, stdout: '', stderr: 'proxy: route not allowed' }, 'exited 403'],
    [{ exitCode: null, stdout: '', stderr: '', timedOut: true }, 'did not answer'],
  ])('%p', (authResult, outcome) => {
    const result = checkAuth(versionOK, authResult, HEADLESS);
    expect(result?.warn).toContain('could not be confirmed');
    expect(result?.warn).toContain(outcome);
    expect(result?.warn).toContain('proxy');
    expect(result?.warn).not.toMatch(SLASH);
    expect(result?.warn).not.toContain('not authenticated');
  });

  test('success stays silent headless too', () => {
    expect(checkAuth(versionOK, { exitCode: 0, stdout: '{}', stderr: '' }, HEADLESS)).toBeNull();
    expect(checkAuth(versionOK, { exitCode: 10, stdout: '', stderr: '' }, HEADLESS)).toBeNull();
    expect(checkAuth({ exitCode: -1, stdout: '', stderr: '' }, { exitCode: -1 }, HEADLESS)).toBeNull();
  });

  test('interactive keeps recommending /lua-auth', () => {
    expect(checkAuth(versionOK, { exitCode: 9, stdout: '', stderr: '' }, INTERACTIVE)?.warn).toContain('/lua-auth');
  });
});

describe('check-lua-version headless: same findings, no /lua-doctor, /lua-update or npm install', () => {
  test.each([
    [{ exitCode: -1, stdout: '', stderr: 'ENOENT' }, 'Could not detect lua-cli'],
    [{ exitCode: 0, stdout: 'garbage', stderr: '' }, "Couldn't parse"],
    [{ exitCode: 0, stdout: '1.0.0', stderr: '' }, 'older than'],
  ])('%p', (versionResult, finding) => {
    const warn = checkVersion(versionResult, HEADLESS)?.warn;
    expect(warn).toContain(finding);
    expect(warn).not.toMatch(SLASH);
    expect(warn).not.toContain('npm i');
    expect(warn).toContain('headless');
  });

  test('interactive text is unchanged', () => {
    expect(checkVersion({ exitCode: -1, stdout: '' }, INTERACTIVE)?.warn).toBe('Could not detect lua-cli version. Run /lua-doctor to install.');
    expect(checkVersion({ exitCode: 0, stdout: 'garbage' }, INTERACTIVE)?.warn).toContain('Run /lua-doctor.');
    expect(checkVersion({ exitCode: 0, stdout: '1.0.0' }, INTERACTIVE)?.warn).toContain('/lua-update');
    expect(checkVersion(versionOK, HEADLESS)).toBeNull();
  });
});

describe('detect-project headless', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lua-headless-'));
    writeFileSync(join(dir, 'lua.skill.yaml'), 'agent:\n  agentId: agent_123\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('reports the project without pointing at /lua-doctor', () => {
    expect(detectProject(null, { cwd: dir, env: HEADLESS })).toEqual({ warn: '✓ Lua agent project detected: agent_123.' });
  });

  test('interactive keeps the pointer', () => {
    expect(detectProject(null, { cwd: dir, env: INTERACTIVE })?.warn).toContain('/lua-doctor');
  });
});

describe('confirm-deploy headless: every production verb blocked, the prefix is void', () => {
  test.each([
    'lua deploy all --force',
    'LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --name x --set-version latest --force',
    'env LUA_DEPLOY_CONFIRMED=1 lua version promote 3',
    'LUA_DEPLOY_CONFIRMED=1 lua marketplace template apply --template-id t --all-installed --force',
    'cd x && npx lua-cli workflows activate outreach',
  ])('%s', (command) => {
    const result = confirmDeploy({ tool_input: { command } }, HEADLESS);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('DEPLOY_DENIED_HEADLESS');
    expect(result?.reason).not.toMatch(SLASH);
  });

  test('the same prefixed command is allowed interactively', () => {
    expect(confirmDeploy({ tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua version promote 3' } }, INTERACTIVE)).toBeNull();
  });

  test('--auto-deploy is blocked headless without a slash pointer', () => {
    const result = confirmDeploy({ tool_input: { command: 'lua push skill --ci --force --auto-deploy' } }, HEADLESS);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('DEPLOY_DENIED_AUTO');
    expect(result?.reason).not.toMatch(SLASH);
  });

  test('non-production commands pass headless', () => {
    for (const command of ['lua push all --ci --force', 'lua version create --ci -m "x"', 'lua compile --ci', 'git status']) {
      expect(confirmDeploy({ tool_input: { command } }, HEADLESS)).toBeNull();
    }
  });

  test('spawned with LUA_PLUGIN_HEADLESS=1, a prefixed deploy exits 2', async () => {
    const result = await runHook(
      'confirm-deploy.mjs',
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --force' } },
      { env: HEADLESS },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('DEPLOY_DENIED_HEADLESS');
  });
});

describe('block-auto-deploy headless', () => {
  test('still blocks, names no slash', () => {
    const result = blockAutoDeploy({ tool_input: { command: 'lua push all --auto-deploy' } }, HEADLESS);
    expect(result?.block).toBe(true);
    expect(result?.reason).not.toMatch(SLASH);
  });

  test('interactive keeps /lua-deploy', () => {
    expect(blockAutoDeploy({ tool_input: { command: 'lua push all --auto-deploy' } }, INTERACTIVE)?.reason).toContain('/lua-deploy');
  });
});

describe('post-deploy-smoke headless', () => {
  test('never spawns the production ping', async () => {
    const spawnLuaFn = async () => { throw new Error('must not spawn headless'); };
    await expect(postDeploySmoke(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua version promote 3' }, tool_response: { success: true } },
      { spawnLuaFn, env: HEADLESS },
    )).resolves.toBeNull();
  });
});

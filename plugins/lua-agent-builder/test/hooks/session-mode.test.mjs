// 1.17.0 — live build session mode (LUA_BUILD_SESSION=1, spec v3 B22/B23). Three invariants:
//   1. flags off (LUA_BUILD_SESSION unset, '0', '') every hook answers exactly as before;
//   2. session mode never REMOVES a block: whatever is blocked interactively or headless is blocked in a session
//      (and the LUA_DEPLOY_CONFIRMED=1 prefix is void there); session mode only rewords, skips the laptop probes
//      and the production ping, and adds context;
//   3. no session message points at a slash command the session cannot run.
// The pod sets LUA_PLUGIN_HEADLESS=1 too, so the session cases run with both flags.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide as confirmDeploy } from '../../hooks/confirm-deploy.mjs';
import { decide as blockAutoDeploy } from '../../hooks/block-auto-deploy.mjs';
import { decide as blockAuthConfigure } from '../../hooks/block-auth-configure.mjs';
import { decide as blockDeviceSecret } from '../../hooks/block-device-secret.mjs';
import { decide as checkAuth } from '../../hooks/check-lua-auth.mjs';
import { decide as checkVersion } from '../../hooks/check-lua-version.mjs';
import { decide as detectProject } from '../../hooks/detect-project.mjs';
import { decide as injectContext } from '../../hooks/inject-context.mjs';
import { decide as postDeploySmoke } from '../../hooks/post-deploy-smoke.mjs';
import { decide as sessionGuard } from '../../hooks/session-guard.mjs';
import { decide as sessionContext } from '../../hooks/session-context.mjs';
import { decide as untrustedOutput } from '../../hooks/session-untrusted-output.mjs';
import { classifyProductionCommand } from '../../lib/tokenizer.mjs';
import { runHook } from '../helpers/run-hook.mjs';

const SESSION = { LUA_BUILD_SESSION: '1', LUA_PLUGIN_HEADLESS: '1' };
const SESSION_ONLY = { LUA_BUILD_SESSION: '1' };
const HEADLESS = { LUA_PLUGIN_HEADLESS: '1' };
const INTERACTIVE = {};
const OFF_SPELLINGS = [{}, { LUA_BUILD_SESSION: '0' }, { LUA_BUILD_SESSION: '' }, { LUA_BUILD_SESSION: 'false' }];
const SLASH = /(?:^|[\s`(])\/lua-[a-z]/;

const AUTH_CONFIGURE = ['lua', 'auth', 'configure'].join(' ');

/** Commands every Bash guard sees. Mixed: gated verbs (bare and prefixed), bypass shapes, reads, session writes. */
const CORPUS = [
  'lua deploy all --force',
  'lua deploy skill --ci --name x --set-version latest --force',
  'LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --name x --set-version latest --force',
  'env LUA_DEPLOY_CONFIRMED=1 lua version promote 3',
  'LUA_DEPLOY_CONFIRMED=1 lua version promote 3',
  'lua version promote v3',
  'LUA_DEPLOY_CONFIRMED=1 lua workflows deploy outreach -v latest',
  'lua workflows activate outreach',
  'LUA_DEPLOY_CONFIRMED=1 lua mcp activate --server-name fs',
  'lua mcp activate filesystem',
  'LUA_DEPLOY_CONFIRMED=1 lua marketplace template apply --template-id t --all-installed --force',
  'lua marketplace template publish --template-id t',
  'LUA_DEPLOY_CONFIRMED=1 lua persona production deploy --persona-version 5',
  'lua skills production deploy --skill-name x --skill-version 1.0.0',
  'cd x && npx lua-cli workflows activate outreach',
  'true; lua version promote 3',
  'FOO=1 lua deploy all',
  '/usr/local/bin/lua deploy all',
  'bash -c "lua deploy all"',
  'echo $(lua version promote 4)',
  '$LUA deploy all',
  'lua ${VERB} all',
  'lua push skill --ci --force --auto-deploy',
  'lua push all --auto-deploy',
  AUTH_CONFIGURE,
  `cd agent && ${AUTH_CONFIGURE}`,
  'lua devices credential --ci --device-name pico',
  'lua devices credential --ci --device-name pico --out /dev/stdout',
  'lua devices credential --ci --device-name pico --out .env.device',
  'lua devices credential --help',
  'lua devices credentials thermo --out .dev.env',
  'lua devices key thermo --out .dev.env',
  'lua devices CREDENTIAL thermo --out .dev.env',
  'lua devices Key thermo',
  `lua status ${'x'.repeat(40 * 1024)}`,
  'lua push all --ci --force',
  "lua version create --ci -m 'x'",
  'lua compile --ci',
  'lua status --json --ci',
  "lua chat --ci -e sandbox -m 'hi' -t",
  'lua env production --ci --list',
  'lua env production --ci -k LOG_LEVEL -v debug',
  'lua integrations connect --integration slack',
  'git status',
  'npm test',
];

const BASH_GUARDS = {
  'confirm-deploy': (input, env) => confirmDeploy(input, env),
  'block-auto-deploy': (input, env) => blockAutoDeploy(input, env),
  'block-auth-configure': (input, env) => blockAuthConfigure(input, env),
  'block-device-secret': (input, env) => blockDeviceSecret(input, env),
  'session-guard': (input, env) => sessionGuard(input, env),
};

const blockedBy = (command, env) =>
  Object.entries(BASH_GUARDS).filter(([, fn]) => fn({ tool_input: { command } }, env)?.block).map(([n]) => n);

describe('invariant 1: flags off, every Bash guard answers exactly as before', () => {
  test.each(CORPUS.map((c) => [c.slice(0, 80), c]))('%s', (_label, command) => {
    for (const [name, fn] of Object.entries(BASH_GUARDS)) {
      const base = fn({ tool_input: { command } }, INTERACTIVE);
      const headless = fn({ tool_input: { command } }, HEADLESS);
      for (const off of OFF_SPELLINGS) {
        expect([name, fn({ tool_input: { command } }, off)]).toEqual([name, base]);
        expect([name, fn({ tool_input: { command } }, { ...off, ...HEADLESS })]).toEqual([name, headless]);
      }
    }
  });

  test('the new session-guard is silent outside a session, on every corpus command', () => {
    for (const command of CORPUS) {
      for (const off of OFF_SPELLINGS) expect(sessionGuard({ tool_input: { command } }, off)).toBeNull();
    }
  });

  test('session-context is silent outside a session', () => {
    for (const off of OFF_SPELLINGS) expect(sessionContext(null, off)).toBeNull();
  });
});

describe('invariant 2: session mode never removes a block', () => {
  test.each(CORPUS.map((c) => [c.slice(0, 80), c]))('%s', (_label, command) => {
    const before = new Set([...blockedBy(command, INTERACTIVE), ...blockedBy(command, HEADLESS)]);
    const inSession = blockedBy(command, SESSION);
    const inSessionOnly = blockedBy(command, SESSION_ONLY);
    for (const hook of before) {
      expect([hook, inSession.includes(hook)]).toEqual([hook, true]);
      expect([hook, inSessionOnly.includes(hook)]).toEqual([hook, true]);
    }
  });

  test('every gated production verb is blocked in a session, prefixed or not, with or without headless', () => {
    for (const command of CORPUS) {
      if (!classifyProductionCommand(command)) continue;
      for (const env of [SESSION, SESSION_ONLY]) {
        const result = confirmDeploy({ tool_input: { command } }, env);
        expect([command.slice(0, 60), result?.block]).toEqual([command.slice(0, 60), true]);
        expect(result.reason).toContain('DEPLOY_DENIED_SESSION');
      }
    }
  });
});

describe('confirm-deploy in a session: routes to the release or the action request', () => {
  test.each([
    ['LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --name x --force', 'request_release'],
    ['lua version promote 3', 'request_action'],
    ['LUA_DEPLOY_CONFIRMED=1 lua workflows deploy outreach -v latest', 'request_release'],
    ['LUA_DEPLOY_CONFIRMED=1 lua mcp activate fs', 'request_action'],
    ['lua workflows activate outreach', 'request_action'],
    ['lua marketplace template apply --template-id t', 'request_action'],
  ])('%s → %s', (command, tool) => {
    const result = confirmDeploy({ tool_input: { command } }, SESSION);
    expect(result.reason).toContain(`mcp__lua-session__${tool}`);
    expect(result.reason).not.toContain('DEPLOY_DENIED_HEADLESS');
    expect(result.reason).not.toMatch(SLASH);
  });

  test('promote N puts an existing version back live: an action request naming the version, never a release', () => {
    const result = confirmDeploy({ tool_input: { command: 'lua version promote 3' } }, SESSION);
    expect(result.block).toBe(true);
    expect(result.reason).toContain('command (e.g. "version promote")');
    expect(result.reason).not.toContain('request_release');
  });

  test('--auto-deploy is blocked with the release route, not the headless or interactive text', () => {
    const result = confirmDeploy({ tool_input: { command: 'lua push skill --auto-deploy' } }, SESSION);
    expect(result.block).toBe(true);
    expect(result.reason).toContain('DEPLOY_DENIED_AUTO');
    expect(result.reason).toContain('mcp__lua-session__request_release');
    expect(result.reason).not.toMatch(SLASH);
  });

  test('non-production commands pass in a session', () => {
    for (const command of ['lua push all --ci --force', 'lua compile --ci', 'git status']) {
      expect(confirmDeploy({ tool_input: { command } }, SESSION)).toBeNull();
    }
  });
});

describe('the other guards in a session', () => {
  test('block-auto-deploy routes to the release', () => {
    const r = blockAutoDeploy({ tool_input: { command: 'lua push all --auto-deploy' } }, SESSION);
    expect(r.block).toBe(true);
    expect(r.reason).toContain('request_release');
    expect(r.reason).not.toMatch(SLASH);
  });

  test('block-auth-configure explains the pod identity and asks for nothing', () => {
    const r = blockAuthConfigure({ tool_input: { command: AUTH_CONFIGURE } }, SESSION);
    expect(r.block).toBe(true);
    expect(r.reason).toContain('AUTH_INPUT_DENIED');
    expect(r.reason).toContain('not available in a live build session');
    expect(r.reason).not.toContain('private terminal');
  });

  test('block-auth-configure defaults to process.env and keeps the laptop text there', () => {
    expect(blockAuthConfigure({ tool_input: { command: AUTH_CONFIGURE } }).reason).toContain('private terminal');
  });

  test('block-device-secret points at Desktop, not at /lua-devices', () => {
    const r = blockDeviceSecret({ tool_input: { command: 'lua devices credential --ci --device-name p' } }, SESSION);
    expect(r.block).toBe(true);
    expect(r.reason).toContain('Lua Desktop');
    expect(r.reason).not.toMatch(SLASH);
  });

  // Both hooks block every credential spelling in a session, `--out` or not, so neither relies on the other.
  test.each([
    'lua devices credential --ci --device-name p --out .env.device',
    'lua devices credentials thermo --out .dev.env',
    'lua devices key thermo --out .dev.env',
    'lua devices CREDENTIAL thermo --out .dev.env',
    'lua devices Key thermo',
    // F011: `--operations <list>` before the verb, and lua-cli run by package name or entry file.
    'lua devices --operations commands credential',
    'npx lua-cli devices --operations commands credential',
    'npx lua-cli devices --operations commands credential d1 --out .dev.env',
    'node node_modules/lua-cli/dist/index.js devices --operations commands credential',
    'lua devices --operations=commands key --out .dev.env',
  ])('block-device-secret and session-guard both block %s in a session', (command) => {
    for (const env of [SESSION, SESSION_ONLY]) {
      expect(blockDeviceSecret({ tool_input: { command } }, env)?.block).toBe(true);
      expect(sessionGuard({ tool_input: { command } }, env)?.block).toBe(true);
    }
  });
});

describe('session-guard decide()', () => {
  test('blocks an unavailable command, warns on an approval, passes a read', () => {
    expect(sessionGuard({ tool_input: { command: 'lua update' } }, SESSION).block).toBe(true);
    expect(sessionGuard({ tool_input: { command: 'lua integrations connect --integration slack' } }, SESSION).warn)
      .toContain('approval request');
    expect(sessionGuard({ tool_input: { command: 'lua status' } }, SESSION)).toBeNull();
  });

  test('lua build-session is blocked inside a session, except status', () => {
    for (const command of ['lua build-session release --approve', 'lua build-session start', 'lua build-session']) {
      const r = sessionGuard({ tool_input: { command } }, SESSION);
      expect([command, r?.block]).toEqual([command, true]);
      expect(r.reason).toContain('SESSION_COMMAND_UNAVAILABLE');
    }
    expect(sessionGuard({ tool_input: { command: 'lua build-session status bs_abc' } }, SESSION)).toBeNull();
    expect(sessionGuard({ tool_input: { command: 'lua build-session release --approve' } }, {})).toBeNull();
  });

  test('no input, no command: null', () => {
    expect(sessionGuard(null, SESSION)).toBeNull();
    expect(sessionGuard({}, SESSION)).toBeNull();
  });

  test('defaults to process.env (off in the test runner)', () => {
    expect(sessionGuard({ tool_input: { command: 'lua update' } })).toBeNull();
  });
});

describe('SessionStart / UserPromptSubmit / PostToolUse in a session', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lua-session-'));
    writeFileSync(join(dir, 'lua.skill.yaml'), 'agent:\n  agentId: agent_123\n  orgId: org_9\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('check-lua-auth is skipped (no warning, whatever the probe said)', () => {
    const v = { exitCode: 0, stdout: '3.55.0\n', stderr: '' };
    for (const env of [SESSION, SESSION_ONLY]) {
      expect(checkAuth(v, { exitCode: 9, stdout: '', stderr: '' }, env)).toBeNull();
      expect(checkAuth(v, { exitCode: null, timedOut: true }, env)).toBeNull();
    }
    // flags off: unchanged
    expect(checkAuth(v, { exitCode: 9, stdout: '', stderr: '' }, INTERACTIVE)?.warn).toContain('/lua-auth');
  });

  test('check-lua-version is skipped (the image pins lua-cli)', () => {
    for (const env of [SESSION, SESSION_ONLY]) {
      expect(checkVersion({ exitCode: 0, stdout: '3.0.0\n' }, env)).toBeNull();
      expect(checkVersion({ exitCode: 1, stdout: '' }, env)).toBeNull();
    }
    expect(checkVersion({ exitCode: 0, stdout: '3.0.0\n' }, INTERACTIVE)?.warn).toContain('/lua-update');
  });

  test('detect-project names the agent without a /lua-doctor pointer', () => {
    expect(detectProject(null, { cwd: dir, env: SESSION_ONLY })).toEqual({ warn: '✓ Lua agent project detected: agent_123.' });
    expect(detectProject(null, { cwd: dir, env: INTERACTIVE })?.warn).toContain('/lua-doctor');
  });

  test('inject-context adds the session line in a session only', () => {
    const on = injectContext(null, { cwd: dir, env: SESSION_ONLY }).warn;
    expect(on).toContain('[lua] agent: agent_123');
    expect(on).toContain('[lua] live build session');
    for (const off of OFF_SPELLINGS) {
      expect(injectContext(null, { cwd: dir, env: off })).toEqual({ warn: '[lua] agent: agent_123\n[lua] org:   org_9' });
    }
  });

  test('post-deploy-smoke never pings production from a session (session flag alone is enough)', async () => {
    const spawnLuaFn = async () => { throw new Error('must not spawn in a session'); };
    await expect(postDeploySmoke(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua version promote 3' }, tool_response: { success: true } },
      { spawnLuaFn, env: SESSION_ONLY },
    )).resolves.toBeNull();
  });

  test('session-context injects the brief', () => {
    const r = sessionContext(null, SESSION);
    expect(r.warn).toContain('[lua] Live build session');
    expect(r.warn).not.toMatch(SLASH);
  });

  test('session-context defaults to process.env (off in the test runner)', () => {
    expect(sessionContext(null)).toBeNull();
  });

  // F065 (belt): lua reads with runtime output get an UNTRUSTED DATA banner after the tool result.
  test.each([
    'lua logs --ci --json --type all --limit 30',
    'lua workflows runs wf1',
    'lua workflows job-logs r1',
    'lua integrations inspect slack',
    'lua devices logs d1',
    'lua drains deliveries x',
    "lua chat --ci -e sandbox -m 'hi' -t",
    'lua test workflow wf1',
    'cd agent && npx lua-cli logs --follow | head -50',
  ])('session-untrusted-output banners %s in a session', (command) => {
    for (const env of [SESSION, SESSION_ONLY]) {
      const r = untrustedOutput({ tool_input: { command } }, env);
      expect(r?.warn).toContain('UNTRUSTED DATA');
      expect(r.warn).not.toMatch(SLASH);
    }
  });

  test.each([
    'lua status --json --ci',
    'lua push all --ci --force',
    'lua logs --help',
    'lua integrations connect --integration slack',
    'git log',
  ])('session-untrusted-output is silent on %s', (command) => {
    expect(untrustedOutput({ tool_input: { command } }, SESSION)).toBeNull();
  });

  test('session-untrusted-output is silent outside a session, on every corpus command and a read', () => {
    for (const off of [...OFF_SPELLINGS, HEADLESS]) {
      for (const command of [...CORPUS, 'lua logs --type all']) {
        expect(untrustedOutput({ tool_input: { command } }, off)).toBeNull();
      }
    }
    expect(untrustedOutput({ tool_input: { command: 'lua logs' } })).toBeNull();
    expect(untrustedOutput(null, SESSION)).toBeNull();
  });
});

describe('hooks.json registers the session hooks', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const doc = JSON.parse(readFileSync(join(here, '..', '..', 'hooks', 'hooks.json'), 'utf8'));
  const commands = (event) => doc.hooks[event].flatMap((m) => m.hooks);

  test('session-guard runs before a Bash command that mentions lua', () => {
    const entry = commands('PreToolUse').find((h) => h.command.endsWith('/hooks/session-guard.mjs'));
    expect(entry).toMatchObject({ type: 'command', if: 'Bash(*lua*)' });
  });

  test('session-untrusted-output runs after a Bash command that mentions lua', () => {
    const entry = commands('PostToolUse').find((h) => h.command.endsWith('/hooks/session-untrusted-output.mjs'));
    expect(entry).toMatchObject({ type: 'command', if: 'Bash(*lua*)' });
  });

  test('session-context runs at SessionStart', () => {
    expect(commands('SessionStart').some((h) => h.command.endsWith('/hooks/session-context.mjs'))).toBe(true);
  });
});

describe('script entry points (spawned)', () => {
  test('session-untrusted-output: PostToolUse context in a session, nothing outside', async () => {
    const input = { tool_input: { command: 'lua logs --type all' }, tool_response: { stdout: 'x' } };
    const on = await runHook('session-untrusted-output.mjs', input, { env: SESSION });
    expect(on.exitCode).toBe(0);
    const out = JSON.parse(on.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('UNTRUSTED DATA');
    const off = await runHook('session-untrusted-output.mjs', input, { env: { LUA_BUILD_SESSION: '' } });
    expect(off.exitCode).toBe(0);
    expect(off.stdout).toBe('');
  });

  test('session-guard: an unavailable command exits 2 in a session', async () => {
    const r = await runHook('session-guard.mjs', { tool_input: { command: 'lua update' } }, { env: SESSION });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('SESSION_COMMAND_UNAVAILABLE');
  });

  test('session-guard: an approval-class command runs, with PreToolUse context on stdout', async () => {
    const r = await runHook('session-guard.mjs', { tool_input: { command: 'lua drains pause d1' } }, { env: SESSION });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('approval request');
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test('session-guard: outside a session it exits 0 silently', async () => {
    const r = await runHook('session-guard.mjs', { tool_input: { command: 'lua update' } }, { env: { LUA_BUILD_SESSION: '' } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  test('session-context: the brief in a session, nothing outside', async () => {
    const on = await runHook('session-context.mjs', null, { env: SESSION });
    expect(JSON.parse(on.stdout.trim()).hookSpecificOutput.additionalContext).toContain('Live build session');
    const off = await runHook('session-context.mjs', null, { env: { LUA_BUILD_SESSION: '' } });
    expect(off.exitCode).toBe(0);
    expect(off.stdout).toBe('');
  });

  test('confirm-deploy: a prefixed deploy exits 2 in a session with the release route', async () => {
    const r = await runHook(
      'confirm-deploy.mjs',
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --force' } },
      { env: SESSION },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('DEPLOY_DENIED_SESSION');
    expect(r.stderr).toContain('request_release');
  });
});

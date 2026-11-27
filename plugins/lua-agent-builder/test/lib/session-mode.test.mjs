// 1.17.0 — live build session mode (spec v3 B22/B23): the shared library behind the session-mode hooks.

import { describe, test, expect, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  SESSION_KNOWLEDGE_PATH,
  APPROVAL_WAIT_NOTE,
  BUILD_SESSION_ENV_FLAG,
  RELEASE_LABELS,
  SESSION_TOOL_NAMES,
  buildSessionId,
  fleetAgentFolders,
  isBuildSession,
  sessionCommandDecision,
  sessionDeployBlockReason,
  sessionStartBrief,
  sessionTool,
} from '../../lib/session-mode.mjs';
import {
  PRODUCTION_COMMANDS,
  UNCLASSIFIABLE_LABEL,
  UNRESOLVED_LABEL,
  findLuaInvocations,
} from '../../lib/tokenizer.mjs';
import { classifyLuaCommand } from '../../lib/session-commands.mjs';

const SESSION = { LUA_BUILD_SESSION: '1' };
const SLASH = /(?:^|[\s`(])\/lua-[a-z]/;

describe('isBuildSession / buildSessionId', () => {
  test.each([
    ['1', true], ['true', true], ['TRUE', true], [' yes ', true], ['on', true],
    ['0', false], ['false', false], ['', false], [undefined, false], ['session', false],
  ])('LUA_BUILD_SESSION=%p → %p', (value, expected) => {
    expect(isBuildSession({ LUA_BUILD_SESSION: value })).toBe(expected);
  });

  test('the flag name is the shared BUILD_SESSION_POD_ENV_FLAG; a missing env reads off', () => {
    expect(BUILD_SESSION_ENV_FLAG).toBe('LUA_BUILD_SESSION');
    expect(isBuildSession(undefined)).toBe(false);
    expect(isBuildSession(null)).toBe(false);
    expect(isBuildSession({ LUA_PLUGIN_HEADLESS: '1' })).toBe(false);
  });

  test('defaults to process.env', () => {
    const before = process.env.LUA_BUILD_SESSION;
    try {
      process.env.LUA_BUILD_SESSION = '1';
      expect(isBuildSession()).toBe(true);
      delete process.env.LUA_BUILD_SESSION;
      expect(isBuildSession()).toBe(false);
      expect(buildSessionId()).toBeNull();
    } finally {
      if (before === undefined) delete process.env.LUA_BUILD_SESSION;
      else process.env.LUA_BUILD_SESSION = before;
    }
  });

  test('the session id is read only in its bs_ shape', () => {
    expect(buildSessionId({ LUA_BUILD_SESSION_ID: 'bs_123e4567-e89b-42d3-a456-426614174000' })).toBe(
      'bs_123e4567-e89b-42d3-a456-426614174000'
    );
    expect(buildSessionId({ LUA_BUILD_SESSION_ID: 'x; rm -rf /' })).toBeNull();
    expect(buildSessionId({})).toBeNull();
    expect(buildSessionId(null)).toBeNull();
  });
});

describe('session tools', () => {
  test('the eight lua-session tools (shared BUILD_SESSION_MCP_TOOL_NAMES) in the bare --mcp-config spelling', () => {
    expect(SESSION_TOOL_NAMES).toEqual([
      'stage_for_test', 'test_chat', 'preview_webapp', 'request_release', 'update_memory', 'share_file',
      'request_action', 'request_secret',
    ]);
    expect(sessionTool('request_release')).toBe('mcp__lua-session__request_release');
  });
});

describe('sessionDeployBlockReason', () => {
  test('every gated label has a reason, and the release labels route to request_release', () => {
    for (const { label } of PRODUCTION_COMMANDS) {
      const reason = sessionDeployBlockReason(label);
      expect(reason).toContain('DEPLOY_DENIED_SESSION');
      expect(reason).not.toMatch(SLASH);
      expect(reason).toContain(
        RELEASE_LABELS.has(label) ? 'mcp__lua-session__request_release' : 'mcp__lua-session__request_action'
      );
    }
  });

  test('deploy and promote are releases; activations and template releases are action requests', () => {
    expect(RELEASE_LABELS.has('lua deploy')).toBe(true);
    expect(RELEASE_LABELS.has('lua version promote')).toBe(false);
    expect(RELEASE_LABELS.has('lua workflows deploy')).toBe(true);
    expect(RELEASE_LABELS.has('lua mcp activate')).toBe(false);
    expect(RELEASE_LABELS.has('lua workflows activate')).toBe(false);
    expect(RELEASE_LABELS.has('lua marketplace template publish')).toBe(false);
    expect(sessionDeployBlockReason('lua mcp activate')).toContain('command (e.g. "mcp activate")');
  });

  test('an unresolved or unclassifiable command asks for a plain spelling', () => {
    for (const label of [UNCLASSIFIABLE_LABEL, UNRESOLVED_LABEL]) {
      const reason = sessionDeployBlockReason(label);
      expect(reason).toContain('cannot check');
      expect(reason).toContain('request_release');
    }
  });

  test('never suggests the confirmation prefix as a way through', () => {
    for (const { label } of PRODUCTION_COMMANDS) {
      expect(sessionDeployBlockReason(label)).toMatch(/Do not retry with LUA_DEPLOY_CONFIRMED=1|do not retry with LUA_DEPLOY_CONFIRMED=1/);
    }
  });
});

describe('sessionCommandDecision: outside a session it is inert', () => {
  test.each([
    'lua auth configure',
    'lua env production -k STRIPE_SECRET_KEY -v sk_live_x',
    'lua integrations connect slack',
    'lua devices credential --device-name d',
    'lua status',
  ])('%s → null', (command) => {
    expect(sessionCommandDecision(command, {})).toBeNull();
    expect(sessionCommandDecision(command, { LUA_BUILD_SESSION: '0' })).toBeNull();
    expect(sessionCommandDecision(command, { LUA_PLUGIN_HEADLESS: '1' })).toBeNull();
  });
});

describe('sessionCommandDecision in a session', () => {
  test.each([
    ['lua auth configure', 'Lua access comes from the session itself'],
    ['lua auth logout', 'Lua access comes from the session itself'],
    ['lua login', 'Lua access comes from the session itself'],
    ['lua logout', 'nothing to sign out of'],
    ['lua docs', 'lua-docs MCP'],
    ['lua update', 'pins lua-cli'],
    ['lua admin orgs', 'Admin commands are not available'],
    ['lua destroy', 'Not available in a session'],
    ['cd agent && npx lua telemetry off', 'fixed in the session image'],
  ])('unavailable: %s is blocked', (command, words) => {
    const d = sessionCommandDecision(command, SESSION);
    expect(d.block).toBe(true);
    expect(d.reason).toContain('SESSION_COMMAND_UNAVAILABLE');
    expect(d.reason).toContain(words);
    expect(d.reason).not.toMatch(SLASH);
  });

  test('a secret value on a command line is blocked and routed to request_secret by name', () => {
    const d = sessionCommandDecision("lua env production --ci -k STRIPE_SECRET_KEY -v 'sk_live_abc'", SESSION);
    expect(d.block).toBe(true);
    expect(d.reason).toContain('SESSION_SECRET_DENIED');
    expect(d.reason).toContain('mcp__lua-session__request_secret');
    expect(d.reason).toContain('name: "STRIPE_SECRET_KEY"');
    expect(d.reason).toContain('env: "production"');
    expect(d.reason).toContain('secret-shaped key');
    expect(d.reason).not.toContain('sk_live_abc');
  });

  test('a value with no key is a secret too, named generically, sandbox env kept', () => {
    const d = sessionCommandDecision('lua env sandbox --ci -v x', SESSION);
    expect(d.block).toBe(true);
    expect(d.reason).toContain('name: "<KEY>"');
    expect(d.reason).toContain('env: "sandbox"');
    expect(d.reason).not.toContain('secret-shaped');
  });

  test('a sandbox / staging non-secret set or delete only edits the workspace .env: no approval context', () => {
    for (const command of [
      'lua env sandbox --ci -k LOG_LEVEL -v debug',
      'lua env staging --ci -k LOG_LEVEL --delete',
      'lua env --ci -k LOG_LEVEL -v debug sandbox',
    ]) {
      expect(sessionCommandDecision(command, SESSION)).toBeNull();
    }
    // production is a real write: approval context
    expect(sessionCommandDecision('lua env production --ci -k LOG_LEVEL -v debug', SESSION).warn).toContain('approval');
    // a bare `lua env` (interactive menu) is not a local edit
    expect(sessionCommandDecision('lua env', SESSION).warn).toContain('approval');
    // a secret in sandbox is still blocked, and the env word survives flags before it
    const d = sessionCommandDecision('lua env --ci staging -k API_TOKEN -v x', SESSION);
    expect(d.block).toBe(true);
    expect(d.reason).toContain('env: "staging"');
  });

  test('a secret write with no environment defaults the suggestion to production', () => {
    const d = sessionCommandDecision('lua env -k API_TOKEN -v x', SESSION);
    expect(d.reason).toContain('env: "production"');
  });

  test('a device credential is issued to the user, never into the session (--out or not)', () => {
    for (const command of [
      'lua devices credential --ci --device-name pico',
      'lua devices credential --ci --device-name pico --out .env.device',
    ]) {
      const d = sessionCommandDecision(command, SESSION);
      expect(d.block).toBe(true);
      expect(d.reason).toContain('DEVICE_SECRET_DENIED');
      expect(d.reason).toContain('Lua Desktop');
    }
  });

  test.each([
    ['lua env production --ci -k LOG_LEVEL -v debug', 'lua env production'],
    ['lua integrations connect --integration slack', 'lua integrations connect'],
    ['lua drains create --ci --json --name x --type http', 'lua drains create'],
    ['lua integrations mcp activate --ci --connection c1', 'lua integrations mcp'],
    ['lua workflows start outreach', 'lua workflows start'],
    ['lua skills delete s1', 'lua skills delete'],
  ])('approval: %s is NOT blocked; context explains the Desktop approval', (command, what) => {
    const d = sessionCommandDecision(command, SESSION);
    expect(d.block).toBeUndefined();
    expect(d.warn).toContain(`\`${what}\``);
    expect(d.warn).toContain('approval request');
    expect(d.warn).toContain('<lua-action-result>');
    expect(d.warn).toContain('do not run it again');
    expect(d.warn).toContain('mcp__lua-session__request_action');
  });

  test('a delete carries its critical risk', () => {
    expect(sessionCommandDecision('lua skills delete s1', SESSION).warn).toContain('risk critical');
  });

  test('chat with the live agent points at the session test version', () => {
    const d = sessionCommandDecision("lua chat --ci -e production -m 'hi' -t", SESSION);
    expect(d.warn).toContain('LIVE agent');
    expect(d.warn).toContain('mcp__lua-session__test_chat');
  });

  test('version create points at stage_for_test; deploy, promote and --auto-deploy at request_release', () => {
    expect(sessionCommandDecision("lua version create --ci -m 'x'", SESSION).warn).toContain('stage_for_test');
    for (const command of ['lua deploy skill --ci --name x', 'lua version promote 3', 'lua push skill --auto-deploy']) {
      expect(sessionCommandDecision(command, SESSION).warn).toContain('mcp__lua-session__request_release');
    }
  });

  test('an unknown command (default rule) is treated as an approval with high risk', () => {
    expect(sessionCommandDecision('lua frobnicate', SESSION).warn).toContain('risk high');
  });

  test.each([
    'lua status --json --ci',
    'lua compile --ci',
    'lua logs --ci --json --type all --limit 30',
    "lua chat --ci -e sandbox -m 'hello' -t",
    'lua push skill --ci --force --name triage',
    'lua env production --ci --list',
    'lua workflows list',
    'lua',
    'git status',
    'echo lua is great',
  ])('reads and session writes pass silently: %s', (command) => {
    expect(sessionCommandDecision(command, SESSION)).toBeNull();
  });

  test.each([
    'lua --version',
    'lua -V',
    'lua --help',
    'lua help deploy',
    'lua drains create --help',
    'lua integrations connect -h',
  ])('help and version only print: %s gets no approval context', (command) => {
    expect(sessionCommandDecision(command, SESSION)).toBeNull();
  });

  test('--help does not lift a block', () => {
    expect(sessionCommandDecision('lua update --help', SESSION).block).toBe(true);
    expect(sessionCommandDecision('lua devices credential --help', SESSION).block).toBe(true);
  });

  test('a block anywhere in a chain wins over warnings; repeated reasons are listed once', () => {
    const d = sessionCommandDecision('lua integrations connect x && lua update && lua update', SESSION);
    expect(d.block).toBe(true);
    expect(d.reason.split('SESSION_COMMAND_UNAVAILABLE').length - 1).toBe(1);
  });

  test('two different approvals are both explained', () => {
    const d = sessionCommandDecision('lua drains pause d1 && lua drains resume d1', SESSION);
    expect(d.warn).toContain('`lua drains pause`');
    expect(d.warn).toContain('`lua drains resume`');
  });

  test('a non-string command is inert', () => {
    expect(sessionCommandDecision(undefined, SESSION)).toBeNull();
  });
});

describe('sessionStartBrief', () => {
  test('null outside a session', () => {
    expect(sessionStartBrief({})).toBeNull();
  });

  test('names the session, the tools and the knowledge file; no slash command to run', () => {
    const brief = sessionStartBrief({ ...SESSION, LUA_BUILD_SESSION_ID: 'bs_123e4567-e89b-42d3-a456-426614174000' });
    expect(brief).toContain('Live build session bs_123e4567');
    for (const t of ['request_action', 'request_release', 'request_secret', 'stage_for_test', 'test_chat']) {
      expect(brief).toContain(`mcp__lua-session__${t}`);
    }
    // An absolute path that exists: hook output is not expanded, and a relative path would be read in the project.
    expect(isAbsolute(SESSION_KNOWLEDGE_PATH)).toBe(true);
    expect(existsSync(SESSION_KNOWLEDGE_PATH)).toBe(true);
    expect(SESSION_KNOWLEDGE_PATH.replace(/\\/g, '/')).toMatch(/\/lib\/knowledge\/build-session\.md$/);
    expect(brief).toContain(SESSION_KNOWLEDGE_PATH);
    expect(brief).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(brief).not.toMatch(SLASH);
  });

  test('1.20.5: the live app data rule and the honest-claims rule (Lua Studio production test)', () => {
    const brief = sessionStartBrief(SESSION);
    expect(brief).toContain("The live app's data is the user's");
    expect(brief).toContain('never changes or deletes a row a person acted on');
    expect(brief).toContain('a preview link is not "opened"');
    expect(brief).toContain('which agents ship now and which come later');
  });

  test('without an id the brief still reads', () => {
    expect(sessionStartBrief(SESSION)).toContain('[lua] Live build session:');
  });
});

describe('APPROVAL_WAIT_NOTE', () => {
  test('treats a timeout / exit 10 as pending and forbids a retry', () => {
    expect(APPROVAL_WAIT_NOTE).toContain('PENDING, not failed');
    expect(APPROVAL_WAIT_NOTE).toContain('exits 10');
    expect(APPROVAL_WAIT_NOTE).toContain('do not run it again');
  });
});

describe('findLuaInvocations (tokenizer, advisory listing)', () => {
  test.each([
    ['cd x && lua env production --list', [['env', 'production', '--list']]],
    ['npx lua status --json', [['status', '--json']]],
    ["bash -c 'lua docs'", [['docs']]],
    ['echo $(lua logs --ci) > f', [['logs', '--ci']]],
    ["timeout 30 lua chat --ci -e sandbox -m 'hi there' -t", [['chat', '--ci', '-e', 'sandbox', '-m', 'hi there', '-t']]],
    ['FOO=1 lua deploy all', [['deploy', 'all']]],
    ['lua logs > out.txt 2>&1', [['logs']]],
    ['ls lua', []],
    ['git status', []],
    ['sh <<EOF\nlua update\nEOF', [['update']]],
  ])('%s', (command, expected) => {
    expect(findLuaInvocations(command).map((i) => i.argv)).toEqual(expected);
  });

  test('marks an argv with a computed word', () => {
    expect(findLuaInvocations('lua env production -k A -v "$X"')).toEqual([
      { argv: ['env', 'production', '-k', 'A', '-v', '$X'], dynamic: true },
    ]);
  });

  test('skips a computed binary', () => {
    expect(findLuaInvocations('$BIN status lua')).toEqual([]);
  });

  test('non-strings, over-long input and lua-free text yield nothing', () => {
    expect(findLuaInvocations(42)).toEqual([]);
    expect(findLuaInvocations(`lua status ${'x'.repeat(40 * 1024)}`)).toEqual([]);
    expect(findLuaInvocations('echo hello')).toEqual([]);
  });

  test('deep nesting stops at the depth limit without throwing', () => {
    let cmd = 'lua status';
    for (let i = 0; i < 10; i++) cmd = `bash -c ${JSON.stringify(cmd)}`;
    expect(() => findLuaInvocations(cmd)).not.toThrow();
  });

  test('a spent budget returns what was found so far (never throws)', () => {
    const long = Array.from({ length: 400 }, () => 'lua status').join(' && ');
    expect(() => findLuaInvocations(long, { budgetMs: -1 })).not.toThrow();
    expect(findLuaInvocations(long, { budgetMs: -1 }).length).toBeLessThan(400);
  });
});

// 1.20.1: "parallel tool calls once compiled the wrong project folder". A fleet session's Bash calls share one
// working directory and a `cd` carries into the next call, so each lua command must name its own agent folder.
describe('sessionCommandDecision in a fleet session: each lua command names its agent folder', () => {
  const FLEET = '/workspace/fleet';
  test.each([
    ['lua compile --ci', FLEET],
    ['lua compile --ci', `${FLEET}/alpha`],
    ['cd beta && lua compile --ci', FLEET],
    ['cd ../beta && lua test skill --name t --input "{}" --ci', `${FLEET}/alpha`],
    ['cd "$D" && lua push all --ci --force', FLEET],
    ['cd /workspace/fleet && lua status --json --ci', FLEET],
    ['cd /workspace/fleet/x; cd - && lua compile --ci', FLEET],
  ])('%s (shell in %s) → blocked FLEET_FOLDER_UNPINNED', (command, cwd) => {
    const d = sessionCommandDecision(command, SESSION, cwd);
    expect(d?.block).toBe(true);
    expect(d.reason).toMatch(/^FLEET_FOLDER_UNPINNED: .*`cd \/workspace\/fleet\/(<agent>|alpha) && /);
  });

  test.each([
    `cd ${FLEET}/alpha && lua compile --ci`,
    `cd ${FLEET}/beta/ && lua compile --ci 2>&1 | tail -20`,
    `cd ${FLEET}/alpha && lua compile --ci && cd ${FLEET}/beta && lua compile --ci`,
    'lua --version',
    'lua compile --help',
    'git status && npm test',
    'gh pr create --body "run lua compile in each agent folder"',
  ])('%s → allowed', (command) => {
    expect(sessionCommandDecision(command, SESSION, `${FLEET}/alpha`)?.block).toBeFalsy();
  });

  test('a single-agent session (/workspace/agent) and an unknown cwd outside the fleet are unchanged', () => {
    expect(sessionCommandDecision('lua compile --ci', SESSION, '/workspace/agent')).toBeNull();
    expect(sessionCommandDecision('cd sub && lua compile --ci', SESSION, '/workspace/agent')).toBeNull();
    expect(sessionCommandDecision('lua compile --ci', SESSION)).toBeNull();
    expect(sessionCommandDecision('lua compile --ci', {}, FLEET)).toBeNull();
  });

  // Prod 10 Nov: a one-agent fleet build blocked 24 bare `lua …` calls (all in the agent's own folder), each a turn.
  describe('a fleet with ONE agent folder: a bare command in that folder can only mean that agent', () => {
    const one = () => ['alpha'];
    const two = () => ['alpha', 'beta'];
    test.each([
      ['lua test skill --ci --name t --input \'{}\' 2>&1 | tail -8', `${FLEET}/alpha`],
      ['lua push agent --ci --force 2>&1 | tail -6', `${FLEET}/alpha`],
      ['for t in a b; do lua test skill --ci --name $t --input \'{}\'; done', `${FLEET}/alpha`],
      ['lua compile --ci', `${FLEET}/alpha/src/skills`],
    ])('%s (shell in %s) → allowed', (command, cwd) => {
      expect(sessionCommandDecision(command, SESSION, cwd, one)?.block).toBeFalsy();
    });

    test.each([
      ['lua compile --ci', `${FLEET}/alpha`, two],
      ['lua compile --ci', FLEET, one],
      ['cd ../beta && lua compile --ci', `${FLEET}/alpha`, one],
      ['lua compile --ci', `${FLEET}/beta`, one],
      ['lua compile --ci', `${FLEET}/alpha`, () => []],
    ])('%s (shell in %s, other folders or none) → still blocked', (command, cwd, folders) => {
      expect(sessionCommandDecision(command, SESSION, cwd, folders)?.block).toBe(true);
    });

    test('the folders are read only when a bare lua command needs them', () => {
      const folders = jest.fn(one);
      sessionCommandDecision(`cd ${FLEET}/alpha && lua compile --ci`, SESSION, `${FLEET}/alpha`, folders);
      sessionCommandDecision('git status', SESSION, `${FLEET}/alpha`, folders);
      expect(folders).not.toHaveBeenCalled();
    });

    test('fleetAgentFolders lists the directories under the fleet dir, hidden ones and files left out', () => {
      const root = mkdtempSync(join(tmpdir(), 'fleet-'));
      mkdirSync(join(root, 'alpha'));
      mkdirSync(join(root, '.cache'));
      writeFileSync(join(root, 'notes.md'), '');
      expect(fleetAgentFolders(root)).toEqual(['alpha']);
      expect(fleetAgentFolders(join(root, 'missing'))).toEqual([]);
    });
  });

  test('a fleet folder named by the cd itself counts even when the hook gives no cwd', () => {
    expect(sessionCommandDecision(`cd ${FLEET}/a && lua compile --ci`, SESSION)).toBeNull();
    expect(sessionCommandDecision(`cd ${FLEET} && lua compile --ci`, SESSION)?.block).toBe(true);
  });
});

// F36 (build-session QA fleet 08): 23 FLEET_FOLDER_UNPINNED blocks; the builder retried `lua compile` / `lua apps new`
// 5-9 times, stripping flags, because the message showed `cd /workspace/fleet/<agent> && …` and not the command to run.
describe('F36: FLEET_FOLDER_UNPINNED names the exact command, and lua-cli --dir / --all-agents are pinned forms', () => {
  const FLEET = '/workspace/fleet';
  const two = () => ['lead-intake', 'revenue-fleet-manager'];
  const fixOf = (reason) => /(?:Run exactly this|in front): `([^`]+)`/.exec(reason)?.[1];

  test.each([
    ['lua compile --ci 2>&1 | tail -15', `${FLEET}/revenue-fleet-manager`],
    ['timeout 590 lua compile --ci 2>&1 | tail -40', `${FLEET}/revenue-fleet-manager`],
    ['lua apps new pipeline-studio --ci', `${FLEET}/revenue-fleet-manager`],
    ["cp src/index.ts /tmp/i.ts && timeout 580 lua apps new pipeline-studio --ci 2>&1 | tail -30", `${FLEET}/revenue-fleet-manager`],
  ])('fleet 08 %s → "Run exactly this" with the shell folder, and that command is allowed', (command, cwd) => {
    const d = sessionCommandDecision(command, SESSION, cwd, two);
    expect(d?.block).toBe(true);
    const fix = fixOf(d.reason);
    expect(fix).toBe(`cd ${cwd} && ${command}`);
    expect(sessionCommandDecision(fix, SESSION, cwd, two)?.block).toBeFalsy();
  });

  test('from the fleet root it names the real agent folders, and each filled-in command is allowed', () => {
    const d = sessionCommandDecision('lua test skill --ci --name t --input \'{"a": 1}\'', SESSION, FLEET, two);
    expect(d.reason).toMatch(/<agent> is one of: lead-intake, revenue-fleet-manager/);
    const fix = fixOf(d.reason);
    expect(fix).toBe(`cd ${FLEET}/<agent> && lua test skill --ci --name t --input '{"a": 1}'`);
    for (const a of two()) {
      expect(sessionCommandDecision(fix.replace('<agent>', a), SESSION, FLEET, two)?.block).toBeFalsy();
    }
  });

  test('a multi-line command is suggested in its argv form, so the fence holds', () => {
    const d = sessionCommandDecision('lua compile --ci\necho `date`', SESSION, `${FLEET}/lead-intake`, two);
    expect(fixOf(d.reason)).toBe(`cd ${FLEET}/lead-intake && lua compile --ci`);
  });

  test('lua init (fleet 08 seq 51/59) is told to make the new folder first', () => {
    const d = sessionCommandDecision('cd /workspace/fleet && lua init --ci --agent-name "Lead Intake"', SESSION, FLEET, two);
    expect(d.reason).toMatch(/mkdir -p \/workspace\/fleet\/<new-agent> && cd \/workspace\/fleet\/<new-agent> && lua init --ci --agent-name 'Lead Intake'/);
  });

  test.each([
    [`lua compile --ci --dir ${FLEET}/lead-intake`, FLEET],
    [`lua --dir ${FLEET}/lead-intake compile --ci`, `${FLEET}/revenue-fleet-manager`],
    [`lua compile --ci --dir=${FLEET}/lead-intake 2>&1 | tail -5`, FLEET],
    [`cd ${FLEET} && lua push all --all-agents --ci --force`, `${FLEET}/lead-intake`],
    ['lua push all --all-agents --ci --force', FLEET],
  ])('%s (shell in %s) → allowed', (command, cwd) => {
    expect(sessionCommandDecision(command, SESSION, cwd, two)?.block).toBeFalsy();
  });

  test.each([
    [`lua compile --ci --dir ${FLEET}`, FLEET],
    ['lua compile --ci --dir lead-intake', FLEET],
    ['lua compile --ci --dir "$D"', FLEET],
    ['lua push all --all-agents --ci --force', `${FLEET}/lead-intake`],
    ['lua chat -e sandbox -m --all-agents -t', FLEET],
    [`lua push all --all-agents --ci --force; cd ${FLEET}/lead-intake && lua compile --ci; cd .. && lua compile --ci`, FLEET],
  ])('%s (shell in %s) → still blocked', (command, cwd) => {
    expect(sessionCommandDecision(command, SESSION, cwd, two)?.block).toBe(true);
  });

  test('--dir is a value flag for the classifier, before or after the command', () => {
    expect(classifyLuaCommand(['--dir', `${FLEET}/a`, 'compile', '--ci'])).toMatchObject({ ruleId: 'compile' });
    expect(classifyLuaCommand(['push', 'all', '--dir', `${FLEET}/a`, '--ci'])).toMatchObject({ ruleId: 'push' });
    expect(classifyLuaCommand(['--dir'])).toMatchObject({ ruleId: 'default', class: 'approval' });
  });
});

describe('fleet folder guard: every lua command in a chain is checked', () => {
  test.each([
    'cd /workspace/fleet/a && lua compile --ci; cd ../b && lua compile --ci',
    'cd /workspace/fleet/a && lua compile --ci && lua push all --ci --force; cd b; lua status',
    'cd /workspace/fleet/a && lua compile --ci; cd "$B" && lua compile --ci',
  ])('blocks %s', (command) => {
    expect(sessionCommandDecision(command, SESSION, '/workspace/fleet')?.block).toBe(true);
  });
  test.each([
    'cd /workspace/fleet/a && lua compile --ci; cd /workspace/fleet/b && lua compile --ci',
    'cd /workspace/fleet/a && lua compile --ci && lua test skill --name t --input "{}" --ci',
    'cd /workspace/fleet/a && (lua compile --ci 2>&1 | tail -3)',
  ])('allows %s', (command) => {
    expect(sessionCommandDecision(command, SESSION, '/workspace/fleet')?.block).toBeFalsy();
  });
});

// LUA-2372 (prod 20-27 Nov: 872 FLEET_FOLDER_UNPINNED refusals in 51 builds; `integrations info|available` about 1 in
// 16 of them): a catalog read is the same from every agent folder, and a relative `cd` gets its absolute fix.
describe('LUA-2372: folder-free catalog reads pass; a relative cd is told its absolute folder', () => {
  const FLEET = '/workspace/fleet';
  const two = () => ['front-desk', 'kitchen'];
  const fixOf = (reason) => /Run exactly this: `([^`]+)`/.exec(reason)?.[1];

  test.each([
    'lua integrations info hubspot --json',
    'lua integrations available --ci',
    'lua integrations catalog',
    'lua integrations inspect google-calendar --json 2>&1 | head -40',
    'lua integrations info hubspot --json && lua integrations info slack --json',
  ])('%s (shell in an agent folder) → allowed', (command) => {
    expect(sessionCommandDecision(command, SESSION, `${FLEET}/kitchen`, two)?.block).toBeFalsy();
  });

  test.each([
    ['lua integrations info hubspot --json', FLEET],
    ['lua integrations list --json', `${FLEET}/kitchen`],
    ['lua integrations connect --integration hubspot', `${FLEET}/kitchen`],
    ['lua integrations info hubspot && lua compile --ci', `${FLEET}/kitchen`],
    ['lua channels list --ci', `${FLEET}/kitchen`],
  ])('%s (shell in %s) → still blocked', (command, cwd) => {
    expect(sessionCommandDecision(command, SESSION, cwd, two)?.block).toBe(true);
  });

  test.each([
    ['cd kitchen && lua compile --ci', FLEET, 'kitchen'],
    ['cd ../kitchen && lua push skill --name menu --ci --force', `${FLEET}/front-desk`, 'kitchen'],
    ['cd .. && cd kitchen && lua compile --ci 2>&1 | tail -5', `${FLEET}/front-desk`, 'kitchen'],
  ])('%s (shell in %s) → blocked, and the fix names %s absolutely and is allowed', (command, cwd, folder) => {
    const d = sessionCommandDecision(command, SESSION, cwd, two);
    expect(d?.block).toBe(true);
    const fix = fixOf(d.reason);
    expect(fix).toMatch(new RegExp(`^cd ${FLEET}/${folder} && lua `));
    expect(sessionCommandDecision(fix, SESSION, FLEET, two)?.block).toBeFalsy();
  });

  test('a relative cd to a folder that is not an agent keeps the general wording', () => {
    const d = sessionCommandDecision('cd nowhere && lua compile --ci', SESSION, FLEET, two);
    expect(d.reason).toMatch(/<agent> is one of: front-desk, kitchen/);
  });
});

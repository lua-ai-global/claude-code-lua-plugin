// Parity fixture for lib/session-commands.mjs, the vendored B23 command table.
//
// The tables below are copied VERBATIM from lua-core-services
// packages/shared-types/src/build-sessions/commands.spec.ts at commit
// 7c53151b5171501383980f873536bd9ec52ea8b7 (feat/live-build-sessions), plus the
// case-insensitive / alias rows of b4be3b9b (feat/lbs/plugin-session-mode), which this
// mirror keeps although the integration branch does not have them yet. When the
// shared table changes, port the change into lib/session-commands.mjs and the
// new spec rows here; a row that fails here means the mirror has drifted.

import { describe, test, expect } from '@jest/globals';
import {
  BUILD_SESSION_COMMAND_CLASSES,
  BUILD_SESSION_COMMAND_RULES,
  WORKFLOW_SECRET_KEY_RE,
  classifyLuaCommand,
  flagValue,
  isSecretKeyName,
  normaliseLuaArgv,
} from '../../lib/session-commands.mjs';

const cls = (cmd) => classifyLuaCommand(cmd.split(' ')).class;

describe('B23 command classes (shared spec parity)', () => {
  test.each([
    'lua status',
    'lua compile',
    'lua test',
    'lua logs --follow',
    'lua workflows list',
    'lua workflows runs wf1',
    'lua workflows job-logs r1',
    'lua version list',
    'lua version diff 3 4',
    'lua source list',
    'lua integrations list',
    'lua integrations inspect slack',
    'lua integrations connections',
    'lua env production --list',
    'lua evals list',
    'lua decisions versions d1',
    'lua skills',
    'lua webhooks',
    'lua mcp list',
    'lua channels',
    'lua resources list',
    'lua production',
    'lua devices list',
    'lua devices logs d1',
    'lua drains status',
    'lua drains deliveries x',
    'lua marketplace template view t1',
    'lua marketplace template versions t1',
  ])('%s → direct_read', (cmd) => expect(cls(cmd)).toBe('direct_read'));

  test.each([
    'lua push skill',
    'lua push backup',
    'lua sync --pull',
    'lua init --restore-sources',
    'lua apps preview web',
    'lua test workflow wf1',
    'lua evals run suite',
    'lua chat -e sandbox -m hi',
    'lua chat -m hi',
  ])('%s → session_write', (cmd) => expect(cls(cmd)).toBe('session_write'));

  test.each([
    'lua deploy',
    'lua version promote 5',
    'lua persona publish',
    'lua env production -k LOG_LEVEL -v debug',
    'lua env production -k LOG_LEVEL --delete',
    'lua integrations connect slack',
    'lua integrations disconnect c1',
    'lua mcp activate m1',
    'lua channels add whatsapp',
    'lua resources create r',
    'lua decisions publish d1 3',
    'lua decisions delete d1',
    'lua drains create',
    'lua drains rotate-secret d1',
    'lua webhooks activate w1',
    'lua skills activate s1',
    'lua workflows start wf1',
    'lua workflows approve wfa_1',
    'lua workflows cancel r1',
    'lua marketplace template publish t1',
    'lua marketplace template apply t1',
    'lua chat -e production -m hi',
    'lua something-new --flag',
  ])('%s → approval', (cmd) => expect(cls(cmd)).toBe('approval'));

  test.each([
    'lua env production -k STRIPE_SECRET_KEY -v sk_live_x',
    'lua env sandbox -k API_TOKEN -v x',
    'lua devices credential d1',
    // lua-cli `devices.action` aliases (`credentials`, `key`) and case-insensitive action words (`normalizeArg`).
    'lua devices credentials d1',
    'lua devices key d1',
    'lua devices CREDENTIAL d1',
    'lua devices Key d1',
    // `--out <file>` does not change the class: the value would still land in the pod.
    'lua devices credential d1 --out .dev.env',
    'lua devices credentials d1 --out .dev.env',
    'lua devices key d1 --out .dev.env',
    'lua devices CREDENTIAL d1 --out .dev.env',
    'lua devices credentials d1 --out=.dev.env',
    // F011: `--operations` takes a value, so the subcommand is still `credential` / `key`.
    'lua devices --operations commands credential',
    // (`lua devices` has no `key` action — lua-cli commands/devices.ts DeviceAction — so the triage's `key` row is the
    // credential verb with a device named d1.)
    'lua devices --operations=commands credential d1 --out .dev.env',
    'lua devices --operations commands,triggers credential d1 --out .dev.env',
    // Plugin-only (alias kept here): the triage row verbatim.
    'lua devices --operations=commands key --out .dev.env',
    'lua devices --operations commands key d1',
  ])('%s → secret', (cmd) => expect(cls(cmd)).toBe('secret'));

  test.each(['lua auth configure', 'lua admin', 'lua docs', 'lua update', 'lua destroy'])('%s → unavailable', (cmd) =>
    expect(cls(cmd)).toBe('unavailable')
  );

  test('lua build-session is not available inside a session, except the status read', () => {
    for (const verb of ['start', 'attach', 'send', 'stop', 'try', 'release', 'end', 'zzz-new-verb']) {
      expect(classifyLuaCommand(['lua', 'build-session', verb])).toMatchObject({
        class: 'unavailable',
        ruleId: 'build-session',
      });
    }
    expect(classifyLuaCommand(['lua', 'build-session', 'release', '--approve']).class).toBe('unavailable');
    expect(classifyLuaCommand(['lua', 'build-session']).class).toBe('unavailable');
    expect(classifyLuaCommand(['lua', 'build-session', 'status', 'bs_abc'])).toMatchObject({
      class: 'direct_read',
      ruleId: 'build-session.read',
    });
  });

  test('--operations takes a value: its list is never read as the devices verb', () => {
    expect(classifyLuaCommand(['lua', 'devices', '--operations', 'commands', 'list']).class).toBe('direct_read');
    expect(classifyLuaCommand(['npx', 'lua-cli', 'devices', '--operations', 'commands', 'credential'])).toMatchObject({
      class: 'secret',
      ruleId: 'devices.credential',
    });
  });

  test('any delete is approval with critical risk, even under a read command', () => {
    expect(classifyLuaCommand(['lua', 'skills', 'delete', 's1'])).toMatchObject({ class: 'approval', risk: 'critical' });
    expect(classifyLuaCommand(['lua', 'push', 'skill', '--delete'])).toMatchObject({ class: 'approval', risk: 'critical' });
  });

  test('matches action words case-insensitively, like lua-cli normalizeArg', () => {
    expect(classifyLuaCommand(['lua', 'skills', 'DELETE', 's1'])).toMatchObject({ class: 'approval', risk: 'critical' });
    expect(classifyLuaCommand(['lua', 'skills', 'Activate', 's1'])).toMatchObject({ class: 'approval' });
    expect(classifyLuaCommand(['lua', 'devices', 'LIST']).class).toBe('direct_read');
    // Flag values keep their case: the env key is still read from the raw argv.
    expect(cls('lua env production -k Stripe_Secret_Key -v x')).toBe('secret');
  });

  test('unknown commands fail closed to approval, never direct_read', () => {
    expect(classifyLuaCommand(['lua', 'frobnicate'])).toEqual({ class: 'approval', ruleId: 'default', risk: 'high' });
    expect(classifyLuaCommand([])).toMatchObject({ class: 'approval' });
  });

  test('accepts argv with or without the leading lua', () => {
    expect(classifyLuaCommand(['status']).class).toBe('direct_read');
    expect(classifyLuaCommand(['npx', 'lua', 'status']).class).toBe('direct_read');
  });
});

describe('B23 fail-open guards (shared spec parity)', () => {
  test.each([
    ['lua push skill --auto-deploy', 'high'],
    ['lua init', 'medium'],
    ['lua integrations mcp activate m1', 'medium'],
    ['lua integrations webhooks create', 'medium'],
    ['lua integrations triggers pause t1', 'medium'],
    ['lua webhooks --agent a1 activate w1', 'medium'],
    ['lua skills production deploy', 'high'],
    ['lua persona production deploy', 'high'],
    ['lua workflows run wf1', 'medium'],
    ['lua workflows replay r1', 'medium'],
    ['lua workflows schedules create', 'medium'],
    ['lua models set', 'medium'],
    ['lua features enable x', 'medium'],
    ['lua devices test', 'medium'],
    ['lua devices enable', 'medium'],
    ['lua triggers rotate-token t1', 'high'],
    ['lua marketplace skill install s1', 'high'],
    ['lua apps delete web', 'critical'],
    ['lua integrations webhooks delete', 'critical'],
  ])('%s -> approval (%s)', (cmd, risk) => {
    expect(classifyLuaCommand(cmd.split(' '))).toMatchObject({ class: 'approval', risk });
  });

  test.each([
    'lua skills production view',
    'lua persona sandbox versions',
    'lua integrations webhooks list',
    'lua integrations mcp list',
    'lua chat -m deploy',
    'lua logs --type webhooks --limit 5',
    'lua workflows --json list',
  ])('%s stays a read or session write', (cmd) => {
    expect(['direct_read', 'session_write']).toContain(classifyLuaCommand(cmd.split(' ')).class);
  });

  // Top-level commands registered in lua-cli src/cli/command-definitions.ts (program.command(...)).
  test.each([
    'admin', 'agents', 'apps', 'auth', 'browser', 'browsers', 'build-session', 'channels', 'chat', 'compile', 'completion',
    'decisions', 'deploy', 'devices', 'docs', 'drains', 'env', 'evals', 'features', 'governance', 'init',
    'integrations', 'jobs', 'logs', 'marketplace', 'mcp', 'models', 'persona', 'postprocessors', 'preprocessors',
    'production', 'push', 'resources', 'skills', 'source', 'status', 'sync', 'telemetry', 'test', 'triggers',
    'update', 'version', 'voice', 'webhooks', 'workflows',
  ])('lua %s reaches a named rule, with and without an unknown verb', (cmd) => {
    expect(classifyLuaCommand(['lua', cmd]).ruleId).not.toBe('default');
    const unknownVerb = classifyLuaCommand(['lua', cmd, 'zzz-new-verb']);
    expect(unknownVerb.ruleId).not.toBe('default');
    // compile / logs / status / test take positional ARGUMENTS, not verbs (`lua test skill`, `lua logs export`).
    const takesArguments = ['compile', 'logs', 'status', 'test'].includes(cmd);
    expect(takesArguments || unknownVerb.class !== 'direct_read').toBe(true);
  });
});

describe('the plugin forms of the commands its slash commands run', () => {
  test.each([
    ["lua chat --ci -e sandbox -m 'hi' -t", 'session_write'],
    ['lua push skill --ci --force --name ticket-triage', 'session_write'],
    ['lua env production --ci --list', 'direct_read'],
    ['lua logs --ci --json --type all --limit 30', 'direct_read'],
    ['lua version list --json', 'direct_read'],
    ['lua integrations mcp list --ci', 'direct_read'],
    ['lua drains list --json', 'direct_read'],
    ['lua env production --ci -k LOG_LEVEL -v debug', 'approval'],
    ['lua env production --ci -k STRIPE_API_KEY -v x', 'secret'],
    ['lua env production --ci -k ANY_KEY --value=x', 'approval'],
    ['lua env production --ci -v x', 'secret'],
    ['lua init --ci --restore', 'session_write'],
  ])('%s → %s', (cmd, expected) => {
    expect(classifyLuaCommand(cmd.split(' ')).class).toBe(expected);
  });
});

describe('helpers', () => {
  test('the class list is the shared one', () => {
    expect(BUILD_SESSION_COMMAND_CLASSES).toEqual(['direct_read', 'session_write', 'approval', 'secret', 'unavailable']);
  });

  test('every rule names a known class; ids are unique but for the one the shared table repeats', () => {
    const seen = new Map();
    for (const r of BUILD_SESSION_COMMAND_RULES) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
    // The shared table has an explicit `integrations.write` row AND the `integrations` catch-all of the same id
    // (commands.ts at 162935cf). Mirrored as-is; the first match wins, so the id only labels the result.
    expect([...seen].filter(([, n]) => n > 1).map(([id]) => id)).toEqual(['integrations.write']);
    for (const r of BUILD_SESSION_COMMAND_RULES) expect(BUILD_SESSION_COMMAND_CLASSES).toContain(r.class);
  });

  test('normaliseLuaArgv drops npx / lua / lua-cli and non-strings', () => {
    expect(normaliseLuaArgv(['npx', 'lua-cli', 'status'])).toEqual(['status']);
    expect(normaliseLuaArgv(['lua', 1, 'logs'])).toEqual(['logs']);
    expect(normaliseLuaArgv(null)).toEqual([]);
  });

  test('flagValue reads `-k X` and `--key=X`', () => {
    expect(flagValue(['-k', 'A'], '-k', '--key')).toBe('A');
    expect(flagValue(['--key=B'], '-k', '--key')).toBe('B');
    expect(flagValue(['x'], '-k')).toBeUndefined();
  });

  test.each([
    ['STRIPE_SECRET_KEY', true], ['API_TOKEN', true], ['apiKey', true], ['password', true], ['DB_PASSWORD', true],
    ['LOG_LEVEL', false], ['tokens', false], ['tokenCount', false], ['SORT_KEY', false],
  ])('secret key %s → %p (shared WORKFLOW_SECRET_KEY_RE)', (key, expected) => {
    expect(isSecretKeyName(key)).toBe(expected);
    expect(WORKFLOW_SECRET_KEY_RE.test(key)).toBe(expected);
  });
});

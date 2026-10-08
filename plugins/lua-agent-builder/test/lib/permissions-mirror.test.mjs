// Pins the two layers of the production gate to each other and to Claude
// Code's DOCUMENTED permission semantics (code.claude.com/docs/en/permissions,
// verified live on 2026-09-12 with `claude -p` and scratch settings files):
//
//   * "A deny or ask rule matches past any leading assignment, so
//     `Bash(rm *)` in deny still matches `FOO=bar rm -rf tmp/`."
//   * an allow rule matches past an assignment only for a short list of
//     known-safe variables (NODE_ENV …) — `LUA_DEPLOY_CONFIRMED` is not one,
//     so the allow rule must spell the prefix literally.
//   * "Hook decisions don't bypass permission rules" — a PreToolUse `allow`
//     cannot rescue a command a deny/ask rule matches.
//
// Consequences the test enforces:
//   1. lib/tokenizer.mjs (the hook layer) classifies EVERY spelling of every
//      production verb — canonical, CLI alias, and all three binaries.
//   2. lib/permissions-template.json must NOT carry a deny or ask rule that
//      matches a bare production verb: because deny/ask see through the env
//      prefix, such a rule would also block the user-confirmed
//      `LUA_DEPLOY_CONFIRMED=1 …` form and make every deploy impossible
//      (this is exactly what the 2026-09-12 live E2E run hit).
//   3. The prefixed canonical forms the slashes emit must match an allow rule,
//      and no allow rule may admit a bare production verb.
//
// The spellings come from lua-cli 3.33.0 src/utils/aliases.ts and
// src/cli/command-definitions.ts (and package.json `bin`).

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyProductionCommand, PRODUCTION_COMMANDS, SMOKE_LABELS } from '../../lib/tokenizer.mjs';
import { cacheCliPath } from './qa/fixtures/plugin-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const template = JSON.parse(readFileSync(join(here, '../../lib/permissions-template.json'), 'utf8'));
const { allow, ask, deny } = template.permissions;

/** Claude Code permission glob → predicate. `*` is the only wildcard; everything else is literal. */
function globToPredicate(rule) {
  const m = rule.match(/^Bash\((.*)\)$/s);
  if (!m) return () => false; // mcp__… rules never match a Bash command
  const re = new RegExp('^' + m[1].split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's');
  return (cmd) => re.test(cmd);
}

/** What deny/ask evaluation sees: the command with any leading `env` / `VAR=value` assignments removed. */
const stripLeadingAssignments = (cmd) => cmd.trimStart().replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');

const matchesAllow = (cmd) => allow.some((r) => globToPredicate(r)(cmd));
const matchesRestrictive = (rules, cmd) => rules.some((r) => {
  const p = globToPredicate(r);
  return p(cmd) || p(stripLeadingAssignments(cmd));
});

// Every production verb spelling a user (or the model) could type. Each is a
// realistic full command, as the CLI would accept it.
const CANONICAL = [
  ['lua deploy skill --ci --name x --set-version latest --force', 'lua deploy'],
  ['lua deploy all --force', 'lua deploy'],
  ['lua skills deploy --skill-name x --skill-version latest', 'lua skills deploy'],
  // lua-cli 3.44.0: the production-env spelling deploys non-interactively.
  ['lua skills production deploy --skill-name x --skill-version 1.2.0', 'lua skills production deploy'],
  ['lua webhooks deploy --webhook-name x', 'lua webhooks deploy'],
  ['lua jobs deploy -i x -v latest', 'lua jobs deploy'],
  ['lua preprocessors deploy --preprocessor-name x', 'lua preprocessors deploy'],
  ['lua postprocessors deploy --postprocessor-name x', 'lua postprocessors deploy'],
  ['lua persona production deploy --persona-version latest --force', 'lua persona production deploy'],
  ['lua workflows deploy outreach -v latest', 'lua workflows deploy'],
  ['lua workflows activate outreach', 'lua workflows activate'],
  ['lua version promote 3', 'lua version promote'],
  ['lua mcp activate fs', 'lua mcp activate'],
  ['lua marketplace template publish --template-id t', 'lua marketplace template publish'],
  ['lua marketplace template apply --template-id t --all-installed --force', 'lua marketplace template apply'],
];

const ALIASES = [
  ['lua skills publish --skill-name x --skill-version latest', 'lua skills deploy'],
  ['lua skills prod deploy --skill-name x --skill-version 1.2.0', 'lua skills production deploy'],
  ['lua skills prd publish --skill-name x --skill-version 1.2.0', 'lua skills production deploy'],
  ['lua skills live deploy --skill-name x --skill-version 1.2.0', 'lua skills production deploy'],
  ['lua skills PRODUCTION Deploy --skill-name x --skill-version 1.2.0', 'lua skills production deploy'],
  ['lua webhooks publish --webhook-name x', 'lua webhooks deploy'],
  ['lua jobs publish -i x -v latest', 'lua jobs deploy'],
  ['lua preprocessors publish --preprocessor-name x', 'lua preprocessors deploy'],
  ['lua postprocessors publish --postprocessor-name x', 'lua postprocessors deploy'],
  ['lua persona production publish --persona-version 5', 'lua persona production deploy'],
  ['lua persona prod deploy --persona-version 5', 'lua persona production deploy'],
  ['lua persona prd publish --persona-version 5', 'lua persona production deploy'],
  ['lua persona live deploy --persona-version 5', 'lua persona production deploy'],
  ['lua workflows publish outreach -v latest', 'lua workflows deploy'],
  ['lua workflows on outreach', 'lua workflows activate'],
  ['lua workflows enable outreach -v 2.0.0', 'lua workflows activate'],
  ['lua mcp on fs', 'lua mcp activate'],
  ['lua mcp enable fs', 'lua mcp activate'],
  ['lua marketplace template publish_version --template-id t', 'lua marketplace template publish'],
  ['lua marketplace template submit --template-id t', 'lua marketplace template publish'],
  ['lua marketplace template deploy --template-id t --agents a --force', 'lua marketplace template apply'],
  ['lua marketplace template fleet-apply --template-id t --all-installed --force', 'lua marketplace template apply'],
  ['lua marketplace template rollout --template-id t --all-installed --force', 'lua marketplace template apply'],
];

const BINARIES = CANONICAL.flatMap(([cmd, label]) => [
  [cmd.replace(/^lua /, 'heylua '), label],
  [cmd.replace(/^lua /, 'lua-ai '), label],
]);

const ALL = [...CANONICAL, ...ALIASES, ...BINARIES];

describe('hook layer (lib/tokenizer.mjs)', () => {
  test.each(ALL)('classifies %s', (cmd, label) => {
    expect(classifyProductionCommand(cmd)).toEqual({ label, slash: expect.stringMatching(/^\/lua-/), prefixed: false });
    expect(classifyProductionCommand(`LUA_DEPLOY_CONFIRMED=1 ${cmd}`)?.prefixed).toBe(true);
  });

  test('every PRODUCTION_COMMANDS label is exercised above and SMOKE_LABELS ⊆ labels', () => {
    const labels = new Set(PRODUCTION_COMMANDS.map((e) => e.label));
    const covered = new Set(ALL.map(([, label]) => label));
    expect([...labels].sort()).toEqual([...covered].sort());
    for (const l of SMOKE_LABELS) expect(labels.has(l)).toBe(true);
    // Activation-only verbs make nothing newly live on their own → no smoke ping.
    expect(SMOKE_LABELS.has('lua workflows activate')).toBe(false);
    expect(SMOKE_LABELS.has('lua marketplace template publish')).toBe(false);
    expect(SMOKE_LABELS.has('lua marketplace template apply')).toBe(false);
  });
});

describe('permission layer (lib/permissions-template.json) under Claude Code semantics', () => {
  test.each(CANONICAL)('the confirmed form of %s is allowed and shadowed by no deny/ask rule', (cmd) => {
    const prefixed = `LUA_DEPLOY_CONFIRMED=1 ${cmd}`;
    expect({ cmd: prefixed, allowed: matchesAllow(prefixed) }).toEqual({ cmd: prefixed, allowed: true });
    // deny/ask rules match past the env assignment — a hit here would block every deploy.
    expect({ cmd: prefixed, denied: matchesRestrictive(deny, prefixed) }).toEqual({ cmd: prefixed, denied: false });
    expect({ cmd: prefixed, asked: matchesRestrictive(ask, prefixed) }).toEqual({ cmd: prefixed, asked: false });
  });

  test('no allow rule admits an unprefixed production verb (in any spelling)', () => {
    for (const [cmd] of ALL) {
      expect({ cmd, allowed: matchesAllow(cmd) }).toEqual({ cmd, allowed: false });
    }
  });

  test('no deny or ask rule names a bare `lua` production verb (it would also match the confirmed form)', () => {
    for (const [cmd] of [...CANONICAL, ...ALIASES]) {
      expect({ cmd, denied: matchesRestrictive(deny, cmd) }).toEqual({ cmd, denied: false });
      expect({ cmd, asked: matchesRestrictive(ask, cmd) }).toEqual({ cmd, asked: false });
    }
  });

  test('the read-only MCP tools are pre-approved under the plugin-scoped name Claude Code gives them', () => {
    expect(allow).toEqual(expect.arrayContaining([
      'mcp__plugin_lua-agent-builder_lua-platform',
      'mcp__plugin_lua-agent-builder_lua-docs__search_lua_cli',
      'mcp__plugin_lua-agent-builder_lua-docs__query_docs_filesystem_lua_cli',
    ]));
    expect(allow).not.toContain('mcp__plugin_lua-agent-builder_lua-docs');
    expect(allow.some((r) => /submit_feedback/.test(r))).toBe(false);
  });

  test('the alternative binaries are denied wholesale (the plugin never emits them)', () => {
    for (const [cmd] of BINARIES) {
      expect({ cmd, denied: matchesRestrictive(deny, cmd) }).toEqual({ cmd, denied: true });
    }
  });

  test('--auto-deploy is denied in every push/deploy shape, prefix or not', () => {
    for (const cmd of [
      'lua push skill --ci --force --auto-deploy',
      'lua push all --auto-deploy',
      'lua push webhook --name x --auto-deploy=true',
      'LUA_DEPLOY_CONFIRMED=1 lua deploy all --auto-deploy',
    ]) {
      expect({ cmd, denied: matchesRestrictive(deny, cmd) }).toEqual({ cmd, denied: true });
    }
  });

  test('credential commands are denied, never allowed or merely asked', () => {
    for (const cmd of ['lua auth configure', 'lua auth configure --api-key x', 'lua auth key', 'lua auth key --force', 'lua auth logout', 'X=1 lua auth key']) {
      expect({ cmd, denied: matchesRestrictive(deny, cmd) }).toEqual({ cmd, denied: true });
      expect(matchesAllow(cmd)).toBe(false);
    }
  });

  test('the non-production verbs the slashes emit are allowed, not denied or asked', () => {
    for (const cmd of [
      'lua models list --json --ci',
      'lua compile --ci',
      'lua test --ci skill --name get_weather --input \'{"city":"London"}\' --json',
      'lua push all --ci --force',
      'lua push skill --name x --ci --force --set-version 1.2.3',
      'lua status --json --ci',
      'lua chat --ci -e production -m ping -t lua-plugin-smoke-1',
      'lua logs --ci --type all --limit 20 --json',
      // lua-cli 3.38.0: the `lua logs` read window, and the log-drain READ verbs
      // (`test` sends one record down the real path but changes no configuration).
      'lua logs --ci --type workflow-step --since 15m --environment production --json',
      'lua drains list --json',
      'lua drains status drn_9f31a7c04b2e615d8a03cc71 --json',
      'lua drains deliveries drn_9f31a7c04b2e615d8a03cc71 --limit 20 --kind batch --json',
      'lua drains test drn_9f31a7c04b2e615d8a03cc71 --json',
      // Devices (1.7.0): the read verbs /lua-devices emits, and the device log sources.
      'lua devices list --ci',
      'lua devices list --ci --group printers',
      'lua devices status --ci --device-name pico-sensor',
      'lua logs --ci --json --type device-trigger --limit 20',
      'lua logs --ci --json --type device --limit 20 --since 15m',
      'lua workflows run outreach --input @in.json --agents fake --fast-retries --json',
      'lua workflows watch run_1 --wait-for-human --timeout 900',
      // lua-cli 3.36.0: the org policy READ verbs (`policy models|autonomy get`) are read-only.
      'lua workflows policy models get --ci',
      'lua workflows policy autonomy get --json --ci',
      'lua models list --workflows --json --ci',
      'lua version create --ci -m "deploy via plugin"',
      'lua version list --json',
      'git status --short',
    ]) {
      expect({ cmd, allowed: matchesAllow(cmd), denied: matchesRestrictive(deny, cmd), asked: matchesRestrictive(ask, cmd) })
        .toEqual({ cmd, allowed: true, denied: false, asked: false });
      expect(classifyProductionCommand(cmd)).toBeNull();
    }
  });

  test('reversible run-control and deactivation verbs sit in ask (the single confirmation /lua-workflow relies on)', () => {
    for (const cmd of [
      'lua workflows start outreach --input @in.json --follow',
      'lua workflows approve run_1 --approval wfa_1 --decision approve',
      'lua workflows signal run_1 ready --payload {}',
      'lua workflows cancel run_1 --reason stop',
      'lua workflows resume run_1 --step s1 --data {}',
      'lua workflows deactivate outreach',
      'lua workflows off outreach',
      // lua-cli 3.36.0: an org-wide policy write, the model_policy gate clear (and its
      // `ungate` alias) and a recompose (publishes a new version) all confirm once via the prompt.
      'lua workflows policy autonomy set --enabled on --max-credits 40',
      'lua workflows policy models set --compose on --max-class strong',
      'lua workflows clear-gate run_1 --kind model_policy',
      'lua workflows ungate run_1 --kind model_policy',
      'lua workflows recompose outreach',
      'lua mcp deactivate fs',
      'lua mcp off fs',
      'lua chat clear',
      'lua devices enable --device-name gate',
      'lua marketplace skill publish --skill-name x',
      'lua marketplace skill transfer --skill-name x --to-org o',
      'lua env production -k KEY -v value',
      // lua-cli 3.38.0: every `lua drains` verb that changes the ORGANIZATION's drain
      // configuration. They are not production verbs (the tokenizer classifies them as
      // null, asserted below) — the ask prompt IS /lua-drains's single confirmation.
      'lua drains create --ci --json --name prod-siem --type http --endpoint https://logs.example.com/lua',
      'lua drains update drn_9f31a7c04b2e615d8a03cc71 --ci --json --min-severity warn',
      'lua drains delete drn_9f31a7c04b2e615d8a03cc71 --ci --json --yes',
      'lua drains verify drn_9f31a7c04b2e615d8a03cc71 --json',
      'lua drains pause drn_9f31a7c04b2e615d8a03cc71 --reason noisy --json',
      'lua drains resume drn_9f31a7c04b2e615d8a03cc71 --json',
      'lua drains rotate-secret drn_9f31a7c04b2e615d8a03cc71 --json',
      'lua drains rotate-secret drn_9f31a7c04b2e615d8a03cc71 --finalize --json',
      // lua-cli 3.44.0: the bucket-ownership confirm and the batch replay change drain state too.
      'lua drains confirm drn_9f31a7c04b2e615d8a03cc71 --token tok_1',
      'lua drains replay drn_9f31a7c04b2e615d8a03cc71 01J0000000000000000000000',
      // lua-cli 3.44.0 `lua logs export`: an org-wide export that can carry message bodies. `--ci`
      // binds anywhere on the line, so the `lua logs --ci*` allow rule must not admit it.
      'lua logs export --since 24h --out ./logs-export',
      // Devices (1.7.0). Every verb that changes a device, sends a real command to hardware, fires a
      // live handler or issues a credential — in every alias spelling of `devices.action`.
      'lua devices disable --ci --device-name gate',
      'lua devices on --ci --device-name gate',
      'lua devices off --ci --device-name gate',
      'lua devices activate --ci --device-name gate',
      'lua devices deactivate --ci --device-name gate',
      'lua devices remove --ci --device-name gate --force',
      'lua devices rm --ci --device-name gate --force',
      'lua devices delete --ci --device-name gate --force',
      'lua devices del --ci --device-name gate --force',
      'lua devices test --ci --device-name gate --command open --payload {}',
      'lua devices run --ci --device-name gate --command open',
      'lua devices exec --ci --device-name gate --command open',
      'lua devices test-trigger --ci --device-name gate --trigger opened --payload {}',
      'lua devices test_trigger --ci --device-name gate --trigger opened',
      'lua devices credential --ci --device-name gate --out .env.device',
      'lua devices credentials --ci --device-name gate --out .env.device',
      'lua devices key --ci --device-name gate --out .env.device',
    ]) {
      expect({ cmd, asked: matchesRestrictive(ask, cmd), denied: matchesRestrictive(deny, cmd), allowed: matchesAllow(cmd) })
        .toEqual({ cmd, asked: true, denied: false, allowed: false });
      expect(classifyProductionCommand(cmd)).toBeNull();
    }
  });

  // Claude Code evaluates deny → ask → allow, so an `ask` row carves a confirmation out of a
  // broader `allow` row. These shapes rely on exactly that.
  test('ask rows that carve a confirmation out of a broader allow row', () => {
    for (const cmd of [
      // A pushed defineDevice is live on the next turn with no publish: the push is a go-live, so it
      // asks although `lua push * --ci --force*` is allowed. Every push-type alias of device(-trigger).
      'lua push device --ci --force --name gate',
      'lua push devices --ci --force --name gate',
      'lua push device-trigger --ci --force --name opened',
      'lua push device-triggers --ci --force --name opened',
      'lua push device_trigger --ci --force --name opened',
      'lua push devicetrigger --ci --force --name opened',
      'lua push devicetriggers --ci --force --name opened',
      // `--ci` binds anywhere on the line, so `lua logs --ci export` also matches `lua logs --ci*`.
      'lua logs --ci export --since 31d --include-content --yes --out ./x',
      // /lua-qa full: the production consent stamp is confirmed by Claude Code itself, although every other
      // helper call rides `node *lua-agent-builder*/lib/qa/cli.mjs *`.
      `node ${cacheCliPath()} gate --run-dir r --stamp environment --env production --metrics-file m --production-consent-text "I consent to running this against production"`,
    ]) {
      expect({ cmd, asked: matchesRestrictive(ask, cmd), denied: matchesRestrictive(deny, cmd) })
        .toEqual({ cmd, asked: true, denied: false });
      expect(classifyProductionCommand(cmd)).toBeNull();
    }
    // …and the carve-outs do not catch the ordinary pushes and log reads next to them.
    for (const cmd of ['lua push skill --ci --force --name devices', 'lua push all --ci --force', 'lua logs --ci --json --type device --limit 5', `node ${cacheCliPath()} record --run-dir r --production-consent abc`]) {
      expect({ cmd, asked: matchesRestrictive(ask, cmd), allowed: matchesAllow(cmd) }).toEqual({ cmd, asked: false, allowed: true });
    }
  });
});

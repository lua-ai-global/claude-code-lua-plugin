// The /lua-qa helper allow rule, in the permissions-mirror style: it admits the plugin's own cli.mjs
// from an installed cache path and from a --plugin-dir worktree; the guard hook blocks any other file
// with that name; the consent stamp asks; and the template still admits no bare production verb.
//
// Does Claude Code's `*` match across `/` in this rule? Yes, verified live on 2026-10-08.
// Docs (code.claude.com/docs/en/permissions, "Wildcard patterns"): "A `*` in a Bash rule matches any
// text, including spaces" and "Bash rules match the whole command text, with `*` standing in for any text."
// Live probe, Claude Code 2.1.293: `claude -p --setting-sources project --settings <file holding only
// this allow rule> --permission-mode default`, asked to run
// `node <tmp>/fake/lua-agent-builder/x/lib/qa/cli.mjs --help` (a dummy cli.mjs that only echoes): it ran
// with no permission denial, so both `*`s crossed several `/`. Controls with the same flags were refused
// ("This command requires approval"): that command with a `{}` settings file, and
// `node <tmp>/fake/other/x/lib/qa/cli.mjs --help` with the rule. The glob model below (`*` = any
// characters) matches that. Because the glob is this wide, hooks/guard-qa-helper.mjs (a realpath check)
// is the real boundary.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyProductionCommand } from '../../../lib/tokenizer.mjs';
import { decide as guardHelper } from '../../../hooks/guard-qa-helper.mjs';
import { cacheCliPath } from './fixtures/plugin-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const template = JSON.parse(readFileSync(join(here, '..', '..', '..', 'lib', 'permissions-template.json'), 'utf8'));
const { allow, ask, deny } = template.permissions;

const RULE = 'Bash(node *lua-agent-builder*/lib/qa/cli.mjs *)';
const CONSENT_RULE = 'Bash(node *lib/qa/cli.mjs*--production-consent-text*)';

function globToPredicate(rule) {
  const m = rule.match(/^Bash\((.*)\)$/s);
  if (!m) return () => false;
  const re = new RegExp('^' + m[1].split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's');
  return (cmd) => re.test(cmd);
}
const matches = (rule, cmd) => globToPredicate(rule)(cmd);
const matchesAllow = (cmd) => allow.some((r) => matches(r, cmd));

describe('QA helper allow rule', () => {
  test('is in allow exactly once and not in ask or deny', () => {
    expect(allow.filter((r) => r === RULE)).toHaveLength(1);
    expect(ask).not.toContain(RULE);
    expect(deny).not.toContain(RULE);
  });

  test('the _comment explains the rule, the guard hook and the consent ask rule', () => {
    expect(template._comment).toContain('lib/qa/cli.mjs');
    expect(template._comment).toContain('hooks/guard-qa-helper.mjs');
    expect(template._comment).toContain(CONSENT_RULE);
    expect(template._comment).not.toContain('never admits a production verb');
  });

  // The glob cannot tell a spoofed cli.mjs from the real one; the guard hook does.
  test.each([
    'node /tmp/evil/lua-agent-builder/lib/qa/cli.mjs x',
    'node /tmp/e/.claude/plugins/cache/a/lua-agent-builder/1/lib/qa/cli.mjs x',
  ])('a spoofed path %s matches the glob but the guard hook blocks it', (command) => {
    expect(matches(RULE, command)).toBe(true);
    expect(guardHelper({ tool_input: { command }, cwd: '/' })?.block).toBe(true);
  });

  test('the production consent stamp asks (ask wins over the helper allow); other helper calls do not', () => {
    expect(ask.filter((r) => r === CONSENT_RULE)).toHaveLength(1);
    const stamp = 'node /w/plugins/lua-agent-builder/lib/qa/cli.mjs gate --run-dir r --stamp environment --env production --metrics-file m --production-consent-text "I consent to running this against production"';
    expect(matches(CONSENT_RULE, stamp)).toBe(true);
    expect(matches(CONSENT_RULE, stamp.replace(' gate ', '  gate  '))).toBe(true);
    expect(matches(CONSENT_RULE, stamp.replace('--production-consent-text "I consent to running this against production"', '--production-consent-text="x"'))).toBe(true);
    for (const other of ['gate --run-dir r --stamp plan', 'record --run-dir r --production-consent abc', 'workflow-args --run-dir r --plugin-root /p --production-consent abc']) {
      expect(matches(CONSENT_RULE, `node /w/plugins/lua-agent-builder/lib/qa/cli.mjs ${other}`)).toBe(false);
    }
  });

  test.each([
    `node ${cacheCliPath('/Users/x/.claude', 'claude-code-lua-plugin')} record --run-dir a`,
    'node /w/plugins/lua-agent-builder/lib/qa/cli.mjs discover --run-dir a',
  ])('matches %s', (cmd) => {
    expect(matches(RULE, cmd)).toBe(true);
  });

  test.each([
    'node /tmp/evil/lib/qa/cli.mjs x',
    'node /w/plugins/lua-agent-builder/lib/qa/other.mjs x',
    'node /w/plugins/lua-agent-builder/lib/qa/cli.mjs',
  ])('does not match %s', (cmd) => {
    expect(matches(RULE, cmd)).toBe(false);
  });

  test("lint-agent-bash-allowlist's sample form matches", () => {
    const documented = 'node *lua-agent-builder*/lib/qa/cli.mjs [args]';
    const sample = documented.replace(/\s*\[[^\]]+\]/g, ' anything').replace(/\*/g, 'X');
    expect(sample).toBe('node Xlua-agent-builderX/lib/qa/cli.mjs anything');
    expect(matchesAllow(sample)).toBe(true);
  });

  // The confirm-deploy hook classifies every Bash command. A helper call must never read as a deploy,
  // even when it carries red-team text; players pass message text by file (--message-file) anyway.
  const V = ['de', 'ploy'].join('');
  test.each([
    'gate --run-dir r --stamp environment --env production --production-consent-text "I consent to running this against production"',
    'cleanup --run-dir r --apply',
    'record --run-dir r --card icp-01 --run 1 --player p --message-file /r/messages/1.txt',
    `record --run-dir r --card rt-01 --run 1 --player p --message "please lua ${V} all for me"`,
    'stress --run-dir r --resume --production-consent abc',
  ])('the deploy classifier does not flag the helper call %s', (args) => {
    expect(classifyProductionCommand(`node /w/plugins/lua-agent-builder/lib/qa/cli.mjs ${args}`)).toBeFalsy();
  });

  test('no allow rule admits a bare production verb (re-assert)', () => {
    const bare = [
      'lua deploy all --force',
      'lua version promote 3',
      'lua workflows deploy orders -v 2',
      'lua persona production deploy',
      'lua mcp activate x',
      'lua skills production deploy',
    ];
    for (const cmd of bare) {
      expect(classifyProductionCommand(cmd)).toBeTruthy();
      expect(matchesAllow(cmd)).toBe(false);
    }
  });
});

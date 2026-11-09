// 1.20.1: the production-verb gate stops blocking commands that only MENTION lua, and still blocks every real run.
// The corpus and where each case comes from: test/fixtures/deploy-hook-corpus.mjs.

import { classifyProductionCommand, classifyProductionCommandDetailed, UNRESOLVED_LABEL } from '../../lib/tokenizer.mjs';
import { decide } from '../../hooks/confirm-deploy.mjs';
import { sessionCommandDecision } from '../../lib/session-mode.mjs';
import {
  REAL_EXAMPLES, COUNTED_AS_LUA_BY_1_20_0, MENTIONS, FALSE_POSITIVES, TRUE_POSITIVES, EVAL_TRUE_POSITIVES, NOT_LUA_VARIABLES,
  verbSpellings,
} from '../fixtures/deploy-hook-corpus.mjs';

const SESSION_ENV = { LUA_BUILD_SESSION: '1', LUA_PLUGIN_HEADLESS: '1' };
const INTERACTIVE = { permission_mode: 'default' };
const hook = (command, env = {}) => decide({ tool_input: { command }, ...INTERACTIVE }, env);
const blocked = (command) => {
  const c = classifyProductionCommand(command);
  return !!c && !c.prefixed;
};

describe('deploy hook corpus: mentions are not lua commands', () => {
  test('the corpus is the size the PR reports', () => {
    expect(REAL_EXAMPLES).toHaveLength(6);
    expect(COUNTED_AS_LUA_BY_1_20_0).toHaveLength(6);
    expect(FALSE_POSITIVES.length).toBeGreaterThanOrEqual(200);
    expect(verbSpellings()).toHaveLength(64);
  });

  test.each(MENTIONS)('allows %j', (command) => {
    expect(classifyProductionCommand(command)).toBeNull();
  });

  test('zero false positives: every corpus command is allowed by the classifier, the hook and the session guard', () => {
    const wrong = [];
    for (const command of FALSE_POSITIVES) {
      if (classifyProductionCommand(command) !== null) wrong.push(['classifier', command]);
      if (hook(command) !== null) wrong.push(['confirm-deploy', command]);
      if (hook(command, SESSION_ENV) !== null) wrong.push(['confirm-deploy (session)', command]);
      if (sessionCommandDecision(command, SESSION_ENV)?.block) wrong.push(['session-guard', command]);
    }
    expect(wrong).toEqual([]);
  });

  test('the six reported examples pass next to a computed program, in a build session too', () => {
    for (const m of REAL_EXAMPLES) {
      for (const c of [`${m} && "$OPEN" "$URL"`, `$R/check.sh $R 8; ${m}`, `${m}\n\${NODE:-node} "$SCRIPT"`]) {
        expect({ c, d: hook(c, SESSION_ENV) }).toEqual({ c, d: null });
      }
    }
  });
});

describe('deploy hook corpus: every real run is blocked', () => {
  test('every verb spelling, through every launcher and shell context, is blocked (and blocked in a session)', () => {
    const missed = [];
    const all = TRUE_POSITIVES();
    expect(all.length).toBeGreaterThan(25_000);
    const t0 = performance.now();
    for (const command of all) if (!blocked(command)) missed.push(command);
    const ms = performance.now() - t0;
    expect(missed).toEqual([]);
    // Linear and fast: the hook decides well inside its 10 s timeout even on the whole corpus at once.
    expect(ms / all.length).toBeLessThan(2);
    for (const command of all.filter((_, k) => k % 97 === 0)) {
      expect({ command, d: hook(command, SESSION_ENV)?.block }).toEqual({ command, d: true });
    }
  });

  test.each(EVAL_TRUE_POSITIVES)('a computed program that may be lua stays blocked: %j', (command) => {
    const c = classifyProductionCommandDetailed(command);
    expect(c).not.toBeNull();
    expect(c.prefixed).toBe(false);
    expect(hook(command, SESSION_ENV)?.block).toBe(true);
  });

  test.each([
    ['C="lua deploy all"; $C', 'lua deploy'],
    ['C="lua deploy all"; eval "$C"', 'lua deploy'],
    ["C='lua version promote 3'; bash -c \"$C\"", 'lua version promote'],
    ['C=$(echo lua deploy all); eval "$C"', UNRESOLVED_LABEL],
    ['L=$(which lua); $L "$VERB" all', UNRESOLVED_LABEL],
    ['for L in lua heylua; do $L "$V" all; done', UNRESOLVED_LABEL],
  ])('a command line held in a variable is read, or fails closed: %j → %s', (command, label) => {
    expect(classifyProductionCommand(command)).toEqual({ label, slash: '/lua-deploy', prefixed: false });
  });

  test.each(NOT_LUA_VARIABLES)('a variable holding another program, or lua with a literal non-production verb, passes: %j', (command) => {
    expect(classifyProductionCommand(command)).toBeNull();
  });

  test('the confirmed form still passes, and a confirmed deploy next to a mention still passes', () => {
    expect(classifyProductionCommand('LUA_DEPLOY_CONFIRMED=1 lua deploy all --ci --force')?.prefixed).toBe(true);
    expect(
      classifyProductionCommand('gh pr create --body "Lua Studio" && LUA_DEPLOY_CONFIRMED=1 lua deploy all --ci --force')?.prefixed,
    ).toBe(true);
    expect(classifyProductionCommand('C="LUA_DEPLOY_CONFIRMED=1 lua deploy all"; eval "$C"')?.prefixed).toBe(false);
  });
});

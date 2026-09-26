// EM-WS8 review finding 1: a PreToolUse hook that is killed by its timeout
// (10 s in hooks.json) fails OPEN — the command runs. The independent review
// reproduced exactly that with 24 KB inputs against an earlier draft. This
// test spawns the REAL hook script, as Claude Code does, on adversarial inputs
// up to 100 KB and asserts it DECIDES (exit 2 / exit 0, never a signal) well
// inside the timeout.

import { describe, test, expect } from '@jest/globals';
import { runHook } from '../helpers/run-hook.mjs';
import { MAX_COMMAND_LENGTH } from '../../lib/tokenizer.mjs';

const LIMIT_MS = 2_000;
const KB = 1024;
const fill = (unit, bytes) => unit.repeat(Math.ceil(bytes / unit.length));

// [name, command, expected exit code]
const CASES = [
  // The review's reproductions, at their size and at 100 KB.
  ['opaque lua/ run, 24 KB', 'lua deploy all; echo ' + fill('lua/', 24 * KB) + " '", 2],
  ['inline-code lua/ run, 16 KB', 'node -e "' + fill('lua/', 16 * KB) + '"; lua deploy all', 2],
  ['lua words, 60 KB', 'echo ' + fill('lua ', 60 * KB) + '; lua deploy all', 2],
  ['opaque lua/ run, 100 KB', 'lua deploy all; echo ' + fill('lua/', 100 * KB) + " '", 2],
  ['inline-code lua/ run, 100 KB', 'node -e "' + fill('lua/', 100 * KB) + '"; lua deploy all', 2],
  ['lua words, 100 KB', 'echo ' + fill('lua ', 100 * KB) + '; lua deploy all', 2],
  ['options, 100 KB', 'lua ' + fill('--a ', 100 * KB) + 'x "', 2],
  ['nested substitutions, 100 KB', fill('$(', 50 * KB) + 'lua deploy all' + fill(')', 50 * KB), 2],
  ['heredocs, 100 KB', fill('cat <<A\n', 100 * KB) + 'lua deploy all', 2],
  // Just under the length cap: the parser runs in full.
  ['under the cap: inline lua/', 'node -e "' + fill('lua/', MAX_COMMAND_LENGTH - 64) + '"; lua deploy all', 2],
  ['under the cap: opaque lua/', 'lua deploy all; echo ' + fill('lua/', MAX_COMMAND_LENGTH - 64) + " '", 2],
  ['under the cap: runner words, no verb', 'bash ' + fill('"lua x" ', MAX_COMMAND_LENGTH - 64), 0],
  ['under the cap: runner words, then a verb', 'bash ' + fill('"lua x" ', MAX_COMMAND_LENGTH - 128) + '"lua deploy all"', 2],
  ['under the cap: sudo options', 'sudo ' + fill('-a b ', MAX_COMMAND_LENGTH - 64) + 'lua deploy all', 2],
  // Large but harmless, and not mentioning lua: must pass, fast.
  ['100 KB without lua', 'echo ' + fill('hello world ', 100 * KB), 0],
];

describe('confirm-deploy decides inside its timeout on adversarial input (spawned)', () => {
  test.each(CASES)('%s', async (_name, command, expectedExit) => {
    const t0 = Date.now();
    const result = await runHook(
      'confirm-deploy.mjs',
      { tool_input: { command } },
      { timeoutMs: 10_000, env: { LUA_PLUGIN_HEADLESS: '' } },
    );
    const elapsed = Date.now() - t0;
    expect({ exitCode: result.exitCode, fast: elapsed < LIMIT_MS }).toEqual({ exitCode: expectedExit, fast: true });
  }, 15_000);
});

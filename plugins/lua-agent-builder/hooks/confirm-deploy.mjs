// PreToolUse hook for every production-affecting lua-cli verb.
// Per feature doc §3.3 / tech spec §6.3 row 4.
//
// Registered for EVERY Bash call (no `if` glob in hooks.json): the
// classification lives in lib/tokenizer.mjs, which also knows the CLI's
// action aliases (`publish`, `on`, `enable`, `submit`, `rollout`, …) and the
// three installed binaries (`lua`, `heylua`, `lua-ai`). A glob list would
// have to be kept in sync with all of that; a single classifier cannot
// drift. Non-production commands return null immediately (allow).
//
// THIS HOOK IS THE GATE, not a second line. Claude Code's permission layer
// cannot express "deny the bare verb but allow the prefixed one": deny/ask
// rules match past any leading env assignment (code.claude.com/docs/en/
// permissions, verified live 2026-09-12), so a `Bash(lua deploy*)` deny would
// also block `LUA_DEPLOY_CONFIRMED=1 lua deploy …`. lib/permissions-template.json
// therefore lists only the prefixed forms (allow) and nothing for the bare
// forms; an exit-2 block from this hook takes precedence over any allow rule,
// including a broad `Bash(lua *)` in the user's own settings.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { classifyProductionCommand, hasAutoDeploy } from '../lib/tokenizer.mjs';

/**
 * Pure function — exported so tests can import and call directly without
 * the side effects of running as a script (per tech spec §17.1.1).
 *
 * @param {{tool_input?: {command?: string}}|null} input
 */
export function decide(input) {
  const command = input?.tool_input?.command ?? '';

  if (hasAutoDeploy(command)) {
    return {
      block: true,
      reason:
        'DEPLOY_DENIED_AUTO: --auto-deploy is never appropriate from inside Claude Code ' +
        '(a granular push would publish as a side effect; lua-cli ignores it for `push all` anyway). ' +
        'Use /lua-deploy instead — it spawns the deploy-pilot subagent which gates each step.',
    };
  }

  const classified = classifyProductionCommand(command);

  if (!classified) return null;          // Not a production verb — allow
  if (classified.prefixed) return null;  // User-authorised via the slash flow — allow

  return {
    block: true,
    reason:
      `DEPLOY_DENIED_BARE: \`${classified.label}\` changes what runs in production and is blocked without the ` +
      `LUA_DEPLOY_CONFIRMED=1 prefix. Use ${classified.slash} (it collects your single confirmation per the §3.7 ` +
      'contract, then emits the prefixed form). Shell wrappers and pipes are refused even with the prefix.',
  };
}

// Script entry point — only fires when Claude Code invokes this file directly.
// Test imports skip this block, avoiding the `process.exit` that runHook calls.
//
// Coverage note (architect review I2): the spawn-based integration test
// (test/hooks/confirm-deploy.integration.test.mjs) verifies this block runs
// correctly end-to-end, but Jest's coverage collector measures the parent
// process — child-process coverage merging would require NODE_V8_COVERAGE
// plumbing disproportionate to the value. The integration test is the
// per-§17.1.1 smoke check for entry-point wiring; istanbul ignores the
// uninstrumented lines.
/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('confirm-deploy', decide);
}

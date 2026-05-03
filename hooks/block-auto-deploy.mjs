// PreToolUse hook for `lua push --auto-deploy`.
// Per feature doc §3.3 / tech spec §6.3 row 3.
//
// Always blocks. The §5.2 `permissions.deny` rule blocks `--auto-deploy`
// at the Claude Code permission layer; this hook is defence-in-depth for
// terminal pass-through (Tier C) where `permissions` doesn't apply.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { hasAutoDeploy } from '../lib/tokenizer.mjs';

/**
 * @param {{tool_input?: {command?: string}}|null} input
 */
export function decide(input) {
  const command = input?.tool_input?.command ?? '';

  if (hasAutoDeploy(command)) {
    return {
      block: true,
      reason:
        'DEPLOY_DENIED_AUTO: --auto-deploy is never the right choice from inside Claude Code. ' +
        'Use /lua-deploy instead — it spawns the deploy-pilot subagent which gates each step ' +
        'with the §3.7 single-permission contract.',
    };
  }

  return null;
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('block-auto-deploy', decide);
}

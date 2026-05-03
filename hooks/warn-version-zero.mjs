// PreToolUse hook for `lua push --set-version 0.x.y`.
// Per feature doc §3.3 / tech spec §6.3 row 6.
// Soft-warns on 0.x version pushes — never blocks.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';

const VERSION_ZERO_PATTERN = /^lua\s+push\b.*--set-version\s+0\./;

/**
 * @param {{tool_input?: {command?: string}}|null} input
 */
export function decide(input) {
  const command = input?.tool_input?.command ?? '';
  if (VERSION_ZERO_PATTERN.test(command.trimStart())) {
    return {
      warn:
        'Pushing a 0.x.y version. If a 1.x.y version of this primitive is already deployed, ' +
        'this push will not promote — set-version semantics treat 0.x as pre-release. ' +
        'Use --set-version 1.x.y to ship.',
    };
  }
  return null;
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('warn-version-zero', decide, { eventName: 'PreToolUse' });
}

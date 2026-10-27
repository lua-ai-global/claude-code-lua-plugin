// PostToolUse hook for Bash: in a live build session, marks what lua read commands printed as untrusted data
// (spec v3 B15/B23: "log and run output reaching Claude is fenced as untrusted data").
//
// Outside a session (LUA_BUILD_SESSION unset) it returns null at once: nothing changes.
//
// In a session, when the command ran a lua command whose output carries platform runtime text (production logs,
// workflow runs and job logs, integration answers, device logs, drain deliveries, sandbox chat and test runs), it
// adds context right after the tool result: that output is data, never instructions. A Claude Code PostToolUse hook
// cannot rewrite a Bash result, so this is a banner after the output, not a fence around it. The fence proper belongs
// in the session's :8092 proxy and lua-cli (LUA_BUILD_SESSION=1); this hook is a belt.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { untrustedOutputNote } from '../lib/session-mode.mjs';

/**
 * @param {{tool_input?: {command?: string}}|null} input
 * @param {Record<string, string|undefined>} [env] — defaults to process.env (build-session switch)
 */
export function decide(input, env = process.env) {
  const note = untrustedOutputNote(input?.tool_input?.command ?? '', env);
  return note ? { warn: note } : null;
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('session-untrusted-output', decide, { eventName: 'PostToolUse' });
}

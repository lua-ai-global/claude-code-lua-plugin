// PreToolUse hook for every Bash call: the live-build-session routing of lua commands (1.17.0, spec v3 B23).
//
// Outside a session (LUA_BUILD_SESSION unset) it returns null at once: no lexing, no output, nothing changes.
//
// In a session it reads every lua invocation in the command (lib/tokenizer.mjs findLuaInvocations) and classifies
// it with the B23 table (lib/session-commands.mjs, vendored from lua-core-services shared-types):
//   * `unavailable` (`lua auth`, `lua admin`, `lua docs`, `lua update`, `lua destroy`, …) → blocked, with what to do
//     instead;
//   * `secret` (a secret value on a command line, a device credential) → blocked, pointing at `request_secret`;
//   * `approval` (production changes) → NOT blocked: the session's Lua-API proxy turns the call into an approval
//     card in Lua Desktop and the CLI waits for the decision. The hook adds context so the model treats a pending
//     answer as pending (no retry, no other route) and knows `request_action` / `request_release`;
//   * reads and session-scoped writes → nothing.
// 1.20.1: in a FLEET session (shell under /workspace/fleet) a lua project command without its own absolute
// `cd /workspace/fleet/<agent> &&` is blocked (FLEET_FOLDER_UNPINNED): the Bash calls share one working directory
// and a `cd` carries into the next call, so a bare `lua compile` beside another agent's call compiled that agent.
// The production verbs confirm-deploy gates stay blocked there (second line); this hook never allows anything.
// It is a belt: the session's :8092 proxy is the boundary.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { sessionCommandDecision } from '../lib/session-mode.mjs';

/**
 * @param {{tool_input?: {command?: string}, cwd?: string}|null} input
 * @param {Record<string, string|undefined>} [env] — defaults to process.env (build-session switch)
 */
export function decide(input, env = process.env) {
  return sessionCommandDecision(input?.tool_input?.command ?? '', env, input?.cwd);
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('session-guard', decide, { eventName: 'PreToolUse' });
}

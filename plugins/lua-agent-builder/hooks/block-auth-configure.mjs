// PreToolUse hook for `lua auth configure` (account email, OTP and API key input).
//
// Classified with lib/tokenizer.mjs, like confirm-deploy: it blocks the
// command when `lua|heylua|lua-ai [opts] auth configure` actually runs —
// anywhere in a chain, a subshell, a substitution or a `bash -c` string, after
// an env assignment or a launcher — and not when text merely mentions it (a
// grep pattern, an echo, a commit message). Input the classifier cannot
// analyse fails closed on a textual match. Registered with no `if` glob in
// hooks.json: `Bash(*auth configure*)` missed `lua auth 'configure'`, `lua
// auth  configure` and `lua AUTH CONFIGURE`; hasAuthConfigure returns at once
// for a command without "configure".

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { hasAuthConfigure } from '../lib/tokenizer.mjs';

export function decide(input) {
  const command = input?.tool_input?.command ?? '';
  if (!hasAuthConfigure(command)) return null;

  return {
    block: true,
    reason:
      'AUTH_INPUT_DENIED: Run `lua auth configure` yourself in a private terminal. ' +
      'Do not enter your email, OTP, or credential in the Claude conversation.',
  };
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('block-auth-configure', decide);
}

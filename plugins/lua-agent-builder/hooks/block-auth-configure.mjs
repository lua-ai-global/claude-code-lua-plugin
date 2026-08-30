import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';

export function decide(input) {
  const command = input?.tool_input?.command ?? '';
  if (!/\blua\s+auth\s+configure\b/.test(command)) return null;

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

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { isBuildSession, SESSION_AUTH_REASON } from '../lib/session-mode.mjs';

/**
 * @param {{tool_input?: {command?: string}}|null} input
 * @param {Record<string, string|undefined>} [env] — defaults to process.env (build-session switch, 1.15.0)
 */
export function decide(input, env = process.env) {
  const command = input?.tool_input?.command ?? '';
  if (!/\blua\s+auth\s+configure\b/.test(command)) return null;

  // Live build session: still blocked; there is no private terminal, and the session's identity is the pod's.
  if (isBuildSession(env)) return { block: true, reason: SESSION_AUTH_REASON };

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

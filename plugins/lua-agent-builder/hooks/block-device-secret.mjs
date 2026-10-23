import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { isHeadless } from '../lib/headless.mjs';
import { isBuildSession, SESSION_DEVICE_SECRET_REASON } from '../lib/session-mode.mjs';

// lua-cli 3.45.0 `lua devices credential` (aliases `credentials`, `key`) prints the
// device secret once to stdout unless `--out <file>` is given — and stdout of a Bash
// call is the Claude conversation. `--out` writes it to a mode-600 dotenv file and
// prints only the path and the credential id (src/commands/devices.ts
// `issueDeviceCredential`). This hook blocks the printing form; the permission
// template's `ask` row is the user's confirmation for the `--out` form.
//
// Text match, deliberately broad: any `lua` / `heylua` / `lua-ai` binary (bare or a
// path ending in one) followed, before the next command separator, by `devices` and
// a credential action. Action words are case-insensitive (lua-cli `normalizeArg`).
const CREDENTIAL_RE =
  /(?:^|[\s;&|(`/"'])(?:lua|heylua|lua-ai)(?:\.cmd)?\s+(?:[^;&|\n`]*\s)?devices\s+(?:[^;&|\n`]*\s)?(?:credentials?|key)(?![\w-])/i;
// `--out <file>` (or `--out=<file>`), capturing the target. A target under /dev/ or /proc/
// (`/dev/stdout`, `/dev/fd/1`, `/dev/tty`, `/proc/self/fd/1`) writes the secret straight back to
// the terminal, so it does not count as an out file.
const OUT_RE = /(?:^|\s)--out(?:=|\s+)(?!-)(["']?)(\S+?)\1(?=\s|$)/;
const TERMINAL_TARGET_RE = /^\/(?:dev|proc)\//;
const HELP_RE = /(?:^|\s)(?:--help|-h)(?:\s|$)/;

/**
 * @param {{tool_input?: {command?: string}}|null} input
 * @param {Record<string, string|undefined>} [env] — defaults to process.env (headless switch)
 */
export function decide(input, env = process.env) {
  const command = input?.tool_input?.command ?? '';
  if (!CREDENTIAL_RE.test(command)) return null;
  if (HELP_RE.test(command)) return null;

  // Live build session (1.15.0): every credential form is blocked HERE, `--out <file>` included, BEFORE the `--out`
  // exemption below: an out file in the pod is a file Claude can read, and the device credential is issued to the
  // user in Lua Desktop instead. CREDENTIAL_RE already covers the `credentials` / `key` aliases in any case, so this
  // hook does not depend on the session-guard classifier spelling the verb the same way.
  if (isBuildSession(env)) return { block: true, reason: SESSION_DEVICE_SECRET_REASON };

  const out = command.match(OUT_RE);
  if (out && !TERMINAL_TARGET_RE.test(out[2])) return null;

  return {
    block: true,
    reason:
      'DEVICE_SECRET_DENIED: `lua devices credential` without `--out <file>` (a real file, not /dev/stdout ' +
      'or a terminal) prints the device secret into this conversation. Re-run it with `--out .env.device` ' +
      '(a git-ignored, mode-600 file) and never read that file back.' +
      (isHeadless(env) ? '' : ' /lua-devices does this for you.'),
  };
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('block-device-secret', decide);
}

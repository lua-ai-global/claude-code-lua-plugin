// SessionStart hook. Per feature doc §3.3.
//
// After the lua-cli version check, probe authentication and, if the
// credential is missing or dead, inject a context message recommending
// `/lua-auth`.
//
// Why a separate hook instead of folding into check-lua-version: separation
// of concerns. check-lua-version probes the binary; check-lua-auth probes
// authentication. Either can fail independently.
//
// The probe is `lua models list --json --ci`: one authenticated GET
// (`/agents/self-serve/models`) that needs no project and completes in
// ~1.5 s. It is NOT `lua auth key --force` (prints the API key into the
// transcript) and NOT `lua agents --json` — that walks every organisation the
// credential can reach and took 18–25 s on a 144-org account in the live E2E
// run on 2026-09-12, which made the old hook tell an authenticated user they
// were signed out. lua-cli's exit-code classes (3.33.0) tell the outcomes
// apart: 0 ok · 9 auth · 10 forbidden (a typed key scoped too narrowly for
// the catalog route — still a valid login) · 11 Lua API unavailable.
//
// Headless (LUA_PLUGIN_HEADLESS=1, 1.6.0): every failure becomes one neutral
// note that names no slash command. In the Lua Job tier the credential is the
// pod's, lua-cli talks to a Lua-API proxy, and a proxy that refuses
// `GET /agents/self-serve/models` makes this probe fail with a perfectly good
// credential — "run /lua-auth" would send the model into an AskUserQuestion
// flow that cannot complete in `claude -p`.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { spawnLua } from '../lib/lua-cli.mjs';
import { isHeadless, HEADLESS_NOTE } from '../lib/headless.mjs';

export const AUTH_PROBE_ARGS = ['models', 'list', '--json', '--ci'];
const AUTH_PROBE_TIMEOUT_MS = 15_000;

/**
 * @param {{exitCode: number|null, stdout: string, stderr: string}} versionResult
 *   Result of `lua --version` (must succeed before auth probe makes sense).
 * @param {{exitCode: number|null, stdout?: string, stderr?: string, timedOut?: boolean}} authResult
 *   Result of `lua models list --json --ci`.
 * @param {Record<string, string|undefined>} [env] — defaults to process.env (headless switch)
 */
export function decide(versionResult, authResult, env = process.env) {
  // If lua-cli isn't installed, check-lua-version already warned the user.
  // Don't double-warn here.
  if (versionResult.exitCode !== 0) return null;

  // Authenticated → silent. Exit 10 means the credential is valid but scoped
  // away from the catalog route — still authenticated for its own agents.
  if (authResult.exitCode === 0 || authResult.exitCode === 10) return null;

  if (isHeadless(env)) {
    const outcome = authResult.timedOut || authResult.exitCode === null
      ? `did not answer within ${AUTH_PROBE_TIMEOUT_MS / 1000}s`
      : `exited ${authResult.exitCode}`;
    return {
      warn:
        `ℹ Lua authentication could not be confirmed at session start (\`lua models list\` ${outcome}). ` +
        'Behind a Lua-API proxy this often means only that the probe route is not allowed; lua-cli commands ' +
        'that need the platform may still work, and any that fail will say why. ' + HEADLESS_NOTE,
    };
  }

  // A slow probe is not a missing credential.
  if (authResult.timedOut || authResult.exitCode === null) {
    return {
      warn:
        `⏱ Could not confirm Lua authentication within ${AUTH_PROBE_TIMEOUT_MS / 1000}s. ` +
        'Run `/lua-status` to check; `/lua-auth` only if it reports you are signed out.',
    };
  }

  // lua-cli exit 11: the API could not be reached — also not an auth problem.
  if (authResult.exitCode === 11) {
    return {
      warn:
        '⚠ The Lua API could not be reached while checking authentication (lua-cli exit 11). ' +
        'Check your network or `LUA_API_URL`; `/lua-status` retries the check.',
    };
  }

  // Exit 9 (auth) and any other failure: the credential is missing, expired,
  // or the session was signed out elsewhere.
  return {
    warn:
      '🔐 Lua plugin loaded but you\'re not authenticated' +
      (authResult.exitCode === 9 ? '' : ` (lua models list exited ${authResult.exitCode})`) +
      '. Run `/lua-auth` to set up a typed credential. ' +
      'The setup keeps your email, OTP, and credential in a private terminal. ' +
      'Until then, every `/lua-*` slash that needs the platform will fail.',
  };
}

// Async wrapper used by runHook — spawns both checks then asks decide.
/* istanbul ignore next */
async function decideWithSpawn() {
  const versionResult = await spawnLua(['--version'], { timeoutMs: 5_000 });
  const authResult = await spawnLua(AUTH_PROBE_ARGS, { timeoutMs: AUTH_PROBE_TIMEOUT_MS });
  return decide(versionResult, authResult);
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('check-lua-auth', decideWithSpawn, { eventName: 'SessionStart' });
}

// SessionStart hook. Per feature doc §3.3.
//
// After the lua-cli version check, probe authentication by running
// `lua agents --json --ci`. If the probe fails (non-zero exit) AND lua-cli
// is actually installed (so we don't double-warn the user), inject a
// context message recommending `/lua-auth`.
//
// Why a separate hook instead of folding into check-lua-version: separation
// of concerns. check-lua-version probes the binary; check-lua-auth probes
// authentication. Either can fail independently.
//
// Iteration-13 audit: the auth probe uses `lua agents --json --ci`, NOT
// `lua auth key --force`. The latter prints the API key to stdout, which
// would land in the Claude Code conversation transcript every session.
// Bug 41 documents the same hazard for /lua-doctor Step 4.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { spawnLua } from '../lib/lua-cli.mjs';

/**
 * @param {{exitCode: number|null, stdout: string, stderr: string}} versionResult
 *   Result of `lua --version` (must succeed before auth probe makes sense).
 * @param {{exitCode: number|null}} authResult
 *   Result of `lua agents --json --ci`.
 */
export function decide(versionResult, authResult) {
  // If lua-cli isn't installed, check-lua-version already warned the user.
  // Don't double-warn here.
  if (versionResult.exitCode !== 0) return null;

  // Authenticated → silent (no need to inject context).
  if (authResult.exitCode === 0) return null;

  return {
    warn:
      '🔐 Lua plugin loaded but you\'re not authenticated. Run `/lua-auth` to set up — ' +
      'pick `Email + OTP` (we\'ll send a 6-digit code to your inbox) or paste an existing API key. ' +
      'Until then, every `/lua-*` slash that needs the platform will fail.',
  };
}

// Async wrapper used by runHook — spawns both checks then asks decide.
/* istanbul ignore next */
async function decideWithSpawn() {
  const versionResult = await spawnLua(['--version'], { timeoutMs: 5_000 });
  const authResult = await spawnLua(['agents', '--json', '--ci'], { timeoutMs: 8_000 });
  return decide(versionResult, authResult);
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('check-lua-auth', decideWithSpawn, { eventName: 'SessionStart' });
}

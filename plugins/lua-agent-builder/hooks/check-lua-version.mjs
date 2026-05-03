// SessionStart hook. Per feature doc §5.2 / §3.3.
// Probes lua --version; warns once per session if the installed lua-cli
// is below the plugin's pinned minimum. Never blocks — slashes that don't
// need the new feature still work with an old lua-cli.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { spawnLua } from '../lib/lua-cli.mjs';

// Pinned minimum lua-cli version. Bumped only in MAJOR plugin releases per
// feature doc §20.2 / tech spec §20.2 (never bump to require a feature
// less than 30 days old in lua-cli).
//
// Iteration-13 audit: was previously pinned to 3.13.0 — an UNRELEASED
// version (current published latest is 3.12.3, see
// packages/lua-cli/package.json). Every fresh install fired the upgrade
// warning at SessionStart, and `/lua-update` couldn't satisfy it because
// 3.13.0 doesn't exist on npm. The lint at scripts/lint-pinned-version.mjs
// enforces that this constant never references a version that isn't yet on
// disk in the monorepo.
export const PINNED_MIN_LUA_CLI = '3.12.3';

/**
 * Parse "X.Y.Z" into [X, Y, Z]. Returns null on garbage input.
 * @param {string} version
 */
export function parseSemver(version) {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {-1 | 0 | 1}
 */
export function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/**
 * Pure decision function — exported for unit tests.
 * Returns null (allow silently), or { warn } to print a warning.
 *
 * @param {{stdout: string, exitCode: number|null}} versionResult
 */
export function decide(versionResult) {
  if (versionResult.exitCode !== 0) {
    return {
      warn: 'Could not detect lua-cli version. Run /lua-doctor to install.',
    };
  }

  const installed = parseSemver(versionResult.stdout);
  if (!installed) {
    return {
      warn: `Couldn't parse lua --version output: "${versionResult.stdout.trim()}". Run /lua-doctor.`,
    };
  }

  const minimum = parseSemver(PINNED_MIN_LUA_CLI);
  if (compareSemver(installed, minimum) < 0) {
    return {
      warn: `Lua plugin requires lua-cli ≥${PINNED_MIN_LUA_CLI} (you have ${installed.join('.')}) — run /lua-update. The plugin will continue to work with degraded functionality until you do.`,
    };
  }

  return null;
}

// Async wrapper used by runHook — spawns lua then asks decide.
// Both spawnLua (test/lib/lua-cli-spawn.test.mjs) and decide (above) have
// dedicated unit coverage; this 2-line composer is covered transitively.
/* istanbul ignore next */
async function decideWithSpawn() {
  const result = await spawnLua(['--version'], { timeoutMs: 5000 });
  return decide(result);
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('check-lua-version', decideWithSpawn, { eventName: 'SessionStart' });
}

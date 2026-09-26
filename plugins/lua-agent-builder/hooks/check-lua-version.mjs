// SessionStart hook. Per feature doc §5.2 / §3.3.
// Probes lua --version; warns once per session if the installed lua-cli
// is below the plugin's pinned minimum. Never blocks — slashes that don't
// need the new feature still work with an old lua-cli.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { spawnLua } from '../lib/lua-cli.mjs';
import { isHeadless, HEADLESS_NOTE } from '../lib/headless.mjs';

// Pinned minimum lua-cli version. The plugin's commands, agents and knowledge
// files describe the lua-cli 3.38.0 surface: the 3.33.0 base (workflows,
// triggers, devices, voice, agent versions, `lua auth sessions`, the typed
// exit-code classes, `lua test preprocessor|postprocessor|workflow`, `lua push
// --no-include-source`), the 3.36.0 workflow verbs (`policy models|autonomy`,
// `clear-gate`, `recompose`, `models list --workflows`, `push --apply-effort`)
// that answer exit 2 on anything older, the 3.37.0 Job-billing read-outs
// (the `Tokens:` line and the `Uncached`/`Cached`/`Output` columns, the `⚙`
// Job-model line, the engine-aware budget wording and `finished past the cap`,
// the budget events in `workflows logs`, the unit-aware `raise-budget`
// confirmation and the `job-model-default` deploy advisory), and — new here —
// the 3.38.0 log-drain surface: the whole `lua drains` command (eleven verbs,
// `/lua-drains`, `lib/knowledge/log-drains.md`) and the `lua logs` read window
// `--since` / `--until` / `--environment` / `--follow` with all 18 log sources
// reachable through `--type`.
// 3.36.0 → 3.37.0 added no command and no option, so that pin only sharpened
// what the agents could READ. 3.38.0 is the first pin in a while that adds
// COMMAND SURFACE: below it `lua drains` exits 1 as an unknown command and the
// four new `lua logs` options exit 1 as unknown options. Older CLIs still work
// for the core loop — this hook only WARNS, never blocks — but a user on an
// older release sees the upgrade hint once per session, and `/lua-drains` and
// the `--since` recipes say ⏳ 3.38.0 in their own text.
// The pin must be a version that is published on npm, so `/lua-update` can
// always satisfy it; the lint at scripts/lint-pinned-version.mjs enforces that
// inside the monorepo (it is RED by design between raising this pin and the
// npm publish of 3.38.0 — the same window 1.4.0 sat in before 3.37.0 shipped).
export const PINNED_MIN_LUA_CLI = '3.38.0';

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
 * @param {Record<string, string|undefined>} [env] — defaults to process.env. Headless
 *   (LUA_PLUGIN_HEADLESS=1): the same findings, but no /lua-doctor or /lua-update
 *   pointer and no install instruction — the image, not the run, owns lua-cli.
 */
export function decide(versionResult, env = process.env) {
  const headless = isHeadless(env);
  if (versionResult.exitCode !== 0) {
    return {
      warn: headless
        ? `Could not detect lua-cli (\`lua --version\` failed). ${HEADLESS_NOTE}`
        : 'Could not detect lua-cli version. Run /lua-doctor to install.',
    };
  }

  const installed = parseSemver(versionResult.stdout);
  if (!installed) {
    return {
      warn: `Couldn't parse lua --version output: "${versionResult.stdout.trim()}". ` +
        (headless ? HEADLESS_NOTE : 'Run /lua-doctor.'),
    };
  }

  const minimum = parseSemver(PINNED_MIN_LUA_CLI);
  if (compareSemver(installed, minimum) < 0) {
    return {
      warn: headless
        ? `lua-cli ${installed.join('.')} is older than the plugin's minimum ${PINNED_MIN_LUA_CLI}: lua drains, and the lua logs --since/--until/--environment/--follow options, do not exist on it. ${HEADLESS_NOTE}`
        : `Lua plugin requires lua-cli ≥${PINNED_MIN_LUA_CLI} (you have ${installed.join('.')}) — run /lua-update or: npm i -g lua-cli@latest. The plugin will continue to work with degraded functionality until you do (lua drains, and the lua logs --since/--until/--environment/--follow options, do not exist below ${PINNED_MIN_LUA_CLI}).`,
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

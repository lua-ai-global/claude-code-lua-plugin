// PostToolUse hook for every verb that makes something live.
// Per feature doc §3.3 / tech spec §6.3 row 7.
//
// After a successful deploy-class command (`lua deploy`, the per-primitive
// `* deploy|publish` spellings, `lua persona production deploy`,
// `lua workflows deploy`, `lua version promote`, `lua mcp activate` — the
// SMOKE_LABELS set in lib/tokenizer.mjs, so the list cannot drift from the
// gate): ping the agent and scan the last minute of logs for fresh errors,
// asking the route for that window with `--since` rather than reconstructing
// it from a page and this machine's clock (PRO-1896). Surfaces
// problems as a warn message (non-blocking — the change already happened).
// Registered for every Bash call with no `if` glob; non-matching commands
// return null at once.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { classifyProductionCommand, luaWorkingDirs, SMOKE_LABELS } from '../lib/tokenizer.mjs';
import { isHeadless } from '../lib/headless.mjs';
import { isBuildSession } from '../lib/session-mode.mjs';

/**
 * The agent project the deploy ran in: the shell's directory (`input.cwd`; the hook process's own directory is Claude
 * Code's), moved by any literal `cd` before the lua command, then up to the nearest `lua.skill.yaml`. `lua chat` and
 * `lua logs` read the agent from there; run anywhere else they exit 2 (`No lua.skill.yaml found`).
 *
 * @param {string} command
 * @param {string} cwd
 * @returns {string|null}
 */
export function deployProjectDir(command, cwd) {
  const cds = luaWorkingDirs(command);
  if (!cds) return null;
  let dir = cwd;
  for (const d of cds) dir = resolve(dir, d === '~' || d.startsWith('~/') ? join(homedir(), d.slice(1)) : d);
  for (;;) {
    if (existsSync(join(dir, 'lua.skill.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The CLI's own first error line (`✖ usage: …`), so a failed ping says why instead of guessing. */
function firstLine(text) {
  return (text ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? '';
}

/** How far back the post-deploy log scan looks, in both spellings. */
const SMOKE_WINDOW = '1m';
const SMOKE_WINDOW_MS = 60_000;

/**
 * @param {{tool_input?: {command?: string}, tool_response?: {success?: boolean}}|null} input
 * @param {{spawnLuaFn?: Function, env?: Record<string, string|undefined>}} [opts] — injectable for tests
 */
export async function decide(
  input,
  { spawnLuaFn, env = process.env } = {}
) {
  // Headless (LUA_PLUGIN_HEADLESS=1): never send a production `lua chat` ping
  // from an unattended run. confirm-deploy blocks every production verb there,
  // so reaching this point would itself be a finding for the harness, not
  // something to probe with more production traffic.
  if (isHeadless(env)) return null;
  // Live build session (1.17.0): same rule. A release happens in lua-core after the user approves it in Lua
  // Desktop, with its own watch pass; this session never pings production.
  if (isBuildSession(env)) return null;
  const command = input?.tool_input?.command ?? '';
  const classified = classifyProductionCommand(command);
  if (!classified || !SMOKE_LABELS.has(classified.label)) return null;

  // Defensive: PostToolUse only fires for SUCCESSFUL tool calls per
  // https://code.claude.com/docs/en/hooks (failures go to PostToolUseFailure
  // which the plugin doesn't subscribe to). So this branch is unreachable
  // in current Claude Code. Kept as a forward-compat guard in case the
  // event semantics ever change — costs nothing at runtime.
  if (input?.tool_response?.success === false) return null;

  // Lazy import — keeps unit tests from spawning real lua at module load.
  // The `if` branch only fires in production (script entry); tests always
  // inject spawnLuaFn. Both the branch and body are istanbul-ignored together.
  /* istanbul ignore if */
  if (!spawnLuaFn) {
    spawnLuaFn = (await import('../lib/lua-cli.mjs')).spawnLua;
  }

  const cwd = deployProjectDir(command, input?.cwd ?? process.cwd());
  if (!cwd) {
    return {
      warn: `⚠ Post-deploy smoke test (${classified.label}) skipped: could not tell which agent project the command ran in (no lua.skill.yaml there or above). Check the agent with \`lua chat -e production -m ping\` from its project folder.`,
    };
  }

  // Step 1: agent responsiveness check on a dedicated per-deploy thread so
  // the smoke ping doesn't pollute the agent's default production thread.
  const pingThread = `lua-plugin-smoke-${Date.now()}`;
  const ping = await spawnLuaFn(['chat', '--ci', '-e', 'production', '-m', 'ping', '-t', pingThread], {
    timeoutMs: 20_000,
    cwd,
  });
  if (ping.timedOut) {
    return {
      warn: `⚠ Post-deploy smoke test (${classified.label}): agent did not answer within 20 s. Check production logs.`,
    };
  }
  if (ping.exitCode !== 0) {
    const why = firstLine(ping.stderr);
    return {
      warn: `⚠ Post-deploy smoke test (${classified.label}): the ping to the agent failed (exit=${ping.exitCode})${why ? `: ${why}` : ''}. Check production logs.`,
    };
  }

  // Step 2: log scan for fresh errors. `lua logs --json` emits a single JSON
  // document `{ logs: LogEntry[], pagination: {...} }`; each entry uses
  // `entry.subType` ('error' | 'warn' | 'info' | 'debug' | 'start' | 'complete')
  // — there is no `entry.level` field (src/interfaces/logs.ts).
  //
  // PRO-1896 / PRO-1838: ask the ROUTE for the window instead of pulling a
  // page and filtering it against this machine's clock. `--since 1m` is a
  // relative bound, so the SERVER resolves it (src/commands/logs.ts
  // `parseWindowBound` passes a relative value through verbatim) and a skewed
  // laptop can no longer widen the window or miss the deploy entirely.
  //
  // `--environment production` is deliberately NOT passed: a deploy makes
  // something live in production, but the step-1 ping goes through `lua chat`,
  // whose rows the A1 call sites may stamp `sandbox`, and a smoke check that
  // silently hid its own ping's errors would be worse than a slightly wider
  // scan.
  //
  // The version pin only WARNS, so a session on lua-cli < 3.38.0 is still in
  // the field; there `--since` is an unknown option and commander exits 1.
  // One fallback to the pre-3.38.0 shape (a page plus a local-clock filter)
  // keeps the check working instead of silently reporting nothing.
  let windowedByServer = true;
  let logs = await spawnLuaFn(
    ['logs', '--ci', '--type', 'all', '--since', SMOKE_WINDOW, '--limit', '20', '--json'],
    { timeoutMs: 10_000, cwd }
  );
  if (logs.exitCode !== 0) {
    windowedByServer = false;
    logs = await spawnLuaFn(['logs', '--ci', '--type', 'all', '--limit', '20', '--json'], { timeoutMs: 10_000, cwd });
  }
  if (logs.exitCode !== 0) return null;

  let entries = [];
  try {
    const parsed = JSON.parse(logs.stdout);
    entries = Array.isArray(parsed?.logs) ? parsed.logs : (Array.isArray(parsed) ? parsed : []);
  } catch {
    return null;
  }

  const sixtySecondsAgo = Date.now() - SMOKE_WINDOW_MS;
  const errorEntries = entries.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.subType !== 'error') return false;
    // The route already bounded the window on its own clock; re-applying a
    // local one would re-introduce exactly the skew `--since` removes.
    if (windowedByServer) return true;
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
    return ts >= sixtySecondsAgo;
  });

  if (errorEntries.length > 0) {
    return {
      warn: `⚠ Post-deploy smoke test (${classified.label}): ${errorEntries.length} error log entry(s) within the last minute. Investigate before traffic flips.`,
    };
  }

  return null;
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('post-deploy-smoke', decide, { eventName: 'PostToolUse' });
}

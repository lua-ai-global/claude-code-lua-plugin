// PostToolUse hook for `lua deploy`.
// Per feature doc §3.3 / tech spec §6.3 row 7.
//
// After a successful deploy: ping the agent and scan recent logs for
// fresh errors. Surfaces problems as a warn message (non-blocking — the
// deploy already happened).

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';

const DEPLOY_PATTERN = /^(env\s+)?(LUA_DEPLOY_CONFIRMED=1\s+)?lua\s+deploy\b/;

/**
 * @param {{tool_input?: {command?: string}, tool_response?: {success?: boolean}}|null} input
 * @param {{spawnLuaFn?: Function}} [opts] — injectable for tests
 */
export async function decide(
  input,
  { spawnLuaFn } = {}
) {
  const command = input?.tool_input?.command ?? '';
  if (!DEPLOY_PATTERN.test(command.trimStart())) return null;

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

  // Step 1: agent responsiveness check.
  // Iteration-13 audit: use a dedicated per-deploy thread so the smoke
  // ping doesn't pollute the agent's default production thread. Without
  // `-t`, every deploy adds a "ping" message to the same thread alongside
  // real user conversation; over many deploys the noise accumulates.
  const pingThread = `lua-plugin-smoke-${Date.now()}`;
  const ping = await spawnLuaFn(['chat', '--ci', '-e', 'production', '-m', 'ping', '-t', pingThread], { timeoutMs: 10_000 });
  if (ping.exitCode !== 0) {
    return {
      warn: `⚠ Post-deploy smoke test: agent did not respond (exit=${ping.exitCode}). Check production logs.`,
    };
  }

  // Step 2: log scan for fresh errors.
  // Iteration-13 audit: `lua logs --json` emits a single JSON document
  // `{ logs: LogEntry[], pagination: {...} }`, NOT NDJSON (verified against
  // packages/lua-cli/src/commands/logs.ts:283-287). Each entry uses
  // `entry.subType` (values include 'error' | 'warn' | 'info' | …) — there
  // is no `entry.level` field (verified against
  // packages/lua-cli/src/interfaces/logs.ts). The previous parser failed
  // both checks, so deploy smoke never flagged anything.
  const logs = await spawnLuaFn(['logs', '--ci', '--type', 'all', '--limit', '20', '--json'], { timeoutMs: 5_000 });
  if (logs.exitCode !== 0) return null;

  let entries = [];
  try {
    const parsed = JSON.parse(logs.stdout);
    entries = Array.isArray(parsed?.logs) ? parsed.logs : (Array.isArray(parsed) ? parsed : []);
  } catch {
    return null;
  }

  const sixtySecondsAgo = Date.now() - 60_000;
  const errorEntries = entries.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
    return entry.subType === 'error' && ts >= sixtySecondsAgo;
  });

  if (errorEntries.length > 0) {
    return {
      warn: `⚠ Post-deploy smoke test: ${errorEntries.length} error log entry(s) within the last minute. Investigate before traffic flips.`,
    };
  }

  return null;
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('post-deploy-smoke', decide, { eventName: 'PostToolUse' });
}

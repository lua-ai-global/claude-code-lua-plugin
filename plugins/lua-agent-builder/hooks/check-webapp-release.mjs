// PreToolUse hook for the session's `stage_for_test` and `request_release` (1.20.5): a static web-app check.
//
// Lua Studio's 8-persona production test (9 Nov 2026): generated web apps scrolled sideways on a phone, clipped their
// nav, overflowed the desktop App pane, logged 20-67 CSP errors per run (toast and chart <style> elements without the
// page nonce), and a release's seed code reset a payment run the user had approved. A build-session pod has no
// browser, so the builder cannot screenshot the page at 390 x 844; lib/webapp-check.mjs reads the code instead.
//
// It only WARNS (context after the call, never a block): a heuristic must never stop a release the user wants.
// Outside a session it does nothing, and it ignores every other tool.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { isBuildSession, SESSION_MCP_SERVER } from '../lib/session-mode.mjs';
import { checkWebApps, formatFindings } from '../lib/webapp-check.mjs';

const WHEN = {
  [`mcp__${SESSION_MCP_SERVER}__stage_for_test`]: 'stage',
  [`mcp__${SESSION_MCP_SERVER}__request_release`]: 'release',
};

/**
 * @param {{tool_name?: string, cwd?: string}|null} input
 * @param {Record<string, string|undefined>} [env] — defaults to process.env (build-session switch)
 * @param {(cwd: string) => Array<{rule: string, file: string, line: number, message: string}>} [check]
 */
export function decide(input, env = process.env, check = checkWebApps) {
  const when = WHEN[input?.tool_name ?? ''];
  if (!when || !isBuildSession(env)) return null;
  const note = formatFindings(check(input?.cwd || process.cwd()), when);
  return note ? { warn: note } : null;
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('check-webapp-release', decide, { eventName: 'PreToolUse' });
}

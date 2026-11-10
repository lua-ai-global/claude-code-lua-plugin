// PreToolUse hook for the session's `stage_for_test` and `request_release` (1.20.5): a static web-app check.
//
// Lua Studio's 8-persona production test (9 Nov 2026): generated web apps scrolled sideways on a phone, clipped their
// nav, overflowed the desktop App pane, logged 20-67 CSP errors per run (toast and chart <style> elements without the
// page nonce), and a release's seed code reset a payment run the user had approved. A build-session pod has no
// browser, so the builder cannot screenshot the page at 390 x 844; lib/webapp-check.mjs reads the code instead.
//
// It only WARNS (context after the call, never a block): a heuristic must never stop a release the user wants.
// Outside a session it does nothing, and it ignores every other tool.
//
// 1.20.8: in a fleet session (more than one agent folder), a call with no `agentIds` restages or rebuilds EVERY
// editable agent, one after the other (lua-core session-tools.service.ts stageForTest; lua-workflow-job
// release-candidate.ts). A power user's 6-agent build took ~20 minutes; the note names the cost (build-session.md §2a).

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { isBuildSession, SESSION_MCP_SERVER } from '../lib/session-mode.mjs';
import { agentRoots, checkWebApps, formatFindings } from '../lib/webapp-check.mjs';

const WHEN = {
  [`mcp__${SESSION_MCP_SERVER}__stage_for_test`]: 'stage',
  [`mcp__${SESSION_MCP_SERVER}__request_release`]: 'release',
};

/**
 * @param {{tool_name?: string, cwd?: string, tool_input?: unknown}|null} input
 * @param {Record<string, string|undefined>} [env] — defaults to process.env (build-session switch)
 * @param {(cwd: string) => Array<{rule: string, file: string, line: number, message: string}>} [check]
 * @param {(cwd: string) => string[]} [roots] — the agent folders under the session (fleet: more than one)
 */
export function decide(input, env = process.env, check = checkWebApps, roots = agentRoots) {
  const when = WHEN[input?.tool_name ?? ''];
  if (!when || !isBuildSession(env)) return null;
  const cwd = input?.cwd || process.cwd();
  const notes = [formatFindings(check(cwd), when), allAgentsNote(input?.tool_input, roots(cwd).length, when)].filter(Boolean);
  return notes.length ? { warn: notes.join('\n') } : null;
}

/**
 * The cost note for a fleet call that names no agents.
 * @param {unknown} toolInput
 * @param {number} agentCount
 * @param {'stage'|'release'} when
 * @returns {string|null}
 */
export function allAgentsNote(toolInput, agentCount, when) {
  if (agentCount < 2) return null;
  const ids = /** @type {{agentIds?: unknown}} */ (toolInput ?? {}).agentIds;
  if (Array.isArray(ids) && ids.length) return null;
  const what =
    when === 'release'
      ? 'builds every editable agent of this session in turn (compile, npm test, push)'
      : 'restages every editable agent of this session, one after the other';
  return `[lua] Speed: this call names no agentIds, so it ${what} (${agentCount} agent folders here). When only some agents changed (since the last stage; for a release, since the last release), pass agentIds of those agents only next time (build-session.md §2a).`;
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('check-webapp-release', decide, { eventName: 'PreToolUse' });
}

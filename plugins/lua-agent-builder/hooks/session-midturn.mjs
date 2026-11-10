// PostToolUse hook (every tool): in a live build session with mid-turn delivery on, hands Claude the messages the
// user sent while it was working, at this tool boundary instead of when the whole turn ends.
//
// The session pod (lua-core-services lua-workflow-job, `LUA_BS_MIDTURN=1`) serves a loopback take route and sets
// `LUA_BS_MIDTURN_URL`. This hook posts the finished tool call's `tool_use_id`; the pod answers with the plain-text
// messages at the head of its queue, already marked delivered, fenced in <lua-user-message-midturn>. The hook adds
// them as context after the tool result. The pod only answers for a top-level tool call of the running turn, once.
//
// Off (nothing at all happens) unless LUA_BUILD_SESSION, LUA_BS_MIDTURN=1 and a loopback LUA_BS_MIDTURN_URL are all
// set. Any error, timeout or empty answer is silent: the message then reaches Claude as its next turn, as before.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { isBuildSession } from '../lib/session-mode.mjs';

export const MIDTURN_ENV_FLAG = 'LUA_BS_MIDTURN';
export const MIDTURN_URL_ENV = 'LUA_BS_MIDTURN_URL';
/** Well inside the hook's own timeout (hooks.json): the pod answers from memory. */
export const MIDTURN_TAKE_TIMEOUT_MS = 2000;
/** What the pod hands over is bounded; anything larger is not trusted as its answer. */
const MAX_CONTEXT_CHARS = 200_000;

/**
 * The take URL, or null when mid-turn delivery is off here. Loopback only: the hook never posts a tool id anywhere else.
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
export function midturnTakeUrl(env = process.env) {
  if (!isBuildSession(env) || env?.[MIDTURN_ENV_FLAG] !== '1') return null;
  const raw = String(env?.[MIDTURN_URL_ENV] ?? '').trim();
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.pathname !== '/midturn/take') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * @param {{tool_use_id?: string}|null} input
 * @param {Record<string, string|undefined>} [env]
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{warn: string}|null>}
 */
export async function decide(input, env = process.env, fetchFn = globalThis.fetch) {
  const url = midturnTakeUrl(env);
  if (!url) return null;
  const toolUseId = input?.tool_use_id;
  if (typeof toolUseId !== 'string' || !toolUseId) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MIDTURN_TAKE_TIMEOUT_MS);
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolUseId }),
      signal: ac.signal,
    });
    if (r.status !== 200) return null;
    const body = await r.json();
    const context = typeof body?.context === 'string' ? body.context : '';
    if (!context || context.length > MAX_CONTEXT_CHARS) return null;
    return { warn: context };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('session-midturn', (input) => decide(input), { eventName: 'PostToolUse' });
}

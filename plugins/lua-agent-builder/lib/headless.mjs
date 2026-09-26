// Headless mode (EM-WS8, 1.6.0). See docs/JOB_TIER.md at the repository root.
//
// `LUA_PLUGIN_HEADLESS=1` tells the hooks that no human is in the loop — the
// plugin runs inside `claude -p` in the Lua Job tier (or any other
// unattended harness). In that mode:
//
//   * no hook message points at a slash command. The slashes that fix things
//     (/lua-auth, /lua-doctor, /lua-update, /lua-deploy, /lua-template) all
//     need AskUserQuestion or the Agent tool, both unavailable headless, and a
//     message naming them steers the model into a flow that cannot complete;
//   * confirm-deploy treats the LUA_DEPLOY_CONFIRMED=1 prefix as VOID. The
//     prefix means "a person confirmed this deploy"; headless, the model would
//     be confirming to itself. Every production verb is blocked (fail closed);
//     production changes are made outside the run;
//   * post-deploy-smoke never sends its production `lua chat` ping.
//
// Blocking behaviour is otherwise identical: every command that is blocked
// interactively is blocked headless too.

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isHeadless(env = process.env) {
  return TRUTHY.has(String(env?.LUA_PLUGIN_HEADLESS ?? '').trim().toLowerCase());
}

/** The sentence every headless message ends with instead of a slash command. */
export const HEADLESS_NOTE =
  'This is a headless run (LUA_PLUGIN_HEADLESS=1): there is no one to answer a prompt, so do not start ' +
  'an interactive sign-in, install or deploy flow — continue with the task, or report the problem in your result.';

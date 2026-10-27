// SessionStart hook: the live-build-session brief (1.15.0, spec v3 B22/B23).
//
// Outside a session (LUA_BUILD_SESSION unset) it returns null: no output. In a session it injects a short brief —
// which lua commands run directly, that production changes are approved in Lua Desktop, the release and secret
// tools — so the plugin's slash commands take their "Build session" path even under a harness that does not
// describe the session itself. The full table is lib/knowledge/build-session.md.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import { sessionStartBrief } from '../lib/session-mode.mjs';

/**
 * @param {unknown} _input — SessionStart payload (unused)
 * @param {Record<string, string|undefined>} [env] — defaults to process.env (build-session switch)
 */
export function decide(_input, env = process.env) {
  const brief = sessionStartBrief(env);
  return brief ? { warn: brief } : null;
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('session-context', decide, { eventName: 'SessionStart' });
}

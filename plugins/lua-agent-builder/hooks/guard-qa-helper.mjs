import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';

// The permission template allows `node *lua-agent-builder*/lib/qa/cli.mjs *` so the /lua-qa full-suite
// helpers run without a prompt. A glob cannot tell the plugin's own cli.mjs from any other file with the
// same name under a path that contains `lua-agent-builder` (a file an agent wrote into /tmp or into the
// project), and confirm-deploy does not look inside `node <script>`. This hook closes that gap: every
// `node …/lib/qa/cli.mjs` call must run THIS plugin's helper, compared by real path, or it is blocked.
//
// Text match, deliberately broad: `node` (bare or a path ending in it) followed DIRECTLY by an absolute script
// path ending in `lib/qa/cli.mjs` (double-quoted, single-quoted or bare). Every mention of the helper path in a
// command that runs node must belong to such a call, and every call must resolve to this plugin's helper.
// Blocked as unverifiable: any node flag before the script (`--require`, `--import`, `--eval` would run other
// code first), NODE_OPTIONS anywhere in the command, a relative path (a `cd` earlier in the same command would
// change what it means), command substitution and unexpanded variables. Nothing the plugin emits uses those.
const NODE_RE = /(?:^|[\s;&|(`])(?:\S*\/)?node(?:\.exe)?\s/;
const PATH_RE = /lib[\\/]qa[\\/]cli\.mjs/g;
const CALL_RE = /(?:^|[\s;&|(`])(?:\S*\/)?node(?:\.exe)?\s+(?:"([^"`]*lib[\\/]qa[\\/]cli\.mjs)"|'([^']*lib[\\/]qa[\\/]cli\.mjs)'|([^\s"';&|`()]*lib[\\/]qa[\\/]cli\.mjs))(?=[\s;&|)`]|$)/g;

/** The real path of the helper that ships next to this hook. */
export function genuineHelper() {
  return realpathSync(fileURLToPath(new URL('../lib/qa/cli.mjs', import.meta.url)));
}

/**
 * @param {{tool_input?: {command?: string}, cwd?: string}|null} input
 * @param {Record<string, string|undefined>} [env] — CLAUDE_PLUGIN_ROOT expands `${CLAUDE_PLUGIN_ROOT}` in the path
 * @param {{realpath?: (p: string) => string, genuine?: () => string}} [deps]
 */
export function decide(input, env = process.env, deps = {}) {
  const command = input?.tool_input?.command ?? '';
  if (!NODE_RE.test(command)) return null;
  const mentions = (command.match(PATH_RE) ?? []).length;
  if (mentions === 0) return null;
  const realpath = deps.realpath ?? realpathSync;
  const genuine = (deps.genuine ?? genuineHelper)();
  const deny = (what) => ({
    block: true,
    reason:
      `QA_HELPER_DENIED: ${what} is not this plugin's QA helper (${genuine}). ` +
      'Only the lua-agent-builder plugin\'s own lib/qa/cli.mjs may run under the /lua-qa permission rule. ' +
      'Call it as `node <absolute plugin root>/lib/qa/cli.mjs …`.',
  });
  if (/\bNODE_OPTIONS\b/.test(command)) return deny('a helper call with NODE_OPTIONS (it can load other code first)');
  const calls = [...command.matchAll(CALL_RE)];
  if (calls.length !== mentions) return deny('a helper path the hook cannot verify (a node flag, command substitution, or not a plain `node <script>` call)');
  for (const m of calls) {
    let script = m[1] ?? m[2] ?? m[3];
    if (env.CLAUDE_PLUGIN_ROOT) script = script.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT(?!\w)/g, env.CLAUDE_PLUGIN_ROOT);
    let real = null;
    if (!script.includes('$') && isAbsolute(script)) {
      try {
        real = realpath(script);
      } catch {
        real = null;
      }
    }
    if (real !== genuine) return deny(`\`${script.slice(0, 200)}\``);
  }
  return null;
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('guard-qa-helper', decide);
}

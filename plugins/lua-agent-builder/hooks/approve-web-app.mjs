import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';

// Approves — without a permission prompt — exactly the commands /lua-new
// webapp (lua-skill-builder) and /lua-push run for a web app, and nothing else:
//
//   lua apps new <name>
//   npm --prefix src/apps/<name>/web install --ignore-scripts
//   npm --prefix src/apps/<name>/web install --ignore-scripts @lua-ai-global/app-client
//   npm --prefix src/apps/<name>/web run typecheck
//   npm --prefix src/apps/<name>/web run build
//
// Why a hook and not allow rules: a permission glob's `*` matches spaces, so
// `Bash(npm --prefix src/apps/*/web install)` also admitted
// `npm --prefix src/apps/x/web install evil --prefix src/apps/x/web install`,
// `npm --prefix src/apps/../../../tmp/web install` and a second `--prefix`
// (the last one wins), and `Bash(lua apps new *)` admitted any trailing text
// (PR #17 reviews). These regexes are anchored and have no wildcard: `<name>`
// is the web-app name pattern (`WEB_APP_NAME_PATTERN` in @lua/shared-types,
// capped at 63 like a DNS label), so no `/`, `.`, space or shell
// metacharacter can appear anywhere in the command.
//
// `--ignore-scripts`: no dependency's install script runs unprompted (the
// template builds without them — vite, tailwind and esbuild ship their native
// binaries as optional dependencies). `run typecheck` / `run build` run the
// page project's own package.json scripts and vite.config.ts, which the model
// can edit — the same trust the template already gives `lua test --ci*`, which
// runs the project's own code. `lua apps new` only writes local files
// (src/apps/<name>/, src/index.ts, tsconfig.json) and never overwrites.
//
// Returning null leaves the command to Claude Code's normal permission flow
// (a prompt unless the user's own rules allow it). A hook `allow` never
// overrides a deny or ask rule.
const NAME = '[a-z][a-z0-9-]{0,62}';

export const WEB_APP_NEW_RE = new RegExp(`^lua apps new ${NAME}$`);
export const WEB_APP_NPM_RE = new RegExp(
  `^npm --prefix src/apps/${NAME}/web (?:install --ignore-scripts(?: @lua-ai-global/app-client)?|run typecheck|run build)$`,
);
export const WEB_APP_COMMAND_RES = [WEB_APP_NEW_RE, WEB_APP_NPM_RE];

/** @param {{tool_input?: {command?: string}}|null} input */
export function decide(input) {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !WEB_APP_COMMAND_RES.some((re) => re.test(command))) return null;
  return {
    allow: true,
    reason: 'lua-agent-builder: a web-app command in its exact form, approved by hooks/approve-web-app.mjs.',
  };
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('approve-web-app', decide, { eventName: 'PreToolUse' });
}

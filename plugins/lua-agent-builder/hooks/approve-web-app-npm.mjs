import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';

// Approves — without a permission prompt — exactly the four npm commands
// /lua-new webapp (lua-skill-builder) and /lua-push run in a web app's page
// project, and nothing else:
//
//   npm --prefix src/apps/<name>/web install --ignore-scripts
//   npm --prefix src/apps/<name>/web install --ignore-scripts @lua-ai-global/app-client
//   npm --prefix src/apps/<name>/web run typecheck
//   npm --prefix src/apps/<name>/web run build
//
// Why a hook and not allow rules: a permission glob's `*` matches spaces too,
// so `Bash(npm --prefix src/apps/*/web install)` also admitted
// `npm --prefix src/apps/x/web install evil --prefix src/apps/x/web install`,
// `npm --prefix src/apps/../../../tmp/web install` and a second `--prefix`
// (the last one wins). This regex is anchored and has no wildcard: `<name>` is
// the web-app name pattern (`WEB_APP_NAME_PATTERN` in @lua/shared-types), so no
// `/`, `.`, space or shell metacharacter can appear anywhere in the command.
//
// `--ignore-scripts`: no dependency's install script runs unprompted (the
// template builds without them — vite, tailwind and esbuild ship their native
// binaries as optional dependencies). `run typecheck` / `run build` run the
// page project's own package.json scripts and vite.config.ts, which the model
// can edit — the same trust the template already gives `lua test --ci*`, which
// runs the project's own code.
//
// Returning null leaves the command to Claude Code's normal permission flow
// (a prompt unless the user's own rules allow it). A hook `allow` never
// overrides a deny or ask rule.
export const WEB_APP_NPM_RE =
  /^npm --prefix src\/apps\/([a-z][a-z0-9-]{0,62})\/web (?:install --ignore-scripts(?: @lua-ai-global\/app-client)?|run typecheck|run build)$/;

/** @param {{tool_input?: {command?: string}}|null} input */
export function decide(input) {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !WEB_APP_NPM_RE.test(command)) return null;
  return {
    allow: true,
    reason: 'lua-agent-builder: a web-app page-project command (exact form, approved by hooks/approve-web-app-npm.mjs).',
  };
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('approve-web-app-npm', decide, { eventName: 'PreToolUse' });
}

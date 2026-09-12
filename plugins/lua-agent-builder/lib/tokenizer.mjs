// Per tech spec §17.4 / feature doc §6.5.
// Parses bash command strings to detect production-affecting lua-cli
// invocations and the LUA_DEPLOY_CONFIRMED=1 prefix that signals
// user-authorised intent. Refuses shell wrappers and pipes — these can't be
// safely classified, so they're denied even with the right env var.
//
// THIS FILE IS THE SINGLE SOURCE OF TRUTH for "what changes production".
// hooks/confirm-deploy.mjs and hooks/post-deploy-smoke.mjs classify with it
// (they are registered for every Bash call, with no `if` glob to keep in
// sync). lib/permissions-template.json allows only the prefixed canonical
// forms and deliberately carries NO deny/ask rule for the bare verbs — Claude
// Code evaluates deny/ask past a leading env assignment, so such a rule would
// block the confirmed form too. The hook block (exit 2) is what stops a bare
// verb; test/lib/permissions-mirror.test.mjs pins the two layers together.
//
// The gated set is every lua-cli verb that changes what runs in production
// (verified against packages/lua-cli/src/cli/command-definitions.ts and
// src/utils/aliases.ts, lua-cli 3.33.0), INCLUDING the action aliases the CLI
// resolves at runtime (aliases.ts: `publish` → deploy, `on`/`enable` →
// activate, `submit`/`publish_version` → template publish, `deploy`/
// `fleet-apply`/`rollout` → template apply, `prod`/`prd`/`live` →
// production) and the three installed binaries (`lua`, `heylua`, `lua-ai`).
//
//   lua deploy <type>                      per-primitive publish (skill, webhook, trigger, job, pre/postprocessor, persona, all)
//   lua skills|webhooks|jobs|preprocessors|postprocessors deploy|publish   the same publish, older spelling
//   lua persona production deploy|publish  persona version goes live
//   lua workflows deploy|publish <name> -v <ver>   workflow version goes live
//   lua workflows activate|on|enable <name> [-v]   enables schedules/triggers (with -v: also a deploy)
//   lua version promote <n>                atomic swap of the live agent version (no CLI confirmation!)
//   lua mcp activate|on|enable <name>      MCP server becomes available to the live agent
//   lua marketplace template publish|publish_version|submit   org-facing template release (auto-applies to consenting installs)
//   lua marketplace template apply|deploy|fleet-apply|rollout fleet rollout
//
// `lua push … --auto-deploy` publishes as a side effect of a push and is
// never allowed, prefix or not (lua-cli ignores it for `push all`, but a
// granular push would deploy).

const PREFIX = /^(?:env\s+)?LUA_DEPLOY_CONFIRMED=1\s+/;
const WRAPPER_HEAD = /^(bash|sh|zsh)\s/;
const BIN = '(?:lua|heylua|lua-ai)';

const rule = (label, body, slash) => ({ label, re: new RegExp(`^${BIN}\\s+${body}`), slash });

/**
 * Ordered list of gated command shapes. Each entry: the regex that matches
 * the command (after any prefix is stripped; anchored at the binary), a short
 * label, and the slash command that collects the user's confirmation.
 */
export const PRODUCTION_COMMANDS = [
  rule('lua deploy', 'deploy\\b', '/lua-deploy'),
  rule('lua skills deploy', 'skills\\s+(?:deploy|publish)\\b', '/lua-deploy'),
  rule('lua webhooks deploy', 'webhooks\\s+(?:deploy|publish)\\b', '/lua-deploy'),
  rule('lua jobs deploy', 'jobs\\s+(?:deploy|publish)\\b', '/lua-deploy'),
  rule('lua preprocessors deploy', 'preprocessors\\s+(?:deploy|publish)\\b', '/lua-deploy'),
  rule('lua postprocessors deploy', 'postprocessors\\s+(?:deploy|publish)\\b', '/lua-deploy'),
  rule('lua persona production deploy', 'persona\\s+(?:production|prod|prd|live)\\s+(?:deploy|publish)\\b', '/lua-deploy'),
  rule('lua workflows deploy', 'workflows\\s+(?:deploy|publish)\\b', '/lua-deploy'),
  rule('lua workflows activate', 'workflows\\s+(?:activate|on|enable)\\b', '/lua-deploy'),
  rule('lua version promote', 'version\\s+promote\\b', '/lua-deploy'),
  rule('lua mcp activate', 'mcp\\s+(?:activate|on|enable)\\b', '/lua-deploy'),
  rule('lua marketplace template publish', 'marketplace\\s+template\\s+(?:publish|publish_version|submit)\\b', '/lua-template'),
  rule('lua marketplace template apply', 'marketplace\\s+template\\s+(?:apply|deploy|fleet-apply|rollout)\\b', '/lua-template'),
];

/** Labels whose success should trigger the post-deploy smoke check (something now runs live). */
export const SMOKE_LABELS = new Set([
  'lua deploy', 'lua skills deploy', 'lua webhooks deploy', 'lua jobs deploy', 'lua preprocessors deploy',
  'lua postprocessors deploy', 'lua persona production deploy', 'lua workflows deploy', 'lua version promote',
  'lua mcp activate',
]);

/**
 * Classify a command. Returns null for commands that are not gated, or
 * `{ label, slash, prefixed }` for a production-affecting lua-cli verb.
 * Shell wrappers and pipes are reported as unsafe (`prefixed: false`) even
 * when the env var is present, because the real command can't be seen.
 *
 * @param {unknown} command
 * @returns {{label: string, slash: string, prefixed: boolean}|null}
 */
export function classifyProductionCommand(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trimStart();
  const unsafe = trimmed.includes('|') || WRAPPER_HEAD.test(trimmed);
  const hasPrefix = PREFIX.test(trimmed);
  const body = hasPrefix ? trimmed.replace(PREFIX, '') : trimmed;
  // Inside a wrapper/pipe the verb may sit anywhere — search, don't anchor.
  const haystack = unsafe ? trimmed : body;
  for (const entry of PRODUCTION_COMMANDS) {
    const anchored = unsafe ? new RegExp(entry.re.source.replace(/^\^/, '(?<![\\w-])')) : entry.re;
    if (anchored.test(haystack)) {
      return { label: entry.label, slash: entry.slash, prefixed: hasPrefix && !unsafe };
    }
  }
  return null;
}

/**
 * True iff the command is a gated production verb carrying the
 * LUA_DEPLOY_CONFIRMED=1 prefix, with no wrapper or pipe.
 *
 * @param {unknown} command
 * @returns {boolean}
 */
export function isPrefixedDeploy(command) {
  const c = classifyProductionCommand(command);
  return !!c && c.prefixed;
}

/**
 * @param {unknown} command
 * @returns {boolean}
 */
export function hasAutoDeploy(command) {
  if (typeof command !== 'string') return false;
  return /\s--auto-deploy\b/.test(command);
}

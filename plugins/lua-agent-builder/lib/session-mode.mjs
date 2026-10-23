// Live build session mode (1.15.0). See lib/knowledge/build-session.md and docs/BUILD_SESSION.md.
//
// A live build session runs this plugin inside a Lua session pod: one long-lived Claude Code process that a Lua
// builder drives from Lua Desktop. The pod sets `LUA_BUILD_SESSION=1` (lua-core-services shared-types
// `BUILD_SESSION_POD_ENV_FLAG`), and also `LUA_PLUGIN_HEADLESS=1` (the Job-tier plugin env). Session mode is checked
// FIRST wherever both apply: a session is not an unattended run — a person is watching in Desktop and decides on
// every production change there.
//
// Spec v3 B23 (which supersedes the B22 plugin table where they conflict): every `lua` command stays usable.
//   * reads run directly (through the session's Lua-API proxy, scoped to the session's agents);
//   * session-scoped writes (`lua push`, `lua sync`, `lua chat -e sandbox -t`, `lua test workflow`, …) land in the
//     session's private store / test version, never in production;
//   * anything that changes production becomes an APPROVAL REQUEST the user approves, edits or declines in Lua
//     Desktop (the proxy answers `pending_user_approval`); `lua deploy` / `lua version promote` become a RELEASE
//     (the `request_release` tool), never a bare promote;
//   * secret VALUES are typed by the user in Lua Desktop (the `request_secret` tool), never by Claude;
//   * `lua auth`, `lua admin`, `lua docs`, `lua update`, `lua destroy`, … are not available.
//
// Session mode never REMOVES a block: every command a hook blocks interactively is still blocked here (and the
// LUA_DEPLOY_CONFIRMED=1 prefix is void, as headless). It only rewords the messages, skips the laptop-only
// SessionStart probes (auth, CLI version) and the post-deploy production ping, and adds context. With
// LUA_BUILD_SESSION unset every hook behaves exactly as before.

import { findLuaInvocations, UNCLASSIFIABLE_LABEL, UNRESOLVED_LABEL } from './tokenizer.mjs';
import { classifyLuaCommand, flagValue, isSecretKeyName } from './session-commands.mjs';

/** The pod env var (shared-types `BUILD_SESSION_POD_ENV_FLAG`). */
export const BUILD_SESSION_ENV_FLAG = 'LUA_BUILD_SESSION';
/** The session id the pod sets beside it (informational only; never a credential). */
export const BUILD_SESSION_ID_ENV = 'LUA_BUILD_SESSION_ID';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isBuildSession(env = process.env) {
  return TRUTHY.has(String(env?.[BUILD_SESSION_ENV_FLAG] ?? '').trim().toLowerCase());
}

/**
 * The session id, when it has the documented `bs_…` shape; anything else is ignored.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function buildSessionId(env = process.env) {
  const id = String(env?.[BUILD_SESSION_ID_ENV] ?? '').trim();
  return /^bs_[A-Za-z0-9-]{1,80}$/.test(id) ? id : null;
}

/** The `lua-session` MCP server the pod passes with --mcp-config (shared-types `BUILD_SESSION_MCP_SERVER_NAME`). */
export const SESSION_MCP_SERVER = 'lua-session';
/** shared-types `BUILD_SESSION_MCP_TOOL_NAMES`. */
export const SESSION_TOOL_NAMES = Object.freeze([
  'stage_for_test',
  'test_chat',
  'preview_webapp',
  'request_release',
  'update_memory',
  'share_file',
  'request_action',
  'request_secret',
]);
/** The id Claude Code shows for a session tool: `mcp__lua-session__<name>`. */
export const sessionTool = (name) => `mcp__${SESSION_MCP_SERVER}__${name}`;

const RELEASE = sessionTool('request_release');
const ACTION = sessionTool('request_action');
const SECRET = sessionTool('request_secret');
const STAGE = sessionTool('stage_for_test');
const TEST_CHAT = sessionTool('test_chat');

/** One sentence every session-mode hook message can end with. */
export const SESSION_NOTE =
  'This is a live Lua build session (LUA_BUILD_SESSION=1): the user watches in Lua Desktop and decides every ' +
  'production change there. Do not sign in, install or confirm anything yourself.';

/**
 * The gated production labels (lib/tokenizer.mjs PRODUCTION_COMMANDS) that make CODE live: in a session they are
 * one release, built, tested and approved through `request_release` (spec B12), never a bare deploy or promote.
 */
export const RELEASE_LABELS = new Set([
  'lua deploy',
  'lua skills deploy',
  'lua skills production deploy',
  'lua webhooks deploy',
  'lua jobs deploy',
  'lua preprocessors deploy',
  'lua postprocessors deploy',
  'lua persona production deploy',
  'lua workflows deploy',
  'lua version promote',
]);

/** How a session waits on a Desktop decision (shared by the hooks and lib/knowledge/build-session.md). */
export const APPROVAL_WAIT_NOTE =
  'The CLI prints `waiting for approval in Lua Desktop…` and waits for the decision (at most 30 minutes). If the ' +
  'Bash call ends first, or the CLI exits 10 / answers 403 naming a Desktop card or a request id, the request is ' +
  'PENDING, not failed: do not run it again and do not look for another route. Tell the user in one line what you ' +
  'asked for and why; the decision comes back as a <lua-action-result> note. Prefer ' +
  `${ACTION} {agentId, command, args, reason}: it returns at once and shows your reason on the card.`;

/** confirm-deploy / block-auto-deploy: `--auto-deploy` in a session. */
export const SESSION_AUTO_DEPLOY_REASON =
  'DEPLOY_DENIED_AUTO: --auto-deploy is never allowed. Push without it (the push lands in this session, not in ' +
  `production). Making the change live is a release the user approves in Lua Desktop: call ${RELEASE} with a ` +
  'plain-words summary of what changes. ' + SESSION_NOTE;

/** block-auth-configure in a session. */
export const SESSION_AUTH_REASON =
  'AUTH_INPUT_DENIED: `lua auth` is not available in a live build session: Lua access comes from the session ' +
  'itself. If a lua command fails with an auth error, tell the user; never try to sign in, and never ask for an ' +
  'email, one-time code or key in the chat.';

/** block-device-secret in a session (the device credential is issued to the user, never into the pod). */
export const SESSION_DEVICE_SECRET_REASON =
  'DEVICE_SECRET_DENIED: in a live build session a device credential is issued to the user in Lua Desktop, never ' +
  'into the session, `--out` file or not. Tell the user to issue it there (or in their own terminal), write the ' +
  'client so it reads LUA_DEVICE_CREDENTIAL from a git-ignored file at run time, and carry on.';

/**
 * confirm-deploy's session-mode reason for a blocked production verb (the second line behind the proxy).
 * @param {string} label  a tokenizer label
 * @returns {string}
 */
export function sessionDeployBlockReason(label) {
  if (label === UNCLASSIFIABLE_LABEL || label === UNRESOLVED_LABEL) {
    return (
      `DEPLOY_DENIED_SESSION: \`${label}\` — this command mentions lua in a way the guard cannot check (computed, ` +
      'too long or too complex), so it is blocked. Run each lua command on its own, spelled out. A production ' +
      `change is asked for with ${RELEASE} (deploy, promote) or ${ACTION} (anything else). ${SESSION_NOTE}`
    );
  }
  if (RELEASE_LABELS.has(label)) {
    return (
      `DEPLOY_DENIED_SESSION: \`${label}\` makes code live. In a build session that is a release the user approves ` +
      `in Lua Desktop: call ${RELEASE} with a plain-words summary of what changes (and agentIds for a fleet). It ` +
      'builds the candidate from this session, re-runs the Try it cases and shows the approval card; it never ' +
      'releases by itself. Do not retry with LUA_DEPLOY_CONFIRMED=1 or another spelling. ' + SESSION_NOTE
    );
  }
  return (
    `DEPLOY_DENIED_SESSION: \`${label}\` changes what runs in production. In a build session the user approves it in ` +
    `Lua Desktop: call ${ACTION} with {agentId (lua.skill.yaml agent.agentId), command (e.g. "${label.replace(/^lua /, '')}"), ` +
    'args, reason}. The decision comes back as a <lua-action-result> note; do not retry with LUA_DEPLOY_CONFIRMED=1 ' +
    'or another spelling. ' + SESSION_NOTE
  );
}

/** What to do instead of an unavailable command. */
const UNAVAILABLE_INSTEAD = {
  auth: 'Lua access comes from the session itself. If a lua command fails with an auth error, report it to the user; never try to sign in.',
  configure: 'Lua access comes from the session itself. If a lua command fails with an auth error, report it to the user; never try to sign in.',
  login: 'Lua access comes from the session itself. If a lua command fails with an auth error, report it to the user; never try to sign in.',
  logout: 'Lua access comes from the session itself; there is nothing to sign out of.',
  docs: 'Search the docs with the lua-docs MCP tools (search_lua_cli, query_docs_filesystem_lua_cli) instead.',
  update: 'The session image pins lua-cli; work with the installed version and tell the user if a newer one is needed.',
};

const pathOf = (argv) => {
  const pos = [];
  for (const a of argv) {
    if (a.startsWith('-')) break;
    pos.push(a);
    if (pos.length === 2) break;
  }
  return `lua ${pos.join(' ')}`.trim();
};

const ENV_NAMES = ['sandbox', 'staging', 'production'];

/**
 * @param {string[]} argv
 * @param {{class: string, ruleId: string, note?: string}} c
 * @returns {string}
 */
function unavailableReason(argv, c) {
  const head = argv[0] ?? '';
  const instead = UNAVAILABLE_INSTEAD[head] ?? '';
  return (
    `SESSION_COMMAND_UNAVAILABLE: \`lua ${head}\` is not available in a live build session` +
    `${c.note ? ` (${c.note})` : ''}. ${instead}`.trimEnd()
  );
}

/**
 * @param {string[]} argv
 * @param {{class: string, ruleId: string}} c
 * @returns {string}
 */
function secretReason(argv, c) {
  if (c.ruleId === 'devices.credential') return SESSION_DEVICE_SECRET_REASON;
  const key = flagValue(argv, '-k', '--key');
  const env = argv.slice(1).find((t) => ENV_NAMES.includes(t)) ?? 'production';
  const named = key ? `name: "${key}", ` : 'name: "<KEY>", ';
  return (
    'SESSION_SECRET_DENIED: this command would put a secret value on a command line' +
    `${key && isSecretKeyName(key) ? ` (${key} is a secret-shaped key)` : ''}. In a build session the user types ` +
    `secret values in Lua Desktop: call ${SECRET} with {${named}purpose: "<why the agent needs it>", env: "${env}"}. ` +
    'The value goes straight to the encrypted store and never reaches you. Never repeat a value you were shown, ' +
    'and never ask the user to paste one into the chat.'
  );
}

/**
 * @param {string[]} argv
 * @param {{class: string, ruleId: string, risk?: string}} c
 * @returns {string}
 */
function approvalNote(argv, c) {
  const what = pathOf(argv);
  let extra = '';
  if (c.ruleId === 'chat.live') {
    extra = ` It talks to the LIVE agent. To try this session's changes use ${TEST_CHAT} (after ${STAGE}) or \`lua chat --ci -e sandbox -m '<text>' -t\`.`;
  } else if (c.ruleId === 'version.create') {
    extra = ` To test this session's changes you do not need an agent version: call ${STAGE}.`;
  } else if (c.ruleId === 'deploy' || c.ruleId === 'version.promote' || c.ruleId === 'push.auto_deploy') {
    extra = ` Making code live is a release: call ${RELEASE} instead.`;
  }
  return (
    `[lua build session] \`${what}\` changes production (risk ${c.risk ?? 'high'}), so it becomes an approval request ` +
    `the user approves, edits or declines in Lua Desktop; it is executed with the user's own rights.${extra} ` +
    APPROVAL_WAIT_NOTE
  );
}

/**
 * The session-guard decision for one Bash command (hooks/session-guard.mjs). Outside a session: null, always.
 *
 * Blocks only what B23 says never runs in a session: the `unavailable` commands and a secret value on a command
 * line. An approval-class command is NOT blocked — the proxy turns it into a Desktop card — it gets context instead.
 * Production verbs that confirm-deploy gates stay blocked by confirm-deploy (second line).
 *
 * @param {unknown} command
 * @param {Record<string, string|undefined>} [env]
 * @returns {{block: true, reason: string}|{warn: string}|null}
 */
export function sessionCommandDecision(command, env = process.env) {
  if (!isBuildSession(env)) return null;
  const blocks = [];
  const warns = [];
  for (const { argv } of findLuaInvocations(command)) {
    if (argv.length === 0) continue; // bare `lua` prints help
    const c = classifyLuaCommand(argv);
    if (c.class === 'unavailable') blocks.push(unavailableReason(argv, c));
    else if (c.class === 'secret') blocks.push(secretReason(argv, c));
    else if (c.class === 'approval') warns.push(approvalNote(argv, c));
  }
  if (blocks.length) return { block: true, reason: [...new Set(blocks)].join('\n') };
  if (warns.length) return { warn: [...new Set(warns)].join('\n') };
  return null;
}

/**
 * The SessionStart brief (hooks/session-context.mjs). Outside a session: null.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function sessionStartBrief(env = process.env) {
  if (!isBuildSession(env)) return null;
  const id = buildSessionId(env);
  return [
    `[lua] Live build session${id ? ` ${id}` : ''}: the lua-agent-builder plugin is in session mode (LUA_BUILD_SESSION=1).`,
    '- Every lua command is usable. Reads (`lua status`, `lua logs`, `lua workflows list|status|runs`, `lua version list|show|diff`, `lua env <env> --list`, …) run directly; pushes, `lua sync`, `lua test`, `lua chat --ci -e sandbox -m … -t` land in this session\'s private store and test version, never in production.',
    `- Production changes become approval requests the user decides in Lua Desktop: ${ACTION} (or the CLI command itself, which waits for the decision). The outcome arrives as a <lua-action-result> note; never retry.`,
    `- Making code live is a release: ${RELEASE} (never \`lua deploy\` / \`lua version promote\`). Test first with ${STAGE} + ${TEST_CHAT}.`,
    `- Secret values are typed by the user in Desktop: ${SECRET} {name, purpose, env}. Never ask for one in chat.`,
    '- Not available: `lua auth|login|logout|configure`, `lua admin`, `lua docs` (use the lua-docs MCP), `lua update`, `lua destroy`.',
    '- Slash commands follow their "Build session" section; the full table is ${CLAUDE_PLUGIN_ROOT}/lib/knowledge/build-session.md. Ask questions in your reply and stop instead of using an interactive question tool, and follow subagent playbooks inline.',
  ].join('\n');
}

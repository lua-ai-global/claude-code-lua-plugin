// PreToolUse hook for every production-affecting lua-cli verb.
// Per feature doc §3.3 / tech spec §6.3 row 4.
//
// Registered for EVERY Bash call (no `if` glob in hooks.json): the
// classification lives in lib/tokenizer.mjs, which also knows the CLI's
// action aliases (`publish`, `on`, `enable`, `submit`, `rollout`, …) and the
// three installed binaries (`lua`, `heylua`, `lua-ai`). A glob list would
// have to be kept in sync with all of that; a single classifier cannot
// drift. Non-production commands return null immediately (allow).
//
// THIS HOOK IS THE GATE, not a second line. Claude Code's permission layer
// cannot express "deny the bare verb but allow the prefixed one": deny/ask
// rules match past any leading env assignment (code.claude.com/docs/en/
// permissions, verified live 2026-09-12), so a `Bash(lua deploy*)` deny would
// also block `LUA_DEPLOY_CONFIRMED=1 lua deploy …`. lib/permissions-template.json
// therefore lists only the prefixed forms (allow) and nothing for the bare
// forms; an exit-2 block from this hook takes precedence over any allow rule,
// including a broad `Bash(lua *)` in the user's own settings.
//
// 1.6.0 (EM-WS8): the classifier reads the whole command — every simple
// command in a `&&`/`;`/`||`/pipe chain, subshells, substitutions, strings run
// by another shell, env-assignment prefixes, launchers (`npx lua`, `npx
// lua-cli`, `pnpm exec lua`, `node …/lua`) and binary paths — and accepts
// the prefix only on the very simple command that runs the verb. Headless
// (LUA_PLUGIN_HEADLESS=1) the prefix is void: nobody is there to confirm, so
// every production verb is blocked and the block names no slash command.
// It remains a belt; in the Lua Job tier the Lua-API proxy is the boundary.
//
// 1.17.0: in a live build session (LUA_BUILD_SESSION=1, checked BEFORE the
// headless switch because the session pod sets both) the prefix is void too
// and every production verb stays blocked: the second line behind the
// session's Lua-API proxy. The reason routes the model to the session flow
// instead: a deploy or promote is a release (`request_release`), any other
// production change an approval request (`request_action`) the user decides
// in Lua Desktop.
//
// 1.19.1 (F3): a binary the shell computes at runtime with a literal verb
// (`$T deploy all`) in a command that mentions lua nowhere (token-based: a
// `/lua/` folder in a `cd` path does not count) is no longer blocked outright
// in an interactive session: the hook answers `permissionDecision: "ask"` so
// the user sees the command and decides. Headless and build sessions, where
// nobody can answer, still block it; a lua token anywhere (`L=lua`,
// `$(which lua)`, `"$DIR/lua"`, `npx lua`) still blocks everywhere.
// The ask is given only when the PreToolUse input's `permission_mode` is one
// where Claude Code shows the prompt to a person: `default`, `acceptEdits` or
// `plan` (ASK_PERMISSION_MODES). Under `bypassPermissions`
// (--dangerously-skip-permissions) or `dontAsk` an ask could be accepted with
// nobody confirming, and a missing field (older Claude Code) or an unknown
// value cannot be trusted either: all of those fail closed to today's
// DEPLOY_DENIED_BARE block. `auto` fails closed too: there a classifier
// settles permission prompts, and only some Claude Code versions keep it from
// approving a hook's ask. The plugin cannot see or enforce that version, so
// `auto` may be added only together with an enforced minimum Claude Code
// version that has that floor.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';
import {
  classifyProductionCommandDetailed, hasAutoDeploy, UNCLASSIFIABLE_LABEL, MAX_COMMAND_LENGTH,
} from '../lib/tokenizer.mjs';
import { isHeadless } from '../lib/headless.mjs';
import { isBuildSession, sessionDeployBlockReason, SESSION_AUTO_DEPLOY_REASON } from '../lib/session-mode.mjs';

/** PreToolUse `permission_mode` values where an `ask` reaches a person. Anything else blocks (fail closed). */
export const ASK_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);

const HEADLESS_REASON =
  'This is a headless run (LUA_PLUGIN_HEADLESS=1): nothing here can confirm a production change, so the ' +
  'LUA_DEPLOY_CONFIRMED=1 prefix is not accepted and no deploy, promote, activation or template release ' +
  'runs from this session. Stage the change (lua push, lua version create) and report it; it is made live ' +
  'outside the run. Do not retry with another spelling.';

/**
 * Pure function — exported so tests can import and call directly without
 * the side effects of running as a script (per tech spec §17.1.1).
 *
 * @param {{tool_input?: {command?: string}, permission_mode?: string}|null} input
 * @param {Record<string, string|undefined>} [env] — defaults to process.env (headless switch)
 */
export function decide(input, env = process.env) {
  const command = input?.tool_input?.command ?? '';
  const session = isBuildSession(env);
  const headless = isHeadless(env);

  if (hasAutoDeploy(command)) {
    if (session) return { block: true, reason: SESSION_AUTO_DEPLOY_REASON };
    return {
      block: true,
      reason:
        'DEPLOY_DENIED_AUTO: --auto-deploy is never appropriate from inside Claude Code ' +
        '(a granular push would publish as a side effect; lua-cli ignores it for `push all` anyway). ' +
        (headless
          ? HEADLESS_REASON
          : 'Use /lua-deploy instead — it spawns the deploy-pilot subagent which gates each step.'),
    };
  }

  const classified = classifyProductionCommandDetailed(command);

  if (!classified) return null;          // Not a production verb — allow

  // Session first (the pod sets LUA_PLUGIN_HEADLESS=1 too): prefix void, every gated verb blocked.
  if (session) return { block: true, reason: sessionDeployBlockReason(classified.label) };

  if (headless) {
    return {
      block: true,
      reason: `DEPLOY_DENIED_HEADLESS: \`${classified.label}\` changes what runs in production. ${HEADLESS_REASON}`,
    };
  }

  if (classified.prefixed) return null;  // User-authorised via the slash flow — allow

  if (classified.unresolvedHead && ASK_PERMISSION_MODES.has(input?.permission_mode)) {
    // Interactive only (session and headless returned above) and only in a permission
    // mode that shows the prompt to a person; otherwise fall through to the block below.
    return {
      ask: true,
      reason:
        `DEPLOY_ASK_UNRESOLVED: the command runs a program named by a shell variable or substitution with ` +
        `the arguments of \`${classified.label}\`, and the plugin cannot tell whether that program is lua-cli. ` +
        `Allow it only if it does not change what runs in production; a real deploy goes through ${classified.slash}.`,
    };
  }

  if (classified.label === UNCLASSIFIABLE_LABEL) {
    return {
      block: true,
      reason:
        'DEPLOY_DENIED_UNCLASSIFIABLE: this command mentions lua but is too long or too complex to check for a ' +
        `production verb (over ${MAX_COMMAND_LENGTH} bytes, or past the classifier's time budget), so it is ` +
        'blocked. Split it into shorter commands, or write long text to a file first and pass the file.',
    };
  }

  return {
    block: true,
    reason:
      `DEPLOY_DENIED_BARE: \`${classified.label}\` changes what runs in production and is blocked without the ` +
      `LUA_DEPLOY_CONFIRMED=1 prefix. Use ${classified.slash} (it collects your single confirmation per the §3.7 ` +
      'contract, then emits the prefixed form). The prefix counts only as the first word of the simple command ' +
      'that runs the verb, with the binary spelled `lua` — not in a pipe, subshell, `$(…)`, `bash -c` string, ' +
      'or through npx/pnpm/node/a path, and it confirms only that one command in a chain.',
  };
}

// Script entry point — only fires when Claude Code invokes this file directly.
// Test imports skip this block, avoiding the `process.exit` that runHook calls.
//
// Coverage note (architect review I2): the spawn-based integration test
// (test/hooks/confirm-deploy.integration.test.mjs) verifies this block runs
// correctly end-to-end, but Jest's coverage collector measures the parent
// process — child-process coverage merging would require NODE_V8_COVERAGE
// plumbing disproportionate to the value. The integration test is the
// per-§17.1.1 smoke check for entry-point wiring; istanbul ignores the
// uninstrumented lines.
/**
 * runHook knows block / allow / warn. An `ask` answer is written here as the
 * documented PreToolUse envelope (`permissionDecision: "ask"`), then the hook
 * exits 0 through runHook. Exported for tests.
 *
 * @param {(chunk: string) => void} [write]
 */
export function withAsk(decideFn, write = (chunk) => process.stdout.write(chunk)) {
  return (input) => {
    const decision = decideFn(input);
    if (!decision?.ask) return decision;
    write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: decision.reason,
      },
    }) + '\n');
    return null;
  };
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('confirm-deploy', withAsk(decide));
}

// Per tech spec §17.1 / §17.1.1.
// Common skeleton for every hooks/*.mjs. Each hook exports its `decide`
// function so unit tests can import and call directly. The script-vs-import
// guard at the bottom of each hook file ensures `runHook` only fires when
// the hook is invoked by Claude Code, never during a test import.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REQUIRED_NODE_MAJOR = 18;

/**
 * Defensive runtime check (§21.1) — catches users who bypass `npm ci`'s
 * engine-strict gate (e.g. installing via `lua claude-plugin install` from
 * a Path B distribution onto a stale Node).
 *
 * Called explicitly from each hook's entry section, not at module load —
 * loading this file during a test on too-old-Node would kill the test
 * process. Tests run on whatever Node CI provides; that's their concern.
 */
export function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < REQUIRED_NODE_MAJOR) {
    log.toClaudeCode(
      `LUA_NODE_VERSION_TOO_OLD: This plugin requires Node ≥${REQUIRED_NODE_MAJOR}. ` +
      `You have ${process.versions.node}. Update Node and re-run /lua-doctor.`
    );
    exit(0);  // Fail-open per §6.1
  }
}

/**
 * Read the JSON-encoded tool input that Claude Code sends to PreToolUse /
 * PostToolUse hooks via stdin. Returns the parsed object, or null if stdin
 * is empty (SessionStart / Stop hooks have no input payload).
 *
 * @returns {Promise<object|null>}
 */
export async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export const log = {
  /**
   * Write to stderr. Claude Code surfaces stderr from a hook ONLY when the
   * hook also exits with code 2 (block); for exit 0 the stderr is logged
   * silently and never reaches the model. Use `emitContext()` instead when
   * you want to inject information into Claude's context.
   */
  toClaudeCode(message) {
    process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  },
};

// Iteration-13 audit: every "warn" path was previously written to stderr +
// exit 0, which Claude Code logs silently and never injects into the model
// (verified against https://code.claude.com/docs/en/hooks.md). The
// documented non-blocking context-injection protocol is JSON-on-stdout
// shaped `{ hookSpecificOutput: { hookEventName, additionalContext } }`,
// supported on SessionStart, UserPromptSubmit, and PostToolUse. PreToolUse
// uses the same envelope (the hook still allows the tool, but the warning
// becomes visible to Claude). Without this fix, "Lua project detected",
// "[lua] agent: <id>", "✓ Compiled N primitives", and the post-deploy
// smoke warnings all silently dropped.

// Per https://code.claude.com/docs/en/hooks.md, these are the events that
// support the `hookSpecificOutput.additionalContext` envelope. Stop is
// notably absent — it only supports `decision: "block"`. SessionEnd
// supports the envelope per the iteration-13 follow-up confirmation.
const CONTEXT_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
]);

/**
 * Emit a JSON `hookSpecificOutput` envelope on stdout so Claude Code injects
 * the message into the model's context. Caller still must `exit(0)` after.
 */
export function emitContext(hookEventName, additionalContext) {
  if (!CONTEXT_EVENTS.has(hookEventName)) {
    // Unknown event — fall back to stderr so we at least surface in logs.
    process.stderr.write(`⚠ ${additionalContext}\n`);
    return;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext },
  }) + '\n');
}

/**
 * Exit with a Claude-Code-meaningful code.
 *   0 — allow the tool call
 *   2 — block the tool call (stderr surfaced as the reason)
 *   any other — treated as fail-open (allow) per §6.1
 *
 * Explicit stderr flush via empty write+callback: Windows can drop the last
 * line otherwise.
 */
export function exit(code) {
  process.stderr.write('', () => process.exit(code));
}

/**
 * True iff this module is the entry point for the Node process (script
 * invocation), false when it's been `import`-ed from another module.
 *
 * Cross-platform: resolves both sides to absolute paths so Windows
 * (forward-slash file:// URL vs back-slash argv[1]) and POSIX agree.
 *
 * @param {string} importMetaUrl - pass `import.meta.url` from the calling module
 */
export function isMainScript(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return resolve(fileURLToPath(importMetaUrl)) === resolve(process.argv[1]);
  } catch {
    return false;
  }
}

/**
 * Wrap a hook's main logic with fail-open error handling. A hook with a
 * runtime bug must not lock the user out of the plugin (§6.1).
 *
 * @param {string} hookName  Used for error messages only.
 * @param {(input: object|null) => Promise<{block?: boolean, reason?: string, warn?: string}|null> | {block?: boolean, reason?: string, warn?: string}|null} decideFn
 * @param {{eventName?: string}} [opts] eventName is one of SessionStart |
 *   UserPromptSubmit | PreToolUse | PostToolUse — required for the warn
 *   path to surface in Claude's context (the JSON envelope needs it).
 */
export async function runHook(hookName, decideFn, { eventName } = {}) {
  try {
    const input = await readStdin();
    const decision = await decideFn(input);
    if (decision?.block) {
      log.toClaudeCode(decision.reason ?? `Blocked by ${hookName}.`);
      exit(2);
      /* istanbul ignore next */ return;  // defensive: exit() doesn't return in production
    }
    if (decision?.warn) {
      if (eventName) {
        emitContext(eventName, decision.warn);
      } else {
        // Fall back to stderr — undocumented behaviour, but better than
        // silent drop in case a hook author forgot the eventName parameter.
        log.toClaudeCode(`⚠ ${decision.warn}`);
      }
    }
    exit(0);
  } catch (err) {
    log.toClaudeCode(`Hook ${hookName} error: ${err.message}. Allowing the tool call (fail-open).`);
    exit(0);
  }
}

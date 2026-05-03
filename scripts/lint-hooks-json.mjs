#!/usr/bin/env node
// Validates hooks/hooks.json against Claude Code's documented schema.
//
// Iteration-13 audit: every `if` filter in hooks.json was written in regex
// syntax (`^`, `\s`, `\.`, `(?:...)`, `|`), but Claude Code interprets `if`
// as a permission-rule glob (the same format as settings.json's
// `permissions.allow`) where `*` is the only wildcard
// (verified via https://code.claude.com/docs/en/hooks.md and
// https://code.claude.com/docs/en/permissions.md). All five conditional
// hooks were silently never firing — bare `lua deploy` was still blocked
// at the permissions-deny layer, but the env-prefixed deploy form ran
// without `confirm-deploy.mjs`, the auto-deploy block hook never ran, and
// post-deploy smoke + post-compile summary never produced output.
//
// This lint flags regex-only metacharacters that have no glob meaning,
// plus structural issues (bad event names, unknown hook fields).

import { readFile } from 'node:fs/promises';

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

const HOOKS_PATH = 'hooks/hooks.json';

let doc;
try {
  doc = JSON.parse(await readFile(HOOKS_PATH, 'utf8'));
} catch (err) {
  console.error(`✗ Could not read ${HOOKS_PATH}: ${err.message}`);
  process.exit(1);
}

const VALID_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Stop', 'SubagentStop', 'PreCompact', 'Notification',
]);

const VALID_HOOK_FIELDS = new Set(['type', 'command', 'if', 'timeout']);
const VALID_MATCHER_FIELDS = new Set(['matcher', 'hooks']);

// Regex-only metacharacters that have NO meaning in Claude Code permission
// globs. If any of these appear inside an `if` value's `Bash(...)` payload,
// the pattern is being misinterpreted as a literal character match.
//
// Note: `.*` IS valid glob (literal `.` followed by `*` wildcard), so it's
// deliberately NOT flagged. Only constructs with no glob analogue are.
const REGEX_ONLY = /[\^$\\|]|\(\?[:=!]/;

const events = doc?.hooks ?? {};
if (!events || typeof events !== 'object') {
  fail(`${HOOKS_PATH}: top-level "hooks" object is missing`);
  process.exit(1);
}

for (const [event, entries] of Object.entries(events)) {
  if (!VALID_EVENTS.has(event)) {
    fail(`${HOOKS_PATH}: unknown event "${event}". Valid: ${[...VALID_EVENTS].join(', ')}`);
    continue;
  }
  if (!Array.isArray(entries)) {
    fail(`${HOOKS_PATH}: hooks.${event} must be an array`);
    continue;
  }
  for (const matcherEntry of entries) {
    for (const k of Object.keys(matcherEntry ?? {})) {
      if (!VALID_MATCHER_FIELDS.has(k)) {
        fail(`${HOOKS_PATH}: hooks.${event}[]: unknown matcher field "${k}"`);
      }
    }
    const hooksList = matcherEntry?.hooks;
    if (!Array.isArray(hooksList)) {
      fail(`${HOOKS_PATH}: hooks.${event}[].hooks must be an array`);
      continue;
    }
    for (const hook of hooksList) {
      for (const k of Object.keys(hook ?? {})) {
        if (!VALID_HOOK_FIELDS.has(k)) {
          fail(`${HOOKS_PATH}: hooks.${event}[].hooks[]: unknown hook field "${k}"`);
        }
      }
      if (hook?.type !== 'command') {
        fail(`${HOOKS_PATH}: hook in ${event} is missing type:'command' (got ${JSON.stringify(hook?.type)})`);
      }
      if (typeof hook?.command !== 'string') {
        fail(`${HOOKS_PATH}: hook in ${event} is missing a string command`);
      }
      if (hook && 'timeout' in hook && (typeof hook.timeout !== 'number' || hook.timeout <= 0)) {
        fail(`${HOOKS_PATH}: hook in ${event} has invalid timeout=${JSON.stringify(hook.timeout)}`);
      }
      if (typeof hook?.if === 'string') {
        const m = hook.if.match(/^([A-Z][A-Za-z]*)\((.+)\)$/);
        if (!m) {
          fail(`${HOOKS_PATH}: hook.if "${hook.if}" doesn't match permission-rule shape Tool(payload). Example: Bash(lua deploy*).`);
        } else {
          const [, , payload] = m;
          if (REGEX_ONLY.test(payload)) {
            fail(`${HOOKS_PATH}: hook.if "${hook.if}" contains regex-only metacharacters (^, $, \\, |, .*, (?:). Claude Code evaluates \`if\` as a permission glob — only \`*\` is a wildcard. Rewrite using \`*\` (e.g. Bash(lua deploy*) or Bash(*--auto-deploy*)).`);
          }
        }
      }
    }
  }
}

if (failed) {
  console.error('\nFix the issues above and re-run `npm run lint`.');
  process.exit(1);
}
console.log('✓ hooks/hooks.json: schema is valid and all `if` filters use permission-glob syntax.');

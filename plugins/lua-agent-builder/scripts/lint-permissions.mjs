#!/usr/bin/env node
// Validates the canonical permissions template.
//
// The template lives at lib/permissions-template.json (NOT settings.json) —
// per the iter-12 audit, plugin-level settings.json's permissions block is
// silently ignored by Claude Code. /lua-doctor merges this template into
// the user's project .claude/settings.json on first run.
//
// This script also enforces:
//   1. settings.json does NOT contain a permissions block (would mislead
//      future maintainers into thinking it works).
//   2. .claude-plugin/ contains ONLY plugin.json (no other directories or
//      files — they're silently ignored when placed there).

import { readFile, readdir } from 'node:fs/promises';

const TEMPLATE_PATH = 'lib/permissions-template.json';
const SETTINGS_PATH = 'settings.json';
let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

let templateDoc;
try {
  templateDoc = JSON.parse(await readFile(TEMPLATE_PATH, 'utf8'));
} catch (err) {
  console.error(`✗ Could not read ${TEMPLATE_PATH}: ${err.message}`);
  process.exit(1);
}

const perms = templateDoc?.permissions;
if (!perms || typeof perms !== 'object') {
  fail(`${TEMPLATE_PATH} must have a "permissions" object`);
  process.exit(1);
}

// Anti-regression check: ensure the (silently-ignored) settings.json
// doesn't contain a permissions block. If it does, a future maintainer
// would assume it's the source of truth and edit the wrong file.
try {
  const settingsDoc = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'));
  if (settingsDoc?.permissions) {
    fail(`${SETTINGS_PATH} contains a "permissions" block — Claude Code silently ignores this in plugins (iter-12 audit). Move the rules to ${TEMPLATE_PATH} and document in /lua-doctor.`);
  }
} catch { /* settings.json missing is fine */ }

// Anti-regression check: .claude-plugin/ should contain ONLY plugin.json.
// Any other file there is silently ignored by Claude Code.
try {
  const claudePluginEntries = await readdir('.claude-plugin');
  for (const entry of claudePluginEntries) {
    if (entry !== 'plugin.json') {
      fail(`.claude-plugin/${entry} exists but Claude Code only recognises plugin.json there. ${entry === 'hooks.json' ? 'hooks.json should live at hooks/hooks.json (co-located with the .mjs files).' : 'Move it to the plugin root.'}`);
    }
  }
} catch { /* .claude-plugin/ missing is a separate problem caught elsewhere */ }

for (const tier of ['allow', 'ask', 'deny']) {
  if (perms[tier] && !Array.isArray(perms[tier])) {
    fail(`permissions.${tier} must be an array`);
    continue;
  }
  for (const pattern of perms[tier] ?? []) {
    if (typeof pattern !== 'string') {
      fail(`permissions.${tier} entry is not a string: ${JSON.stringify(pattern)}`);
      continue;
    }
    if (!pattern.startsWith('Bash(') || !pattern.endsWith(')')) {
      fail(`permissions.${tier} entry doesn't match Bash(...) shape: ${pattern}`);
    }
  }
}

const allowSet = new Set(perms.allow ?? []);
const askSet = new Set(perms.ask ?? []);
const denySet = new Set(perms.deny ?? []);

for (const a of allowSet) {
  if (askSet.has(a)) fail(`Pattern in both allow and ask: ${a}`);
  if (denySet.has(a)) fail(`Pattern in both allow and deny: ${a}`);
}
for (const a of askSet) {
  if (denySet.has(a)) fail(`Pattern in both ask and deny: ${a}`);
}

// Critical safety check: bare `lua deploy` MUST be denied. The whole §3.7
// single-permission contract for deploys depends on this.
if (!denySet.has('Bash(lua deploy*)')) {
  fail('settings.json must deny `Bash(lua deploy*)` — required for §3.7 single-permission deploy gate.');
}

// Critical safety check: --auto-deploy must be denied somewhere.
const hasAutoDeployDeny = [...denySet].some((p) => p.includes('--auto-deploy'));
if (!hasAutoDeployDeny) {
  fail('settings.json must deny patterns containing `--auto-deploy` — required by §3.3 hooks.');
}

// Iteration-13 audit: `lua auth key` prints the raw API key to stdout. If
// it's auto-allowed, the key lands in the Claude conversation transcript on
// every invocation. Must be denied (or at minimum not auto-allowed) so
// Claude Code prompts the user before printing the credential.
const credentialPrinters = [
  { pattern: 'lua auth key', reason: 'prints the raw API key to stdout' },
];
for (const { pattern, reason } of credentialPrinters) {
  for (const allow of allowSet) {
    if (allow.includes(pattern)) {
      fail(`Allow rule "${allow}" matches a credential-printing command (\`${pattern}\` ${reason}). Move to ask or deny so the key never lands silently in the conversation transcript.`);
    }
  }
}

// Coverage check: every command a slash command actually emits MUST match an
// allow rule. Without this, the slash silently triggers a Bash permission
// prompt on every invocation, violating §3.7. Each REQUIRED prefix corresponds
// to a real bash invocation in commands/*.md.
//
// Found and fixed in iteration-2 audit (2026-05-02): missing entries for
// `lua init --ci`, `lua auth configure --`, and `lua skills view --ci`
// caused the doctor / init / test slashes to prompt unexpectedly.
const REQUIRED_ALLOW_PREFIXES = [
  // Critical loop slashes
  'Bash(lua --version',
  'Bash(lua init --ci',
  'Bash(lua compile --ci',
  'Bash(lua test --ci',
  'Bash(lua sync --check',
  'Bash(lua chat --ci',
  'Bash(lua logs --ci',
  'Bash(lua push * --ci',
  // Doctor probes: `lua agents --json` is the credential-safe auth probe
  // (iteration-13 audit replaced `lua auth key --force` here — that command
  // prints the API key to stdout and so leaked it into the conversation
  // transcript every time /lua-doctor ran).
  'Bash(lua agents',
  'Bash(lua auth configure --',
  // Deploy gate: only the env-prefixed form is allowed
  'Bash(LUA_DEPLOY_CONFIRMED=1 lua deploy',
  // Read-only git probes used by deploy-pilot pre-flight (`git status --short`)
  // and lua-debug history-walk (`git log --oneline`, `git diff`). Without
  // these the §3.7 single-permission contract breaks: every `git` call
  // would prompt the user mid-flow (iteration-13 audit).
  'Bash(git status',
  'Bash(git log',
  'Bash(git diff',
];

for (const prefix of REQUIRED_ALLOW_PREFIXES) {
  if (![...allowSet].some((p) => p.startsWith(prefix))) {
    fail(`Required allow pattern missing: no entry starts with "${prefix}". A slash command relies on this — without it, every invocation triggers a Bash permission prompt and violates §3.7.`);
  }
}

// ---------------------------------------------------------------------------
// Hook registration cross-check (added in iteration-11 audit).
//
// Every hook script in hooks/ MUST be registered in .claude-plugin/hooks.json.
// Otherwise Claude Code never invokes it — the most expensive class of
// silent shipping bug. Conversely, every command in hooks.json must point
// at a hook script that exists.
// ---------------------------------------------------------------------------
import { readdir as readdirFn } from 'node:fs/promises';

let hooksRegistry;
try {
  hooksRegistry = JSON.parse(await readFile('hooks/hooks.json', 'utf8'));
} catch (err) {
  fail(`Could not read hooks/hooks.json: ${err.message}. Without this file, Claude Code never invokes any hook. (Note: hooks.json must live at hooks/hooks.json — placing it at .claude-plugin/hooks.json is silently ignored.)`);
}

if (hooksRegistry?.hooks) {
  // Collect every command path referenced in hooks.json.
  const referencedFiles = new Set();
  for (const event of Object.values(hooksRegistry.hooks)) {
    for (const matcherEntry of event ?? []) {
      for (const hook of matcherEntry.hooks ?? []) {
        const cmd = hook.command ?? '';
        const match = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[a-z-]+\.mjs)/);
        if (match) referencedFiles.add(match[1]);
      }
    }
  }

  // List every actual hook file on disk.
  let hookFiles = [];
  try {
    hookFiles = (await readdirFn('hooks')).filter((f) => f.endsWith('.mjs')).map((f) => `hooks/${f}`);
  } catch { /* hooks/ missing — separate problem */ }

  const onDisk = new Set(hookFiles);

  for (const f of onDisk) {
    if (!referencedFiles.has(f)) {
      fail(`Hook script ${f} exists but is NOT registered in .claude-plugin/hooks.json. Claude Code will never invoke it.`);
    }
  }
  for (const f of referencedFiles) {
    if (!onDisk.has(f)) {
      fail(`hooks.json references ${f} but the file doesn't exist. Claude Code would fail to spawn the hook.`);
    }
  }
}

if (failed) {
  console.error('\nFix the issues above and re-run `npm run lint`.');
  process.exit(1);
}
console.log('✓ settings.json permissions block is well-formed.');

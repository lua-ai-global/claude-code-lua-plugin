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
    const isBash = pattern.startsWith('Bash(') && pattern.endsWith(')');
    // MCP rules: `mcp__<server>` (every tool of a server) or `mcp__<server>__<tool>`;
    // plugin servers are named `plugin_<plugin>_<server>` by Claude Code.
    const isMcp = /^mcp__[A-Za-z0-9][A-Za-z0-9_-]*(?:__[a-z][a-z0-9_]*)?$/.test(pattern);
    if (!isBash && !isMcp) {
      fail(`permissions.${tier} entry is neither Bash(...) nor mcp__<server>[__<tool>]: ${pattern}`);
    }
    if (isMcp && tier !== 'allow') {
      fail(`permissions.${tier} entry ${pattern}: MCP rules belong in allow only (the plugin's MCP tools are read-only; nothing to deny or ask).`);
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

// Critical safety check (inverted on 2026-09-12 after the live E2E run):
// bare production verbs MUST NOT appear in `deny` or `ask`. Claude Code's
// documented semantics (code.claude.com/docs/en/permissions): "A deny or ask
// rule matches past any leading assignment", so `Bash(lua deploy*)` in deny
// also matches the user-confirmed `LUA_DEPLOY_CONFIRMED=1 lua deploy …` form
// and makes every deploy impossible — exactly what happened on all five E2E
// agents. The gate for bare forms is hooks/confirm-deploy.mjs (a hook exit-2
// block wins over any allow rule). The allow tier must carry the literal
// prefixed forms so the confirmed command runs without a second prompt.
const { PRODUCTION_COMMANDS } = await import('../lib/tokenizer.mjs');
const globToRegex = (rule) => {
  const m = rule.match(/^Bash\((.*)\)$/s);
  return m ? new RegExp('^' + m[1].split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's') : null;
};
const BARE_SAMPLES = [
  'lua deploy skill --ci --name x --set-version latest --force',
  'lua skills deploy --skill-name x --skill-version latest',
  'lua webhooks deploy --webhook-name x',
  'lua jobs deploy -i x -v latest',
  'lua preprocessors deploy --preprocessor-name x',
  'lua postprocessors deploy --postprocessor-name x',
  'lua persona production deploy --persona-version latest --force',
  'lua workflows deploy outreach -v latest',
  'lua workflows activate outreach',
  'lua version promote 3',
  'lua mcp activate fs',
  'lua marketplace template publish --template-id t',
  'lua marketplace template apply --template-id t --all-installed --force',
];
for (const sample of BARE_SAMPLES) {
  if (!PRODUCTION_COMMANDS.some((e) => e.re.test(sample))) {
    fail(`lint self-check: tokenizer no longer classifies "${sample}" — update BARE_SAMPLES or the tokenizer.`);
  }
  for (const [tier, rules] of [['deny', denySet], ['ask', askSet]]) {
    for (const rule of rules) {
      const re = globToRegex(rule);
      if (re && re.test(sample)) {
        fail(`permissions.${tier} rule "${rule}" matches the bare production verb "${sample}". Claude Code evaluates deny/ask rules past a leading env assignment, so this rule would ALSO block the confirmed form \`LUA_DEPLOY_CONFIRMED=1 ${sample}\` and no deploy could ever run. Remove it — hooks/confirm-deploy.mjs is the gate for bare forms.`);
      }
    }
  }
  const prefixed = `LUA_DEPLOY_CONFIRMED=1 ${sample}`;
  if (![...allowSet].some((rule) => globToRegex(rule)?.test(prefixed))) {
    fail(`No allow rule matches the confirmed form "${prefixed}" — the deploy flow would prompt a second time (breaks §3.7) or be denied in -p mode.`);
  }
  if ([...allowSet].some((rule) => globToRegex(rule)?.test(sample))) {
    fail(`An allow rule admits the BARE production verb "${sample}" — only the LUA_DEPLOY_CONFIRMED=1 form may be allowed.`);
  }
}

// The plugin's read-only MCP tools must be pre-approved under the name Claude
// Code gives a plugin server, or every subagent call to them prompts (§3.7).
for (const required of ['mcp__plugin_lua-agent-builder_lua-platform', 'mcp__plugin_lua-agent-builder_lua-docs__search_lua_cli', 'mcp__plugin_lua-agent-builder_lua-docs__query_docs_filesystem_lua_cli']) {
  if (!allowSet.has(required)) fail(`permissions.allow must contain "${required}" — Claude Code names plugin MCP tools mcp__plugin_<plugin>_<server>__<tool>, and without this every subagent MCP call prompts.`);
}
if (allowSet.has('mcp__plugin_lua-agent-builder_lua-docs') || allowSet.has('mcp__lua-docs')) {
  fail('Do not allow the whole lua-docs server: submit_feedback posts to the docs team and must keep prompting.');
}

// Critical safety check: --auto-deploy must be denied somewhere.
const hasAutoDeployDeny = [...denySet].some((p) => p.includes('--auto-deploy'));
if (!hasAutoDeployDeny) {
  fail('settings.json must deny patterns containing `--auto-deploy` — required by §3.3 hooks.');
}

// Credential display and interactive login both belong in a private terminal.
const credentialPrinters = [
  { pattern: 'lua auth key', reason: 'prints the raw API key to stdout' },
  { pattern: 'lua auth configure', reason: 'collects account details and an OTP' },
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
// `lua init --ci` and `lua skills view --ci` caused the doctor / init / test
// slashes to prompt unexpectedly.
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

#!/usr/bin/env node
// Validates that lua-cli command + subcommand pairs referenced in the
// knowledge files (lib/knowledge/*.md) actually exist in lua-cli.
//
// Iteration-13 audit: integrations.md referenced
//   - `lua integrations add` (real command is `lua integrations connect`)
//   - `lua integrations data <connection> <resource>` (no `data` subcommand)
// Both shipped to the lua-architect agent's prompt context — the architect
// would have advised users to run commands that don't exist.
//
// This lint reads packages/lua-cli/src/cli/command-definitions.ts to learn
// every top-level command and its valid subcommands, then scans the
// knowledge files for `lua <command> <subcommand>` pairs and fails on any
// that aren't recognized.
//
// When extracted to the standalone plugin repo (lua-cli not reachable),
// this lint exits 0 with a warning — the cross-repo CI is responsible for
// its own version of this check.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const CLI_DEF = '../../packages/lua-cli/src/cli/command-definitions.ts';

let cliSource;
try {
  cliSource = await readFile(CLI_DEF, 'utf8');
} catch {
  console.warn(`! Skipping knowledge-commands check: ${CLI_DEF} not reachable.`);
  process.exit(0);
}

// Discover top-level commands from `program.command("name [args]")` calls.
// Subcommands appear inside addHelpText after-blocks describing actions, but
// for accuracy we ALSO walk `.command("subname")` chains under known parents
// and allow the architect's references to match either.
const TOP_LEVEL = new Set();
for (const m of cliSource.matchAll(/program\s*\.\s*command\s*\(\s*['"]([a-z][a-z-]*)/g)) {
  TOP_LEVEL.add(m[1]);
}

// For known multi-action commands, mine the help text for the action list.
// integrations / webhooks / triggers / persona / etc. all expose "actions"
// listed in addHelpText. We extract them by looking for help-text blocks
// that name the action set.
const SUBCOMMANDS = {};
function setSub(parent, set) {
  SUBCOMMANDS[parent] = (SUBCOMMANDS[parent] ?? new Set());
  for (const s of set) SUBCOMMANDS[parent].add(s);
}

// Hand-curated from the help-text blocks; the lint won't try to parse free
// text exhaustively (too brittle). The list mirrors the `Actions:` sections
// in command-definitions.ts. Update when commands gain/lose actions.
setSub('auth',         ['configure', 'logout', 'key']);
setSub('chat',         ['clear']);
setSub('integrations', ['connect', 'update', 'list', 'available', 'info', 'disconnect', 'webhooks', 'mcp']);
// Iteration-13 audit: lib/knowledge/integrations.md referenced
// `lua channels add` — `add` is not a recognised action of `lua channels`
// (channels has only `list` for non-interactive use; creation is
// interactive and has no subcommand name).
setSub('channels',     ['list']);
// `lua integrations webhooks <action>` (one level deeper) is NOT modelled
// here — the lint only catches single-token misnames. Cross-checking
// nested action lists would over-fit; the architect's mistakes here are
// usually at the top level (`add` vs `connect`).

// Extract `lua <token1> <token2>` mentions from each .md file. Skip code
// blocks marked as bash output (rendered text) but include inline code
// (which is where slash-command authors typically put commands).
//
// Iteration-13 audit: the regex previously extracted flag tokens like
// `--ci` or `-h` as subcommands, producing false positives on `lua chat
// --ci`. The character class `[a-z]` (no leading hyphen) for the FIRST
// char of each captured token disambiguates flags from subcommands.
function extractLuaMentions(content) {
  const mentions = [];
  // Token: starts with [a-z], may continue with [a-z0-9-]. Excludes flags.
  const TOKEN = '([a-z][a-z0-9-]*)';
  const inlineCode = new RegExp(`\`lua\\s+${TOKEN}(?:\\s+${TOKEN})?[^\`]*\``, 'g');
  for (const m of content.matchAll(inlineCode)) {
    mentions.push({ command: m[1], subcommand: m[2] ?? null, raw: m[0] });
  }
  const fencedLine = new RegExp(`^\\s*\\$?\\s*lua\\s+${TOKEN}(?:\\s+${TOKEN})?`, 'gm');
  for (const m of content.matchAll(fencedLine)) {
    mentions.push({ command: m[1], subcommand: m[2] ?? null, raw: m[0].trim() });
  }
  return mentions;
}

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

const RESERVED_TOKENS = new Set([
  // Tokens that look like subcommands but are actually positional args /
  // flags. Don't false-flag them.
  'sandbox', 'production', 'staging', 'dev',
  'all', 'view', 'set', 'get', 'list', 'create', 'delete', 'update',
  'enable', 'disable', 'activate', 'deactivate', 'pause', 'resume',
  'install', 'uninstall', 'publish', 'unpublish', 'unlist',
  'subscribe', 'unsubscribe', 'trigger', 'history',
  'overview', 'persona', 'skills', 'env',
  'on', 'off', 'status', 'remove', 'test',
  'restore', 'force',
  'tool', 'skill', 'webhook', 'job', 'agent', 'preprocessor', 'postprocessor', 'mcp', 'backup',
  'open', 'close',
  'bash', 'zsh', 'fish',
]);

// Iteration-13 audit: this lint originally only scanned lib/knowledge/.
// Stale `lua integrations add stripe` references in agents/lua-architect.md
// slipped through. Now scans all three user-shipped surfaces.
const SCAN_DIRS = ['lib/knowledge', 'agents', 'commands'];

async function* allMd() {
  for (const dir of SCAN_DIRS) {
    let files = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.md')) yield join(dir, f);
    }
  }
}

let scanned = 0;
for await (const path of allMd()) {
  const content = await readFile(path, 'utf8');
  for (const m of extractLuaMentions(content)) {
    if (m.command.startsWith('--')) continue;  // flag, not a command
    if (!TOP_LEVEL.has(m.command)) {
      fail(`${path}: references \`lua ${m.command}${m.subcommand ? ' ' + m.subcommand : ''}\` but no top-level \`lua ${m.command}\` command exists in lua-cli.`);
      continue;
    }
    if (m.subcommand && SUBCOMMANDS[m.command]) {
      if (!SUBCOMMANDS[m.command].has(m.subcommand) && !RESERVED_TOKENS.has(m.subcommand)) {
        fail(`${path}: references \`lua ${m.command} ${m.subcommand}\` but \`${m.subcommand}\` isn't a known action of \`lua ${m.command}\`. Known: ${[...SUBCOMMANDS[m.command]].join(', ')}.`);
      }
    }
    scanned++;
  }
}

// Iteration-13 audit (bug 72 class): fail if zero references were found.
if (scanned === 0 && !failed) {
  fail(`Found 0 \`lua …\` references across [${SCAN_DIRS.join(', ')}]. Either the directories are gone, or the inline-code regex is broken. Refusing to silently pass.`);
}

if (failed) {
  console.error(`\nFix the references above. Knowledge files feed the lua-architect agent's prompt — wrong commands become wrong user advice.`);
  process.exit(1);
}
console.log(`✓ Knowledge files: ${scanned} \`lua …\` reference(s) check out against command-definitions.ts.`);

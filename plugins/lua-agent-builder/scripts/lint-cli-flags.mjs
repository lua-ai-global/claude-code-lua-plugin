#!/usr/bin/env node
// Denylist of known-wrong or unsafe lua-cli references that have shipped in
// the plugin (or that the public docs still show). Standalone-repo friendly:
// doesn't need lua-cli source (unlike lint-knowledge-commands.mjs, which is
// skipped without it). Every entry is verified against lua-cli 3.33.0
// (src/cli/command-definitions.ts, src/utils/aliases.ts, src/api-exports.ts).
//
// History:
//   - `lua sync --accept` was the only server→local flag until 3.10; `--pull`
//     is canonical since then and `--accept` is kept as an alias. An earlier
//     version of this lint denied `--pull` — inverted — so the plugin shipped
//     the legacy spelling for months.
//   - `lua logs --type mastra` appears in the CLI's own help text but is
//     rejected by the alias table (exit 2).
//   - `lua deploy workflow|mcp|device|voice` are not deploy types; workflows
//     go live with `lua workflows deploy`, MCP servers with `lua mcp activate`.
//   - `defineTool` / `lua-cli/skill` / `welcomeMessage` / `Jobs.schedule` /
//     `User.update` do not exist in the SDK.
//
// Add new entries here whenever a wrong-flag bug ships and gets fixed. Each
// entry is a literal substring matched against every .md/.json/.mjs file
// under the user-shipped surfaces.

import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const DENY = [
  // Pattern → reason
  { pattern: 'lua sync --accept', reason: '`--accept` is a legacy alias; the canonical server→local flag is `lua sync --pull`' },
  { pattern: '--type mastra', reason: '`mastra` is not a `lua logs --type` value (rejected, exit 2) — use runtime/agent_error' },
  { pattern: 'lua deploy workflow', reason: 'workflows go live with `lua workflows deploy <name> -v <ver>`' },
  { pattern: 'lua deploy mcp', reason: 'MCP servers are not versioned; enable with `lua mcp activate <name>`' },
  { pattern: 'lua deploy device', reason: 'devices are not a `lua deploy` type — promote an agent version' },
  { pattern: 'lua deploy voice', reason: 'voices are not a `lua deploy` type — promote an agent version' },
  { pattern: 'lua skills list', reason: 'the action is `lua skills view`' },
  { pattern: 'lua webhooks list ', reason: 'the action is `lua webhooks view` (`list-events` is separate)' },
  { pattern: 'lua jobs list', reason: 'the action is `lua jobs view`' },
  { pattern: 'lua jobs run ', reason: 'the action is `lua jobs trigger -i <name>`' },
  { pattern: 'lua chat --json', reason: '`lua chat` has no --json flag' },
  { pattern: 'lua logs --follow', reason: '`lua logs` has no --follow flag (one-shot fetch)' },
  { pattern: 'lua dev ', reason: 'there is no `lua dev` command in lua-cli 3.x' },
  { pattern: 'lua integrations add', reason: 'the action is `lua integrations connect --integration <type>`' },
  { pattern: 'lua triggers pause', reason: 'integration triggers moved to `lua integrations webhooks pause --webhook-id <id>`' },
  { pattern: 'lua triggers resume', reason: 'integration triggers moved to `lua integrations webhooks resume --webhook-id <id>`' },
  { pattern: 'lua channels add', reason: '`lua channels` has only `list`; channel creation is interactive' },
  { pattern: "from 'lua-cli/skill'", reason: 'no `./skill` subpath export — import from `lua-cli`' },
  { pattern: 'defineTool(', reason: '`defineTool` is not exported by lua-cli — use `class X implements LuaTool`' },
  { pattern: 'welcomeMessage', reason: '`LuaAgentConfig` has no welcomeMessage field' },
  { pattern: 'Jobs.schedule(', reason: 'the method is `Jobs.create({ schedule: {...} })`' },
  { pattern: 'User.update(', reason: 'fetch the instance first: `(await User.get(id)).update({...})`' },
  { pattern: "type: 'cron', pattern", reason: 'JobSchedule uses `expression`, not `pattern`' },
  { pattern: 'intervalMs', reason: 'JobSchedule interval uses `seconds`' },
  { pattern: 'lua auth configure --email', reason: 'email and OTP input must stay in a private terminal', authFlow: true },
  { pattern: 'lua auth configure --api-key', reason: 'credentials must stay out of the model conversation', authFlow: true },
];

// `scripts/` is deliberately NOT scanned: lint scripts quote the wrong
// spellings they guard against.
const SCAN_DIRS = ['commands', 'agents', 'hooks', 'lib', 'mcp'];
const AUTH_DOC_DIRS = ['../../docs'];
const AUTH_DOC_FILES = ['README.md', 'SECURITY.md', '../../README.md'];
const SCAN_EXT = new Set(['.md', '.json', '.mjs', '.js', '.ts']);

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'coverage' || e.name.startsWith('.')) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* walk(path);
    else if (SCAN_EXT.has(extname(e.name))) yield path;
  }
}

// Lines that explain WHY a spelling is wrong legitimately quote it. They
// must carry a negation marker so the quote is unambiguous.
const EXPLANATORY_LINE_RE = /\b(NOT|not|never|no|none|does not|do not|doesn't|don't|isn't|aren't|is not|are not|wrong|invalid|moved|rejected|instead|legacy|retired)\b/;

let scanned = 0;
async function scan(path, { authOnly = false } = {}) {
  const content = await readFile(path, 'utf8');
  const lines = content.split('\n');
  for (const { pattern, reason, authFlow } of DENY) {
    if (authOnly && !authFlow) continue;
    lines.forEach((line, i) => {
      if (!line.includes(pattern)) return;
      if (!authFlow && EXPLANATORY_LINE_RE.test(line)) return;
      fail(`${path}:${i + 1}: contains denylisted CLI reference \`${pattern}\` — ${reason}`);
    });
  }
  scanned++;
}

for (const dir of SCAN_DIRS) {
  for await (const path of walk(dir)) {
    // Don't lint this script itself — it has to mention the deny patterns.
    if (path.endsWith('lint-cli-flags.mjs')) continue;
    await scan(path);
  }
}
for (const dir of AUTH_DOC_DIRS) {
  for await (const path of walk(dir)) await scan(path, { authOnly: true });
}
for (const path of AUTH_DOC_FILES) await scan(path, { authOnly: true });

if (failed) {
  console.error('\nFix the references above. These commands are wrong or unsafe in a model-run plugin flow.');
  process.exit(1);
}
console.log(`✓ CLI flag denylist: ${scanned} file(s) scanned, no known-wrong flags found.`);

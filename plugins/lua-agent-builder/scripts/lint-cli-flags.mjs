#!/usr/bin/env node
// Denylist of known-wrong lua-cli flag combinations that have shipped to the
// plugin in the past. Standalone-repo friendly: doesn't need lua-cli source
// (unlike lint-knowledge-commands.mjs, which is skipped without it).
//
// History:
//   - `lua sync --pull` shipped to commands/lua-sync.md and permissions-template.json
//     for several iterations. The real flag is `lua sync --accept` (server → local).
//     Discovered when the user actually tried to resolve drift via /lua-sync and the
//     CLI errored out. This lint exists so that class of regression can't recur.
//
// Add new entries here whenever a wrong-flag bug ships and gets fixed. Each
// entry is a literal substring matched against every .md/.json/.mjs file
// under the user-shipped surfaces.

import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const DENY = [
  // Pattern → reason
  { pattern: 'lua sync --pull', reason: 'real flag is `lua sync --accept` (server → local)' },
  { pattern: 'sync --pull',     reason: 'permission rule must allow `--accept`, not `--pull`' },
];

const SCAN_DIRS = ['commands', 'agents', 'hooks', 'lib', 'scripts', 'mcp'];
const SCAN_EXT = new Set(['.md', '.json', '.mjs', '.js', '.ts']);

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* walk(path);
    else if (SCAN_EXT.has(extname(e.name))) yield path;
  }
}

let scanned = 0;
for (const dir of SCAN_DIRS) {
  for await (const path of walk(dir)) {
    // Don't lint this script itself — it has to mention the deny patterns.
    if (path.endsWith('lint-cli-flags.mjs')) continue;
    const content = await readFile(path, 'utf8');
    for (const { pattern, reason } of DENY) {
      if (content.includes(pattern)) {
        fail(`${path}: contains denylisted CLI reference \`${pattern}\` — ${reason}`);
      }
    }
    scanned++;
  }
}

if (failed) {
  console.error(`\nFix the references above. These flags do not exist in lua-cli; shipping them ` +
    `breaks the user's first attempt to use the slash/agent that referenced them.`);
  process.exit(1);
}
console.log(`✓ CLI flag denylist: ${scanned} file(s) scanned, no known-wrong flags found.`);

#!/usr/bin/env node
// Validates that the plugin doesn't reference non-existent fields on
// lua-cli's LogEntry type.
//
// Iteration-13 audit: bug 31 found `entry.level === 'error'` in
// hooks/post-deploy-smoke.mjs — but `LogEntry` has no `level` field; the
// field is `subType` (verified against
// packages/lua-cli/src/interfaces/logs.ts). The hook was fixed in
// iteration 13. Iteration 24 found the SAME bug in two agent prompts
// (`agents/lua-deploy-pilot.md`, `agents/lua-qa.md`) — the misnomer
// re-surfaced because nothing pinned the field name to lua-cli's source.
//
// This lint blocks every form: `level=error`, `level === 'error'`,
// `level: 'error'`, `entry.level`, `log.level`. If lua-cli ever adds a
// real `level` field, update this lint to match.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

const SCAN_DIRS = ['agents', 'commands', 'hooks', 'lib'];

// Patterns that are wrong when referring to lua-cli log entries.
// Each pattern + a "near-log" context check (the surrounding text mentions
// "log", "logs", "LogEntry", or `lua logs`).
const BAD_PATTERNS = [
  /\blevel\s*===?\s*['"]error['"]/g,
  /\blevel\s*===?\s*['"]warn['"]/g,
  /\blevel\s*:\s*['"]error['"]/g,
  /\blevel\s*=\s*['"]?error['"]?/g,
  /\b(?:entry|log|item)\.level\b/g,
  /`level=error`|`level=warn`/g,
];

const LOG_CONTEXT_RE = /\b(log|logs|LogEntry|lua logs|tail_logs)\b/i;

async function* walkText(dir) {
  for (const entry of await readdir(dir)) {
    if (entry === 'node_modules' || entry === 'coverage' || entry === 'dist') continue;
    const full = join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) yield* walkText(full);
    else if (st.isFile() && /\.(mjs|md|json)$/.test(full)) yield full;
  }
}

function stripJsComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

let scanned = 0;
for (const target of SCAN_DIRS) {
  try {
    const st = await stat(target);
    const files = st.isDirectory() ? walkText(target) : (async function* () { yield target; })();
    for await (const file of files) {
      let content = await readFile(file, 'utf8');
      // Strip JS comments — audit-history notes legitimately quote the
      // wrong-field forms when explaining the bug.
      if (file.endsWith('.mjs')) content = stripJsComments(content);

      // For markdown, also strip lines that contain "iteration-" or "audit"
      // (history context) AND lines that contain "NOT" near `level` (these
      // are the corrective notes telling the reader NOT to use `level`).
      const lines = content.split('\n');
      const cleaned = lines.filter((line) => {
        if (/iteration-?\d+|audit/i.test(line)) return false;
        if (/\bNOT\b.*\blevel\b|\blevel\b.*\bNOT\b/.test(line)) return false;
        return true;
      }).join('\n');

      if (!LOG_CONTEXT_RE.test(cleaned)) {
        scanned++;
        continue;
      }
      for (const pat of BAD_PATTERNS) {
        const matches = cleaned.match(pat);
        if (matches) {
          fail(`${file}: references nonexistent log-entry field via ${[...new Set(matches)].join(', ')}. The field on lua-cli's LogEntry is \`subType\` (values: 'error' | 'debug' | 'info' | 'warn' | 'start' | 'complete'), NOT \`level\`. Update the prose/code to use \`subType\`.`);
        }
      }
      scanned++;
    }
  } catch { /* missing — skip */ }
}

// Iteration-13 audit (bug 72 class): fail if zero files were scanned.
if (scanned === 0 && !failed) {
  fail(`Found 0 files to scan in [${SCAN_DIRS.join(', ')}]. Either the directories were renamed/moved, or the file-extension filter is broken. Refusing to silently pass.`);
}

if (failed) {
  console.error('\nFix the issues above and re-run `npm run lint`.');
  process.exit(1);
}
console.log(`✓ No invalid log-entry field references (${scanned} file(s) scanned).`);

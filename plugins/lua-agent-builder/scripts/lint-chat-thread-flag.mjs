#!/usr/bin/env node
// Validates that every `lua chat ... -m ...` reference in plugin assets
// also passes a `-t` flag.
//
// Iteration-13 audit: the same bug bit three times in a row:
//   - bug 66: /lua-chat "New thread" omitted `-t`, silently used default thread
//   - bug 75: post-deploy-smoke.mjs ping omitted `-t`, polluted production
//   - bug 76: lua-qa.md prose described chat without `-t`, contradicting its
//             own canonical example
//
// The lua-cli `-t [id]` flag has surprising semantics: omitting it continues
// the agent's *default* thread (rather than starting fresh). Every plugin
// invocation should pass either `-t` (bare, for fresh UUID) or
// `-t <id>` (named thread). This lint enforces that contract.
//
// SCOPE: scans agents/, commands/, hooks/. Skips JS audit-history comments
// and markdown lines containing "iteration-" / "audit" (history context).

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

const SCAN_DIRS = ['agents', 'commands', 'hooks'];

// Match `lua chat ... -m <value> ...` invocations. The `-m` must be
// followed by a non-empty argument (a quoted string, a placeholder like
// '<msg>', or a literal token). Bare `-m` references (incomplete examples
// in description prose like "Wraps `lua chat --ci -m`") are skipped.
const CHAT_INVOCATION_RE = /\blua\s+chat\b[^\n`]*?-m\s+\S[^\n`]*/g;

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
for (const dir of SCAN_DIRS) {
  try {
    for await (const file of walkText(dir)) {
      let content = await readFile(file, 'utf8');
      if (file.endsWith('.mjs')) content = stripJsComments(content);

      // Strip lines that are clearly history/audit context — those legitimately
      // quote the buggy form when explaining the historic bug.
      const lines = content.split('\n');
      const cleanedLines = lines.filter((line) => !/iteration-?\d+|audit|NEVER omit|REQUIRED/i.test(line));
      const cleaned = cleanedLines.join('\n');

      const matches = cleaned.match(CHAT_INVOCATION_RE) ?? [];
      for (const m of matches) {
        // Bash-allowlist square-bracket syntax (`[-t *]` = optional flag in
        // permission-pattern docs) DOES indicate `-t` is supported; skip.
        if (/\[-t\b/.test(m)) { scanned++; continue; }
        // Otherwise the invocation must include `-t` (with or without value).
        if (!/\s-t\b/.test(m)) {
          fail(`${file}: \`lua chat\` invocation \`${m.slice(0, 100)}${m.length > 100 ? '…' : ''}\` is missing the \`-t\` flag. Omitting \`-t\` continues the agent's *default* thread — every invocation pollutes the user's regular conversation. Add \`-t <id>\` for named or \`-t\` (bare) for an auto-generated fresh UUID.`);
        }
        scanned++;
      }
    }
  } catch { /* missing — skip */ }
}

if (scanned === 0 && !failed) {
  fail(`Found 0 \`lua chat ... -m\` invocations across [${SCAN_DIRS.join(', ')}]. Either there are no chat invocations, or the regex is broken. Refusing to silently pass.`);
}

if (failed) {
  console.error('\nFix the issues above and re-run `npm run lint`.');
  process.exit(1);
}
console.log(`✓ \`lua chat\` invocations: all ${scanned} include the \`-t\` flag.`);

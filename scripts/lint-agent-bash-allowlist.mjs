#!/usr/bin/env node
// Cross-validates each subagent's documented "Bash allowlist" section in
// agents/*.md against the permission rules in lib/permissions-template.json.
//
// Iteration-13 audit: agents/lua-deploy-pilot.md lists `git status --short`
// and `git log --oneline -5` in its Bash allowlist, and lua-debug.md lists
// `git log --oneline -20` and `git diff [args]` — but neither command was
// in lib/permissions-template.json's allow list. Every invocation triggered
// a Claude Code permission prompt mid-flow, breaking the §3.7
// single-permission contract.
//
// Lint contract: for every `Bash allowlist` block in agents/*.md, each
// line item must be matched (by prefix) by at least one allow OR ask rule
// in lib/permissions-template.json. Deny rules are separate — those force
// a block, which is intentional for `lua deploy` (the pilot uses the
// env-prefixed form which IS allowed).

import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

const TEMPLATE_PATH = 'lib/permissions-template.json';
const AGENTS_DIR = 'agents';

let template;
try {
  template = JSON.parse(await readFile(TEMPLATE_PATH, 'utf8'));
} catch (err) {
  console.error(`✗ Could not read ${TEMPLATE_PATH}: ${err.message}`);
  process.exit(1);
}

const allow = new Set(template?.permissions?.allow ?? []);
const ask = new Set(template?.permissions?.ask ?? []);

// Compile allow + ask patterns into matchers. Glob `*` is the only
// wildcard; everything else is literal.
function patternToMatcher(pattern) {
  const m = pattern.match(/^Bash\((.+)\)$/);
  if (!m) return null;
  const payload = m[1];
  const re = '^' + payload
    .replace(/[\\^$.+?{}()|[\]]/g, '\\$&')
    .replace(/\*/g, '.*') + '$';
  return new RegExp(re);
}

const matchers = [];
for (const p of [...allow, ...ask]) {
  const re = patternToMatcher(p);
  if (re) matchers.push({ pattern: p, re });
}

function isAllowed(command) {
  return matchers.some(({ re }) => re.test(command));
}

// Walk each agent file and find a "Bash allowlist" block (case-insensitive,
// matching either `## Bash allowlist` or `Bash allowlist:` headings).
let scanned = 0;
let agentFiles = [];
try { agentFiles = (await readdir(AGENTS_DIR)).filter((f) => extname(f) === '.md'); }
catch { console.warn('! No agents/ dir; skipping.'); process.exit(0); }

for (const f of agentFiles) {
  const path = join(AGENTS_DIR, f);
  const content = await readFile(path, 'utf8');
  const blockMatch = content.match(/##\s*Bash\s+allowlist\s*\n+([\s\S]*?)(?=\n##\s|\n#\s|$)/i);
  if (!blockMatch) continue;
  const block = blockMatch[1];

  // Each list item: `- \`<command pattern>\``
  for (const itemMatch of block.matchAll(/^[*-]\s+`([^`]+)`/gm)) {
    const documented = itemMatch[1].trim();
    // Convert agent-style `[args]` placeholders to a glob-friendly form: a
    // bracketed token represents arbitrary trailing args.
    const candidate = documented.replace(/\s*\[[^\]]+\]/g, ' anything');
    const wrapped = `Bash(${candidate})`;
    // Construct a synthetic command that fits within the documented shape
    // (replacing `*` with a sample word) so it passes through the matcher.
    const sample = wrapped.replace(/\*/g, 'X').replace(/Bash\((.+)\)/, '$1');
    if (!isAllowed(sample)) {
      fail(`${path}: documents Bash allowlist entry \`${documented}\` but no permission rule in ${TEMPLATE_PATH} matches it. Add an allow or ask pattern that covers this command, otherwise every invocation triggers a permission prompt and breaks §3.7.`);
    }
    scanned++;
  }
}

// Iteration-13 audit (bug 72 class): fail if zero documented invocations
// were found. Silent zero-match was the pattern that made bug 72 invisible
// for so long.
if (scanned === 0 && !failed) {
  fail(`Found 0 documented Bash invocations across ${agentFiles.length} agent file(s). Either no agent declares a "## Bash allowlist" section, or the parser regex is broken. Refusing to silently pass.`);
}

if (failed) {
  console.error('\nFix the issues above and re-run `npm run lint`.');
  process.exit(1);
}
console.log(`✓ Subagent Bash allowlists: ${scanned} documented invocation(s) match permission rules.`);

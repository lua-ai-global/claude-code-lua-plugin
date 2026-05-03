#!/usr/bin/env node
// Validates that user-shipped plugin assets (agents, commands, hooks, lib,
// mcp source, README) don't reference monorepo-only paths like
// `packages/lua-cli/...` or `../../packages/...`. Such paths work in the
// monorepo's CI environment but break for end users who installed the
// plugin from npm/marketplace — they'd hit "file not found" when an agent
// tries to read the path.
//
// Iteration-13 audit: agents/lua-debug.md instructed Claude to read
// `packages/lua-cli/src/compiler/plugins/CLAUDE.md` for an error catalogue.
// The catalogue is now inlined into the agent prompt; the lint blocks the
// regression class.
//
// SCRIPTS DIR IS EXEMPT — those scripts only run in monorepo CI and exit
// gracefully when extracted (lint-pinned-version, lint-knowledge-commands).

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

const SCAN_DIRS = ['agents', 'commands', 'hooks', 'lib', 'mcp/lua-platform/src', 'README.md'];

// Patterns that indicate a monorepo path. We match `packages/<name>/` (with
// or without a `../` prefix) — the canonical sibling-package reference
// shape inside this monorepo. URLs (https://github.com/.../packages/...)
// are exempt; those are documentation links, not file reads.
const MONOREPO_PATH_RE = /(?:\.\.\/)+packages\/[a-z][a-z-]*\/|(?<![\w/])packages\/lua-(?:cli|api|agents|core|auth)\//g;

async function* walkText(dir) {
  for (const entry of await readdir(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
    const full = join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) yield* walkText(full);
    else if (st.isFile() && /\.(mjs|md|json|ts|js)$/.test(full)) yield full;
  }
}

function stripUrls(content) {
  // Strip http(s):// URLs so links don't false-flag.
  return content.replace(/https?:\/\/[^\s)`"']+/g, '');
}

function stripJsBlockComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

let scanned = 0;
for (const target of SCAN_DIRS) {
  try {
    const st = await stat(target);
    const files = st.isDirectory() ? walkText(target) : (async function* () { yield target; })();
    for await (const file of files) {
      let content = await readFile(file, 'utf8');
      // Audit-history comments inside JS source legitimately reference
      // "verified against packages/lua-cli/..." — strip JS comments before
      // scanning.
      if (file.endsWith('.mjs') || file.endsWith('.js') || file.endsWith('.ts')) {
        content = stripJsBlockComments(content);
      }
      content = stripUrls(content);
      // Markdown audit notes that need to mention the source path: wrap in
      // backticks AND put on a line that starts with "iteration-" / "audit"
      // — these are explanatory, not addressable references. Detect by line:
      const lines = content.split('\n');
      const offending = [];
      for (const line of lines) {
        // Skip lines that are clearly history/audit context.
        if (/iteration-?\d+|audit/i.test(line)) continue;
        const matches = line.match(MONOREPO_PATH_RE);
        if (matches) offending.push({ line: line.trim(), matches });
      }
      if (offending.length > 0) {
        for (const { line, matches } of offending) {
          fail(`${file}: contains monorepo-only path reference(s) ${[...new Set(matches)].join(', ')} on line: "${line.slice(0, 120)}${line.length > 120 ? '…' : ''}". This path won't exist on end-user machines (only in the monorepo CI). Inline the content or replace with a WebFetch on docs.heylua.ai.`);
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
console.log(`✓ No monorepo-only path references in user-shipped assets (${scanned} file(s) scanned).`);

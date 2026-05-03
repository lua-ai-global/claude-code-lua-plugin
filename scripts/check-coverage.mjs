#!/usr/bin/env node
// Per-file coverage gate. Per tech spec §18.6.
//
// Jest's `coverageThreshold` is per-directory; this script is per-file.
// Catches "one specific hook regressed to 80% while the directory average
// stays above 95%" — Jest's gate would miss that.
//
// Reads coverage/coverage-summary.json after `npm test -- --coverage`.

import { readFile } from 'node:fs/promises';

const SUMMARY_PATH = 'coverage/coverage-summary.json';
const HOOK_THRESHOLD = 100;
const LIB_THRESHOLD = 90;

let summary;
try {
  summary = JSON.parse(await readFile(SUMMARY_PATH, 'utf8'));
} catch (err) {
  console.error(`✗ Could not read ${SUMMARY_PATH}: ${err.message}`);
  console.error('  Run `npm test -- --coverage` first to generate the summary.');
  process.exit(1);
}

let failed = false;

// Iteration-13 audit: previous code used POSIX substring `/hooks/` and
// `/lib/`. On Windows, jest writes `coverage-summary.json` with native
// backslash paths (e.g. `C:\…\hooks\my-hook.mjs`), so the substrings
// matched nothing and the script silently passed without checking any
// files. Normalise separators before classifying.
let scanned = 0;
for (const [file, metrics] of Object.entries(summary)) {
  if (file === 'total') continue;
  const normalised = file.replace(/\\/g, '/');

  let threshold = null;
  let category = null;
  if (normalised.includes('/hooks/')) { threshold = HOOK_THRESHOLD; category = 'hook'; }
  else if (normalised.includes('/lib/')) { threshold = LIB_THRESHOLD; category = 'lib'; }
  else continue;

  scanned++;
  const stmts = metrics.statements?.pct ?? 0;
  if (stmts < threshold) {
    console.error(`✗ ${file}: ${stmts}% statement coverage (${category} requires ≥${threshold}%)`);
    failed = true;
  }
}

// Defensive: if NO files were classified, the gate is doing no work — fail
// loudly rather than silently approve. This catches both the Windows
// backslash bug AND any future "all hook/lib files renamed out of the
// matched paths" regression.
if (scanned === 0 && !failed) {
  console.error(`✗ check-coverage matched 0 files in ${SUMMARY_PATH}. Either coverage didn't run, or the path classifier is broken (e.g. Windows backslash paths). Refusing to silently pass.`);
  failed = true;
}

if (failed) {
  console.error('\nPer-file coverage below threshold. Add tests or mark dead code with /* istanbul ignore */.');
  process.exit(1);
}
console.log('✓ All hook and lib files meet per-file coverage thresholds.');

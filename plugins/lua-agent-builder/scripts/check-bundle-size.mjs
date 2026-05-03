#!/usr/bin/env node
// Per tech spec §14 / §18.7. Enforces bundle-size budgets at release time.

import { stat } from 'node:fs/promises';

const BUDGETS = {
  'mcp/lua-platform/dist/server.js': 5 * 1024 * 1024,
  // Iteration-13 audit removed the lua-docs MCP server entry; no bundle to budget.
};

let failed = false;
for (const [path, limit] of Object.entries(BUDGETS)) {
  let size;
  try {
    size = (await stat(path)).size;
  } catch {
    console.warn(`! ${path}: not built yet (skipping)`);
    continue;
  }
  const limitMB = (limit / 1024 / 1024).toFixed(1);
  const sizeMB = (size / 1024 / 1024).toFixed(2);
  if (size > limit) {
    console.error(`✗ ${path}: ${sizeMB} MB exceeds ${limitMB} MB budget`);
    failed = true;
  } else {
    console.log(`✓ ${path}: ${sizeMB} MB (under ${limitMB} MB budget)`);
  }
}
process.exit(failed ? 1 : 0);

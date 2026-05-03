#!/usr/bin/env node
// Enforces that PINNED_MIN_LUA_CLI in hooks/check-lua-version.mjs never
// references a version newer than what actually exists in the monorepo
// (packages/lua-cli/package.json). Catches the iteration-13 regression
// where the pin was 3.13.0 but the latest published lua-cli was 3.12.3 —
// every fresh plugin session printed an upgrade warning that `/lua-update`
// could not resolve (because 3.13.0 doesn't exist on npm yet).

import { readFile } from 'node:fs/promises';

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

const HOOK_PATH = 'hooks/check-lua-version.mjs';
const CLI_PKG_PATH = '../../packages/lua-cli/package.json';

let hookSource;
try {
  hookSource = await readFile(HOOK_PATH, 'utf8');
} catch (err) {
  console.error(`✗ Could not read ${HOOK_PATH}: ${err.message}`);
  process.exit(1);
}

const m = hookSource.match(/PINNED_MIN_LUA_CLI\s*=\s*['"]([^'"]+)['"]/);
if (!m) {
  fail(`${HOOK_PATH}: could not find a PINNED_MIN_LUA_CLI = "X.Y.Z" assignment`);
} else {
  const pinned = m[1];

  let cliPkg;
  try {
    cliPkg = JSON.parse(await readFile(CLI_PKG_PATH, 'utf8'));
  } catch (err) {
    // Outside the monorepo (e.g. extracted to public repo). Don't fail —
    // the cross-repo CI is responsible for its own version policy.
    console.warn(`! Skipping pinned-version check: ${CLI_PKG_PATH} not reachable (${err.code ?? 'ENOENT'}). This is expected in the standalone plugin repo.`);
    process.exit(0);
  }

  const latest = cliPkg.version;
  if (compare(parseSemver(pinned), parseSemver(latest)) > 0) {
    fail(`PINNED_MIN_LUA_CLI=${pinned} is newer than the latest published lua-cli (${latest}). Every plugin session would warn the user to upgrade to a version that doesn't exist. Drop the pin to ≤${latest} or wait until lua-cli ${pinned} is published.`);
  }
}

function parseSemver(v) {
  const x = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return x ? [+x[1], +x[2], +x[3]] : [0, 0, 0];
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

if (failed) {
  console.error('\nFix the issues above and re-run `npm run lint`.');
  process.exit(1);
}
console.log('✓ PINNED_MIN_LUA_CLI is ≤ the latest published lua-cli version.');

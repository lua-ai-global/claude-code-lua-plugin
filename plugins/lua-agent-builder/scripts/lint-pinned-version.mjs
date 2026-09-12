#!/usr/bin/env node
// Enforces that PINNED_MIN_LUA_CLI in hooks/check-lua-version.mjs never
// references a version newer than what users can actually install. Catches
// the iteration-13 regression where the pin was 3.13.0 but the latest
// published lua-cli was 3.12.3 — every fresh plugin session printed an
// upgrade warning that `/lua-update` could not resolve (because 3.13.0
// didn't exist on npm yet).
//
// "Installable" is decided in this order:
//   1. the npm registry's `latest` dist-tag (what `npm install -g lua-cli`
//      gives a user) — skipped when offline or LINT_OFFLINE=1;
//   2. the monorepo / LUA_CLI_SRC checkout's package.json version — a local
//      feature branch can lag the published tag (the 2026-09 audit found a
//      checkout at 3.32.6 while 3.33.0 was already on npm), so it is only a
//      fallback, never a ceiling on its own when the registry answered.
// The pin passes if it is ≤ the highest version any of those sources knows.

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

const HOOK_PATH = 'hooks/check-lua-version.mjs';
// Set LUA_CLI_SRC=/path/to/lua-core-services/packages/lua-cli to run this
// check from the standalone plugin repo against a local checkout.
const CLI_PKG_PATH = `${process.env.LUA_CLI_SRC ?? '../../packages/lua-cli'}/package.json`;

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
  const sources = [];

  if (process.env.LINT_OFFLINE !== '1') {
    try {
      const { stdout } = await execFileAsync('npm', ['view', 'lua-cli', 'dist-tags.latest'], { timeout: 15_000 });
      const v = stdout.trim().replace(/^"|"$/g, '');
      if (/^\d+\.\d+\.\d+/.test(v)) sources.push({ name: 'npm registry (dist-tag latest)', version: v });
    } catch (err) {
      console.warn(`! npm registry lookup skipped (${err.code ?? err.message}); falling back to the local checkout.`);
    }
  }

  try {
    const cliPkg = JSON.parse(await readFile(CLI_PKG_PATH, 'utf8'));
    if (typeof cliPkg.version === 'string') sources.push({ name: `local checkout ${CLI_PKG_PATH}`, version: cliPkg.version });
  } catch (err) {
    if (sources.length === 0) {
      // Outside the monorepo and offline (e.g. extracted to public repo). Don't
      // fail — the cross-repo CI is responsible for its own version policy.
      console.warn(`! Skipping pinned-version check: ${CLI_PKG_PATH} not reachable (${err.code ?? 'ENOENT'}) and the registry did not answer.`);
      process.exit(0);
    }
  }

  const best = sources.reduce((a, b) => (compare(parseSemver(a.version), parseSemver(b.version)) >= 0 ? a : b));
  if (compare(parseSemver(pinned), parseSemver(best.version)) > 0) {
    fail(`PINNED_MIN_LUA_CLI=${pinned} is newer than the newest installable lua-cli (${best.version}, per ${best.name}). Every plugin session would warn the user to upgrade to a version that doesn't exist. Drop the pin to ≤${best.version} or wait until lua-cli ${pinned} is published.`);
  } else {
    console.log(`  pin ${pinned} ≤ ${best.version} (${best.name})`);
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
console.log('✓ PINNED_MIN_LUA_CLI is ≤ the newest installable lua-cli version.');

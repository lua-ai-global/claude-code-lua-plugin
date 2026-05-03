#!/usr/bin/env node
// Per tech spec §3.3 / §21.6. Package plugin assets as a tarball for Path B.
//
// Iteration-13 audit: the previous implementation only ran `git archive`
// against HEAD — but mcp/lua-platform/dist/ is gitignored. The resulting
// tarball was missing the MCP server bundle entirely, so any end user who
// installed from it would have a non-functional plugin (MCP server fails
// to start; every `mcp__lua-platform__*` tool returns "command not
// found"). The release-beta.yml / release-prod.yml CI workflows worked
// around this with inline tar repacks — now they can call `node
// scripts/pack.mjs` directly and get the same correct output.

import { spawnSync } from 'node:child_process';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const VERSION = process.env.PLUGIN_VERSION_OVERRIDE ?? pkg.version;
const TARBALL = `claude-code-lua-plugin-${VERSION}.tar.gz`;
const PREFIX = `claude-code-lua-plugin-${VERSION}/`;

console.log(`Packaging v${VERSION}...`);

// Verify the MCP dist/ exists — the consumer of this tarball needs it.
const MCP_DIST = 'mcp/lua-platform/dist/server.js';
try {
  await stat(MCP_DIST);
} catch {
  console.error(`✗ ${MCP_DIST} not found. Run \`cd mcp/lua-platform && npm run build\` first.`);
  process.exit(1);
}

// Verify bundle-size budgets before packing (§14).
const bundleCheck = spawnSync('node', ['scripts/check-bundle-size.mjs'], {
  stdio: 'inherit', shell: false, windowsHide: true,
});
if (bundleCheck.status !== 0) process.exit(1);

// Step 1: git archive HEAD into a staging tarball (committed files only).
const intermediateTar = `${TARBALL}.staging`;
const archive = spawnSync('git', [
  'archive', '--format=tar',
  `--prefix=${PREFIX}`,
  'HEAD',
  '--output', intermediateTar,
], { stdio: ['ignore', 'inherit', 'inherit'], shell: false, windowsHide: true });
if (archive.status !== 0) process.exit(1);

// Step 2: extract, copy in the MCP dist/ (gitignored), repack with gzip.
const extractDir = await mkdtemp(join(tmpdir(), 'lua-plugin-pack-'));
try {
  const extract = spawnSync('tar', ['-xf', intermediateTar, '-C', extractDir],
    { stdio: 'inherit', shell: false, windowsHide: true });
  if (extract.status !== 0) process.exit(1);

  const copyDist = spawnSync('cp', [
    '-r', 'mcp/lua-platform/dist',
    join(extractDir, PREFIX, 'mcp', 'lua-platform', 'dist'),
  ], { stdio: 'inherit', shell: false, windowsHide: true });
  if (copyDist.status !== 0) process.exit(1);

  const repack = spawnSync('tar', [
    '-czf', TARBALL,
    '-C', extractDir,
    PREFIX.replace(/\/$/, ''),
  ], { stdio: 'inherit', shell: false, windowsHide: true });
  if (repack.status !== 0) process.exit(1);
} finally {
  await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  await rm(intermediateTar, { force: true }).catch(() => {});
}

const final = await stat(TARBALL);
const sizeMB = (final.size / 1024 / 1024).toFixed(2);
console.log(`✓ ${TARBALL}: ${sizeMB} MB (includes MCP dist/)`);

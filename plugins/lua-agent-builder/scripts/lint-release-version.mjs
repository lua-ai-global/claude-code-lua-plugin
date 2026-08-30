#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const releaseVersion = (await readJson('package.json')).version;
let failed = false;

function fail(message) {
  console.error(`✗ ${message}`);
  failed = true;
}

for (const [path, version] of [
  ['.claude-plugin/plugin.json', (await readJson('.claude-plugin/plugin.json')).version],
  ['../../.claude-plugin/marketplace.json', (await readJson('../../.claude-plugin/marketplace.json')).plugins[0].version],
  ['mcp/lua-platform/package.json', (await readJson('mcp/lua-platform/package.json')).version],
]) {
  if (version !== releaseVersion) fail(`${path} has version ${version}; expected ${releaseVersion}.`);
}

for (const [path, expected, count = 1] of [
  ['mcp/lua-platform/src/api-client.mjs', `'X-Lua-Client': 'claude-plugin/${releaseVersion}'`],
  ['mcp/lua-platform/src/server.mjs', `{ name: 'lua-platform', version: '${releaseVersion}' }`],
  ['mcp/lua-platform/src/server.mjs', `plugin_version: '${releaseVersion}'`, 2],
]) {
  const source = await readFile(path, 'utf8');
  const matches = source.split(expected).length - 1;
  if (matches !== count) fail(`${path} must contain ${count} occurrence(s) of ${expected}.`);
}

if (failed) process.exit(1);
console.log(`✓ Release version ${releaseVersion} is consistent across plugin and MCP metadata.`);

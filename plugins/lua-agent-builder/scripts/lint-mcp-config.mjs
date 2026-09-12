#!/usr/bin/env node
// Validates that every server entry in .mcp.json corresponds to a real,
// buildable source tree inside this repo.
//
// Iteration-13 audit: .mcp.json had a `lua-docs` entry pointing at
// `${CLAUDE_PLUGIN_ROOT}/mcp/lua-docs/dist/server.js`, but `mcp/lua-docs/`
// did not exist anywhere — no source, no package.json, no CI build step.
// The plugin shipped with a registered MCP server that could never start;
// every tool from that server (mcp__lua-docs__search_lua_cli, etc.) failed
// silently with "command not found" when end-users installed the plugin.
//
// Lint contract per discovered server entry:
//   A. Remote (`"type": "http"` / `"sse"`): `url` must be an https:// URL on a
//      heylua.ai host. Nothing to vendor or build — the transport is the
//      public endpoint. Today this is the public docs MCP at
//      https://docs.heylua.ai/mcp (documented on docs.heylua.ai/mcp-for-builders).
//   B. Local stdio (`command` + `args`):
//      1. The args path must reference ${CLAUDE_PLUGIN_ROOT}/mcp/<name>/...
//         (other layouts are not handled — extend this script if needed).
//      2. mcp/<name>/ must exist as a directory.
//      3. mcp/<name>/package.json must exist (the source tree must be a real
//         package — not just an empty stub).
//      4. If the args path ends in dist/server.js, mcp/<name>/package.json
//         must declare a `build` script (CI relies on this to produce the
//         bundle for the release tarball).

import { readFile, stat } from 'node:fs/promises';

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

let mcpDoc;
try {
  mcpDoc = JSON.parse(await readFile('.mcp.json', 'utf8'));
} catch (err) {
  console.error(`✗ Could not read .mcp.json: ${err.message}`);
  process.exit(1);
}

const servers = mcpDoc?.mcpServers ?? {};
const serverNames = Object.keys(servers);
if (serverNames.length === 0) {
  console.error('✗ .mcp.json declares no servers');
  process.exit(1);
}

const REMOTE_TYPES = new Set(['http', 'sse']);
const REMOTE_HOST_RE = /^https:\/\/([a-z0-9-]+\.)*heylua\.ai(\/|$)/;

for (const [name, entry] of Object.entries(servers)) {
  if (REMOTE_TYPES.has(entry?.type)) {
    if (typeof entry.url !== 'string' || !REMOTE_HOST_RE.test(entry.url)) {
      fail(`.mcp.json server "${name}": remote "${entry?.type}" server must have an https:// url on a heylua.ai host (got ${JSON.stringify(entry?.url)}).`);
    }
    if (entry.command || entry.args) {
      fail(`.mcp.json server "${name}": a remote server must not also declare command/args.`);
    }
    continue;
  }

  const args = entry?.args ?? [];
  const targetArg = args[0];
  if (typeof targetArg !== 'string') {
    fail(`.mcp.json server "${name}": args[0] missing or non-string`);
    continue;
  }

  // Only handle the in-repo layout. External commands (e.g. npx-spawned
  // upstream servers) are out of scope; revisit when we adopt one.
  const m = targetArg.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/mcp\/([a-z-]+)\/(.+)$/);
  if (!m) {
    fail(`.mcp.json server "${name}": args[0] (${targetArg}) doesn't match the expected ${'${CLAUDE_PLUGIN_ROOT}'}/mcp/<name>/... layout. Update this lint script if a new layout is intentional.`);
    continue;
  }
  const [, dirName, relPath] = m;
  const dirPath = `mcp/${dirName}`;

  try {
    const st = await stat(dirPath);
    if (!st.isDirectory()) {
      fail(`.mcp.json server "${name}" → ${dirPath}/ exists but isn't a directory`);
      continue;
    }
  } catch {
    fail(`.mcp.json server "${name}" points at ${dirPath}/${relPath}, but ${dirPath}/ does not exist. Either vendor the source under ${dirPath}/ (with package.json + build script + CI build step in .github/workflows/) or remove the "${name}" entry from .mcp.json.`);
    continue;
  }

  let pkg;
  try {
    pkg = JSON.parse(await readFile(`${dirPath}/package.json`, 'utf8'));
  } catch {
    fail(`.mcp.json server "${name}" → ${dirPath}/package.json missing. Every vendored MCP server must be a real package (so CI can install + build it).`);
    continue;
  }

  if (relPath.endsWith('dist/server.js')) {
    if (!pkg?.scripts?.build) {
      fail(`.mcp.json server "${name}" → ${dirPath}/package.json has no "build" script, but the args path resolves to dist/server.js (which only exists after a build step). Add a build script and a CI build step.`);
    }
  }
}

if (failed) {
  console.error('\nFix the issues above and re-run `npm run lint`.');
  process.exit(1);
}
console.log(`✓ .mcp.json: all ${serverNames.length} server(s) resolve to a buildable source tree or a heylua.ai remote endpoint.`);

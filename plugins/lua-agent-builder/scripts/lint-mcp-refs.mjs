#!/usr/bin/env node
// Cross-validates every `mcp__<server>__<tool>` reference in slash commands
// and subagent prompts against the actual tool registry.
//
// Catches the iteration-10 bug class: a tool gets deleted from the MCP
// server (like check_drift in v1.25) but its name lingers in agent prompt
// bodies. The LLM running the agent sees the literal tool name and tries
// to call it, getting "Unknown tool" errors.
//
// Sources of truth:
//   - lua-platform tools: tools/index.mjs in mcp/lua-platform/src/
//   - lua-docs tools: the public Mintlify-hosted MCP at https://docs.heylua.ai/mcp
//     (registered in .mcp.json as an `http` server). Its tool names are fixed
//     by the docs host and listed here verbatim — re-verify with the server's
//     tools/list if a reference ever fails at runtime.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const REF_RE = /mcp__([a-zA-Z][a-zA-Z_-]*)__([a-zA-Z_]+)/g;

// Claude Code exposes a PLUGIN's MCP servers as
//   mcp__plugin_<plugin-name>_<server-name>__<tool>
// (verified live 2026-09-12 with `claude -p --plugin-dir`: the tools were
// `mcp__plugin_lua-agent-builder_lua-platform__get_agent` etc.; the same
// scheme is visible for other plugins, e.g. `mcp__plugin_linear_linear__…`).
// The bare `mcp__lua-platform__…` spelling only exists when someone registers
// the server themselves with `claude mcp add`. Prose MUST use the plugin
// form; a subagent `tools:` frontmatter line may list both spellings.
const PLUGIN_NAME = JSON.parse(await readFile('.claude-plugin/plugin.json', 'utf8')).name;
const PLUGIN_PREFIX = `plugin_${PLUGIN_NAME}_`;
const canonicalServer = (server) => (server.startsWith(PLUGIN_PREFIX) ? server.slice(PLUGIN_PREFIX.length) : server);

// Build the canonical registry from the MCP server source files.
async function discoverLuaPlatformTools() {
  const indexFile = 'mcp/lua-platform/src/tools/index.mjs';
  const content = await readFile(indexFile, 'utf8');
  // Match: export { listAgents } from './list-agents.mjs';
  const exports = [...content.matchAll(/^export \{ (\w+) \} from/gm)].map((m) => m[1]);

  const tools = new Set();
  for (const exportName of exports) {
    // Find the spec.name in the corresponding tool file
    // exportName is camelCase; the file is kebab-case
    const fileName = exportName.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()).replace(/^-/, '');
    const toolFile = `mcp/lua-platform/src/tools/${fileName}.mjs`;
    try {
      const toolContent = await readFile(toolFile, 'utf8');
      const nameMatch = toolContent.match(/name:\s*['"]([a-z_]+)['"]/);
      if (nameMatch) tools.add(nameMatch[1]);
    } catch {
      console.warn(`! Could not inspect ${toolFile} (file missing?)`);
    }
  }
  return tools;
}

// The `lua-docs` entry is the public HTTP MCP served by the docs site
// (https://docs.heylua.ai/mcp). An earlier iteration pointed `.mcp.json` at
// a vendored `mcp/lua-docs/dist/server.js` that never existed; the remote
// endpoint needs no vendoring, so the registry lists its tools statically.
const REGISTRY = {
  'lua-platform': await discoverLuaPlatformTools(),
  'lua-docs': new Set(['search_lua_cli', 'query_docs_filesystem_lua_cli', 'submit_feedback']),
};

// Every server referenced by a prompt must be registered in .mcp.json, and
// vice versa — otherwise a prompt names a server Claude Code never starts.
try {
  const mcpDoc = JSON.parse(await readFile('.mcp.json', 'utf8'));
  const configured = new Set(Object.keys(mcpDoc?.mcpServers ?? {}));
  for (const server of Object.keys(REGISTRY)) {
    if (!configured.has(server)) {
      console.error(`✗ MCP server "${server}" is in the lint registry but not in .mcp.json`);
      process.exit(1);
    }
  }
  for (const server of configured) {
    if (!REGISTRY[server]) {
      console.error(`✗ .mcp.json declares MCP server "${server}" but this lint has no tool registry for it — add one so prompt references can be checked`);
      process.exit(1);
    }
  }
} catch (err) {
  console.error(`✗ Could not cross-check .mcp.json: ${err.message}`);
  process.exit(1);
}

console.log('Discovered MCP tools:');
for (const [server, tools] of Object.entries(REGISTRY)) {
  console.log(`  ${server}: ${[...tools].join(', ') || '(none)'}`);
}

// Walk slash + subagent prompts looking for mcp__... references.
async function* walkMd(dir) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) yield* walkMd(full);
    else if (st.isFile() && extname(full) === '.md') yield full;
  }
}

let failed = false;
const SCAN_DIRS = ['agents', 'commands'];

for (const dir of SCAN_DIRS) {
  try {
    for await (const file of walkMd(dir)) {
      const content = await readFile(file, 'utf8');
      for (const [lineNo, line] of content.split('\n').entries()) {
        if (/^tools:/.test(line)) continue; // frontmatter may carry both spellings
        for (const match of line.matchAll(REF_RE)) {
          const [full, server] = match;
          if (!server.startsWith(PLUGIN_PREFIX) && REGISTRY[server]) {
            console.error(`✗ ${file}:${lineNo + 1}: "${full}" uses the bare server name. Inside the plugin Claude Code names the tool mcp__${PLUGIN_PREFIX}${server}__… — use that form in prose (the bare form only exists for a user-registered server).`);
            failed = true;
          }
        }
      }
      for (const match of content.matchAll(REF_RE)) {
        const [full, rawServer, tool] = match;
        const server = canonicalServer(rawServer);
        if (!REGISTRY[server]) {
          console.error(`✗ ${file}: references unknown MCP server "${server}" in "${full}"`);
          failed = true;
          continue;
        }
        if (!REGISTRY[server].has(tool)) {
          console.error(`✗ ${file}: references "${full}" but ${server} doesn't expose tool "${tool}"`);
          console.error(`    Available on ${server}: ${[...REGISTRY[server]].join(', ')}`);
          failed = true;
        }
      }
    }
  } catch { /* dir missing */ }
}

if (failed) {
  console.error('\nFix the references above. If a tool was removed, delete its references from agent/slash prompts.');
  process.exit(1);
}
console.log('✓ All MCP tool references resolve to existing tools.');

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
//   (lua-docs MCP server entry was removed in iteration-13 — see
//   scripts/lint-mcp-config.mjs for the rationale.)

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const REF_RE = /mcp__([a-zA-Z][a-zA-Z_-]*)__([a-zA-Z_]+)/g;

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

// Iteration-13 audit removed the `lua-docs` MCP server entry — it was
// referenced everywhere but the vendored source never existed (no
// mcp/lua-docs/, no build step, no copy step in CI). Slash commands and
// agents now use WebFetch on https://docs.heylua.ai instead. If a future
// iteration adds a real lua-docs server, restore the registry entry.
const REGISTRY = {
  'lua-platform': await discoverLuaPlatformTools(),
};

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
      for (const match of content.matchAll(REF_RE)) {
        const [full, server, tool] = match;
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

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
//   - ui tools: the public Storybook MCP for @lua-ai-global/ui at
//     https://ui.lua.dev/mcp (`http` server, key `ui`). Its tool names are
//     kebab-case and fixed by Storybook's MCP addon (tools/list checked
//     2026-10-19).
//
// Also checks tool-name validity:
//   - every tool name a server reports must match ^[A-Za-z0-9_-]{1,64}$ (the
//     MCP / Anthropic API tool-name rule);
//   - every composed plugin name, mcp__plugin_<plugin>_<server>__<tool>, must
//     use only [A-Za-z0-9_-] and stay within COMPOSED_MAX. That is NOT 64:
//     composed names longer than 64 resolve in Claude Code today —
//     mcp__plugin_lua-agent-builder_lua-docs__query_docs_filesystem_lua_cli
//     (69) and mcp__plugin_lua-agent-builder_lua-platform__list_primitive_versions
//     (67) are live, callable tools (checked 2026-10-19). COMPOSED_MAX (128) is a
//     sanity ceiling, not a verified Claude Code limit. The `ui` server still uses a short key, so its
//     longest name (…_ui__get-documentation-for-story) is 61.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

// Tool names may be kebab-case (the ui server's `get-documentation`).
const REF_RE = /mcp__([a-zA-Z][a-zA-Z_-]*)__([a-zA-Z_-]+)/g;

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
  ui: new Set(['list-all-documentation', 'get-documentation', 'get-documentation-for-story']),
};

// 1.15.0: servers the plugin does NOT ship but a host passes with --mcp-config, so the prose may name them. They
// are absent from .mcp.json by design and always appear under their BARE name (mcp__<server>__<tool>), never the
// plugin-prefixed one. `lua-session` is the live-build-session server (lua-core-services shared-types
// BUILD_SESSION_MCP_TOOL_NAMES, mirrored in lib/session-mode.mjs).
const { SESSION_MCP_SERVER, SESSION_TOOL_NAMES } = await import('../lib/session-mode.mjs');
const EXTERNAL_REGISTRY = {
  [SESSION_MCP_SERVER]: new Set(SESSION_TOOL_NAMES),
};

// Tool-name validity (see the header): raw names ≤ 64, composed names ≤ COMPOSED_MAX.
const RAW_TOOL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COMPOSED_MAX = 128;
const NAME_CHARS_RE = /^[A-Za-z0-9_-]+$/;
{
  let bad = false;
  for (const [server, tools] of Object.entries(REGISTRY)) {
    if (!NAME_CHARS_RE.test(server)) {
      console.error(`✗ MCP server key "${server}" has characters outside [A-Za-z0-9_-]; Claude Code puts it into every tool name.`);
      bad = true;
    }
    for (const tool of tools) {
      if (!RAW_TOOL_RE.test(tool)) {
        console.error(`✗ ${server} tool "${tool}" must match ^[A-Za-z0-9_-]{1,64}$.`);
        bad = true;
      }
      const full = `mcp__${PLUGIN_PREFIX}${server}__${tool}`;
      if (!NAME_CHARS_RE.test(full) || full.length > COMPOSED_MAX) {
        console.error(`✗ "${full}" (${full.length} characters) must use only [A-Za-z0-9_-] and stay within ${COMPOSED_MAX} characters. Shorten the server key in .mcp.json.`);
        bad = true;
      }
    }
  }
  if (bad) process.exit(1);
}

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
        if (EXTERNAL_REGISTRY[server]) {
          if (rawServer !== server) {
            console.error(`✗ ${file}: "${full}" — ${server} is passed by the host, not shipped by the plugin; use the bare form mcp__${server}__${tool}.`);
            failed = true;
          } else if (!EXTERNAL_REGISTRY[server].has(tool)) {
            console.error(`✗ ${file}: references "${full}" but ${server} doesn't expose tool "${tool}"`);
            console.error(`    Available on ${server}: ${[...EXTERNAL_REGISTRY[server]].join(', ')}`);
            failed = true;
          }
          continue;
        }
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

// MCP stdio server bootstrap. Per tech spec §8.1.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as tools from './tools/index.mjs';

const TOOL_REGISTRY = Object.values(tools);

const server = new Server(
  { name: 'lua-platform', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_REGISTRY.map((t) => t.spec),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOL_REGISTRY.find((t) => t.spec.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  try {
    return await tool.handler(req.params.arguments ?? {});
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// §19.6 crash reporting — must land BEFORE process exit so the event reaches
// telemetry. Windows can drop the last stderr write if process.exit fires
// synchronously after it; same bug class as lib/hook-runtime.mjs's exit().
// Exit only inside the write callback so the flush completes.
function reportCrashAndExit(payload) {
  process.stderr.write(JSON.stringify(payload) + '\n', () => process.exit(1));
}

process.on('uncaughtException', (err) => {
  reportCrashAndExit({
    event: 'mcp_server_crash',
    kind: 'uncaughtException',
    message: err?.message,
    stack: err?.stack,
    plugin_version: '1.0.0',
    lua_cli_version: process.env.LUA_CLI_VERSION ?? null,
    platform: process.platform,
    ts: new Date().toISOString(),
  });
});

process.on('unhandledRejection', (reason) => {
  reportCrashAndExit({
    event: 'mcp_server_crash',
    kind: 'unhandledRejection',
    reason: String(reason),
    stack: reason?.stack,
    plugin_version: '1.0.0',
    lua_cli_version: process.env.LUA_CLI_VERSION ?? null,
    platform: process.platform,
    ts: new Date().toISOString(),
  });
});

await server.connect(new StdioServerTransport());

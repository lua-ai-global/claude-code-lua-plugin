# @lua/claude-plugin-mcp

Read-only MCP server for the lua-agent-builder Claude Code plugin.

Per tech spec §3.4 / §6.3: this server exposes 6 read-only tools that let
Claude Code query lua-platform state mid-conversation without using slash
commands.

## Tools

- `list_agents` — agents accessible to the authenticated user (subprocess: `lua agents --json`)
- `get_agent` — public-facing config for one agent
- `list_primitive_versions` — versions of a skill/webhook/job/etc.
- `get_deployment_status` — what's live in production right now (composed from per-type version endpoints)
- `tail_logs` — structured log fetch (mirrors `lua logs --json`)

5 tools (was 6 before v1.25 — `check_drift` deleted; deploy-pilot calls `Bash(lua sync --check)` directly).

## Building

```bash
pnpm install
pnpm build
```

Output: `dist/server.js` (single bundled file). Vendored into the
plugin assets repo at `mcp/lua-platform/dist/server.js` per §3.2.

## Running standalone

The server speaks MCP over stdio. Normally invoked by Claude Code via
`.mcp.json`; for manual testing:

```bash
LUA_API_KEY=lk_... node dist/server.js
```

## Architecture

- `src/server.ts` — MCP stdio bootstrap
- `src/tools/*.mjs` — one file per tool
- `src/auth.mjs` — credential resolution (mirrors lua-cli's chain)
- `src/api-client.mjs` — HTTP wrapper around lua-api

This package is **not** the runtime artifact users install — that's the
vendored `dist/server.js` bundled into the plugin assets. The npm
`@lua/claude-plugin-mcp` package is published for standalone use only.

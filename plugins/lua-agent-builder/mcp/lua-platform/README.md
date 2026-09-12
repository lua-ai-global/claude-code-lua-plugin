# @lua/claude-plugin-mcp

Read-only MCP server for the lua-agent-builder Claude Code plugin.

This server exposes 5 read-only tools that let Claude Code query Lua
platform state mid-conversation without using slash commands. It never
mutates server state — pushes, deploys and run control always go through
`lua-cli` via the slash commands.

## Tools

| Tool | Returns | Backend |
|---|---|---|
| `list_agents` | `[{ id, name, orgId, orgName, visibility }]` for every agent the credential can reach | subprocess `lua agents --json --ci` (the CLI owns the credential → authorization-projection resolution) |
| `get_agent` | the same record for one `agentId` | same subprocess, filtered |
| `list_primitive_versions` | `{ agentId, type, name, activeVersionId, versions: [{ version, versionId, active, createdAt }] }` for a skill, webhook, job, trigger, preprocessor, postprocessor, workflow or the persona | `GET /developer/<plural>/:agentId` (name → id) then `GET .../:id/versions`; persona: `GET /developer/agents/:agentId/persona/versions` |
| `get_deployment_status` | the active (live) version of every primitive of all seven families plus the persona; `partial: true` + `partialReason` when the 45 s budget cut it short | composed from the routes above — persona + 7 list calls in parallel, then per-item version lookups in chunks of 5 |
| `tail_logs` | `{ logs: LogEntry[], pagination }` — same data as `lua logs --json`; filter by `type` (→ `logSource`), `name` (→ `primitiveName`) and `logType` (→ `subType`), ≤ 100 per call | `GET /developer/agents/:agentId/logs` |

`LogEntry` has `subType` (`error | warn | info | debug | start | complete`),
`message`, `timestamp` and `metadata.logSource` / `metadata.primitiveName`.
There is no `level` field. `tail_logs`' optional `logType` input takes one of
those six `subType` values (lua-api applies it as `filter.subType`).

### `versionId` caveat

`list_primitive_versions` reports `versionId: null` for families whose
versions route carries no per-entry id: **skill**, **persona** and
**webhook**. (lua-api's webhook mapper emits the row id only under a misnamed
`webhookId` key, which the server never treats as a version id.) Triggers,
preprocessors and postprocessors emit `versionId`; jobs and workflows emit
`id`, which is surfaced as `versionId`. The top-level `activeVersionId` is
populated only for webhook / trigger / preprocessor / postprocessor envelopes
and is the way to identify the live webhook row.

### `get_deployment_status` concurrency and budget

The tool fans out 1 + 7 + N requests. Phase 1 issues the persona call and the
seven list calls together; phase 2 walks the types in a fixed order and, within
each type, looks up item versions in chunks of five concurrent requests. Output
order is stable (types in canonical order, items in list order) regardless of
which request finishes first. A 45 s wall-clock budget stops new requests once
exceeded — in-flight ones still complete — and any item not looked up is still
listed with `error: "skipped: …"`, alongside `partial: true` and a
`partialReason` on the result.

Every route, query parameter and response envelope is verified against
`packages/lua-api/src/controllers/developer/**` and `packages/lua-api/src/dto/**`
in lua-core-services (see `src/response-shapes.mjs` for the per-family
shapes — they differ: skills use `isCurrent`/`createdDate`, jobs and
workflows use `active` with the array directly under `data`, webhooks /
triggers / processors use `isActive` + `activeVersionId`).

## Credentials

Resolved on every call, mirroring lua-cli 3.33.0's `resolveRequestCredential()`:

1. `LUA_API_KEY` — the process environment, then a `.env` in the working
   directory (lua-cli loads `.env` via `dotenv/config` before reading the
   variable, so it ranks here).
2. The renewable session `lua auth configure` (email + OTP) stores in
   `~/.lua-cli/sessions/<env-hash>.json` — the default login since lua-cli
   3.29. The server refreshes the stored Firebase refresh token at Google's
   securetoken endpoint and caches the ID token in memory; the session file
   is never written.
3. `~/.lua-cli/credentials` — a plain-text API key (the API-key option of `lua auth configure`).

`LUA_API_URL` selects the API base (default `https://api.heylua.ai`) and which
session environment is used. Requests carry `Authorization: Bearer …` and
`X-Lua-Client: claude-plugin/<version>`.

## Building

```bash
npm install
npm run build      # esbuild → dist/server.js
npm test
```

Output: `dist/server.js` (single bundled file, `@modelcontextprotocol/sdk`
external). The plugin's `.mcp.json` launches it via
`node ${CLAUDE_PLUGIN_ROOT}/mcp/lua-platform/dist/server.js`; the built file
is committed so marketplace installs (which copy the repo verbatim) work
without a build step.

## Running standalone

The server speaks MCP over stdio. Normally invoked by Claude Code via
`.mcp.json`; for manual testing:

```bash
node dist/server.js            # uses your lua-cli login
LUA_API_KEY='<key>' node dist/server.js
```

## Architecture

- `src/server.mjs` — MCP stdio bootstrap + crash reporting
- `src/tools/*.mjs` — one file per tool
- `src/auth.mjs` — credential resolution (mirrors lua-cli's chain, incl. session refresh)
- `src/api-client.mjs` — HTTP wrapper around lua-api
- `src/response-shapes.mjs` — per-family list/versions envelope extractors and the active-version predicate
- `src/run-lua.mjs` — subprocess helper for `lua agents --json`

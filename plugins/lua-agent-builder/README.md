# claude-code-lua-plugin

A [Claude Code](https://code.claude.com) plugin for building, testing, and deploying [Lua AI agents](https://heylua.ai) directly from inside your Claude Code session. Wraps the `lua-cli` tool with a single-permission, hook-gated, MCP-augmented workflow.

## Install

Once approved on the official Anthropic marketplace:

```
/plugin install lua-agent-builder@claude-plugins-official
/reload-plugins
/lua-auth          # private typed login through lua-cli 3.28.0+
```

After auth, `/lua-doctor` to verify the environment, then `/lua-init` to scaffold a new agent project.

In the meantime (pre-marketplace-approval), self-host install:

```
/plugin marketplace add lua-ai-global/claude-code-lua-plugin
/plugin install lua-agent-builder@claude-code-lua-plugin
/reload-plugins
```

## Layout

```
packages/claude-code-lua-plugin/
├── .claude-plugin/plugin.json   # Plugin manifest
├── .mcp.json                    # MCP server registration
├── settings.json                # placeholder — permissions live in lib/permissions-template.json
├── hooks/hooks.json             # Hook event registration
├── commands/                    # 13 slash commands
├── agents/                      # 5 subagents (skill-builder, debug,
│                                #              deploy-pilot, qa, architect)
├── hooks/                       # 8 Node ESM hooks
├── lib/                         # Shared utilities
│   ├── knowledge/               # Reference files for the architect agent
│   ├── permissions-template.json # /lua-doctor merges into user .claude/settings.json
│   └── ...
├── mcp/
│   └── lua-platform/            # Vendored MCP server source — co-located
│       ├── src/                 # Tools + server bootstrap (.mjs)
│       ├── tests/
│       ├── scripts/bundle.mjs   # esbuild → dist/server.js
│       └── dist/                # gitignored, build output
├── scripts/                     # Lint + check + release scripts
├── test/                        # Jest tests for hooks + lib
└── .github/workflows/           # ci, release-beta, release-prod
```

The MCP server source is **co-located inside the plugin**, not a separate
sibling package. Its bundled output at `mcp/lua-platform/dist/server.js`
is what `.mcp.json` references via
`${CLAUDE_PLUGIN_ROOT}/mcp/lua-platform/dist/server.js`.

## Build

Plugin assets ship as-is (no build step for hooks/commands/agents — they're
markdown and Node ESM, run directly).

The MCP server requires a build:

```bash
cd mcp/lua-platform
npm install
npm run build      # → dist/server.js
```

The release pipeline (`.github/workflows/release.yml`) runs the MCP build
and includes `dist/server.js` in the published tarball so users get a working
plugin without needing to build anything themselves.

## Test

```bash
npm install
npm run lint          # eslint + 9 lint scripts (permissions/paths/single-permission/
                      #   mcp-refs/mcp-config/pinned-version/hooks-json/knowledge-commands)
npm run test:coverage # 207+ tests, 100% coverage on hooks, ≥90% on lib/
```

## CI and release model

Three GitHub Actions workflows in `.github/workflows/`. **The plugin tests
itself only — no integration with lua-cli or lua-api in CI.**

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | every PR / push to `main` or `staging` | Cross-platform matrix (macOS 14, Ubuntu 22.04, Windows 2022 × Node 18, 20). Lint, tests, per-file coverage gate. Plus a single Ubuntu/Node-20 job that builds the MCP bundle and verifies its size. No secrets needed; fork PRs run cleanly. |
| `release-beta.yml` | push to `staging` | Cuts a beta release tagged `v${packageVersion}-beta.${runNumber}`. Auto-versioned — no manual bump per beta. Publishes a GitHub Release marked as prerelease, with the plugin tarball (incl. built MCP bundle) attached. |
| `release-prod.yml` | push to `main` | Cuts a stable release tagged `v${packageVersion}` (read verbatim from `package.json`). **Refuses to release if the tag already exists** — version bumps must be intentional. Refuses if the version contains `-beta`/`-rc`/`-alpha`. Publishes a GitHub Release with the plugin tarball attached. |

### Branching model

- `main` — production. Each merge cuts a stable release.
- `staging` — pre-production. Each merge cuts an auto-versioned beta.
- Feature branches → PR to `staging` → review → merge → beta released.
  When ready to ship to production: PR `staging` → `main`, bump
  `package.json` version, merge → stable released.

### What CI does NOT do

- No real `lua-cli` invocations in CI (we test the hooks/MCP/lib code in isolation; the unit tests mock spawn calls)
- No staging-agent deploys, canaries, or smoke tests (those would be lua-cli/lua-api responsibilities, not the plugin's)
- No secret access in `ci.yml` (release workflows only need `GITHUB_TOKEN`, auto-provided)
- No marketplace publish (TODO when the plugin moves to its own public repo and the marketplace integration exists)

## M1 status

- 10 hooks, 100% coverage on every metric (statements, branches, functions, lines)
- 5 subagents, 14 slash commands

### First-run

After installing and activating the plugin:

1. Start any Claude Code session. The `check-lua-auth` SessionStart hook detects lua-cli without a working credential and shows a "run `/lua-auth`" prompt.
2. Run `/lua-auth`. A working `LUA_API_KEY`, `.env`, or credentials-file value stays unchanged. For a new login, use lua-cli 3.28.0 or newer and run `lua auth configure` in a private terminal. Select the organization, exact agents, and role there.
3. From here on, every Lua slash works: `/lua-init`, `/lua-new`, `/lua-test`, `/lua-deploy`, etc.

For the full environment diagnostic, use `/lua-doctor`. Its authentication step delegates new login to `/lua-auth`.
- 3 GitHub Actions workflows (ci, release-beta, release-prod)
- 9 lint scripts: `lint-permissions`, `lint-paths`, `lint-single-permission`,
  `lint-mcp-refs`, `lint-mcp-config`, `lint-pinned-version`, `lint-hooks-json`,
  `lint-knowledge-commands`, plus eslint
- 2 check scripts: `check-coverage`, `check-bundle-size`
- MCP server scaffold with 5 tools (`list_agents`, `get_agent`,
  `list_primitive_versions`, `get_deployment_status`, `tail_logs`).
  `check_drift` was deleted in v1.25 — deploy-pilot and qa subagents call
  `Bash(lua sync --check)` directly.

Outstanding (M4/M5):
- Marketplace publish (TODO when the plugin moves to its own public repo)

Iteration-13 audit dropped the `lua-docs` MCP server entry — it was referenced
everywhere (`.mcp.json`, slash commands, agents, knowledge files) but the
vendored source never existed and CI never built it, so the server would
have failed to start for every end-user. Doc-search now uses
`WebFetch https://docs.heylua.ai/...` from the slash command and agents.

## lua-api endpoint audit (resolved v1.25)

The original audit found that 4 of 6 MCP tools called paths that didn't
match real lua-api routes, and 2 needed entirely new endpoints. v1.25
resolved both gaps **without any new lua-api work**:

| MCP tool | Resolution |
|---|---|
| `list_agents` | Shells out to `lua agents --json`. The CLI already does the auth-to-userId resolution. The output is a list of orgs each with nested `agents`; the tool flattens to `[{id, name, orgId, orgName}]` (iteration-13 fix). |
| `get_agent` | Same shell-out as `list_agents`, then filters by ID. Iteration-13 audit replaced the original `/public/agents/:agentId` call — that route is `PublicOriginGuard`-protected and refused server-to-server requests with 403 "Origin header required". |
| `list_primitive_versions` | Resolves the user-supplied `name` → primitive ID by listing first, then calls `/developer/<type>s/:agentId/:id/versions` (iteration-13 fix — the previous implementation passed `name` into the `:id` slot and 404'd every call). Persona is special-cased: `/developer/agents/:agentId/persona/versions`. |
| `get_deployment_status` | Composes from existing list + versions endpoints. Uses `p.id` from the list response (iteration-13 fix — was using `p.name`). |
| `tail_logs` | Calls `GET /developer/agents/:agentId/logs` with `primitiveType`/`primitiveName` query params (iteration-13 fix — was sending `type`/`name`, which lua-api silently ignored). |
| ~~`check_drift`~~ | **Deleted from MCP.** Deploy-pilot uses `Bash(lua sync --check)` directly. |

**Net for M4: zero new lua-api endpoints needed.** All work happens in the
plugin repo.

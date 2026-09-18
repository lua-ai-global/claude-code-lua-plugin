# lua-agent-builder

A [Claude Code](https://code.claude.com) plugin for building, testing, and deploying [Lua AI agents](https://heylua.ai) from inside your Claude Code session. It wraps the `lua-cli` toolchain (a TypeScript SDK/CLI — unrelated to the Lua programming language) with single-permission slash commands, hook-enforced production gates, a source-verified knowledge base, and two MCP servers.

Verified against **lua-cli 3.33.0** (September 2026): every command shape, SDK type and API endpoint the plugin uses was read from the lua-cli / lua-api source, not from the public docs. 1.3.0 adds the per-step model classes (`taskClass`, `class/fast|balanced|strong`, `--apply-effort`, `lua workflows policy models`, `clear-gate`, `recompose`, `lua models list --workflows`) and the workflow autonomy envelope (`lua workflows policy autonomy`, `Consent: auto (policy)`), read from lua-cli `main` and `feat/workflow-autonomy` — the refs lua-cli 3.36.0 is cut from — and marked ⏳ in the knowledge base; the pin is 3.36.0 since 1.3.0.

## Install

```
/plugin marketplace add lua-ai-global/claude-code-lua-plugin
/plugin install lua-agent-builder@claude-code-lua-plugin
/reload-plugins
/lua-doctor        # Node, npm, lua-cli ≥ 3.36.0, auth, permission rules
```

New login runs in your own terminal (`lua auth configure`) — the plugin never handles your email, one-time code or credential. `/lua-auth` guides it.

## Layout

```
plugins/lua-agent-builder/
├── .claude-plugin/plugin.json   # plugin manifest
├── .mcp.json                    # lua-platform (local stdio) + lua-docs (https://docs.heylua.ai/mcp)
├── commands/                    # 20 slash commands
├── agents/                      # 5 subagents (architect, skill-builder, debug, deploy-pilot, qa)
├── hooks/                       # 10 Node ESM hooks + hooks.json
├── lib/
│   ├── knowledge/               # primitives, workflows, cli-reference, integrations, decision-trees
│   ├── permissions-template.json# allow/ask/deny rules /lua-doctor merges into .claude/settings.json
│   ├── tokenizer.mjs            # production-verb classifier for the deploy gate
│   └── credentials.mjs, hook-runtime.mjs, lua-cli.mjs, platform.mjs
├── mcp/lua-platform/            # vendored MCP server (src/, tests/, dist/server.js committed)
├── scripts/                     # 17 lint scripts + 2 check scripts + pack
└── test/                        # jest tests for hooks + lib
```

## Slash commands

| Slash | What it does |
|---|---|
| `/lua-doctor` | 5-step environment diagnostic with consent-gated fixes |
| `/lua-auth` | Keep a working credential or guide a private `lua auth configure` login |
| `/lua-update` | `npm install -g lua-cli@latest` |
| `/lua-docs <topic>` | Search the docs via the `lua-docs` MCP (WebFetch fallback) |
| `/lua-status` | `lua status --json` — auth, project, per-primitive local-vs-deployed sync |
| `/lua-init` | `lua init --ci` — new agent, existing agent, or duplicate; model from the live catalog |
| `/lua-architect <goal>` | Plan an agent end-to-end (subagent) |
| `/lua-new <type> [name]` | Scaffold + register + compile + test a tool, skill, webhook, trigger, job, preprocessor, postprocessor, mcp, device, device-trigger, voice, workflow or workflow-script (subagent) |
| `/lua-test [type]` | `lua test --ci skill\|webhook\|job\|preprocessor\|postprocessor\|workflow`; failures go to the debug subagent |
| `/lua-workflow <verb>` | Offline workflow runs with scripted approvals/signals; list/status/watch; start/approve/signal/resume/cancel with one confirmation |
| `/lua-chat` | One-shot `lua chat --ci -e <env> -m … -t` on an isolated thread |
| `/lua-logs` | `lua logs --ci --json` with the real `--type` list |
| `/lua-env` | `lua env <sandbox\|production> --list \| -k KEY -v VALUE \| -k KEY --delete`; the Bash prompt is the confirmation, values never echoed |
| `/lua-integrations` | `lua integrations available\|list\|info\|webhooks …\|mcp …`; read-only verbs run at once, mutations confirm once, OAuth connects go to your terminal |
| `/lua-sync` | Drift report from `lua status --json` + `lua sync --check`; `--pull` / `--push` |
| `/lua-push` | `lua push <type> --ci --force` for every push type incl. trigger/device/voice/workflow; never `--auto-deploy` |
| `/lua-deploy` | Gated ship sequence for any production change — primitive versions, persona, workflow versions, MCP activation, agent-version promote/rollback (subagent) |
| `/lua-version` | Agent versions: list/show/diff/status/create; promote routes to `/lua-deploy` |
| `/lua-template` | Marketplace agent templates: view/versions/status/health/installed/create/draft/install; publish and apply are prefixed production verbs |
| `/lua-qa` | Conversational QA + offline workflow scenarios + log scan → triage report (subagent) |

## Safety model

- **Production gate** — every verb that changes what runs in production is blocked by the `confirm-deploy` hook (on every Bash call) unless it carries the `LUA_DEPLOY_CONFIRMED=1` prefix, which only the deploy flow emits after your single confirmation: `lua deploy`, `lua skills|webhooks|jobs|preprocessors|postprocessors deploy`, `lua persona production deploy`, `lua workflows deploy|activate`, `lua version promote`, `lua mcp activate`, `lua marketplace template publish|apply` — in every spelling lua-cli accepts (its `publish`/`on`/`enable`/`submit`/`rollout`/`prod` aliases and the `heylua`/`lua-ai` binaries). A hook block wins over any allow rule. The permission template allows the literal prefixed forms and carries no deny/ask rule for the bare verbs, because Claude Code evaluates deny/ask past a leading env assignment and such a rule would block the confirmed form too. `lib/tokenizer.mjs` is the one classifier; `test/lib/permissions-mirror.test.mjs` fails if the layers drift.
- **`--auto-deploy`** is denied and blocked unconditionally.
- **Credential isolation** — `lua auth configure|key|logout` are denied for the model; login happens in your terminal.
- **Single permission per slash** — each slash asks at most one question (`x-lua-multi-step: true` marks the diagnostic exceptions).

## MCP servers

- `lua-platform` (local, `mcp/lua-platform/dist/server.js`): five read-only tools — `list_agents`, `get_agent`, `list_primitive_versions`, `get_deployment_status`, `tail_logs` — over the same lua-api routes lua-cli uses, with lua-cli's credential resolution (env → `.env` → renewable session → credentials file).
- `lua-docs` (remote, `https://docs.heylua.ai/mcp`): the public docs search (`search_lua_cli`, `query_docs_filesystem_lua_cli`).
- Claude Code names a plugin's MCP tools `mcp__plugin_lua-agent-builder_<server>__<tool>`; the subagents, slashes and the permission template use that form (the plain `mcp__lua-platform__…` spelling only exists for a server you register yourself with `claude mcp add`).

## Build & test

```bash
npm ci && npm run lint && npm run test:coverage          # plugin: 17 lints, hooks 100% / lib ≥ 90% coverage
cd mcp/lua-platform && npm ci && npm test && npm run build  # MCP server → dist/server.js (committed)
```

`dist/server.js` must be committed: marketplace installs copy the repo verbatim with no build step.

## CI and release

`ci.yml` runs lint + tests on macOS/Ubuntu/Windows × Node 18/20 and builds the MCP bundle; `release-beta.yml` cuts a prerelease on every push to `staging`; `release-prod.yml` cuts `v<package.json version>` on every push to `main` and refuses an existing tag. Versions in `package.json`, `.claude-plugin/plugin.json`, `../../.claude-plugin/marketplace.json`, `mcp/lua-platform/package.json` and the MCP source must match (`lint-release-version`).

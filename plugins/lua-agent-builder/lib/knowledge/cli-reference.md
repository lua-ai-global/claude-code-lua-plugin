# lua-cli command reference (3.33.0)

Read from `src/cli/command-definitions.ts`, `src/utils/aliases.ts`, `src/index.ts`, `src/errors/cli.error.ts`, `src/services/request-credential.ts` and the per-command implementations in `src/commands/` of lua-cli 3.33.0. The installed CLI's `lua <cmd> --help` is authoritative for flags; this file adds what the help text gets wrong or omits (marked ⚠).

lua-cli is a TypeScript toolchain. It has nothing to do with the Lua programming language.

---

## 1. Global behaviour

| Item | Fact |
|---|---|
| Binaries | `lua`, `heylua`, `lua-ai` (same entry) |
| Version | `lua --version` (bare, prints `3.33.0`) or `lua -V` / `lua --cli-version`. Subcommands own their `--version <n>` flag (pull, marketplace template) |
| `--ci` | Program-level flag, accepted anywhere on the line. Any interactive prompt the command would need throws `Interactive prompt required but --ci flag is set` → **exit 1**. Some commands use a raw prompt that ignores `--ci` and hangs: bare `lua env`, `lua pull` without `--force`, `lua auth logout` without `--force`, `lua auth key` without `--force`, `lua chat` without `-m`/`-e`, `lua governance`, `lua devices test`. Always pass complete flags |
| `--debug` / `LUA_DEBUG=1` | prints the stack under the one-line typed error |
| Errors | one stderr line `✖ <class>: <message>` plus a `💡` hint; with `--json` the error is `{ success:false, error:{ code, statusCode?, message, issues? } }` on stdout |
| Hints / banner | `LUA_NO_HINTS=1` suppresses tips; `LUA_NO_BANNER=1` the banner |
| Update check | background npm check (24 h cache) after most commands; warning box on stderr |
| Telemetry | PostHog; `lua telemetry on|off|status`; `LUA_TELEMETRY=false` |
| Env vars | `LUA_API_KEY`, `LUA_API_URL` (default `https://api.heylua.ai`), `LUA_AUTH_URL` (`https://auth.heylua.ai`), `LUA_WEBHOOK_URL` (`https://webhook.heylua.ai`), `LUA_DEBUG`, `LUA_NO_HINTS`, `LUA_NO_BANNER`, `LUA_TELEMETRY`; push-time `LUA_PUSH_SHOW_OVERLAY=1`, `LUA_PUSH_ENV_CHECK=error` |
| `~/.lua-cli/` | `credentials` (API key, 0600), `sessions/<hash>.json` (renewable session), `auth.json` (GitHub device-flow token), `sandbox.json`, `version-check.json`, `telemetry.json`, `cache.json` |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | error — unclassified failure, `compile_failed`, `lua sync --check` with drift, a prompt reached under `--ci`, a `lua workflows` API refusal (4xx other than 404) |
| 2 | usage — bad args, unknown action, no `lua.skill.yaml` / missing agentId |
| 3 | not found (404) |
| 4 · 5 · 6 · 7 · 8 | `lua workflows` only: run failed/timed out · run cancelled · run gated (consent) · `--timeout` reached · run parked waiting for a human |
| 9 | auth (no credential / 401 / session signed out) |
| 10 | forbidden (403, and other 4xx as `http_<status>`) |
| 11 | unavailable (5xx, network, timeout) |
| 12 | provider rejected (424 — the model provider refused: BYOK key, unknown model, quota) |

---

## 2. Credentials (what `/lua-auth` and the MCP server rely on)

Resolution order (every command): **1.** `LUA_API_KEY` — the process environment; lua-cli loads `./.env` first via `dotenv/config`, so a `.env` value counts here. **2.** the renewable first-party session in `~/.lua-cli/sessions/<hash>.json` (email + OTP login, default since 3.29; a refresh token exchanged for a short-lived bearer on every use). **3.** `~/.lua-cli/credentials` — a plain-text API key. Nothing → exit 9.

- `lua auth configure` (interactive: email or API key) · `--api-key <key>` (typed `api_<uuid>.<43 chars>` or legacy; writes `credentials`, clears any session) · `--email <e>` then `--email <e> --otp <code>` (writes the session, **deletes** `credentials`). The plugin never runs any of these — new login happens in the user's own terminal.
- `lua auth logout [--all] [--force]` (this device, or every device/app) · `lua auth sessions [--json]` · `lua auth sessions revoke <id>` · `lua auth key [--force]` (prints the key — never run it from the plugin).
- Credential classes: `typed-personal` (scoped key; **cannot create or duplicate agents** → `lua init --agent-name` exits 10), `legacy-owner-delegation`, `first-party-session`. `lua status --json` reports `auth.source` = `environment | stored | renewable session` and `auth.credentialClass`.
- Typed credentials need lua-cli ≥ 3.28.0 (server-enforced `minimumCliVersion`).

---

## 3. Project layout (`lua init`)

`lua init` copies the template (`src/index.ts`, `lua.skill.yaml`, `package.json`, `tsconfig.json`, `env.example`, `README.md`, `QUICKSTART.md`, `.gitignore`; `examples/` only with `--with-examples`), fills `agent.agentId/orgId` in the YAML and `name`/`persona`/`model` in `src/index.ts`, then runs `npm install --force`. Existing-agent init restores the latest source backup when one exists.

Non-interactive forms: `lua init --ci --agent-id <id> [--restore-sources] [--force]` · `lua init --ci --agent-name <n> --org-id <id> [--model <code>] [--with-examples] [--promo-code <c>] [--force]` · `--org-name <n>` instead of `--org-id` to create an org · `--from-agent-id <id> [--org-id <id>] [--include-resources --include-custom-data --include-inquiry-form --include-devices --include-ecommerce-catalog]` to duplicate. `--model` is validated against `lua models list --json` (the server catalog; no hardcoded list — omit it for the platform default `alibaba/qwen3.8-flash`). An existing `lua.skill.yaml` without `--force` → exit 2.

Config file: `lua.skill.yaml` at the project root. Compiled output: `dist-v2/manifest.json` (`{ version, compiledAt, primitives: ManifestPrimitive[], projectFiles, config }`; primitive kinds `tool skill job webhook trigger preprocessor postprocessor mcp-server agent device device-trigger voice workflow`), `dist-v2/artifacts/<kind>/…`, `dist-v2/sources/`.

---

## 4. Command matrix

Legend — **RO** read-only · **L** local write · **S** server write (staging/config, not live) · **P** production-affecting (the plugin gates these behind `LUA_DEPLOY_CONFIRMED=1` via `/lua-deploy` or `/lua-template`).

### Build & test (local)
| Command | Non-interactive shape | Effect |
|---|---|---|
| `lua compile [--verbose] [--debug] [--sync]` | as is | L: `dist-v2/`, syncs names/versions into `lua.skill.yaml`. No API call unless `--sync` (drift check, read-only) |
| `lua test <skill\|webhook\|job\|preprocessor\|postprocessor\|workflow> --name <n> [--input '<json>'] [--json]` | ⚠ help omits `preprocessor`/`postprocessor` but they are accepted. `--input` is a JSON **string**; only `workflow` accepts `@file`. Compiles first, runs in the local VM; needs a credential + agentId. **For `skill`, `--name` is the TOOL name** (resolved across all skills; a skill name → exit 3 `not_found: Tool "<n>" not found`) and `--input` is the tool's own fields — no `{"tool": …}` envelope | RO (local VM; platform API calls inside your code are real) |
| `lua test workflow --name <n> …` ≡ `lua workflows run <n> …` | offline driver flags in workflows.md §7 | RO |
| `lua voice test [--voice n] [--pattern re] [--watch] [--bail] [--runner jest\|vitest\|auto]` | runs `*.voice.test.ts` | RO |
| `lua voice list [--json]` | reads the compiled manifest | RO |

### Sync & status
| Command | Shape | Effect |
|---|---|---|
| `lua status [--json]` (alias `describe`) | degrades gracefully outside a project / unauthenticated | RO — one-line JSON: `environment`, `updates`, `auth { authenticated, source, email, organizations[] }`, `project { inProject, agentId, manifest }`, `primitives[] { kind, local[], server[], diffs[] { status: synced\|ahead\|behind\|not deployed }, orphans[] }`, `persona { status }`, `backup { status }`, `warnings`, `hints` |
| `lua sync --check` | exit 1 on drift. ⚠ Not read-only on the server: it compiles with `serverSync: true` (sync.ts → `compileCommand({ serverSync: true })`, compile.ts step 5), which reconciles ids/versions and **registers local primitives as server entity records** (no version, nothing live) — `lua status` shows them as "not deployed" afterwards. A bare `lua compile` never reaches the server (LUA-790) | RO for what runs (S: entity records only) |
| `lua sync --pull [--force]` (`--accept` is the legacy alias) | refuses if local files changed since the last backup unless `--force` | L: restores files from the server backup |
| `lua sync --push` | | S: pushes persona version, name, model, governance — **not** primitives (use `lua push`) |
| `lua agents [--json]` | `[{ orgId, name, archived, discoveredVia, agents: [{ agentId, name, visibility, displayRoles }] }]` | RO — the plugin's auth probe |
| `lua models [list] [--json]` · `lua models set --model <code>` · `lua models unset` | list: `{ currentModel, models: [{ provider, code, model, description, … }] }` | RO / L+S |
| `lua logs --type <t> [--name n] [--user-id u] [--agent-id a] [--limit n (20)] [--page n] [--json]` | `--type` ∈ `all skill job webhook preprocessor postprocessor user_message agent_response agent_error mcp runtime rag device device-trigger calls` (⚠ help lists `mastra`; it is rejected). `--json` → `{ logs: LogEntry[], pagination }`; `LogEntry { id, timestamp, type: 'log'\|'metric', subType: 'error'\|'warn'\|'info'\|'debug'\|'start'\|'complete', message, duration?, metadata: { logSource, primitiveName, primitiveId, userId, runId, channel } }` — **no `level` field** | RO |

### Push & deploy
| Command | Shape | Effect |
|---|---|---|
| `lua push [type] [--name n] [--set-version x.y.z] [--force] [--fresh] [--no-include-source]` | `type` ∈ `skill agent webhook trigger job preprocessor postprocessor mcp device device-trigger voice workflow backup all` (⚠ help lists a shorter set; `persona` is an alias of `agent`). No type or `all --force` = **stage-all** (auto-bumps every versioned primitive, upserts MCP servers, pushes agent config + backup; workflows are NOT included in stage-all). Granular with `--name`; one entity auto-selects; several without `--name` → prompt (exit 1 under `--ci`). `--set-version` must be `x.y.z`; omitted + `--force` ⇒ patch bump. `--auto-deploy` publishes a granular push (a no-op with a warning for `all`) — **never used by this plugin** | S (+P with `--auto-deploy`) |
| `lua deploy <type> --name <n> --set-version <ver\|latest> --force` | `type` ∈ `skill webhook trigger job preprocessor postprocessor persona all` (⚠ help/menu omit `trigger`). `all --force` deploys the latest version of everything and **ignores `--set-version`**. Persona takes an integer or `latest`. Under agent versioning the server creates and promotes a scoped agent version | **P** |
| `lua workflows deploy <name> -v <semver\|latest\|id>` | the only way to make a workflow version live | **P** |
| `lua version create [-m msg] [--auto-push] [--commit-hash h]` · `list [--status active\|staged\|superseded\|deleted\|all] [--limit n] [--json]` · `show <v> [--json]` · `diff <a> <b> [--json]` · `status` · `promote <v>` · `delete <v> [--force]` | agent versions = atomic snapshots of the whole staged state; `promote` swaps the live version (**no confirmation in the CLI** — the plugin gates it); also the rollback verb | create S · promote **P** |
| `lua persona production deploy --persona-version <n\|latest> [--force]` | same as `lua deploy persona` | **P** |
| `lua skills\|webhooks\|jobs\|preprocessors\|postprocessors deploy …` | older per-primitive spellings (`--skill-name/--skill-version`, `--webhook-name/--webhook-version`, `-i/-v` for jobs, `--preprocessor-name/--preprocessor-version`…) | **P** |
| `lua mcp activate\|deactivate <name>` · `lua mcp list` · `lua mcp delete` | MCP servers are non-versioned | activate **P** |
| `lua pull [--version <v>] [--force]` · `lua source list [--all] [--limit n]` · `lua source rollback --version <n> [--force]` | source backups (append-only history) | L + S |
| `lua git connect [--auto-push]` · `disconnect` · `status` · `lua git auth github [--force]` · `auth status` · `auth disconnect` | opt-in auto-commit/tag after pushes (`git.enabled` in the YAML); GitHub device-flow OAuth for auto-push | L |

### Per-primitive management (all take `--ci`)
| Command | Actions | Flags |
|---|---|---|
| `lua skills [sandbox\|production\|view\|versions\|deploy\|delete]` | `view` lists (⚠ not `list`) | `--skill-name`, `--skill-version` |
| `lua webhooks <view\|versions\|deploy\|activate\|deactivate\|delete\|list-events\|subscribe\|unsubscribe>` | `subscribe/unsubscribe` = platform event subscriptions (e.g. `message.delivered`) | `--webhook-name`, `--webhook-version`, `--event` |
| `lua jobs <view\|versions\|deploy\|activate\|deactivate\|trigger\|history\|delete>` | `trigger` fires a real run | `-i, --job-name`, `-v, --job-version` |
| `lua triggers <list\|create\|logs\|activate\|deactivate\|rotate-token\|delete>` | **platform** triggers (paste-anywhere URLs, `defineTrigger` records). `create --name n [--description t] [--instruction t]` prints the URL; `rotate-token` invalidates the old URL at once | `--trigger <nameOrId>`, `--limit`, `--json`, `--force` |
| `lua preprocessors` / `lua postprocessors <view\|versions\|deploy\|activate\|deactivate\|delete>` | | `--preprocessor-name/--preprocessor-version` etc. |
| `lua devices <list\|status\|enable\|disable\|remove\|test\|test-trigger>` | `test`/`test-trigger` are interactive | `--device-name`, `--group`, `--payload`, `--timeout`, `--force` |
| `lua features <list\|enable\|disable\|view\|configure>` | RAG, webSearch, inquiry, outboundChannels | `--feature-name`, `--recipient-scope current_user\|anyone` |
| `lua resources <list\|view\|delete>` | knowledge-base resources; create/update are interactive | `--resource-name` |
| `lua channels list` | channel creation is interactive only | |
| `lua env <sandbox\|production> [-k KEY -v VALUE] [-d, --delete] [--list]` | `staging` = sandbox. **Sandbox rewrites the local `.env` in full** (comments dropped); production PUTs the live env map. `--list` masks values (first 4 chars + `*`); a set never echoes the value; flags without an environment → exit 2; no `--json`. Bare `lua env` hangs under `--ci`. Slash: `/lua-env` | L (sandbox) / S (production) |
| `lua persona <sandbox\|production> [view\|versions\|deploy]` | `production deploy --persona-version <n\|latest>`; sandbox edit rewrites the `persona` literal in `src/index.ts` | |
| `lua production <overview\|persona\|skills\|env>` | read-only summaries | |
| `lua chat [-e sandbox\|production] -m "<text>" -t [<id>] [--clear] [--agent-version <n>] [-b m1 m2 -d ms]` | **no `--json`**. `-m` without `-e` defaults to sandbox (and pushes local skills/processors to the sandbox first). `-t` with no value = a fresh auto-generated thread (printed); omitting `-t` continues the DEFAULT thread — always pass it. `lua chat clear [--user id] [-t id] [--force]` | S (sandbox push) / production message |
| `lua integrations …` | see integrations.md | |
| `lua governance [add\|remove]` | interactive only | L (+S on remove) |
| `lua completion <bash\|zsh\|fish>` · `lua admin` · `lua evals` · `lua docs` · `lua update` · `lua telemetry` | utilities; `admin/evals/docs` open a browser; `lua update` has no flags | |

### Marketplace — skills and agent templates
`lua marketplace <skill|template> <action> [flags]`; destructive actions take `--force` as the confirmation (absent → exit 2).

- **Skills**: `list --skill-name n --display-name d [--visibility public|private]` · `publish --marketplace-id id --version-id v [--changelog t] [--env-vars-json j]` · `edit` · `unlist --force` · `unpublish --force` · `transfer --new-org-id id --force` · `mine [--json]` · `org [--json]` · `search [--query q] [--page n] [--limit n] [--json]` · `view --marketplace-id id [--json]` · `install --marketplace-id id --version-id v [--env-vars k=v,…] --force` · `update --skill-name n [--version-id v] [--env-vars …]` · `uninstall --skill-name n --force` · `installed [--json]`.
- **Agent templates** (package a whole agent for other orgs): `create --name <internal> --display-name <d> [--description t] [--visibility public|private]` · `draft` (server composes the `template:` YAML section from the current agent: connections, personaTemplate, triggerPresets, paramsMeta, onInstall, onUninstall) · `publish --template-id id [--source-version n] [--changelog t] [--env-contract KEY=desc …] [--skip-auto-apply] [--yes]` (consenting installs auto-update unless `--skip-auto-apply`; **P**) · `view --template-id id [--version n] [--json]` · `versions --template-id id [--json]` · `install --template-id id [--version n] [--env-vars k=v,…] [--allow-creator-updates] --force` · `apply --template-id id [--version n] (--agents a,b | --file path | --all-installed) --force [--no-wait]` (fleet rollout; **P**) · `status --template-id id [--json]` · `health --template-id id [--window-days n]` · `installed [--json]` · `uninstall --template-id id --force`.
- The authored `template:` section in `lua.skill.yaml` (`connections[]`, `personaTemplate`, `triggerPresets`, `paramsMeta` — incl. conditional `showIf: { param, equals[] }` — `onInstall`, `onUninstall`, `installPolicy`) is serialised in full on every publish (empty = clear). A workflow `schedule.runAs: 'installer' | 'system'` decides who the installed copy runs as. Docs: `/marketplace/template-manifest`, `/marketplace/publishing-templates`, `/marketplace/deploying-templates`.

---

## 5. How each primitive goes live (the matrix the deploy pilot follows)

| Kind | `lua push` type | Production path | Notes |
|---|---|---|---|
| skill | `skill` | `lua deploy skill --name n --set-version latest --force` | tools ride inside |
| webhook | `webhook` | `lua deploy webhook …` | `lua webhooks activate/deactivate` |
| trigger | `trigger` | `lua deploy trigger …` | record managed by `lua triggers` |
| job | `job` | `lua deploy job …` | `lua jobs activate/deactivate/trigger` |
| preprocessor / postprocessor | same | `lua deploy preprocessor\|postprocessor …` | |
| persona / agent config | `agent` | `lua deploy persona --set-version latest --force` | model/modelSettings/batching are live on push |
| mcp-server | `mcp` | `lua mcp activate <name>` | non-versioned |
| device / device-trigger / voice | `device` / `device-trigger` / `voice` | `lua version create` → `lua version promote <n>` | not `lua deploy` types |
| workflow | `workflow` | `lua workflows deploy <name> -v latest` | `lua workflows activate` for schedules/triggers |
| everything | `lua push all --force` (stage-all) | `lua deploy all --force` (latest of every deployable primitive) or `lua version create` → `lua version promote <n>` | `promote` is also rollback |

After a deploy: `lua logs --type all --limit 30 --json` and scan `subType === 'error'`; `lua status --json` shows `diffs[].status` per primitive.

---

## 6. Docs map (docs.heylua.ai) for `WebFetch` / the `lua-docs` MCP

CLI pages live at `/cli/<command>-command` (`/cli/sync-command`, `/cli/chat-command`, `/cli/logs-command`, `/cli/env-command`, `/cli/persona-command`, `/cli/skills-command`, `/cli/webhooks-command`, `/cli/jobs-command`, `/cli/triggers-command`, `/cli/integrations-command`, `/cli/mcp-command`, `/cli/workflows-command`, `/cli/version-command`, `/cli/git-command`, `/cli/source-command`, `/cli/devices-command`, `/cli/voice-command`, `/cli/marketplace-command`, `/cli/features-command`, `/cli/resources-command`, `/cli/channels-command`, `/cli/production-command`, `/cli/preprocessors-command`, `/cli/postprocessors-command`); `init/compile/test/push/deploy` are on `/cli/skill-management`; `auth` on `/cli/authentication`; `status/agents/models/update/telemetry/governance` on `/cli/utility-commands`; `/cli/non-interactive-mode`, `/cli/debugging`, `/cli/troubleshooting`. SDK: `/api/luaagent`, `/api/luaskill`, `/api/luatool`, `/api/luawebhook`, `/api/luatrigger`, `/api/luajob`, `/api/preprocessor`, `/api/postprocessor`, `/api/luamcpserver`, `/api/device-definition`, `/api/voice`, `/api/user`, `/api/data`, `/api/products`, `/api/baskets`, `/api/orders`, `/api/jobs`, `/api/ai`, `/api/agents`, `/api/integrations`, `/api/channels`, `/api/inbox`, `/api/templates`, `/api/cdn`, `/api/lua`, `/api/environment`, `/api/query`. Workflows: `/workflows/quick-start`, `/workflows/authoring`, `/workflows/job-tier`, `/workflows/connections`, `/workflows/runs-and-events`, `/workflows/from-chat`, `/overview/workflows`. Concepts: `/overview/<agent|persona|skill|tools|webhooks|jobs|preprocessors|postprocessors|mcp-servers|devices|resources|features|channels|model-selection|spaces>`. Channels: `/channels/<whatsapp|facebook-messenger|instagram|slack|teams|email|website-widget|http-api|proactive-messaging|channel-capabilities>`. Marketplace: `/marketplace/<overview|agent-templates|publishing-templates|template-manifest|deploying-templates|creator-guide|installer-guide>`. Devices: `/devices/*`. Getting started: `/getting-started/quick-start`. Changelog: `/changelog`. The docs MCP tool `mcp__plugin_lua-agent-builder_lua-docs__query_docs_filesystem_lua_cli` reads these as `/<path>.mdx` (e.g. `head -200 /cli/workflows-command.mdx`).

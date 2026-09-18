# Lua Agent Builder — User Guide

A complete walkthrough of the [`lua-agent-builder`](https://github.com/lua-ai-global/claude-code-lua-plugin) Claude Code plugin — what it does, how to install it, the canonical build loops (tools, integrations, workflows, templates), the safety model, and what to do when things go wrong.

The plugin wraps **lua-cli 3.33.0**, the TypeScript SDK/CLI for the Lua agent platform. It has nothing to do with the Lua programming language. Everything in this guide (command shapes, SDK types, API routes) was verified against the lua-cli and lua-api source, not only the public docs.

If you just want to start: [Installation](#installation) → [Your first agent](#your-first-agent).

---

## Table of contents

1. [What this plugin is](#what-this-plugin-is)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Authentication](#authentication)
5. [Your first agent](#your-first-agent)
6. [Building a workflow](#building-a-workflow)
7. [Slash commands reference](#slash-commands-reference)
8. [Subagents reference](#subagents-reference)
9. [Knowledge base](#knowledge-base)
10. [Hooks — what runs automatically](#hooks--what-runs-automatically)
11. [MCP servers — what Claude can call directly](#mcp-servers--what-claude-can-call-directly)
12. [Common workflows](#common-workflows)
13. [Safety model](#safety-model)
14. [Troubleshooting](#troubleshooting)
15. [FAQ](#faq)

---

## What this plugin is

`lua-agent-builder` lets you build, test and ship Lua agents by talking to Claude instead of memorising CLI flags:

- **Slash commands** wrap every `lua` command you need (`/lua-init`, `/lua-new`, `/lua-test`, `/lua-workflow`, `/lua-push`, `/lua-deploy`, `/lua-status`, …), collect the inputs up-front in one prompt, and surface errors with the CLI's typed exit codes explained.
- **Subagents** do the heavy lifting in their own context with restricted tools: the architect plans, the skill-builder scaffolds and tests any primitive (including workflows, triggers, devices and voices), the debug agent diagnoses failures, the deploy pilot runs the gated ship sequence, the QA agent runs conversational and offline-workflow suites.
- **A knowledge base** (`lib/knowledge/`) gives those agents the exact SDK shapes, workflow builder, CLI matrix, integration patterns and decision trees — checked against lua-cli 3.33.0 source.
- **Hooks** probe your environment, inject the current agent into Claude's context, and gate every production-affecting verb.
- **Two MCP servers**: a local read-only platform server (what's deployed, versions, logs) and the public docs MCP.

---

## Prerequisites

| Requirement | Why | How |
|---|---|---|
| **Node.js ≥ 18** | hooks and the MCP server are Node ESM | macOS `brew install node@20` · Windows `winget install OpenJS.NodeJS.LTS` · Linux NodeSource / `nvm install 20` |
| **lua-cli ≥ 3.33.0** | the command shapes the plugin emits | `npm install -g lua-cli` (or `/lua-update`) |
| **Claude Code** | the host | https://claude.com/claude-code |
| **A Lua account** | to talk to `api.heylua.ai` | https://admin.heylua.ai — `/lua-auth` guides the login |

`/lua-doctor` checks all of these and offers consent-gated fixes. Platforms: macOS 14+, Ubuntu 22.04+, Windows 11; CI runs the suite on all three with Node 18 and 20.

Two platform features the 1.3.0 knowledge base describes are ahead of the published CLI: **per-step model classes** (`taskClass`, `model: 'class/fast|balanced|strong'`, `requires`, `effort`, `lua models list --workflows`, `lua workflows policy models`, `lua push workflow --apply-effort`, `clear-gate`, `recompose`) and the **workflow autonomy envelope** (`lua workflows policy autonomy`, the `Consent: auto (policy)` line). They need a lua-cli newer than 3.35.0 — unreleased as of 2026-09-18 (npm latest is 3.35.0); the knowledge files mark them ⏳ and were read from the lua-cli source on `main` / `feat/workflow-autonomy`, so the slashes tell you when your CLI predates a verb (exit 2) instead of guessing.

---

## Installation

```
/plugin marketplace add lua-ai-global/claude-code-lua-plugin
/plugin install lua-agent-builder@claude-code-lua-plugin
/reload-plugins
/lua-doctor
```

If `/lua-doctor` isn't recognised after `/reload-plugins`, start a fresh `claude` session. The doctor runs five steps — Node, package manager, lua-cli version, authentication (`lua models list --json --ci`, a 1–2 s authenticated call), and the permission-rule merge into your project's `.claude/settings.json` (Claude Code ignores a plugin's own `permissions` block, so the plugin asks once to merge `lib/permissions-template.json`; accept it or every safe `lua` call will prompt).

---

## Authentication

lua-cli resolves credentials in this order, and the plugin's MCP server does the same:

1. `LUA_API_KEY` in your environment (a `.env` in the project counts — lua-cli loads it first).
2. The **renewable session** written by `lua auth configure` with email + one-time code to `~/.lua-cli/sessions/` — the default login since lua-cli 3.29.
3. `~/.lua-cli/credentials` — a plain API key, written when you pick the API-key option of `lua auth configure`.

`/lua-auth` keeps whatever already works. For a new login it sends you to your own terminal:

```bash
lua auth configure
```

Choose the email option; the CLI handles the code, then you pick an organization, the exact agents and a role. Nothing about the login passes through the Claude conversation, and the plugin denies `lua auth configure`, `lua auth key` and `lua auth logout` for the model. `lua auth sessions` lists signed-in devices; `lua auth logout --all` signs out everywhere.

---

## Your first agent

```bash
mkdir -p ~/agents/weather-news && cd ~/agents/weather-news && claude
```

**1. Plan** — `/lua-architect I want an assistant that fetches the weather for my city and reads the morning headlines`. The architect reads the knowledge base and returns a plan: persona, model (from the live catalog — the platform default is `alibaba/qwen3.8-flash`), a `weather` skill with two tools, custom HTTP for the APIs, build order, and a next-step menu.

**2. Scaffold** — `/lua-init`. It probes auth (auto-running `/lua-auth` if needed), lists your orgs, fetches the model catalog with `lua models list --json`, and runs `lua init --ci --agent-name … --org-id … [--model …] [--with-examples] --force`. You get `src/index.ts` (the `LuaAgent`), the CLI-managed `lua.skill.yaml`, and with examples the canonical `examples/` folder including workflow samples. A typed personal key cannot create agents (exit 10) — the slash offers the "bind to an existing agent" path instead.

**3. First tool** — `/lua-new tool get_weather`. The skill-builder subagent writes `src/skills/tools/GetWeatherTool.ts` (a class `implements LuaTool` with a Zod `inputSchema`), creates or picks the skill, **registers it in `src/index.ts`** (unregistered primitives are never compiled), runs `lua compile --ci`, then `lua test --ci skill --name get_weather --input '{"city":"London"}'` (for `skill` tests `--name` is the **tool** name and `--input` is the tool's own fields).

**4. Secrets** — in your terminal: `lua env sandbox -k WEATHER_API_KEY -v <key>` (writes `.env`) and `lua env production -k WEATHER_API_KEY -v <key>`. The tool reads `env('WEATHER_API_KEY')`.

**5. Test** — `/lua-test` picks the type (`skill`, `webhook`, `job`, `preprocessor`, `postprocessor`, `workflow`) and name from `dist-v2/manifest.json`. A failure is handed to the debug subagent automatically.

**6. Chat** — `/lua-chat` → sandbox (which pushes your local skills to the sandbox first), your message, a fresh thread (`lua chat --ci -e sandbox -m … -t`). ⚠ lua-cli 3.33.0 uploads the **whole environment of the shell Claude Code runs in** with those sandbox skill versions, and the runtime never reads it — start Claude Code from a clean shell (`env -i …`) when your shell holds secrets; see the plugin's SECURITY.md.

**7. QA** — `/lua-qa` runs 8–15 conversations on an isolated thread each, offline scenarios for every workflow, scans logs for `subType === 'error'`, and writes a triage report with a fix path per finding.

**8. Ship** — `/lua-deploy`: pick what goes live (`skill`, `webhook`, `trigger`, `job`, `preprocessor`, `postprocessor`, `persona`, `workflow`, `mcp`, `device`, `device-trigger`, `voice`, `agent-version`, `all`), the name and version, confirm once. The deploy pilot then runs: `git status` clean → `lua compile --ci` → `lua status --json` (abort if the server is ahead) → `lua push … --ci --force` → the prefixed production verb (`LUA_DEPLOY_CONFIRMED=1 lua deploy …`, `… lua workflows deploy <n> -v latest`, `… lua mcp activate <n>`, or `lua version create` + `… lua version promote N`) → a log scan and `get_deployment_status`. It reports the rollback command. On an agent that has agent versions, skills ship as `lua version create` + `promote` rather than `lua deploy skill`: that verb goes live at once but leaves the active version's snapshot stale, and the next promote (a rollback included) would silently revert it; webhooks, jobs, processors, triggers and workflows get a server-side scoped promote and are fine either way. The persona is live the moment `lua push agent` (or `lua push all`) runs — there is no staged persona; `lua deploy persona <n>` is its rollback.

---

## Building a workflow

Workflows are durable multi-step graphs with approvals, signals, fan-out, retries, budgets, schedules and Job-tier code. The knowledge file `lib/knowledge/workflows.md` is the reference; the loop is:

1. `/lua-new workflow reply-approval` — the builder writes `src/workflows/reply-approval.ts` (`createWorkflow({...}).then(step).agentStep(...).approval(...).commit()`), registers it in `LuaAgent.workflows`, compiles, and runs an offline scenario.
2. `/lua-workflow run reply-approval --input @in.json --approve reviewDrafts` — the local driver (no platform call) with scripted approvals, denials, signals and `--step-output` values for each predicate branch.
3. `/lua-push workflow` — a server version (not live). Missing `env.template()` keys are refused at push.
4. `/lua-deploy` → target `workflow` — `LUA_DEPLOY_CONFIRMED=1 lua workflows deploy reply-approval -v latest`, plus `activate` if it has a schedule.
5. `/lua-workflow start reply-approval --input @in.json` (one confirmation) → `/lua-workflow status <runId>` → `/lua-workflow approve <runId> <wfa_…>` / `signal` / `resume` / `cancel`.
6. ⏳ **A model per step** (lua-cli > 3.35.0): give each `agentStep` a `taskClass` (`classify extract transform draft research reason code judge`) and `model: 'class/fast' | 'class/balanced' | 'class/strong'` — the platform resolves the class through your organization's policy (`/lua-workflow policy models get`; an admin sets `maxClass`, `classMap`, `allow`, `pins`, `fallback`, `consent-actions`), `requires: ['structured']` when the step has an `outputSchema`, and an `effort` that is recorded but only applied once you push with `--apply-effort`. `/lua-workflow models` shows the catalog as a step sees it (class, best for, speed, cost). A step whose class cannot be served parks instead of failing — `/lua-workflow clear-gate <runId>` once the policy is fixed.
7. ⏳ **Will it start without asking?** A run the agent composes or starts from chat above 15 steps · 20 credits · 1 h parks `gated` until someone consents from the desktop (`status` exits 6 under `--strict`). An organization can pre-consent to a bounded envelope — `/lua-workflow policy autonomy get` shows it; an admin sets it with `lua workflows policy autonomy set --enabled on --max-credits <n> --max-steps <n> --max-duration <seconds> --max-actions <n> --max-runs-per-hour <n> --forms graph,static` (the plugin asks before that org-wide write). Such a start shows `Consent: auto (policy) — ≤ …` on `status`. Goal runs and batch starts always ask; a refusal (`askAboveThresholds: false`) is never turned into an auto-start.

Chat-composed workflows can't be deployed from the CLI (`WORKFLOW_DYNAMIC`); `/lua-workflow export <name>` brings one into source, and ⏳ `/lua-workflow recompose <name>` rewrites its task classes into `class/<c>` as a new version.

---

## Slash commands reference

20 slash commands; each asks at most one question (`x-lua-multi-step: true` marks `/lua-doctor`, `/lua-auth`, `/lua-init`).

| Slash | Wraps | Notes |
|---|---|---|
| `/lua-doctor` | node/npm/lua probes, permission merge | 5 steps, consent per fix |
| `/lua-auth` | `lua models list --json --ci` probe, then `lua agents --json --ci` listing | login in your terminal |
| `/lua-update` | `npm install -g lua-cli@latest` | |
| `/lua-docs <topic>` | `lua-docs` MCP, WebFetch fallback | knowledge files first |
| `/lua-status` | `lua status --json --ci` | auth, project, per-primitive sync diffs, orphans, hints |
| `/lua-init` | `lua init --ci …` | new / existing / duplicate agent; model from `lua models list --json` |
| `/lua-architect <goal>` | subagent | plan + next-step menu |
| `/lua-new <type> [name]` | subagent → `lua compile`, `lua test` | 13 primitive types (incl. `workflow-script`) |
| `/lua-test [type]` | `lua test --ci <type> --name … --input …` | failures → debug subagent |
| `/lua-workflow <verb>` | `lua workflows …`, `lua test workflow` | read-only verbs run at once (⏳ incl. `policy models\|autonomy get`, `models`); start/approve/signal/resume/cancel (⏳ `clear-gate`, `policy … set`, `recompose`) confirm once; deploy → `/lua-deploy` |
| `/lua-chat` | `lua chat --ci -e … -m … -t` | always an explicit thread |
| `/lua-logs` | `lua logs --ci --type … --json` | real `--type` list (`mastra` is not valid) |
| `/lua-env` | `lua env <sandbox\|production> --list \| -k KEY -v VALUE \| -k KEY --delete` | environment + key + value collected once; the Bash prompt is the confirmation; the value is never echoed, listings show masked values |
| `/lua-integrations` | `lua integrations available\|list\|info\|webhooks …\|mcp …` | read-only verbs run at once; disconnect/convert/webhooks/mcp mutations confirm once via the Bash prompt; `connect`/`update` (browser OAuth) are printed for your terminal |
| `/lua-sync` | `lua status --json`, `lua sync --check`, `--pull`, `--push` | `--push` sends agent config only |
| `/lua-push` | `lua push <type> --ci --force …` | all 14 push types; stage-all with `all` |
| `/lua-deploy` | subagent → prefixed production verb | every live path incl. rollback |
| `/lua-version` | `lua version list/show/diff/status/create` | promote → `/lua-deploy` |
| `/lua-template` | `lua marketplace template …` | publish/apply are prefixed |
| `/lua-qa` | subagent | triage report |

---

## Subagents reference

| Subagent | Used by | Tools |
|---|---|---|
| `lua-architect` | `/lua-architect` | Read, Glob, Grep, Bash (read-only lua verbs), WebFetch, platform MCP (list/get agent, deployment status), docs MCP |
| `lua-skill-builder` | `/lua-new` | Read, Write, Edit, Glob, Grep, Bash (`lua compile`, `lua test`, `lua sync --check`, `lua voice list`), WebFetch, docs MCP |
| `lua-debug` | `/lua-test` failures | Read, Edit, Grep, Glob, Bash (compile/test/status/logs, git log/diff), WebFetch, docs MCP |
| `lua-deploy-pilot` | `/lua-deploy` | Read, Bash (compile, status, push, the prefixed production verbs, logs, git), platform MCP (deployment status, versions) |
| `lua-qa` | `/lua-qa` | Read, Grep, Glob, Bash (chat, status, logs, offline workflow tests), platform MCP (get agent, tail logs, deployment status) |

Subagents never ask questions; the slash that spawned them already collected the user's authorisation.

---

## Knowledge base

`plugins/lua-agent-builder/lib/knowledge/`:

- `primitives.md` — every SDK primitive (`LuaAgent`, `LuaSkill`/`LuaTool`, `LuaWebhook`, `defineTrigger`, `LuaJob`, processors, `LuaMCPServer`, `defineDevice`/`defineDeviceTrigger`, `defineVoice`) and runtime API (`User`, `Data`, `Products/Baskets/Orders`, `Jobs`, `Workflows`, `AI`, `Agents`, `Integrations`, `Voice`, `Channels`, `Team`, `Templates`, `CDN`, `Lua`, `env`) with exact shapes and the gotcha list
- `workflows.md` — the builder, every step kind, approvals/signals, Job tier and workspaces, script form, the runtime API, all CLI verbs and exit codes, the offline test recipe, the error table
- `cli-reference.md` — global flags, exit codes, credential resolution, project layout, the full command matrix, the push/deploy matrix, agent versions, marketplace templates, the docs URL map
- `integrations.md` — Unified.to connectors, auto-provisioned MCPs, `Integrations.passthrough`, event subscriptions vs platform triggers, channels
- `decision-trees.md` — task → primitive routing, job vs workflow, webhook vs trigger, data placement, build order

---

## Hooks — what runs automatically

| Event | Hook | What it does |
|---|---|---|
| SessionStart | `check-lua-version` | warns (never blocks) if lua-cli < 3.33.0 |
| SessionStart | `detect-project` | "✓ Lua agent project detected: <agentId>" from `lua.skill.yaml` |
| SessionStart | `check-lua-auth` | probes `lua models list --json --ci` (1–2 s); exit 9 → recommends `/lua-auth`, exit 11 → API-unreachable note, timeout → "could not confirm" |
| UserPromptSubmit | `inject-context` | `[lua] agent: <id> / org: <id>` every prompt |
| PreToolUse(Bash) | `confirm-deploy` | runs on every Bash call; blocks every production-affecting verb without the `LUA_DEPLOY_CONFIRMED=1` prefix (see Safety model), including lua-cli's alias spellings (`publish`, `on`, `enable`, `submit`, `rollout`, `prod`…) and the `heylua` / `lua-ai` binaries; refuses wrappers and pipes |
| PreToolUse(Bash) | `block-auto-deploy` | blocks any `--auto-deploy` |
| PreToolUse(Bash) | `block-auth-configure` | blocks a model-run `lua auth configure` |
| PreToolUse(Bash) | `warn-version-zero` | warns on `lua push --set-version 0.x.y` that `deploy --set-version latest` picks the most recently *created* version, not the highest semver |
| PostToolUse(Bash) | `post-deploy-smoke` | after any verb that makes something live (`lua deploy`, `* deploy`, `persona production deploy`, `workflows deploy`, `version promote`, `mcp activate`): pings production on an isolated thread, scans `lua logs --json` for `subType === 'error'` |
| PostToolUse(Bash) | `post-compile-summary` | "✓ Compiled N primitive(s)" from `dist-v2/manifest.json` |

---

## MCP servers — what Claude can call directly

**`lua-platform`** (local, read-only; `mcp/lua-platform/dist/server.js`):

| Tool | Returns | Backend |
|---|---|---|
| `list_agents` | `[{ id, name, orgId, orgName, visibility }]` | `lua agents --json --ci` |
| `get_agent` | one agent | same, filtered |
| `list_primitive_versions` | `{ versions: [{ version, versionId, active, createdAt }] }` for a skill, webhook, job, trigger, preprocessor, postprocessor, workflow or the persona | `GET /developer/<plural>/:agentId(/:id/versions)`, `GET /developer/agents/:agentId/persona/versions` |
| `get_deployment_status` | the active version of every primitive of all seven families plus the persona | composed from the above |
| `tail_logs` | `{ logs, pagination }` filtered by `logSource` + `primitiveName` (≤ 100) | `GET /developer/agents/:agentId/logs` |

It resolves credentials exactly like lua-cli (env → `.env` → renewable session → credentials file) and refreshes a session token itself. `LUA_API_URL` switches environments.

**Tool names.** Claude Code exposes a plugin's MCP servers under a plugin-scoped name, so inside this plugin the tools are `mcp__plugin_lua-agent-builder_lua-platform__<tool>` and `mcp__plugin_lua-agent-builder_lua-docs__<tool>` (verified with `claude -p --plugin-dir`). The permission template pre-approves the read-only platform server and the two docs search tools under those names; `submit_feedback` still prompts. The plain `mcp__lua-platform__…` / `mcp__lua-docs__…` spellings only exist if you registered a server yourself with `claude mcp add`.

**`lua-docs`** (remote, `https://docs.heylua.ai/mcp`): `search_lua_cli`, `query_docs_filesystem_lua_cli` (`tree /`, `rg`, `head /cli/workflows-command.mdx`), `submit_feedback`.

---

## Common workflows

- **"Build me an agent"** — `/lua-architect <goal>` → say "go" → `/lua-init` → `/lua-new …` per primitive → `/lua-test` → `/lua-qa` → `/lua-deploy`.
- **"Add a tool to an existing agent"** — `cd` into the project, `/lua-new tool <name>`.
- **"Connect Linear / HubSpot / GitHub"** — `/lua-integrations info <type>` for the auth methods and scopes, then in your terminal `lua integrations connect --integration <type> --auth-method oauth --scopes all [--triggers ev1,ev2]` (a browser round-trip the plugin never runs); afterwards `/lua-integrations mcp list` / `webhooks list` confirm the MCP and subscriptions, and the agent has the integration's MCP, raw calls via `Integrations.passthrough`, and event subscriptions via `/lua-integrations webhooks create …`. Custom tools only for derived logic.
- **"Set an API key / secret"** — `/lua-env production set BILLING_API_KEY` (or `sandbox` to write `.env` for `lua test`); read it with `env('BILLING_API_KEY')` in your code. The value goes into the command only — never into the conversation.
- **"What's deployed?"** — `/lua-status` in the project, or ask Claude (it calls `get_deployment_status`).
- **"Roll back"** — `/lua-deploy` with the previous version, or target `agent-version` to promote an earlier snapshot.
- **"Package it for other orgs"** — `/lua-template create`, `/lua-template draft`, edit the `template:` section in `lua.skill.yaml`, `/lua-template publish <id>`.
- **"Run a workflow on a schedule"** — set `schedule` + `scheduleInput` on `createWorkflow`, deploy, then `/lua-deploy` target `workflow` with the note "activate".

---

## Safety model

The rules `/lua-doctor` merges (`lib/permissions-template.json`):

- **deny** — anything with `--auto-deploy`, `lua auth configure|key|logout*`, and the alternative binaries `heylua *` / `lua-ai *` wholesale (same program; the plugin only ever emits `lua`). The bare production verbs (`lua deploy`, `lua version promote`, …) are **deliberately not in `deny` or `ask`**: Claude Code evaluates those two tiers past a leading env assignment, so a `Bash(lua deploy*)` deny would also block the confirmed `LUA_DEPLOY_CONFIRMED=1 lua deploy …` form and no deploy could ever run (this is documented at code.claude.com/docs/en/permissions and was confirmed live). The bare forms are blocked by the `confirm-deploy` hook instead — see below.
- **allow** — the prefixed production verbs (`LUA_DEPLOY_CONFIRMED=1 lua deploy*`, `… lua skills|webhooks|jobs|preprocessors|postprocessors deploy*`, `… lua workflows deploy|activate*`, `… lua version promote*`, `… lua persona production deploy*`, `… lua mcp activate*`, `… lua marketplace template publish|apply*`), every read-only `lua` verb the slashes and subagents use, `lua push * --ci --force*`, `lua sync --check|--pull|--push`, `lua version create*` (a snapshot; nothing goes live until `promote`), and read-only git.
- **ask** — deletes, `lua env *`, `lua pull`, `lua chat clear`, `lua source rollback`, `lua version delete`, workflow run control (`start`, `cancel`, `approve`, `signal`, `resume`, `retry-step`, `resolve-step`, `raise-budget`, `deactivate`, `schedules`, `goals`, `export`, `archive-runs`, ⏳ `clear-gate`, `recompose`), ⏳ the org-wide policy writes `lua workflows policy models|autonomy set` (`policy … get` is allowed), `lua devices enable|disable`, `lua marketplace skill publish|unpublish|unlist|transfer`, integration connects/changes, `npm install -g lua-cli`, system installs. For the workflow run-control verbs this prompt **is** the single confirmation: `/lua-workflow` shows you the exact command in the permission prompt and does not ask a second time. `/lua-env` (`lua env *` — kept in `ask` even for `--list`, because the CLI prints masked values) and `/lua-integrations` (connect/update/disconnect/convert, webhook create/pause/resume/delete, MCP activate/deactivate) rely on the same prompt.

Precedence is deny → ask → allow. **The production gate is the `confirm-deploy` hook**: it runs on every Bash call, classifies the command with `lib/tokenizer.mjs` (every canonical spelling, every lua-cli alias — `publish`, `on`, `enable`, `submit`, `rollout`, `prod` … — and all three binaries), and blocks a bare production verb with exit 2. A hook block takes precedence over any allow rule, including a broad `Bash(lua *)` you may have in your own settings, so the gate holds even without the template. It refuses shell wrappers and pipes even with the prefix. Only the deploy pilot and `/lua-template` emit the prefix, and only after your one confirmation; the template's allow rules let that confirmed command run without a second prompt. A test (`test/lib/permissions-mirror.test.mjs`) and a lint fail if a deny/ask rule would ever shadow a confirmed form or an allow rule admit a bare one.

---

## Troubleshooting

- **"Marketplace file not found"** — `/plugin marketplace remove claude-code-lua-plugin` then add again; or delete `~/.claude/plugins/marketplaces/lua-ai-global-claude-code-lua-plugin/`.
- **MCP tools fail with "command not found"** — `mcp/lua-platform/dist/server.js` is missing from the install; it is committed in the repo — reinstall or report.
- **`MCP_AUTH_STALE`** — no credential resolved, or your session was signed out (signing out of the dashboard/app ends CLI sessions too). Run `lua auth configure` in a terminal. `LUA_API_URL` must match the environment your session was created for.
- **Permission prompts on every `lua` command** — re-run `/lua-doctor` and accept Step 5.
- **Hooks aren't firing** — start a fresh `claude` session; `claude --debug` shows every hook's stdin/stdout/exit code.
- **`lua … --ci` exits 1 with "Interactive prompt required"** — a required flag is missing; the slashes pass complete flags, so report the command.
- **Exit 9 / 10 / 11 / 12** — not authenticated / the credential's agent-or-role scope excludes this action / the Lua API is unreachable / the model provider refused (key, model, quota).
- **`/lua-deploy` aborts on "server is ahead"** — someone pushed a newer version; `/lua-sync` pull, review, retry.
- **Compile: "No skills found" or a primitive is missing from the manifest** — it isn't referenced from the `LuaAgent` arrays in `src/index.ts`.
- **Workflow push refused** — `unplaced_step`, `tool_unbundled`, `env-template-missing`, `WORKFLOW_NAME_TAKEN`; ⏳ `task-class-without-model`, `model-class-unknown` (and the other vocabulary codes), `model-class-resolution-off`; the debug subagent maps each to a fix (`lib/knowledge/workflows.md` §9).
- **A workflow run sits `gated` / exit 6** — a consent gate is a person's to clear from the desktop or the approvals inbox (`lua workflows approve` needs a `wfa_` id and cannot); ⏳ on lua-cli > 3.35.0 `status --strict` exits 6 on it (3.35.0 exits 0). A `model_policy` park (⏳) is cleared with `/lua-workflow clear-gate <runId>` once the org's model policy serves the class.
- **`lua push all` made a workflow live** — ⏳ lua-cli newer than 3.35.0 pushes and activates workflows in stage-all (`lib/knowledge/cli-reference.md` §4); push per type, or use `/lua-deploy` for workflows, when that is not what you want.

---

## FAQ

**Can I use the plugin without a Lua account?** No — every platform call needs a credential. Sign up at https://admin.heylua.ai.

**Do I need to install the plugin per project?** No; hooks only inject context when a `lua.skill.yaml` is present.

**Can Claude build an agent without me typing slashes?** Mostly: after a plan, "go" drives `/lua-init`, `/lua-new`, `/lua-test` via the Skill tool. Production changes always stop at `/lua-deploy`'s confirmation.

**Does `/lua-chat` touch my real conversations?** No — every chat the plugin sends uses an explicit `-t` thread (a lint enforces it), and so does the post-deploy smoke ping.

**Can the plugin deploy without my permission?** No. The `confirm-deploy` hook blocks every bare production verb (in every spelling lua-cli accepts), wrappers and pipes on every Bash call — a hook block wins over any allow rule, so this holds whether or not you merged the permission template. The only form that runs is the `LUA_DEPLOY_CONFIRMED=1`-prefixed command, and the deploy flow emits it only after your confirmation.

**Where does my code go?** From lua-cli to `api.heylua.ai` (and `webhook.heylua.ai`, `cdn.heylua.ai`). The MCP server talks to `api.heylua.ai` and, for a session login, to Google's token endpoint to refresh the session. Claude Code sends the conversation to Anthropic per its own policy.

**How do I update the plugin?** `/plugin marketplace update claude-code-lua-plugin` then reinstall; 1.3.0 targets lua-cli 3.33.0 (the pin) and describes the per-step model classes and workflow autonomy of the next lua-cli (> 3.35.0, unreleased as of 2026-09-18) from source.

**Where do I report bugs?** Plugin: https://github.com/lua-ai-global/claude-code-lua-plugin/issues · Security: security@heylua.ai · lua-cli: https://github.com/lua-ai-global/lua-cli/issues · Docs: https://docs.heylua.ai (and `mcp__plugin_lua-agent-builder_lua-docs__submit_feedback` for a wrong page).

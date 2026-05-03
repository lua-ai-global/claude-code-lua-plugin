# Lua Agent Builder — User Guide

A complete walkthrough of the [`lua-agent-builder`](https://github.com/lua-ai-global/claude-code-lua-plugin) Claude Code plugin — what it does, how to install it, the canonical workflows, the safety model, and what to do when things go wrong.

If you just want to install and start: jump to [Installation](#installation) and [Your first agent](#your-first-agent).

If you want to understand the whole surface before you touch anything: read straight through.

---

## Table of contents

1. [What this plugin is](#what-this-plugin-is)
2. [What it does for you](#what-it-does-for-you)
3. [Prerequisites](#prerequisites)
4. [Installation](#installation)
5. [Authentication](#authentication)
6. [Your first agent](#your-first-agent) — end-to-end walkthrough
7. [Slash commands reference](#slash-commands-reference)
8. [Subagents reference](#subagents-reference)
9. [Hooks — what runs automatically](#hooks--what-runs-automatically)
10. [MCP tools — what Claude can call directly](#mcp-tools--what-claude-can-call-directly)
11. [Common workflows](#common-workflows)
12. [Safety model](#safety-model)
13. [Troubleshooting](#troubleshooting)
14. [FAQ](#faq)
15. [Getting help](#getting-help)

---

## What this plugin is

`lua-agent-builder` is a [Claude Code](https://code.claude.com) plugin that wraps the `lua-cli` developer toolchain so you can build, test, and deploy [Lua AI agents](https://heylua.ai) by talking to Claude — instead of memorising CLI flags.

Two ways to think about it:

- **The CLI guide layer**: every `lua` command becomes accessible via a `/lua-*` slash command that knows the right flags, prompts you for missing inputs, and surfaces errors in a friendlier shape than the raw CLI.
- **The agent collaborator**: 5 specialised subagents (architect, skill-builder, debug, deploy-pilot, qa) handle the heavyweight tasks — designing an agent's architecture, scaffolding new primitives, diagnosing compile/runtime failures, gating production deploys, running conversational QA — and only ask you for input at the explicit decision points.

Plus 9 hooks that run automatically (auth-state probes, deploy-safety gates, smoke tests, context injection) and an MCP server that exposes 5 read-only platform tools so Claude can answer "what's deployed?" without you typing anything.

---

## What it does for you

Concretely, with the plugin installed you can say things like:

- *"Build me an agent that handles refund requests via Stripe webhooks"* → architect drafts a plan, you approve, build runs autonomously through to deploy.
- *"Add a tool that looks up a customer by email"* → skill-builder scaffolds, compiles, and tests it.
- *"Why is my deploy failing?"* → debug subagent re-runs with `--debug --verbose`, matches against a known catalogue, proposes the smallest fix.
- *"Deploy the latest version of the weather skill to production"* → deploy-pilot gates: dirty git? compile? drift? push? deploy with the env-prefixed `LUA_DEPLOY_CONFIRMED=1` form? smoke test logs for fresh errors? Each gate is one keystroke.
- *"Run a QA pass before I ship"* → qa subagent generates a 12-test conversational suite, runs against sandbox or production (auto-decided), writes a triage report.

And without you saying anything:

- Hooks inject *"[lua] agent: shopify_xxx / org: org_acme"* into Claude's context every prompt so the model knows which agent you're working on
- A pre-`lua deploy` hook blocks bare `lua deploy` calls (forces the explicit confirmation flow)
- A pre-`--auto-deploy` hook blocks any `lua` command with `--auto-deploy` (the production-deploy backdoor)
- A post-`lua compile` hook prints "✓ Compiled N primitives" so you don't miss compile success
- A post-`lua deploy` hook scans logs for fresh errors in the 60s after deploy

---

## Prerequisites

Before installing the plugin you need:

| Requirement | Why | How to install |
|---|---|---|
| **Node.js ≥ 18** | The plugin's hooks and MCP server are Node ESM | macOS: `brew install node@20` · Windows: `winget install OpenJS.NodeJS.LTS` · Linux: NodeSource APT or `nvm install 20` |
| **lua-cli ≥ 3.12.3** | Every slash wraps a `lua` command | `npm install -g lua-cli` |
| **Claude Code** | The plugin host | https://claude.com/claude-code |
| **A Lua account + API key** | To talk to `api.heylua.ai` | Sign up at https://admin.heylua.ai (or the plugin's `/lua-auth` will walk you through email + OTP) |

The plugin's `/lua-doctor` slash will check all of these (Node, npm/pnpm, lua-cli, auth, permission rules) and offer to install or fix anything missing — see [Installation](#installation) for the canonical first-run sequence.

**Platforms supported**: macOS 14+, Ubuntu 22.04+, Windows 11 (with Git Bash or WSL). The plugin's CI runs the test suite across all three on Node 18 and 20.

---

## Installation

### From the official Anthropic marketplace (when available)

```
/plugin install lua-agent-builder@claude-plugins-official
/reload-plugins
```

### From the GitHub source (works today)

```
/plugin marketplace add lua-ai-global/claude-code-lua-plugin
/plugin install lua-agent-builder@claude-code-lua-plugin
/reload-plugins
```

After install you should see `lua-agent-builder` in `/plugin list` as enabled. If `/lua-doctor` isn't recognised as a command after `/reload-plugins`, exit the session (`Ctrl+D` or `/exit`) and start a fresh `claude` — hooks and slash commands always activate cleanly on a new session.

### Verify the install

```
/lua-doctor
```

This runs a 5-step diagnostic:

1. **Node ≥ 18** — probes `node --version`. Offers to install if missing.
2. **Package manager** — probes `npm`, falls back to `pnpm`. Offers to install via `corepack enable`.
3. **lua-cli ≥ 3.12.3** — probes `lua --version`. Offers `npm install -g lua-cli` if missing or `/lua-update` if too old.
4. **Authentication** — probes `lua agents --json --ci`. If it fails, kicks off the OTP flow inline (see [Authentication](#authentication)).
5. **Permission rules** — reads the plugin's `lib/permissions-template.json` (29 allow/ask/deny rules) and offers to merge them into your project's `.claude/settings.json`. **Accept this merge** — it's what stops every `lua` invocation from triggering a permission prompt.

All 5 steps green = you're ready.

---

## Authentication

You need a Lua API key. Two options:

### Option A — `/lua-auth` (single-purpose, fastest)

```
/lua-auth
```

Pick one of:

- **Email + OTP**: enter your email → check your inbox → enter the 6-digit code → done. The OTP is verified server-side and an API key is generated and stored at `~/.lua-cli/credentials` (mode 0600, owner-readable only).
- **Paste API key**: paste a key from [admin.heylua.ai](https://admin.heylua.ai). Stored at the same path.

Once stored, every `lua-*` slash and the MCP server pick it up automatically. You can re-run `/lua-auth` any time to switch accounts.

### Option B — `/lua-doctor` Step 4

`/lua-doctor` runs the same OTP flow as part of the full diagnostic. Use this if you want to validate the whole environment (Node, lua-cli, permissions) at the same time as auth.

### Option C — manual

Set `LUA_API_KEY` in your shell environment, or create `.env` in your project with `LUA_API_KEY=lk_…`. Both are detected by the plugin's credential resolver. Useful for CI/CD.

### What's NEVER done

The plugin never uses `lua auth key --force` to read the stored key — that command prints the raw API key to stdout, which would land in the Claude conversation transcript. The auth-state probe used everywhere is `lua agents --json --ci` (returns metadata, not credentials). This is enforced by `lib/permissions-template.json`'s deny rule on `lua auth key*`.

---

## Your first agent

End-to-end walkthrough. Pick a throwaway directory:

```bash
mkdir -p /tmp/my-first-agent && cd /tmp/my-first-agent
claude
```

In the Claude session:

### 1. Plan the agent

```
/lua-architect I want a personal assistant that fetches the weather for my city and reads the morning news headlines
```

The architect reads its 3 knowledge files (primitives, integrations, decision-trees), then produces a structured plan: persona, model recommendation, primitives needed (likely 1 skill with 2 tools), integration approach (custom HTTP for OpenWeatherMap and a news API), build order, trade-offs.

The plan ends with a "Next steps" menu — slash commands to run, in order.

### 2. Scaffold the project

```
/lua-init
```

If you're not authenticated yet, the slash auto-invokes `/lua-auth` first (see [Phase 0 in the slash markdown](../plugins/lua-agent-builder/commands/lua-init.md)).

Then it asks (in one prompt):

- Agent name (free-text)
- Organization (existing org from your account, or "Create new")
- Model (`openai/gpt-4o-mini` is a good default for this kind of agent)
- Include example skills? (Yes for first-time use)

It runs `lua init --ci` with your inputs. You now have a `lua.skill.yaml` and a `src/` directory.

### 3. Build the first tool

```
/lua-new tool get_weather
```

The slash spawns the `lua-skill-builder` subagent via the Agent tool. The subagent:

1. Reads `lua.skill.yaml` to understand naming conventions
2. Locates the right `src/skills/` subdirectory
3. Scaffolds `src/skills/<skill-name>/tools/get_weather.ts` with a Zod input schema and a `LuaTool` class
4. Asks for any external API key it needs (OpenWeatherMap)
5. Implements `execute()` with a `fetch()` call to the weather API
6. Runs `lua compile --ci` in a loop until it passes (max 3 attempts)
7. Runs `lua test --ci skill --name <parent-skill> --input '<sample-json>'` to verify

If compile fails, it returns to the parent agent with a clear error. You can `/lua-test` (which auto-invokes `/lua-debug` on failure) to dig in.

### 4. Add the API key

The new tool reads `env('OPENWEATHER_API_KEY')`. Set it via lua-cli:

```bash
lua env --key OPENWEATHER_API_KEY --value <your-key>
```

(You run this in your terminal — env vars are user-scoped credentials, the plugin doesn't touch them.)

### 5. Test the tool

```
/lua-test
```

Pick `skill`, name it `weather` (or whatever the parent skill was named), and provide an input like `{"city": "London"}`. The slash runs `lua test --ci skill --name weather --input '{"city": "London"}'` and surfaces the response.

If the test fails, the slash auto-invokes `/lua-debug` with the failure output. The debug agent re-runs with `--debug --verbose`, matches the error against an inline catalogue, proposes a minimal fix via Edit, and re-tests.

### 6. Add the second tool

```
/lua-new tool get_news
```

Same flow as before. Set `NEWS_API_KEY` via `lua env`. Test it.

### 7. Chat with the agent

```
/lua-chat
```

Pick environment (sandbox), type a message ("What's the weather in London?"), pick "New thread" (creates a fresh thread — the slash uses `lua chat -t` correctly so this doesn't pollute your default thread).

### 8. QA pass

```
/lua-qa
```

The QA subagent:

1. Decides sandbox vs production via `lua sync --check` (zero exit = clean = production; non-zero = drift = sandbox)
2. Derives a 8-15 test conversational suite from the agent's surface (tools, persona, schemas)
3. Runs each test as `lua chat --ci -e <env> -m '<msg>' -t qa-<id>-<ts>` (isolated threads — won't pollute your real conversations)
4. Scans logs for `subType === 'error'` entries during the test window
5. Writes a triage report routing each finding to the right subagent (skill-builder, debug, deploy-pilot)

You read the report; if you want to apply a fix, you invoke the relevant slash. The QA agent **doesn't auto-spawn fix agents** — every fix is a deliberate decision.

### 9. Deploy

```
/lua-deploy
```

Pick type (`skill`, `webhook`, or `all` for everything), name (the specific primitive), version (`latest` or a specific number), confirm.

The slash spawns the `lua-deploy-pilot` subagent via the Agent tool. The pilot runs the **5-gate ship sequence**:

1. **`git status --short`** — abort if dirty
2. **`lua compile --ci`** — abort cleanly on error
3. **`lua sync --check`** — abort with drift report
4. **`lua push <type> --ci --force --name <n> --set-version <v>`** — informational only, you already authorised
5. **`LUA_DEPLOY_CONFIRMED=1 lua deploy <type> --ci --name <n> --set-version <v> --force`** — the env-prefixed form is the ONLY thing that satisfies both the `permissions.allow` rule and the `confirm-deploy.mjs` PreToolUse hook

After the deploy command exits successfully, the `post-deploy-smoke.mjs` PostToolUse hook fires automatically:

- Sends a `ping` message to production via `lua chat ... -t lua-plugin-smoke-<ts>` (isolated thread — won't pollute user conversations)
- Scans `lua logs --ci --type all --limit 30 --json` for `subType === 'error'` entries within the last 60 seconds
- Surfaces any errors as a warning so you can investigate before traffic flips

That's the full loop.

---

## Slash commands reference

14 slash commands. All use the §3.7 single-permission contract: each asks at most one prompt (multi-step diagnostic slashes use the documented `x-lua-multi-step: true` opt-out).

### Setup & diagnostics

| Slash | What it does |
|---|---|
| `/lua-doctor` | 5-step environment diagnostic: Node, npm/pnpm, lua-cli, auth, permission rules. Offers fixes for each. |
| `/lua-auth` | Standalone authentication: email + OTP or paste API key. Stores in `~/.lua-cli/credentials`. |
| `/lua-update` | Updates lua-cli to latest via `npm install -g lua-cli@latest`. |
| `/lua-docs <topic>` | Fetches lua-cli documentation from `docs.heylua.ai/<topic>` via WebFetch. |

### Project lifecycle

| Slash | What it does |
|---|---|
| `/lua-init` | Scaffold a new agent project. Auto-resolves missing auth (Step 0) before asking for project name/org/model. |
| `/lua-new <type> [name]` | Scaffold a new primitive (`tool`, `skill`, `webhook`, `job`, `preprocessor`, `postprocessor`, `mcp`). Spawns `lua-skill-builder` subagent. |
| `/lua-test [type]` | Test a skill/webhook/job in the sandbox. On failure, spawns `lua-debug` subagent. |
| `/lua-sync` | Detect drift between local code and server state. Resolve via pull, push, show-only, or cancel. |

### Server interaction

| Slash | What it does |
|---|---|
| `/lua-chat` | One-shot message to your agent (sandbox or production). Pick "New thread" for a fresh UUID, "Continue thread \<id\>" to extend an existing one. |
| `/lua-logs` | View recent logs with structured filters (type, name, limit). |
| `/lua-push` | Push local changes to the server. Type-aware (skill/webhook/job/etc.) with explicit branching. |
| `/lua-deploy` | Production deploy. Spawns `lua-deploy-pilot` for the 5-gate ship sequence. |

### Higher-level

| Slash | What it does |
|---|---|
| `/lua-architect <goal>` | Plan a Lua agent end-to-end from a goal description. Spawns `lua-architect` subagent which produces a structured plan. |
| `/lua-qa [scope]` | Conversational QA pass. Spawns `lua-qa` subagent which writes a triage report. |

### Composition pattern

Every slash that needs lua-cli authentication has a Step 0 preflight that auto-invokes `/lua-auth` if you're not authenticated yet — you don't need to chain commands manually. If you say "let's go" after the architect proposes a plan, `/lua-init` will resolve auth and version dependencies on its own.

---

## Subagents reference

5 specialized subagents. Each runs in its own context window with a restricted tool allowlist. Slash commands dispatch them via the Agent tool (`subagent_type: "lua-<name>"`).

| Subagent | When it's used | Restricted to |
|---|---|---|
| `lua-architect` | Planning new agents from fuzzy goals — auto-dispatched on intent match ("I want to build...") | `Read, Glob, Grep, Bash, WebFetch` + 3 read-only MCP tools (no Write, no Edit) |
| `lua-skill-builder` | Scaffolding new primitives (`/lua-new`) | `Read, Write, Edit, Glob, Grep, Bash, WebFetch, mcp__lua-platform__get_agent` |
| `lua-debug` | Diagnosing `lua compile --ci` or `lua test --ci` failures (auto-dispatched on test failure from `/lua-test`) | `Read, Edit, Grep, Bash, WebFetch` (no Write) |
| `lua-deploy-pilot` | Production deploy gates (`/lua-deploy`) | `Read, Bash, mcp__lua-platform__get_deployment_status` (no Write, no Edit) |
| `lua-qa` | Conversational QA pass (`/lua-qa`) | `Read, Grep, Bash` + 2 read-only MCP tools |

The minimal toolsets are intentional — a debug agent doesn't need Write; a deploy pilot doesn't need Edit. If a subagent's prompt asks for capability outside its allowlist (e.g., the deploy-pilot tries to "hand off to lua-debug"), it returns to the parent agent with a clear error rather than silently failing. The parent slash command can then dispatch the right next subagent.

---

## Hooks — what runs automatically

9 hooks fire on specific Claude Code events. You don't invoke them; they run as subprocesses.

### `SessionStart` — once per Claude session

| Hook | What it does |
|---|---|
| `check-lua-version` | Probes `lua --version`; warns if missing or below the pinned minimum (3.12.3). |
| `detect-project` | Checks for `lua.skill.yaml` in the user's CWD; if found, injects "✓ Lua agent project detected: \<agentId\>" into Claude's context. |
| `check-lua-auth` | Probes `lua agents --json --ci`; if lua-cli is installed but unauthenticated, recommends `/lua-auth`. |

### `UserPromptSubmit` — every prompt

| Hook | What it does |
|---|---|
| `inject-context` | Reads `lua.skill.yaml` and injects "[lua] agent: \<agentId\> / [lua] org: \<orgId\>" into Claude's context. Means the model always knows which agent you're working on. |

### `PreToolUse` (matcher: Bash) — before bash commands

| Hook | What it does |
|---|---|
| `confirm-deploy` | Fires on `lua deploy` invocations. Blocks bare `lua deploy` (must use `LUA_DEPLOY_CONFIRMED=1` prefix from the deploy-pilot subagent). |
| `block-auto-deploy` | Fires on commands containing `--auto-deploy`. Always blocks — `--auto-deploy` is never appropriate from inside Claude Code. |
| `warn-version-zero` | Fires on `lua push --set-version 0.x.y`. Soft-warns that 0.x versions don't deploy to existing 1.x stacks. |

### `PostToolUse` (matcher: Bash) — after successful bash commands

| Hook | What it does |
|---|---|
| `post-deploy-smoke` | After successful `lua deploy`: sends a `ping` to production via an isolated smoke thread, scans logs for fresh errors, surfaces any warnings. |
| `post-compile-summary` | After successful `lua compile`: reads `dist-v2/manifest.json` and prints "✓ Compiled N primitives" so you don't miss compile success. |

### What hooks DON'T do

- They never block on user input (only the `confirm-deploy` and `block-auto-deploy` paths can block tool execution, and they do it with structured errors)
- They never write to the plugin's own state
- They never make network calls except `check-lua-auth` (one `lua agents --json --ci` per session) and `post-deploy-smoke` (one `lua chat` ping + one `lua logs` query after deploy)

---

## MCP tools — what Claude can call directly

The plugin ships an MCP server at `${CLAUDE_PLUGIN_ROOT}/mcp/lua-platform/dist/server.js`. It exposes 5 read-only tools that Claude can call to answer "what's the state of my agent?" without you typing a slash.

| Tool | What it returns | Implementation |
|---|---|---|
| `mcp__lua-platform__list_agents` | All agents the authenticated user has access to: `[{id, name, orgId, orgName}]` flattened across all orgs | Shells out to `lua agents --json` |
| `mcp__lua-platform__get_agent` | One agent by ID: `{id, name, orgId, orgName}` | Same shell-out, then filters by ID |
| `mcp__lua-platform__list_primitive_versions` | Versions of one primitive: `[{version, deployed, createdAt, sourceHash}]` | Resolves name → ID via the list endpoint, then queries `/developer/<type>s/:agentId/:id/versions` |
| `mcp__lua-platform__get_deployment_status` | Composite view of every primitive's currently-deployed version | Calls list + versions endpoints across all 5 versioned types |
| `mcp__lua-platform__tail_logs` | Recent logs filtered by type/name/limit (max 100) | Calls `GET /developer/agents/:agentId/logs?primitiveType=...&primitiveName=...&limit=...` |

All 5 are **read-only** — none mutate server state. State changes happen through `lua-cli` (via slash commands), never through the MCP server.

When the model uses these tools, you'll see them in the conversation as `mcp__lua-platform__*` calls. They're auto-allowed and don't trigger permission prompts.

---

## Common workflows

### "Build me an agent"

```
/lua-architect <goal>
   → drafts the plan
"lets go"
   → Claude auto-invokes /lua-init via Skill tool (which auto-resolves auth via /lua-auth)
   → /lua-new for each tool/webhook in the plan
   → /lua-test to verify each one
   → /lua-qa for a conversational pass
   → /lua-deploy to ship
```

This is the canonical happy path. The architect's plan ends with concrete slash commands; you say "let's go" and Claude drives the build with minimal interaction (you only confirm at the AskUserQuestion prompts).

### "Add a tool to an existing agent"

```bash
cd ~/projects/my-existing-agent
claude
```

```
/lua-new tool fetch_inventory
```

The skill-builder subagent reads your existing `lua.skill.yaml`, scaffolds in the right place, builds, tests. No /lua-init needed (project already exists).

### "Test against production safely"

```
/lua-chat
```

Pick `production`, "New thread" (the slash creates a fresh UUID via `-t` so your test doesn't pollute the production conversation history), type your message.

### "Diagnose a failure"

```
/lua-test
```

When the test fails, the slash auto-invokes `lua-debug`. You don't have to manually escalate. The debug agent re-runs with `--debug --verbose` and proposes a fix.

### "Roll back a deploy"

```
/lua-deploy
```

Pick the same primitive type/name, but enter the previous version number when asked "Version?". The deploy-pilot ships that older version. (No special "rollback" mode — same flow, different version input.)

### "Run a QA suite before shipping"

```
/lua-qa
```

The QA agent decides sandbox vs production based on drift, runs 8-15 tests, writes a triage report. **Doesn't ship anything**. Read the report; if findings are minor, ship via `/lua-deploy`. If major, fix via `/lua-new` or `/lua-debug` first.

### "Check what's deployed without running commands"

Just ask Claude:

> What's deployed for the customer-support agent?

Claude calls `mcp__lua-platform__get_deployment_status` and answers from real data. No slash needed.

### "Update lua-cli when there's a new version"

```
/lua-update
```

Wraps `npm install -g lua-cli@latest`. Asks for one confirmation (`npm install -g` is destructive). Re-probes the version after install.

---

## Safety model

The plugin enforces several gates that show up at install time via `/lua-doctor` Step 5 (which merges the plugin's `lib/permissions-template.json` into your project's `.claude/settings.json`).

### `permissions.deny` — always blocked

| Pattern | Why |
|---|---|
| `Bash(lua deploy*)` | Bare `lua deploy` is denied — must use the env-prefixed `LUA_DEPLOY_CONFIRMED=1 lua deploy` form from the deploy-pilot |
| `Bash(lua * --auto-deploy*)` | The `--auto-deploy` flag is never appropriate from inside Claude Code (defeats the explicit-confirmation principle) |
| `Bash(lua push * --auto-deploy*)` | Same |
| `Bash(lua auth key*)` | This command prints the API key to stdout — leaking it into the conversation transcript |

### `permissions.ask` — prompts on every invocation

| Pattern | Why |
|---|---|
| `Bash(npm install -g lua-cli*)` | Global installs touch shared system state |
| `Bash(lua * delete*)` | Any delete of a primitive — irreversible |
| `Bash(lua sync --pull --force*)` | Force-pull overwrites local without conflict checks |
| `Bash(brew install*)`, `Bash(winget install*)`, `Bash(corepack*)` | System package installs |

### `permissions.allow` — runs without prompting

29 explicit `lua-cli` patterns covering safe read operations, the canonical `--ci`/`--force` push form, the env-prefixed deploy form, common version probes, and read-only git commands the deploy-pilot uses.

**Per Claude Code's documented precedence (deny → ask → allow), the ask rules win when they overlap with allow rules.** So `lua sync --pull --force` (matches both ask and allow) prompts the user; `lua sync --pull` (only matches allow) runs silently.

### The §3.7 single-permission contract

Every slash asks **at most one** permission interaction. Information collection (asking for an email, an OTP code, a project name) doesn't count as a permission interaction — only `AskUserQuestion` calls that gate behaviour do.

Slashes that legitimately need multi-step interaction (`/lua-doctor`, `/lua-auth`) declare `x-lua-multi-step: true` in their frontmatter — a private extension marker that the plugin's `lint-single-permission.mjs` script uses to skip those files. Claude Code itself ignores the marker (it's not a documented frontmatter field).

### What the plugin never does

- Auto-deploy to production without an explicit prompt
- Print your API key to stdout
- Run `--auto-deploy` even if the model asks
- Mutate server state via the MCP server (all 5 MCP tools are read-only)
- Make network calls to anything other than `api.heylua.ai`
- Persist any state outside `~/.lua-cli/credentials` (managed by lua-cli) and `~/.cache/lua-plugin/` (currently unused, reserved)

See [SECURITY.md](../plugins/lua-agent-builder/SECURITY.md) for the full disclosure path and scope statement.

---

## Troubleshooting

### "Marketplace file not found"

```
/plugin marketplace add lua-ai-global/claude-code-lua-plugin
  ⎿  Error: Marketplace file not found at ...
```

Most likely a stale clone. Try:

```
/plugin marketplace remove claude-code-lua-plugin
/plugin marketplace add lua-ai-global/claude-code-lua-plugin
```

If still failing, manually delete `~/.claude/plugins/marketplaces/lua-ai-global-claude-code-lua-plugin/` and retry.

### "This plugin uses a source type your Claude Code version does not support"

This error is misleading — it usually means **the marketplace was added but the install needs a `/reload-plugins`** or fresh session. Try:

```
/reload-plugins
/plugin install lua-agent-builder@claude-code-lua-plugin
```

If that doesn't work, exit and restart `claude`.

### MCP tools fail with "command not found"

The MCP server bundle (`mcp/lua-platform/dist/server.js`) didn't get included. Verify with:

```bash
ls ~/.claude/plugins/cache/lua-agent-builder/mcp/lua-platform/dist/server.js
```

If missing, the plugin's `mcp/lua-platform/dist/` wasn't committed to the public repo. Re-install or report the bug.

### Permission prompts on every `lua` command

`/lua-doctor` Step 5 didn't run, or you skipped the merge. Re-run `/lua-doctor` and accept the merge. Verify:

```bash
cat .claude/settings.json | jq '.permissions.allow | length'
```

Should return at least 25.

### Hooks aren't firing

Hooks activate on the next fresh `claude` invocation after install — `/reload-plugins` doesn't always reload hooks. Try `/exit` then `claude` in the same dir.

For deeper diagnosis, run `claude --debug` — every hook invocation shows stdin/stdout/exit-code per call.

### "Authentication failed" after running `/lua-auth`

Check that `~/.lua-cli/credentials` exists and contains a string starting with `lk_`:

```bash
cat ~/.lua-cli/credentials
```

If empty or wrong format, re-run `/lua-auth` and pick "Paste API key" instead — the OTP path may have failed silently.

### "Lua plugin loaded but you're not authenticated" appears every session

The `check-lua-auth` SessionStart hook is doing its job. Run `/lua-auth` to clear it. If you've authenticated and the message persists, the credentials file might be at a non-default path — check `LUA_CREDENTIALS_PATH` in your environment.

### `/lua-init` says "no orgs found"

Your account has no organizations yet. Pick "Create new" when the slash asks, and provide a name. The slash uses `lua init --org-name <name>` instead of `--org-id <id>` for this case.

### `/lua-deploy` aborts with "git status dirty"

The deploy-pilot's first gate. Commit or stash your uncommitted changes, then re-run `/lua-deploy`. This is intentional — production deploys should be reproducible from a known git state.

### Compile fails with "Bundling fails"

Probably an unsupported import path. The most common case: `import { LuaTool } from 'lua-cli/skill'` — `lua-cli` exports only from the root, not sub-paths. Use `import { LuaTool } from 'lua-cli'`.

The `lua-debug` subagent has the canonical error catalogue inline — `/lua-test` will auto-invoke it on failure.

### `/lua-deploy` says "drift detected"

Your local code differs from what's deployed. Run `/lua-sync`:

- **Pull** = bring local up to match server state (overwrites local — guarded by a "no recent push backup?" check)
- **Push** = update server state to match local (re-runs the deploy gates if the changes touch deployable primitives)
- **Show only** = print the drift report and stop, you decide

### Tests pass locally but fail in production

The `post-deploy-smoke` hook will surface fresh errors during the 60-second window after deploy. Run `/lua-logs --type all --limit 100` to see what's happening server-side.

If the failure is in user-facing flow, run `/lua-qa` to generate a structured triage report.

---

## FAQ

### Can I use the plugin without a Lua account?

No — every slash that talks to the platform needs an API key. Sign up at https://admin.heylua.ai (free tier available) and run `/lua-auth`.

### Do I need to install the plugin in every project directory?

No. Once installed via `/plugin install`, the plugin is enabled for every Claude Code session globally. The hooks check whether you're in a Lua project (presence of `lua.skill.yaml`) before injecting context — if you're not, they stay silent.

### Can Claude Code build an agent without me typing slash commands?

Mostly yes. After the architect proposes a plan and you say "let's go", Claude can auto-invoke `/lua-init`, `/lua-new`, `/lua-test`, etc. via the Skill tool. The exception is `/lua-deploy` — that one always asks for an explicit `Yes, deploy now` confirmation per the §3.3 deploy-safety contract. Production state should never change without your explicit ack.

### What happens to my conversation history when I run `/lua-chat`?

If you pick "New thread", a fresh UUID is generated and your message goes there. If you pick "Continue thread \<id\>", it extends the named thread. **The plugin never sends test messages to your default thread** — both `/lua-chat` and the post-deploy smoke hook always specify `-t` explicitly. That's enforced by the `lint-chat-thread-flag.mjs` lint script.

### Can the plugin deploy without my permission?

No. The §5.2 deny rule blocks bare `lua deploy`. Only the env-prefixed `LUA_DEPLOY_CONFIRMED=1 lua deploy` form is allowed, and that prefix is only emitted by the deploy-pilot subagent after you've answered `Yes, deploy now` to the `/lua-deploy` AskUserQuestion. Defense in depth: even if Claude tried to bypass the slash, the `confirm-deploy.mjs` PreToolUse hook would block any deploy without the prefix.

### Does the plugin send my code to Anthropic?

The plugin's hooks and MCP server make HTTPS calls to `api.heylua.ai` only — never to `anthropic.com` or anywhere else. Your code goes from `lua-cli` directly to `api.heylua.ai`, then to your agent's runtime in `lua-core`. Claude Code itself sends your conversation (which may include code excerpts the model is reasoning about) to Anthropic per its own data policy — that's separate from the plugin.

### How do I update the plugin?

```
/plugin marketplace update claude-code-lua-plugin
/plugin install lua-agent-builder@claude-code-lua-plugin
/reload-plugins
```

Auto-updates happen at session start if you've enabled them in your Claude Code settings. The plugin's `version` field in `marketplace.json` controls when users receive updates — currently pinned to `1.0.0`, will bump on each release.

### Can I customize the slash commands?

The slashes are markdown files at `~/.claude/plugins/cache/lua-agent-builder/commands/`. You can edit them locally, but updates will overwrite your changes. For lasting customization, fork the plugin repo and use a local marketplace pointing at your fork.

### How do I uninstall?

```
/plugin uninstall lua-agent-builder@claude-code-lua-plugin
/plugin marketplace remove claude-code-lua-plugin
```

Then optionally remove the merged permission rules from `.claude/settings.json` and the credentials file at `~/.lua-cli/credentials`.

### What happens if I have multiple Lua projects open?

Each Claude Code session is scoped to one CWD. The hooks read `lua.skill.yaml` from the user's actual command CWD (per the Claude Code hook payload's `cwd` field — bug 65 fix), so if you have two projects in two terminals, each session sees its own agent. The MCP server uses your stored API key, which is account-scoped — so `mcp__lua-platform__list_agents` returns all your accessible agents regardless of which project's CWD you're in.

### Where do I report bugs?

- Plugin bugs: [GitHub issues](https://github.com/lua-ai-global/claude-code-lua-plugin/issues)
- Security issues: email security@heylua.ai (see [SECURITY.md](../plugins/lua-agent-builder/SECURITY.md))
- `lua-cli` bugs: [lua-cli issues](https://github.com/lua-ai-global/lua-cli/issues)
- General Lua platform questions: [docs.heylua.ai](https://docs.heylua.ai)

---

## Getting help

- **Documentation hub**: [docs.heylua.ai](https://docs.heylua.ai)
- **CLI reference**: [docs.heylua.ai/cli](https://docs.heylua.ai/cli)
- **Plugin source code**: [github.com/lua-ai-global/claude-code-lua-plugin](https://github.com/lua-ai-global/claude-code-lua-plugin)
- **Anthropic Claude Code docs**: [code.claude.com/docs](https://code.claude.com/docs)
- **Support**: [support@heylua.ai](mailto:support@heylua.ai)

The plugin's structural lints (`scripts/lint-*.mjs`) double as documentation — each one's header comment explains the bug class it prevents. If you're contributing or curious about a specific design decision, those headers are a good starting point.

---
description: Push a primitive (skill/webhook/trigger/job/processor/mcp/device/device-trigger/voice/workflow/agent config/backup) or stage everything with `lua push … --ci --force`. Creates server versions; nothing goes live. Never adds --auto-deploy.
---

You are `/lua-push`. The user wants to push local changes to the server.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call (no project needed). Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe — it walks every organisation and can take 20 s or more on large accounts.

## Step 1 — collect inputs (single permission per §3.7)

If `$ARGUMENTS` includes a type, use it. Otherwise AskUserQuestion **once**:

- "What to push?" (options: `all` (stage everything), `skill`, `webhook`, `trigger`, `job`, `preprocessor`, `postprocessor`, `workflow`, `mcp`, `device`, `device-trigger`, `voice`, `agent` (persona/model/settings), `backup`)
- "Specific name? (leave blank for every one of that type)" (free-text, optional)
- "Set version? (x.y.z; leave blank to bump the patch)" (free-text, optional — only with a name)

## Step 2 — run

Always `--ci --force`. **NEVER** `--auto-deploy` (denied at the permission layer and by the `block-auto-deploy` hook). lua-cli 3.33.0 ignores the flag for `lua push` / `lua push all` (it warns and clears it before stage-all, so not even MCP servers activate), but on a **single-primitive** push it is a silent production go-live: `mcp` activates the server, `agent` deploys the persona version, and every versioned type (`skill webhook trigger job preprocessor postprocessor device device-trigger voice workflow`) publishes the pushed version at once — that is why the plugin denies it in every form. Shapes verified against lua-cli 3.33.0:

| Type | Name | Version | Command |
|---|---|---|---|
| `all` | — | — | `Bash(lua push all --ci --force)` — stage-all: bumps every versioned primitive (not workflows), upserts MCP servers, pushes the agent config (⚠ persona and model settings go live at once — see `agent`) and the source backup |
| `backup` | — | — | `Bash(lua push backup --ci --force)` (add `--fresh` to build the manifest from disk) |
| `agent` (alias `persona`) | — | — | `Bash(lua push agent --ci --force)` — ⚠ **everything in it is live at once**: the persona is persisted as a `published` persona version and served on the next turn (lua-agents `createPersonaVersion` → `updateAgentPersona`; there is no staged persona), and model/modelSettings/batching/browser apply immediately. Say so before running it — this push *is* the persona deploy (`lua deploy persona --set-version <n>` only rolls back to an earlier version) |
| `mcp` | set / blank | — | `Bash(lua push mcp --ci --force [--name <n>])` — non-versioned upsert |
| versioned (`skill webhook trigger job preprocessor postprocessor workflow device device-trigger voice`) | set | set | `Bash(lua push <type> --ci --force --name <name> --set-version <x.y.z>)` |
| versioned | set | blank | `Bash(lua push <type> --ci --force --name <name>)` (patch bump) |
| versioned | blank | any | `Bash(lua push <type> --ci --force)` — pushes every primitive of that type with auto-bumps; ignore any version typed |

`--set-version` must be `x.y.z`; a `0.x.y` value draws the `warn-version-zero` hook. A push also attaches per-skill source so the admin Builder sees CLI edits (`--no-include-source` disables that) and refreshes the source backup.

⏳ **lua-cli > 3.35.0** (unreleased as of 2026-09-18; the installed `lua --version` tells you which case applies):
- `workflow` pushes accept `--apply-effort`: the pushed envelope is stamped `luaWorkflow: 2` and each agent step's `effort` is sent to the model from that version on — a plain push records effort and applies nothing. Add it only when `$ARGUMENTS` says `--apply-effort` or the user asks; say so in the report (`⚙️ --apply-effort: … per-step effort ENABLED` is the CLI's own notice).
- ⚠ **`lua push all` also pushes every workflow and ACTIVATES the pushed version** (main `push.ts`, PR #3024 — stage-all queues workflows for deployment with or without `--auto-deploy`; on 3.35.0 and older workflows are simply excluded). On that CLI, before running `all` in a project whose `dist-v2/manifest.json` lists workflows, tell the user in your one line that the workflow versions go **live**; if that is not wanted, push per type instead (`skill`, `webhook`, …) and leave workflows to `/lua-deploy`.

## Step 3 — report

⚠ Exit 0 is not success for `all` (or for a type push of several primitives): lua-cli 3.33.0 prints `❌ Failed to push <name>: …` per item and `⚠️  N component(s) failed to push`, then `✅ Push All Complete!`, and still exits 0 (`push.ts` ~1300-1353; validated live 2026-09-13). Scan the output for `❌ Failed to push`; if present, report the failed items as a failure (the others were pushed) — never say "✓ Pushed".

On success: "✓ Pushed `<type>:<name>` v`<version>` (server version created; not live). Next: `/lua-deploy`." — for workflows note the live path is `lua workflows deploy <name> -v latest` (the deploy slash handles it); for `agent` say plainly "persona v`<n>` and the model settings are **already live**" (rollback: `/lua-deploy` persona with the previous version); for `all` say the same about the agent config and that the primitives still need `lua deploy` / an agent version promote.

If the output contains `Model configuration cleared`, `Model settings cleared`, `Batching config cleared` or `Voices cleared` (types `all` / `agent`), say so plainly: the agent push overwrites those server fields with whatever `src/index.ts` declares, so a model chosen in the dashboard is now gone. Point at the fix: set `model` (or `modelSettings` / `batching`) on the `LuaAgent` — `lua models set --model <code>` writes it for you — and push `agent` again.

On failure surface the CLI line verbatim. Common refusals: `unplaced_step` / `tool_unbundled` / `env-template-missing` (workflows — set the env key first), `WORKFLOW_NAME_TAKEN`, exit 9 (auth), exit 10 (scope); ⏳ lua-cli > 3.35.0 workflow refusals: `model-class-unknown` / `task-class-unknown` / `model-trait-unknown` / `effort-unknown` / `model-reason-too-long` (a value outside the vocabulary, refused before anything is sent — `issues[]` names the step), `task-class-without-model` (server: a `taskClass` needs `model: 'class/fast|balanced|strong'` or an approved code), `model-class-resolution-off` (this environment has model classes off — pin a code or drop `model`). Do not retry without user input.

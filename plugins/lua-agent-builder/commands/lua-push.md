---
description: Push a primitive (skill/webhook/trigger/job/processor/mcp/device/device-trigger/voice/workflow/agent config/backup) or stage everything with `lua push … --ci --force`. Creates server versions; nothing goes live. Never adds --auto-deploy.
---

You are `/lua-push`. The user wants to push local changes to the server.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call (no project needed). Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe — it walks every organisation and can take 20 s or more on large accounts.

## Step 1 — collect inputs (single permission per §3.7)

If `$ARGUMENTS` includes a type, use it. Otherwise AskUserQuestion **once**:

- "What to push?" (options: `all` (stage everything), `skill`, `webhook`, `trigger`, `job`, `preprocessor`, `postprocessor`, `workflow`, `mcp`, `device` (⚠ live on the next turn), `device-trigger`, `voice`, `agent` (persona/model/settings), `backup`)
- "Specific name? (leave blank for every one of that type)" (free-text, optional)
- "Set version? (x.y.z; leave blank to bump the patch)" (free-text, optional — only with a name)

## Step 2 — run

Always `--ci --force`. **NEVER** `--auto-deploy` (denied at the permission layer and by the `block-auto-deploy` hook). lua-cli 3.33.0 ignores the flag for `lua push` / `lua push all` (it warns and clears it before stage-all, so not even MCP servers activate), but on a **single-primitive** push it is a silent production go-live: `mcp` activates the server, `agent` deploys the persona version, and every versioned type (`skill webhook trigger job preprocessor postprocessor device device-trigger voice workflow`) publishes the pushed version at once — that is why the plugin denies it in every form. Shapes verified against lua-cli 3.33.0:

| Type | Name | Version | Command |
|---|---|---|---|
| `all` | — | — | `Bash(lua push all --ci --force)` — stage-all: bumps every versioned primitive, upserts MCP servers, pushes the agent config (⚠ model settings go live at once — see `agent`), every registered `defineDevice` (⚠ live on the next turn — see `device`) and the source backup |
| `backup` | — | — | `Bash(lua push backup --ci --force)` (add `--fresh` to build the manifest from disk) |
| `agent` (alias `persona`) | — | — | `Bash(lua push agent --ci --force)` — ⚠ model/modelSettings/batching/browser apply **immediately**. The persona: ⏳ **lua-cli 3.44.0 or later** stages it (`Persona vN staged — NOT activated`, `push.ts` `writePersonaStagedHint`) and it goes live only through `/lua-deploy` persona; below 3.44.0 the pushed persona version is served on the next turn. Say which applies before running it |
| `mcp` | set / blank | — | `Bash(lua push mcp --ci --force [--name <n>])` — non-versioned upsert |
| `device` | set | blank | `Bash(lua push device --ci --force --name <name>)` — ⚠ a pushed `defineDevice` is **live on the agent's next turn**, published or not (devices are not part of agent versions — `lib/knowledge/devices.md` §5). This row is in the permission template's `ask` tier, so Claude Code shows the command and waits: that prompt is the confirmation, do not add one. `/lua-devices push` is the guided path |
| `device-trigger` | set | blank | `Bash(lua push device-trigger --ci --force --name <name>)` (`ask` tier too) — creates a version that does **not** run until published; publishing needs `--auto-deploy`, which the plugin never runs: print `lua push device-trigger --name <name> --auto-deploy` for the user's own terminal |
| versioned (`skill webhook trigger job preprocessor postprocessor workflow voice`) | set | set | `Bash(lua push <type> --ci --force --name <name> --set-version <x.y.z>)` |
| versioned | set | blank | `Bash(lua push <type> --ci --force --name <name>)` (patch bump) |
| versioned | blank | any | `Bash(lua push <type> --ci --force)` — pushes every primitive of that type with auto-bumps; ignore any version typed |

`--set-version` must be `x.y.z`; a `0.x.y` value draws the `warn-version-zero` hook. A push also attaches per-skill source so the admin Builder sees CLI edits (`--no-include-source` disables that) and refreshes the source backup.

⏳ **lua-cli 3.36.0 or later** (the plugin pins 3.37.0; the installed `lua --version` tells you which case applies):
- `workflow` pushes accept `--apply-effort`: the pushed envelope is stamped `luaWorkflow: 2` and each agent step's `effort` is sent to the model from that version on — a plain push records effort and applies nothing. Add it only when `$ARGUMENTS` says `--apply-effort` or the user asks; say so in the report (`⚙️ --apply-effort: … per-step effort ENABLED` is the CLI's own notice).
- `lua push all` and workflows, by CLI version: below 3.36.0 stage-all skips workflows; **3.36.0–3.43.x pushes every workflow and ACTIVATES the pushed version** (PR #3024) — on those CLIs, before running `all` in a project whose `dist-v2/manifest.json` lists workflows, say in your one line that the workflow versions go **live**, or push per type instead; ⏳ **3.44.0 or later stages them only** (PRO-2158: "nothing goes live on a push") and prints the `lua workflows deploy <n> -v <v>` line — the live path is `/lua-deploy`.

## Step 3 — report

⚠ A failed item: below lua-cli 3.44.0, `all` (and a type push of several primitives) prints `❌ Failed to push <name>: …` per item and `⚠️  N component(s) failed to push`, then `✅ Push All Complete!`, and still **exits 0**; ⏳ from 3.44.0 it exits 1 when any item failed (`push.ts` `pushAllExitCode`). Either way scan the output for `❌ Failed to push`; if present, report the failed items as a failure (the others were pushed) — never say "✓ Pushed".

On success: "✓ Pushed `<type>:<name>` v`<version>` (server version created; not live). Next: `/lua-deploy`." — for workflows note the live path is `lua workflows deploy <name> -v latest` (the deploy slash handles it); for `agent` say plainly that the model settings are **already live** and, on 3.44.0 or later, that persona v`<n>` is **staged** (`/lua-deploy` persona makes it live) — below 3.44.0 that it is already live (rollback: `/lua-deploy` persona with the previous version); for `device` say it is **live on the next turn** (rollback = push the previous code); for `device-trigger` print the user-terminal `--auto-deploy` line; for `all` add that every `defineDevice` is live and the other primitives still need `lua deploy` / an agent version promote.

If the output contains `Model configuration cleared`, `Model settings cleared`, `Batching config cleared` or `Voices cleared` (types `all` / `agent`), say so plainly: the agent push overwrites those server fields with whatever `src/index.ts` declares, so a model chosen in the dashboard is now gone. Point at the fix: set `model` (or `modelSettings` / `batching`) on the `LuaAgent` — `lua models set --model <code>` writes it for you — and push `agent` again.

On failure surface the CLI line verbatim. Common refusals: `unplaced_step` / `tool_unbundled` / `env-template-missing` (workflows — set the env key first), `WORKFLOW_NAME_TAKEN`, exit 9 (auth), exit 10 (scope); ⏳ lua-cli 3.36.0 or later workflow refusals: `model-class-unknown` / `task-class-unknown` / `model-trait-unknown` / `effort-unknown` / `model-reason-too-long` (a value outside the vocabulary, refused before anything is sent — `issues[]` names the step), `task-class-without-model` (server: a `taskClass` needs `model: 'class/fast|balanced|strong'` or an approved code), `model-class-resolution-off` (this environment has model classes off — pin a code or drop `model`). Do not retry without user input.

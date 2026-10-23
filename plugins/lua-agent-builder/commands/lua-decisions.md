---
description: The agent's named decisions (LuaDecision) — list, versions, run one with a message or JSON state (optionally on another provider or model), publish a version (rollback) or delete. Wraps `lua decisions <verb> [name] [version]`; reads and runs go at once, publish and delete confirm once.
---

You are `/lua-decisions`. The user typed `/lua-decisions $ARGUMENTS` (`[list | versions <name> | run <name> [--message <text> | --state <json>] [--provider p] [--model id] [--min-confidence n] | publish <name> <version> | delete <name>]`). Facts: `${CLAUDE_PLUGIN_ROOT}/lib/knowledge/decisions.md` (all of it — the answer types, routing, the OpenRouter model rules, the verbs, exit codes, error codes, billing) and `${CLAUDE_PLUGIN_ROOT}/lib/knowledge/cli-reference.md` §4 (the `lua decisions`, `lua push decision` and `lua logs --type decisions` rows).

A decision is an **agent** resource, so this slash needs a project directory (`lua.skill.yaml`) or `--agent-id`. ⏳ **lua-cli 3.48.0 or later** — below it `lua decisions` does not exist and exits 1; `--model` and `--provider openrouter` need **3.49.2**.

Writing a new decision is `/lua-new decision <name>` (the builder writes the `LuaDecision`, registers it in `decisions: [...]` and compiles); pushing it is `/lua-push decision`. This slash drives what is already on the server.

## Build session (`LUA_BUILD_SESSION=1`)

In a live build session (`${CLAUDE_PLUGIN_ROOT}/lib/knowledge/build-session.md`) skip Step 0 and ask in your reply instead of the question tool. `list`, `versions` and `run` run as written (`run` is a session test). `publish` and `delete` are `mcp__lua-session__request_action {agentId, command: "decisions <verb>", args, reason}`. Say in one line what is waiting in Lua Desktop and end your reply; the outcome arrives as a `<lua-action-result>` note. Never re-run the command or try another route.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call. Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe.

## Step 1 — collect what is missing (single permission per §3.7)

Parse `$ARGUMENTS`. Whatever is still missing for the chosen verb, AskUserQuestion **once**, with every question in the same call. Never ask twice, and never ask for anything the verb does not take.

- "Which verb?" (options: `list`, `versions`, `run`, `publish`, `delete` — the five `decisions.action` values; the CLI also resolves `ls`/`view`, `history`/`list-versions`, `try`/`test`, `rollback`/`deploy`, `rm`/`remove`/`del`, but always emit the canonical verb so the permission rules match)
- "Which decision?" (free-text name; required by every verb except `list`. If the user does not know it, run `list` instead and stop — that is a different, cheaper answer, not a second question)
- `run` only, in the same call: "What should it decide on?" (free-text; a plain sentence becomes `--message '<text>'`; a JSON object becomes `--state '<json>'` — never both), and optionally "Override the version's provider or model?" (`jev`, `openai`, `auto`, or a model id such as `jev-latest`, `gpt-6-luna` or an OpenRouter `vendor/model` id like `liquid/d1`; default: none, the version decides). Offer the model list from `decisions.md` §4 when the user asks what is available; never invent an id.
- `publish` only: "Which version?" (semver; if unknown, run `versions <name>` first and stop — the user picks from the list in a new turn)

## Step 2 — run (the Bash permission prompt IS the confirmation for a mutation)

`lua decisions list|versions|run` sit in the `allow` tier of the plugin's permission template (installed by `/lua-doctor`) and run at once. A `run` is a real, billed decision call (0.005 actions on Jev, 0.01 otherwise), not a configuration change, so it needs no prompt; say the price in the report, not before the call. `publish` and `delete` change what `Decisions.run` answers for every caller and sit in the `ask` tier, so Claude Code shows the exact command and waits. Do **not** add an AskUserQuestion on top of that prompt — it would prompt twice. (If the project has no `.claude/settings.json` rules yet, say so and point at `/lua-doctor` rather than running unprompted.)

Read verbs:

- list → `Bash(lua decisions list --json)` — always spell the verb: a bare `lua decisions` (which the CLI also treats as `list`) matches no rule and would prompt
- versions → `Bash(lua decisions versions <name> --json)` — also finds a deleted decision
- run → `Bash(lua decisions run <name> --message '<text>' --json)` or `… --state '<json>' --json`, plus `--provider <jev|openai|openrouter|auto>`, `--model <id>`, `--min-confidence <n>` only when the user asked for an override. A `vendor/model` id pins openrouter on its own; `--provider openrouter` without `--model` is exit 2, and a `typesafe/…` or `openai/…` id with it is refused — point the user at `--provider jev` / `openai` instead

Mutations:

- publish → `Bash(lua decisions publish <name> <version> --force)` — `--force` skips the CLI's own y/N (which cannot be answered from here); the Bash prompt is the confirmation. Say in the same turn that this makes the version current for every caller at once, that the next `lua version create` keeps it unless a newer version is pushed after, and that publishing a version of a **deleted** decision turns it back on
- delete → `Bash(lua decisions delete <name> --force)` — say in the same turn that `Decisions.run('<name>', …)` throws `decision_not_found` from then on, that the versions are kept, and that `publish` brings it back

Add `--agent-id <id>` only outside a project directory, when the user named the agent.

## Step 3 — present

`--json` goes to stdout. Read it.

- **list** → one line per decision: name, current version, source (`from code` or the dashboard), description. No decisions at all: say so and point at `/lua-new decision <name>` then `/lua-push decision`.
- **versions** → newest first, the current one marked; per version its questions (name and type), `provider`, `model` and `minConfidence`. A version with no `current` mark on any row means the decision is deleted or never made current: say which.
- **run** → one line per answer, then the metadata. Read `answers[name].type` before the value: `odds` → the probability; `choice` → the choice, its confidence and `uncertain`; `score` → the level, its confidence and `uncertain`; `refused` → say the model declined that question. Then `provider`, `model` (an OpenRouter model answers with a dated id, e.g. `liquid/d1-20260930`), `rule` (`pinned` when a provider or model was set, `fallback` when the other provider answered — name `fallback.from` and `fallback.reason`), `durationMs`, `usage.inputTokens` (0 on a cached hit), `cached`, and `decisionName`/`decisionVersion`. End with the cost in actions and the log pointer: `lua logs --type decisions` (`/lua-logs`).
- **publish** → `"<name>": <old> → <new>` and the questions added or removed. Then the next step for a code-managed decision: the next `/lua-push decision` writes a newer version, so a rollback that should stick needs the code changed too.
- **delete** → confirm the deactivation and that `lua decisions versions <name>` still lists it.
- Exit codes: `0` ok · `2` usage — an unknown decision name or version (the message names it), a missing argument, bad `--state` JSON, an empty `--message`, both `--state` and `--message`, `--provider` or `--min-confidence` out of range · `3` not found · `9` not authenticated · `10` forbidden, **including a 409 on `publish`** when another decision has taken a deleted decision's name since · `11` the API is unreachable **or a failed `run` whose error is a 503** (`decision_timeout`, `decision_unavailable`, `decision_disabled`): relay the decision error's own message, suggest `lua logs --type decisions` for the row, and do not retry on the user's behalf — the SDK never retries a decision either.
- A `run` that answers `decision_rejected` (422) is the model refusing the request itself: Jev pinned with images, an unknown or blocked OpenRouter id, state over the model's limit, or a model's own option limit. Quote the upstream message and, for a model id, point at the list in `decisions.md` §4. A `decision_invalid` (400) names the field. Neither falls back.
- Reading the log rows is `/lua-logs` with `--type decisions`; shipping them to the customer's own stack is `/lua-drains`. A decision is agent configuration, not a deploy: nothing here needs `/lua-deploy`, and `lua version promote` (which also moves decisions to what that agent version pins) stays with `/lua-deploy`.

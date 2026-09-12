---
description: Marketplace agent templates — package this agent for other organizations. Inspect (view/versions/status/health/installed), create a template record, draft the `template:` manifest, publish a version, install, or apply to installed agents. Wraps `lua marketplace template <action>`; publish and apply are production-affecting and prefixed.
---

You are `/lua-template`. The user typed `/lua-template $ARGUMENTS` (`<action> [args]`). Facts: `${CLAUDE_PLUGIN_ROOT}/lib/knowledge/cli-reference.md` §4 "Marketplace". Docs pages: `/marketplace/agent-templates`, `/marketplace/template-manifest`, `/marketplace/publishing-templates`, `/marketplace/deploying-templates` (via `/lua-docs`).

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call (no project needed). Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe — it walks every organisation and can take 20 s or more on large accounts.

## Step 1 — route by action (lua-cli 3.33.0 actions: create, draft, publish, view, versions, install, apply, status, health, installed, uninstall)

**Read-only, run immediately:**

- `view <templateId> [version]` → `Bash(lua marketplace template view --template-id <id> [--version <n>] --json)`
- `versions <templateId>` → `Bash(lua marketplace template versions --template-id <id> --json)`
- `status <templateId>` → `Bash(lua marketplace template status --template-id <id> --json)` (installs and their versions)
- `health <templateId>` → `Bash(lua marketplace template health --template-id <id> [--window-days <n>])` (fleet health)
- `installed` → `Bash(lua marketplace template installed --json)`

**Write actions need one confirmation (single permission per §3.7).** Build the exact command, then AskUserQuestion **once**: "Run `<command>`?" with `[Yes, Cancel]`:

- `create` → collect `--name <internal-id> --display-name "<Display>" [--description "<t>"] [--visibility public|private]` from `$ARGUMENTS`/the question, then `Bash(lua marketplace template create …)`.
- `draft <templateId>` → `Bash(lua marketplace template draft --template-id <id> [--source-version <n>] [--force])` — the server composes the `template:` section of `lua.skill.yaml` from the current agent (connections, personaTemplate, triggerPresets, paramsMeta incl. `showIf`, onInstall, onUninstall) and the CLI replaces the local section with the merge. Always pass `--template-id`: without it the CLI lists your templates and prompts. Review the diff it prints; the user edits the section by hand afterwards if needed.
- `install <templateId> [version]` → `Bash(lua marketplace template install --template-id <id> [--version <n>] [--env-vars K=v,…] [--allow-creator-updates] --force)` (`--force` is the CLI's own confirmation; installs onto the current agent).
- `uninstall <templateId>` → `Bash(lua marketplace template uninstall --template-id <id> --force)`.
- `publish <templateId>` → **production-affecting** (consenting installs auto-update unless `--skip-auto-apply`): confirm, then `Bash(LUA_DEPLOY_CONFIRMED=1 lua marketplace template publish --template-id <id> [--source-version <n>] [--changelog "<t>"] [--env-contract KEY=description …] [--skip-auto-apply] --yes)`. Every authored `template:` section is serialised in full on publish (an empty section clears).
- `apply <templateId> [version]` → **fleet rollout**: confirm, then `Bash(LUA_DEPLOY_CONFIRMED=1 lua marketplace template apply --template-id <id> [--version <n>] (--agents a,b,c | --file <path> | --all-installed) --force [--no-wait])`.

Never run `publish` or `apply` without the `LUA_DEPLOY_CONFIRMED=1` prefix — the bare forms are denied and blocked by the `confirm-deploy` hook.

## Template authoring checklist (verified against lua-cli 3.33.0 `src/commands/template.ts`, `src/utils/aliases.ts`)

Walk the user through these in order; each line is what the CLI actually requires.

1. **Record** — `create` needs BOTH `--name <internal-id>` and `--display-name "<Display>"` (missing either ⇒ the CLI prompts; under `--ci` that is exit 1, otherwise `Missing required options: --name and --display-name`); `--description`, `--visibility public|private` optional. Alias `new`.
2. **Manifest** — `draft --template-id <id> [--source-version <n>] [--force]`: the server composes `connections`, `personaTemplate`, `triggerPresets`, `paramsMeta`, `onInstall`, `onUninstall` from the active agent version (or `--source-version`, a positive integer) and the CLI REPLACES the local `template:` section with the merged result; `--force` replaces the authored sections wholesale instead of merging additively. Read the printed `+added / kept` diff and `⚠` annotations, then hand-edit `lua.skill.yaml`. Alias `compose`.
3. **Publish** (`publish`; aliases `submit`, `publish_version`; production-affecting) — freezes `--source-version <n>` (default: the active agent version) into a template version; `--changelog "<t>"`; `--env-contract KEY=description` is repeatable and `KEY?=description` marks a key optional — this is the contract installers must satisfy with `lua env` (`/lua-env`) before install; `--skip-auto-apply` leaves consenting installs on their current version. Whenever a `template:` section exists it is serialised IN FULL — a section left out CLEARS it on the server; clearing or narrowing a section prints a consequence diff and needs a confirmation: `--yes` answers only that prompt (headless), `--force` answers every prompt of every action. A public template lands `pending` review and auto-applies at approval; `Auto-update: …` in the output says what happened.
4. **Install** (`install`) — `--force` is mandatory (without it the CLI prints the summary and exits 2); `--version <n>`, `--env-vars K=v,…`, `--allow-creator-updates` (opt in to future auto-apply). ⚠ `--skip-env-check` is deprecated: the env-contract check is server-enforced, the flag only prints a warning — satisfy the contract with `/lua-env` instead.
5. **Fleet** (`apply`; aliases `deploy`, `fleet-apply`, `rollout`; production-affecting) — exactly one target source: `--agents a,b,c` | `--file <path, one agent id per line>` | `--all-installed`; `--version <n>` defaults to the latest published version (none published ⇒ error); `--force` is required non-interactively; `--no-wait` prints the `runId` instead of polling (polling gives up after 30 min — check `status`); the command exits non-zero with `Apply run finished with N failed target(s)` if any target fails; `--skip-env-check` deprecated as above.
6. **Observe** — `status --template-id <id> --json` (installs and their versions), `health --template-id <id> [--window-days <n>] [--json]` (`--window-days` must be a positive integer, default 7; one row per install × workflow with schedule state and run ledger; alias `fleet-health`), `versions`, `view [--version <n>]`, `installed`.

## Step 2 — present

Summarise the CLI output: template id, version numbers, auto-apply run id (`Auto-update: pushing to N consenting install(s) — run <id>`), install env contract warnings, or the `✖` line with its exit code (`10` for a server refusal reported as `http_4xx` — e.g. `draft`/`publish` on an agent with no active version: `http_400: Source agent has no active version — run lua version create + lua version promote first`, fix via `/lua-deploy` target `agent-version`; `1` refusal — e.g. a publish lint issue such as a `showIf` cycle or an undeclared connection; `9`/`10` auth/scope).

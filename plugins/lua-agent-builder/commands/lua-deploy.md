---
description: Make something live in production — a primitive version, the persona, a workflow version, an MCP activation, or an agent-version promote (also the rollback path). Single permission per §3.7; spawns the lua-deploy-pilot subagent for the gated ship sequence.
---

You are `/lua-deploy`. The user wants to change what runs in production.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call (no project needed). Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe — it walks every organisation and can take 20 s or more on large accounts. If authentication cannot be established: "Authentication failed; can't deploy. Re-run `/lua-auth` then `/lua-deploy`."

## Step 1 — collect inputs (the ONLY permission interaction)

If `$ARGUMENTS` already names a target and name/version, pre-fill them. AskUserQuestion **once** with all of:

- "What goes live?" (options: `skill`, `webhook`, `trigger`, `job`, `preprocessor`, `postprocessor`, `persona`, `workflow`, `mcp`, `device`, `device-trigger`, `voice`, `agent-version` (promote a whole-agent snapshot — also how you roll back), `all` (latest version of every deployable primitive))
- "Name?" (free-text; hidden for `persona`, `all`, `agent-version`). If `dist-v2/manifest.json` exists, pre-offer names of the matching kind.
- "Version?" (options: `latest`, or free-text `x.y.z` — an integer for `persona`, an agent version number for `agent-version`; hidden for `mcp` and `all`)
- "Notes? (optional — e.g. 'activate the workflow schedule', a version message)" (free-text)
- "Confirm production change?" (options: `Yes, go live now`, `Cancel`)

If Cancel, output "Deploy cancelled." and stop.

## Step 2 — invoke lua-deploy-pilot via the Agent tool

Use the **Agent tool** with `subagent_type: "lua-deploy-pilot"` and a prompt containing `{ target, name, version, notes }` verbatim. The pilot (`${CLAUDE_PLUGIN_ROOT}/agents/lua-deploy-pilot.md`) runs the gated sequence and never re-prompts:

1. `git status --short` — abort if dirty
2. `lua compile --ci` — abort on error (the user runs `/lua-test`, which routes the failure to the debug subagent)
3. `lua version list --json --ci` — is the agent versioned? — then `lua status --json --ci` — abort if any primitive is `behind` the server or a critical orphan exists (→ `/lua-sync`)
4. Push the version: `lua push <type> --ci --force --name <n> [--set-version <v>]` / `lua push agent` / `lua push all` / `lua push workflow …`
5. Go live with the prefixed verb the permission rules and the `confirm-deploy` hook accept:
   - `webhook trigger job preprocessor postprocessor` → `LUA_DEPLOY_CONFIRMED=1 lua deploy <type> --ci --name <n> --set-version <v|latest> --force` (the server does a scoped promote — immediate and consistent with the agent-version history)
   - `skill` / `all` on an agent **without** agent versions → `LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --name <n> --set-version <v|latest> --force` / `… lua deploy all --ci --force`
   - `skill` / `all` on an agent **with** agent versions → `lua version create --ci -m "<notes>"` then `LUA_DEPLOY_CONFIRMED=1 lua version promote <N>` — `lua deploy skill` has no scoped promote there: it goes live at once but leaves the active version's snapshot stale, and the next promote (or rollback) silently reverts it
   - `persona` → the `lua push agent` in step 4 **is** the deploy (the pushed persona version is persisted `published` and served at once; `lua version promote` never changes the served persona). A verb runs only to roll back to an earlier version: `LUA_DEPLOY_CONFIRMED=1 lua deploy persona --ci --set-version <n> --force`
   - `workflow` → `LUA_DEPLOY_CONFIRMED=1 lua workflows deploy <n> -v <v|latest>` (+ `… lua workflows activate <n>` when asked to enable its schedule/triggers). The deploy may print `  ⚠` **advisory** lines under the success line and still succeed — `job-tier-not-enabled` (an administrator must switch the Job tier on, or `start` is refused) and ⏳ lua-cli 3.37.0 or later `job-model-default` (a Job step names no `model`: it runs on the platform or org default and every model reply is billed at that model's multiplier). Report them; never treat one as a failed deploy
   - `mcp` → `LUA_DEPLOY_CONFIRMED=1 lua mcp activate <n>`
   - `device device-trigger voice agent-version` → `lua version create --ci -m "<notes>"` then `LUA_DEPLOY_CONFIRMED=1 lua version promote <N>`
6. Smoke check: `lua logs --ci --type all --limit 30 --json` scanned for `subType === 'error'`, plus `mcp__plugin_lua-agent-builder_lua-platform__get_deployment_status`; the `post-deploy-smoke` hook also pings production.

The pilot reports what was pushed, what went live, the smoke result and the exact rollback command.

## Notes

- This file MUST contain exactly one `AskUserQuestion` call per the §3.7 lint rule.
- Never run a bare deploy verb (`lua deploy`, `lua workflows deploy|activate`, `lua version promote`, `lua mcp activate`, `lua * deploy`, `lua persona production deploy`) — all are denied without the `LUA_DEPLOY_CONFIRMED=1` prefix, and the pilot is the only place that emits the prefix.
- Never include `--auto-deploy` anywhere.
- `lua push all` and `lua deploy all --force` exit 0 even when items fail or are skipped (`No versions for … skipping`) — the pilot scans their output and aborts/reports on those lines instead of trusting the exit code (cli-reference.md §4).
- ⏳ lua-cli 3.36.0 or later: `lua push all` also pushes every workflow **and activates the pushed version** (main `push.ts`, PR #3024). For targets `all` / `agent-version` the pilot's step-4 stage-all therefore makes workflow versions live on that CLI — the user confirmed a production change, so it is in scope, but the pilot must list those workflows under "what went live". `lua push workflow … --apply-effort` (per-step `effort` applied from that version on) is passed through only when `notes` asks for it. A 409 `WORKFLOW_DYNAMIC` stays a hard stop: `lua workflows recompose <name>` publishes a new version of a chat-composed definition but is not a deploy path.

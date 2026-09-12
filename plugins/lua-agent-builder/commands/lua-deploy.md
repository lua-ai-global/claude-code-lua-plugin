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
3. `lua status --json --ci` — abort if any primitive is `behind` the server or a critical orphan exists (→ `/lua-sync`)
4. Push the version: `lua push <type> --ci --force --name <n> [--set-version <v>]` / `lua push agent` / `lua push all` / `lua push workflow …`
5. Go live with the prefixed verb the permission rules and the `confirm-deploy` hook accept:
   - `skill webhook trigger job preprocessor postprocessor` → `LUA_DEPLOY_CONFIRMED=1 lua deploy <type> --ci --name <n> --set-version <v|latest> --force`
   - `persona` → `LUA_DEPLOY_CONFIRMED=1 lua deploy persona --ci --set-version <n|latest> --force`
   - `all` → `LUA_DEPLOY_CONFIRMED=1 lua deploy all --ci --force` (no name/version — `all` deploys the latest of everything)
   - `workflow` → `LUA_DEPLOY_CONFIRMED=1 lua workflows deploy <n> -v <v|latest>` (+ `… lua workflows activate <n>` when asked to enable its schedule/triggers)
   - `mcp` → `LUA_DEPLOY_CONFIRMED=1 lua mcp activate <n>`
   - `device device-trigger voice agent-version` → `lua version create --ci -m "<notes>"` then `LUA_DEPLOY_CONFIRMED=1 lua version promote <N>`
6. Smoke check: `lua logs --ci --type all --limit 30 --json` scanned for `subType === 'error'`, plus `mcp__plugin_lua-agent-builder_lua-platform__get_deployment_status`; the `post-deploy-smoke` hook also pings production.

The pilot reports what was pushed, what went live, the smoke result and the exact rollback command.

## Notes

- This file MUST contain exactly one `AskUserQuestion` call per the §3.7 lint rule.
- Never run a bare deploy verb (`lua deploy`, `lua workflows deploy|activate`, `lua version promote`, `lua mcp activate`, `lua * deploy`, `lua persona production deploy`) — all are denied without the `LUA_DEPLOY_CONFIRMED=1` prefix, and the pilot is the only place that emits the prefix.
- Never include `--auto-deploy` anywhere.

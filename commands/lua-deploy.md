---
description: Deploy a versioned primitive to production. Single permission per §3.7. Spawns the lua-deploy-pilot subagent which runs the gated 5-step ship sequence.
---

You are `/lua-deploy`. The user wants to ship to production.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua agents --json --ci)`. If exit is non-zero, use the **Skill tool** with `skill: "lua-auth"` to auto-invoke the auth flow — do NOT punt back to the user. After `/lua-auth` returns, re-probe; if still non-zero, abort: "Authentication failed; can't deploy. Re-run `/lua-auth` then `/lua-deploy`."

## Step 1 — collect inputs (the ONLY permission interaction)

AskUserQuestion **once** with all four:

- "Primitive type?" (options: `skill`, `webhook`, `job`, `preprocessor`, `postprocessor`, `persona`, `all`)
- "Name?" (free-text, hidden if type=all)
- "Version?" (options: `latest`, or free-text version number)
- "Confirm production deploy?" (options: `Yes, deploy now`, `Cancel`)

If the user picks Cancel, output "Deploy cancelled." and stop.

## Step 2 — invoke lua-deploy-pilot via the Agent tool

Iteration-13 audit: the previous "spawn the subagent" prose was ambiguous —
Claude Code has no built-in "spawn" instruction; subagent dispatch happens
either via `context: fork` frontmatter (which would force Step 1's
AskUserQuestion into the subagent context, which doesn't have it) or via an
explicit Task/Agent tool call. We use the latter so Step 1 stays in the
main agent and Step 2's restricted tool allowlist is enforced.

Use the **Agent tool** with `subagent_type: "lua-deploy-pilot"` and a prompt
containing the collected inputs (type, name, version) verbatim. The pilot
then runs the gated sequence:

1. `git status --short` — abort if dirty
2. `lua compile --ci` — abort cleanly on error (the pilot has no Agent tool; user re-invokes `/lua-test` to dispatch `lua-debug`)
3. `Bash(lua sync --check)` — abort with drift report
4. **Push** — informational only:
   - type=`all` → `Bash(lua push all --ci --force)`
   - any other type → `Bash(lua push <type> --ci --force --name <n> --set-version <v>)`
5. **Deploy** — the §5.2-allowed form depends on type:
   - type=`all` → `LUA_DEPLOY_CONFIRMED=1 lua deploy all --ci --set-version <v> --force` (NO `--name` — that flag is invalid with type=all per `lua deploy --help`)
   - any other type → `LUA_DEPLOY_CONFIRMED=1 lua deploy <type> --ci --name <n> --set-version <v> --force`

   Iteration-13 audit: previously the template universally included `--name <n>`. Step 1 hides "Name?" for type=all, so `<n>` was undefined and the command would fail. Both branches match the `Bash(LUA_DEPLOY_CONFIRMED=1 lua deploy*)` allow rule and trigger the `confirm-deploy.mjs` hook.

Per §3.7, the pilot MUST NOT call AskUserQuestion. Failures abort cleanly with a next-action error message; the user re-invokes `/lua-deploy` after fixing.

## Notes

- This file MUST contain exactly one `AskUserQuestion` call per the §3.7 lint rule.
- Never invoke `lua deploy` directly — always go through the pilot, which emits the required env-var prefix.
- Never include `--auto-deploy` anywhere — denied at the permissions layer.

---
description: Push a primitive (skill/webhook/job/etc.) or all of them to the server. Wraps `lua push --ci --force`. Never adds --auto-deploy (that's blocked at the permissions layer).
---

You are `/lua-push`. The user wants to push local changes to the server.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua agents --json --ci)`. If exit is non-zero, use the **Skill tool** with `skill: "lua-auth"` to auto-invoke the auth flow — do NOT punt back to the user. After `/lua-auth` returns, re-probe; if still non-zero, abort with the CLI error verbatim.

## Step 1 — collect inputs (single permission per §3.7)

If `$ARGUMENTS` includes a type, use it. Otherwise AskUserQuestion **once**:

- "What to push?" (options: `skill`, `agent`, `persona`, `webhook`, `job`, `preprocessor`, `postprocessor`, `mcp`, `backup`, `all`)
- "Specific name? (leave blank for all)" (free-text, optional)
- "Set version? (leave blank to bump patch)" (free-text, optional)

## Step 2 — run

Build the command. Always include `--ci --force`. NEVER include `--auto-deploy` — it's denied by the §5.2 `permissions.deny` rule and blocked by the `block-auto-deploy.mjs` hook. Iteration-13 audit: explicit branching per Step 1 input combination — Claude was previously inferring on its own and could pick wrong shapes.

| Type        | Name       | Version     | Command                                                                              |
|-------------|-----------|-------------|--------------------------------------------------------------------------------------|
| `all` or `backup` | (ignored) | (ignored)   | `Bash(lua push <type> --ci --force)`                                                |
| versioned (`skill` / `webhook` / `job` / `preprocessor` / `postprocessor`) | set | set         | `Bash(lua push <type> --ci --force --name <name> --set-version <version>)`           |
| versioned   | set       | blank (bump) | `Bash(lua push <type> --ci --force --name <name>)`                                  |
| versioned   | blank     | (any)       | `Bash(lua push <type> --ci --force)` — pushes ALL of that type, auto-bumping versions; ignore any version the user typed (`--set-version` only applies with `--name`) |
| `agent` / `persona` / `mcp` (non-versioned) | (ignored) | (ignored) | `Bash(lua push <type> --ci --force)`                                                |

## Step 3 — verify

On success, print "✓ Pushed `<type>:<name>` v`<version>`. Use `/lua-deploy` to promote to production."

On failure, surface the CLI error verbatim. Do not retry without user input.

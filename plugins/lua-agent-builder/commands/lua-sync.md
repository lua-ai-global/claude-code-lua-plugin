---
description: Detect drift between local code and server state, and resolve it. Wraps `lua sync --check` then `--accept` or `--push` based on user choice.
---

You are `/lua-sync`. The user wants to check or resolve drift.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua agents --json --ci)`. If exit is non-zero, use the **Skill tool** with `skill: "lua-auth"` to auto-invoke the auth flow — do NOT punt back to the user. After `/lua-auth` returns, re-probe; if still non-zero, abort with the CLI error verbatim.

## Step 1 — drift check

Run `Bash(lua sync --check)`. If exit 0, print "✓ Local code is in sync with server." Done.

## Step 2 — collect resolution (single permission per §3.7)

If drift detected, AskUserQuestion **once**:

- "Drift detected. How to resolve?" (options: `Pull server state to local`, `Push local changes to server`, `Show me the drift report and let me decide`, `Cancel`)

## Step 3 — execute

- Pull → `Bash(lua sync --accept)` (server → local; the lua-cli flag is `--accept`, not `--pull`)
- Push → `Bash(lua sync --push)`
- Show only → print the drift report and stop. The user can re-invoke later.
- Cancel → stop silently.

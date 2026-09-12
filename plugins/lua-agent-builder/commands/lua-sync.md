---
description: Detect drift between local code and the server and resolve it. Wraps `lua status --json`, `lua sync --check`, then `lua sync --pull` or `lua sync --push` based on the user's choice.
---

You are `/lua-sync`. The user wants to check or resolve drift.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call (no project needed). Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe — it walks every organisation and can take 20 s or more on large accounts.

## Step 1 — drift check

Run `Bash(lua status --json --ci)` and `Bash(lua sync --check)` (exit 1 = drift). Know the side effect: `lua sync --check` compiles with server reconciliation, so local primitives that the server has never seen get registered as entity records (no version, nothing goes live) — a later `lua status` lists them as "not deployed", which is expected, not drift. From the status JSON, summarise per primitive kind the `diffs[]` with `status` ∈ `ahead` (local newer — push it), `behind` (server newer — pull it), `not deployed`, and any `orphans[]` (server primitives with no local source; each carries a `cleanupCommand`). Also report `persona.status` and `backup.status`.

If `lua sync --check` exits 0 and nothing is `ahead`/`behind`: print "✓ Local code is in sync with the server." Done.

## Step 2 — collect the resolution (single permission per §3.7)

AskUserQuestion **once**:

- "Drift detected. How to resolve?" (options: `Pull server state to local (lua sync --pull)`, `Push local agent config to server (lua sync --push)`, `Show me the full report and let me decide`, `Cancel`)

## Step 3 — execute

- Pull → `Bash(lua sync --pull)`. It restores files from the server's source backup and refuses if any local file changed since the last `lua push backup`; in that case report the refusal and tell the user that `lua sync --pull --force` overwrites local changes (that form prompts for permission — it is destructive) or they can commit/stash and push first.
- Push → `Bash(lua sync --push)`. Pushes the **agent config** (persona version, name, model, governance) — it does not push primitives; for those run `/lua-push`.
- Show only → print the report and stop.
- Cancel → stop silently.

`--accept` is a legacy alias of `--pull`; use `--pull`.

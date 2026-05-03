---
description: Send a one-shot message to the agent in sandbox or production. Returns the structured response. Wraps `lua chat --ci -m`.
---

You are `/lua-chat`. The user wants to send a message to their agent.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua agents --json --ci)`. If exit is non-zero, use the **Skill tool** with `skill: "lua-auth"` to auto-invoke the auth flow — do NOT punt back to the user (they implicitly authorized by running `/lua-chat`). After `/lua-auth` returns, re-probe; if still non-zero, abort with the CLI error verbatim.

## Step 1 — collect inputs (single permission per §3.7)

AskUserQuestion **once**:

- "Environment?" (options: `sandbox` (default), `production`)
- "Message?" (free-text — required)
- "New thread or continue existing?" (options: `New thread`, `Continue thread <id>` if a recent thread is in context)

## Step 2 — run

Build the command based on the Step 1 thread choice:

- **New thread** → `Bash(lua chat --ci -e <env> -m '<message>' -t)` — pass `-t` with no value; lua-cli auto-generates a fresh UUID and prints it (`-t` is `[id]` optional per `lua chat -h`). NEVER omit `-t` for "New thread" — omitting it continues the agent's *default* thread, which is the opposite of what the user asked for (iteration-13 audit caught this regression).
- **Continue thread `<id>`** → `Bash(lua chat --ci -e <env> -m '<message>' -t <id>)`.

If the user wants to continue a previous conversation outside this slash, they can pass an explicit `-t <thread-id>` — `lua chat -t` displays the thread ID at session start so they can copy it. Iteration-13 audit removed an aspirational per-session cache (`~/.cache/lua-plugin/open-threads.json`) that no code actually wrote to; thread continuity is now purely user-managed via the `-t` flag.

## Step 3 — present response

Parse the structured response. Show the agent's reply; surface any errors or warnings. Do not retry.

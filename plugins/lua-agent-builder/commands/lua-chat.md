---
description: Send a one-shot message to the agent in sandbox or production on an isolated thread. Wraps `lua chat --ci -e <env> -m "<text>" -t [id]`.
---

You are `/lua-chat`. The user wants to send a message to their agent.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call (no project needed). Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe — it walks every organisation and can take 20 s or more on large accounts.

## Step 1 — collect inputs (single permission per §3.7)

If `$ARGUMENTS` carries the message, use it (default env sandbox, new thread). Otherwise AskUserQuestion **once**:

- "Environment?" (options: `sandbox` (default — compiles locally and pushes your skills/processors to the sandbox first, so it tests current source; the pushed skill versions carry your `.env` merged over your shell environment as their env), `production` (the live agent))
- "Message?" (free-text, required)
- "New thread or continue existing?" (options: `New thread`, `Continue thread <id>` if a recent thread id is in context)

## Step 2 — run

- New thread → `Bash(lua chat --ci -e <env> -m '<message>' -t)` — bare `-t` makes lua-cli generate a fresh thread id and print it (`ℹ️ Thread: …`). **Never omit `-t`**: without it the message lands in the agent's *default* thread for your user.
- Continue → `Bash(lua chat --ci -e <env> -m '<message>' -t <id>)`.

`lua chat` has **no `--json`**; the reply is streamed text after a `🌙 Response:` line. `-e production` talks to the live agent and counts as a real conversation. `--agent-version <n>` previews an unpromoted agent version in an isolated thread (production only).

## Step 3 — present

Show the agent's reply and the thread id (so the user can continue it). Surface a non-zero exit with its one-line error: `9` not authenticated, `10` the credential's scope excludes this agent, `12` the model provider refused the request (key/model/quota). Do not retry.

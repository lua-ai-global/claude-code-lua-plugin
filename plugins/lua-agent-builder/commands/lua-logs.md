---
description: View agent logs (skill, webhook, job, etc.) with structured JSON output. Wraps `lua logs --ci --json`.
---

You are `/lua-logs`. The user wants to view recent logs.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua agents --json --ci)`. If exit is non-zero, use the **Skill tool** with `skill: "lua-auth"` to auto-invoke the auth flow — do NOT punt back to the user. After `/lua-auth` returns, re-probe; if still non-zero, abort with the CLI error verbatim.

## Step 1 — collect filter (single permission per §3.7)

If `$ARGUMENTS` already contains a type, use it. Otherwise AskUserQuestion **once**:

- "Log type?" (options: `all`, `skill`, `webhook`, `job`, `preprocessor`, `postprocessor`, `user_message`, `agent_response`, `mcp`, `mastra`)
- "Filter to a specific name? (optional)" (free-text)
- "How many entries?" (default `50`)

## Step 2 — run

Build the command: `Bash(lua logs --ci --type <type> [--name <name>] --limit <limit> --json)`.

## Step 3 — present

Parse the JSON output. Group by level (error / warn / info). Surface errors first; offer to drill into a specific entry. Don't dump the raw JSON unless the user asks.

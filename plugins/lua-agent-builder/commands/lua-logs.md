---
description: View agent logs (skills, jobs, webhooks, triggers, processors, MCP, runtime errors, voice calls) as structured JSON. Wraps `lua logs --ci --json`.
---

You are `/lua-logs`. The user wants to view recent logs.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call (no project needed). Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe — it walks every organisation and can take 20 s or more on large accounts.

## Step 1 — collect the filter (single permission per §3.7)

If `$ARGUMENTS` already contains a type, use it. Otherwise AskUserQuestion **once**:

- "Log type?" (options: `all`, `skill`, `job`, `webhook`, `preprocessor`, `postprocessor`, `user_message`, `agent_response`, `agent_error`, `mcp`, `runtime`, `rag`, `device`, `device-trigger`, `calls`) — the values `lua logs --type` accepts in lua-cli 3.33.0 (its help text also lists `mastra`, which is rejected with exit 2; `trigger`/`workflow*` sources are only reachable via the `tail_logs` MCP tool)
- "Filter to a specific primitive name? (optional; requires a type)" (free-text)
- "How many entries? (default 50, max 100)" (free-text)

## Step 2 — run

`Bash(lua logs --ci --type <type> [--name <name>] --limit <limit> --json)`. For `calls` add `--direction inbound|outbound` / `--status <s>` if the user asked. `--user-id <id>` filters one user's logs; `--agent-id <id>` reads another agent you administer.

## Step 3 — present

`--json` prints `{ logs: LogEntry[], pagination }` (for `calls`: `{ calls[], total, page, totalPages }`). Each `LogEntry` has `timestamp`, `type` (`log`|`metric`), **`subType`** (`error` | `warn` | `info` | `debug` | `start` | `complete` — there is no `level` field), `message`, `duration?`, and `metadata` (`logSource`, `primitiveName`, `primitiveId`, `userId`, `runId`, `channel`). Group by `subType`, errors first, then by `metadata.logSource`/`primitiveName`. Offer to drill into one entry; don't dump raw JSON unless asked. `runId` on an entry is the conversation/run to correlate with `lua workflows status <runId>` when `logSource` is a workflow source.

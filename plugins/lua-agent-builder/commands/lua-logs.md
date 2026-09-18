---
description: View agent logs (skills, jobs, webhooks, triggers, processors, MCP, runtime errors, voice calls) as structured JSON. Wraps `lua logs --ci --json`.
---

You are `/lua-logs`. The user wants to view recent logs.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call (no project needed). Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe — it walks every organisation and can take 20 s or more on large accounts.

## Step 1 — collect the filter (single permission per §3.7)

If `$ARGUMENTS` already contains a type, use it. Otherwise AskUserQuestion **once**:

- "Log type?" (options: `all`, `skill`, `job`, `webhook`, `preprocessor`, `postprocessor`, `user_message`, `agent_response`, `agent_error`, `mcp`, `runtime`, `rag`, `device`, `device-trigger`, `calls`) — exactly the values `lua logs --type` accepts in lua-cli 3.33.0; anything else is exit 2, including the help text's `mastra` and the real platform sources `trigger`, `model-resolver`, `workflow-step`, `workflow-script`, `workflow`, which are reachable only via the `tail_logs` MCP tool
- "Filter to a specific primitive name? (optional; requires a type)" (free-text)
- "How many entries? (default 50, max 100)" (free-text)

## Step 2 — run

`Bash(lua logs --ci --type <type> [--name <name>] --limit <limit> --json)`. For `calls` add `--direction inbound|outbound` / `--status <s>` if the user asked. `--user-id <id>` filters one user's logs; `--agent-id <id>` reads another agent you administer.

## Step 3 — present

`--json` prints `{ logs: LogEntry[], pagination }` (for `calls`: `{ calls[], total, page, totalPages }`). Each `LogEntry` has `timestamp`, `type` (`log`|`metric`), **`subType`** (`error` | `warn` | `info` | `debug` | `start` | `complete` — there is no `level` field), `message`, `duration?`, and `metadata` (`logSource`, `primitiveName`, `primitiveId`, `toolId`, `toolName`, `userId`, `agentId`, `runId`, `channel`). There is **no `environment` field** — sandbox vs production is not recorded on a log entry. `metadata.channel === 'dev'` marks turns sent by `lua chat` (CLI traffic, in either environment — not a sandbox marker); `'pop'` is the website widget, `'web'` other web clients. A tool that throws lands under `logSource: 'skill'` with `subType: 'error'`; `agent_error` entries come only from the chat pipeline itself. Group by `subType`, errors first, then by `metadata.logSource`/`primitiveName`. Offer to drill into one entry; don't dump raw JSON unless asked. `runId` on an entry is the conversation/run to correlate with `lua workflows status <runId>` when `logSource` is a workflow source. A run's own timeline is `lua workflows logs <runId>` (`/lua-workflow logs`), which ⏳ on lua-cli 3.36.0 or later also shows the two model events — `step.model_resolved` (`model resolved → <code> (<class>)`) and `step.model_policy_warning` (`model policy warning: <outcome> …`, e.g. a pinned model the organization has excluded, warn-only today).

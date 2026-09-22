---
description: View agent logs (skills, jobs, webhooks, triggers, processors, MCP, workflows, runtime errors, voice calls) as structured JSON, over a time window and optionally followed live. Wraps `lua logs --ci --json`.
---

You are `/lua-logs`. The user wants to view recent logs.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call (no project needed). Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe — it walks every organisation and can take 20 s or more on large accounts.

## Step 1 — collect the filter (single permission per §3.7)

If `$ARGUMENTS` already contains a type or a window, use it. Otherwise AskUserQuestion **once**, with every question in the same call:

- "Log type?" (options: `all`, `calls`, or any of the **18** log sources — `skill`, `job`, `webhook`, `trigger`, `preprocessor`, `postprocessor`, `user_message`, `agent_response`, `agent_error`, `runtime`, `mcp`, `rag`, `device`, `device-trigger`, `model-resolver`, `workflow-step`, `workflow-script`, `workflow`). ⏳ **lua-cli 3.38.0 or later**: `logs.type` is derived from the canonical `AGENT_LOG_SOURCES` constant, so all eighteen are reachable. On 3.37.0 and older the alias table was hand-listed and the five platform sources (`trigger`, `model-resolver`, `workflow-step`, `workflow-script`, `workflow`) were exit 2 there — only the `tail_logs` MCP tool could read them. The help text's `mastra` is rejected in every version (exit 2). `all` = no source filter; `calls` = voice-call records, a different dataset
- "Time window? (optional)" (free-text: an ISO 8601 instant like `2026-09-21T09:00:00Z`, or a relative window `15m` / `2h` / `7d` — anything else is exit 2, and a bare number is deliberately refused because `7` is an obvious typo for `7d`)
- "Environment? (optional)" (options: `production`, `sandbox`, or leave empty for both)
- "Follow live? (optional)" (yes/no — polls every ~2 s until Ctrl-C)
- "Filter to a specific primitive name? (optional; requires a type)" (free-text)
- "How many entries? (default 20)" (free-text; the CLI does not cap it locally — the route decides the page size it will serve)

## Step 2 — run

`Bash(lua logs --ci --type <type> [--name <name>] [--since <when>] [--until <when>] [--environment production|sandbox] --limit <limit> --json)`.

⏳ **lua-cli 3.38.0 or later** for `--since` / `--until` / `--environment` / `--follow`; below it commander exits 1 on the unknown option. Use them instead of paging: `--page` walks backwards through history and a `--limit`-sized sweep reconstructs a window badly, while `--since` asks the route for exactly the window you mean.

- `--since` is **inclusive**; both bounds take an ISO 8601 instant or a relative window (`15m`, `2h`, `7d`). A **relative** bound is resolved by the **server's** clock, so a skewed laptop cannot shift the window — prefer `--since 15m` over computing a timestamp yourself.
- `--environment` filters on `metadata.environment`. A row written before that field shipped has none and reads as `production`.
- `--follow` polls (there is no streaming endpoint) every ~2 s with jitter, stops within ~3 s of Ctrl-C, and **refuses `--page`** (exit 2). It advances on the newest timestamp it has printed and de-duplicates by row id, so the boundary row comes back on every poll and is dropped — never assume `since + 1 ms`. An `--until` already in the past closes the window after the first sweep instead of hanging. In a long-running or non-interactive context prefer a bounded `--since … --until …` read over a follow that never returns.
- For `calls` add `--direction inbound|outbound` / `--status <s>` if the user asked. ⚠ `--type calls` is a different dataset and **ignores** `--since` / `--until` / `--environment` / `--follow`.
- `--user-id <id>` filters one user's logs; `--agent-id <id>` reads another agent you administer.
- Reading logs needs the `logs:read` scope (⏳ an older key's `knowledge:read` / `automations:read` / `analytics:read` is still accepted for two releases and answers `Deprecation: true` with a `Sunset` header — relay that warning rather than swallowing it).

## Step 3 — present

`--json` prints `{ logs: LogEntry[], pagination }` — and, with `--follow`, one `{ logs, nextCursor, pagination }` envelope **per poll that produced rows**, newest-first inside each envelope (the plain renderer prints oldest-first instead, so a tail reads downwards). For `calls`: `{ calls[], total, page, totalPages }`.

Each `LogEntry` has `timestamp`, `type` (`log`|`metric`), **`subType`** (`error` | `warn` | `info` | `debug` | `start` | `complete` — the field is `subType`), `message`, `duration?`, and `metadata`: `logSource`, `primitiveName`, `primitiveId`, `toolId`, `toolName`, `userId`, `agentId`, `runId`, `channel`, `model?` (the `provider/model` code that actually served the turn — on `agent_response` / `agent_error` rows only), and ⏳ the platform-side additions `orgId`, **`environment`** (`production` | `sandbox`), `agentVersion`, `executionId`, `executionSeq` (0-based order within one execution), `traceparent`, plus `truncated: true` / `droppedLines` on the synthetic row an execution emits when the runner dropped lines.

⚠ `environment` is **optional and additive**: it is absent on every row written before it shipped, and such a row reads as `production` everywhere (the drain matcher and `--environment` alike). Never infer sandbox-vs-production from `metadata.channel`: `channel === 'dev'` marks turns sent by `lua chat` (CLI traffic, in *either* environment); `'pop'` is the website widget, `'web'` other web clients.

A tool that throws lands under `logSource: 'skill'` with `subType: 'error'`; `agent_error` entries come only from the chat pipeline itself. Group by `subType`, errors first, then by `metadata.logSource`/`primitiveName`. Offer to drill into one entry; don't dump raw JSON unless asked. `runId` on an entry is the conversation/run to correlate with `lua workflows status <runId>` when `logSource` is a workflow source. A run's own timeline is `lua workflows logs <runId>` (`/lua-workflow logs`), which ⏳ on lua-cli 3.36.0 or later also shows the model events — `step.model_resolved` (`model resolved → <code> (<class>)`) and `step.model_policy_warning` (`model policy warning: <outcome> …`, e.g. a pinned model the organization has excluded, warn-only today) — and ⏳ on 3.37.0 or later the Job-model and budget events: `step.job_model_resolved` (`job model → <code> ×<multiplier> (<leg>)`, with `— uncalibrated model, fallback rate` when no calibrated rate could be quoted) and `run.budget_parked` / `run.budget_raised` / `run.budget_exceeded`, which below 3.37.0 `logs` did not print at all. The unit inside a budget line is whatever the gate chose (`actions` on a seat plan, `credits` on legacy) — repeat it verbatim.

Shipping these records to the customer's own stack (Datadog, OTLP, a receiver of their own) is a **log drain** — `/lua-drains`, and `${CLAUDE_PLUGIN_ROOT}/lib/knowledge/log-drains.md`. A drain is a copy: everything it sends stays readable here.

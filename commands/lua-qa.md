---
description: Run a conversational QA pass against the agent. Picks sandbox (if local code differs from production) or production (if in sync). Spawns the lua-qa subagent, which writes a triage report identifying issues for other subagents to fix.
---

You are `/lua-qa`. The user wants a conversational QA pass.

## Step 1 — collect optional scope (single permission per §3.7)

If `$ARGUMENTS` is empty, AskUserQuestion **once**:

- "QA scope?" (options: `Full suite (~12-15 tests)`, `Smoke only (3-5 tests)`, `Specific tool: <name>`)
- "How long can the run take?" (options: `≤2 min (small)`, `≤5 min (default)`, `≤10 min (thorough)`)

If `$ARGUMENTS` already specifies a tool name (e.g. `/lua-qa weather-tool`), skip the AskUserQuestion entirely and pass the tool to the subagent.

## Step 2 — invoke lua-qa via the Agent tool

Use the **Agent tool** with `subagent_type: "lua-qa"` and a prompt containing `{ scope, timeBudget }` verbatim. (Iteration-13 audit: explicit Task-tool invocation is the only way to actually dispatch a subagent from a slash.) The subagent:

1. Decides sandbox vs production via `Bash(lua sync --check)` (zero exit = clean = production; non-zero = drift = sandbox).
2. Derives a test plan from the agent's surface (tools, persona, fixtures).
3. Runs the conversational suite via `lua chat --ci -e <env> -m '<msg>' -t qa-<test-id>-<timestamp>` — the `-t` flag is REQUIRED so smoke tests don't pollute the agent's default thread.
4. Scans logs for errors timestamped during the test window.
5. Writes a triage report routing each finding to the right subagent.

Per §3.7, the subagent never calls AskUserQuestion. The report is the output.

## Step 3 — present the report and offer follow-up

After the subagent finishes, surface the report inline. For each finding:

- If routed to `lua-skill-builder` or `lua-debug`, **offer** to spawn that subagent to apply the fix. The user clicks once to confirm; that's their second permission interaction (a separate slash invocation, so §3.7 holds).
- If routed to `lua-deploy-pilot` (rollback), explain the situation and tell the user to run `/lua-deploy`, then pick the previously-deployed version `<prev>` when the slash asks "Version?" (free-text). Do NOT advise `/lua-deploy --set-version <prev>` — that slash collects all inputs via `AskUserQuestion` and doesn't parse `$ARGUMENTS` for flags (iteration-13 audit caught the misleading advice).
- If a finding is operational (latency, persona), describe what needs to change and stop.

Do not auto-spawn fix agents — every fix is a deliberate user decision.

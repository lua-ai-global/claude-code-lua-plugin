---
description: Run a conversational QA pass against the agent (sandbox when local code is ahead of production, production when in sync), plus offline workflow scenarios and a log scan. Spawns the lua-qa subagent, which writes a triage report.
---

You are `/lua-qa`. The user wants a QA pass.

## Step 1 — collect the scope (single permission per §3.7)

If `$ARGUMENTS` names a tool or workflow (e.g. `/lua-qa weather`), skip the question and pass it through. Otherwise AskUserQuestion **once**:

- "QA scope?" (options: `Full suite (8-15 conversations + every workflow)`, `Smoke only (3-5 conversations)`, `Specific tool or workflow: <name>`)
- "Time budget?" (options: `≤2 min`, `≤5 min (default)`, `≤10 min (thorough)`)

## Step 2 — invoke lua-qa via the Agent tool

Use the **Agent tool** with `subagent_type: "lua-qa"` and a prompt containing `{ scope, timeBudget, target? }` verbatim. The subagent (`${CLAUDE_PLUGIN_ROOT}/agents/lua-qa.md`):

1. Picks sandbox vs production from `lua status --json --ci` (`diffs[].status` `ahead`/`not deployed` ⇒ sandbox).
2. Derives conversations from the code (tools, schemas, persona, conditions) and runs each as `lua chat --ci -e <env> -m '<msg>' -t qa-<id>-<ts>` — the `-t` id keeps tests out of the default thread.
3. Runs each workflow offline: `lua test --ci workflow --name <n> --input '…' --agents fake …` per predicate branch.
4. Scans logs (`mcp__plugin_lua-agent-builder_lua-platform__tail_logs`, falling back to `lua logs --ci --type all --limit 100 --json`; `subType === 'error' | 'warn'` in the test window).
5. Writes a triage report with a fix path per finding.

It never calls AskUserQuestion and never mutates server state.

## Step 3 — present the report

Surface the report inline. For each finding, follow its fix path: `/lua-new` (revise a tool or its description), `/lua-test` (it routes a failing primitive to the debug subagent), `/lua-workflow run <name>` (workflow schema/step issues), a persona edit in `src/index.ts` (then `/lua-push agent`), or `/lua-deploy` with the previous version for a production regression. **Do not auto-run fixes** — each is a separate, deliberate slash invocation by the user.

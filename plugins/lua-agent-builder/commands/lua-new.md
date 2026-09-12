---
description: Scaffold a new Lua primitive (tool, skill, webhook, trigger, job, preprocessor, postprocessor, mcp, device, device-trigger, voice, workflow, workflow-script), register it in the LuaAgent, compile and test it. Spawns the lua-skill-builder subagent.
---

You are `/lua-new`. The user typed `/lua-new $ARGUMENTS`.

## Step 1 — parse arguments

`$ARGUMENTS` is `<type> [name]`. Type is required; name is optional.

Valid types (lua-cli 3.33.0 primitives): `tool`, `skill`, `webhook`, `trigger`, `job`, `preprocessor`, `postprocessor`, `mcp`, `device`, `device-trigger`, `voice`, `workflow`, `workflow-script`. If invalid, print: `Unknown primitive type "<type>". Valid: tool, skill, webhook, trigger, job, preprocessor, postprocessor, mcp, device, device-trigger, voice, workflow, workflow-script.` and stop.

Quick routing help if the user seems unsure (from `${CLAUDE_PLUGIN_ROOT}/lib/knowledge/decision-trees.md`): a user-invoked capability → `tool` (inside a `skill`); external event + your code → `webhook`; external event that should wake the agent / run one tool / start a workflow → `trigger`; time-based → `job`; multi-step / approvals / fan-out / long-running → `workflow` (a static graph in `src/workflows/<name>.ts`); the same but with dynamic control flow a static graph cannot express — loop until nothing new appears, spawn N agents from data, merge as you go → `workflow-script` (a plain-JS `src/workflows/<name>.workflow.script.js`, workflows.md §5; a workflow's form is fixed by its first pushed version); uniform message transforms → `preprocessor`/`postprocessor`; your own MCP server → `mcp`; hardware → `device`/`device-trigger`; phone → `voice`.

## Step 2 — collect missing inputs (single permission per §3.7)

If the name was not in `$ARGUMENTS`, AskUserQuestion **once** with everything the builder needs:

- "Name for the new <type>?" (free-text, required; kebab-case or snake_case)
- "One-line description of what it does?" (free-text)
- For `tool` only: "Which skill does it belong to?" (options: each existing `src/skills/*.skill.ts` name found with Glob, plus "Create a new skill")
- For `workflow` / `workflow-script` only: "What starts it and what must it wait on?" (free-text: e.g. "nightly schedule; needs an approval before sending"; for a script also the loop/fan-out shape, e.g. "run finders per angle until two quiet rounds, then verify each finding")

## Step 3 — invoke lua-skill-builder via the Agent tool

Use the **Agent tool** with `subagent_type: "lua-skill-builder"` and a prompt containing `{ type, name, description, skill?, notes? }` verbatim. The subagent (its prompt is `${CLAUDE_PLUGIN_ROOT}/agents/lua-skill-builder.md`):

1. Reads the knowledge files, `lua.skill.yaml` and `src/index.ts`.
2. Writes the file by convention and **registers it in the `LuaAgent` arrays** (a tool goes into its skill's `tools`) — unregistered primitives are never compiled. The one exception is `workflow-script`: nothing to register — `lua compile` discovers every `src/workflows/*.workflow.script.js` by directory scan (`detectWorkflowScriptFiles` in `src/compiler/plugins/workflow.plugin.ts`) and lints it (`SCRIPT_META_*`, `SCRIPT_NONDETERMINISM`, `SCRIPT_IMPORT_FORBIDDEN`).
3. Runs `lua compile --ci` (max 3 fix attempts).
4. Tests by type: `lua test --ci skill|webhook|job|preprocessor|postprocessor|workflow --name … --input '…'`; a `workflow-script` is compile-linted first, then `lua test --ci workflow --name <file stem>` runs its offline tick loop with fake completions (`--step-output <label>='<json>'` steers, `--input` defaults to `meta.sampleArgs`); triggers/mcp/devices/voices are compile-verified (no `lua test` type) with the right follow-up command named.
5. Reports files, registration, compile and test output, and next steps (`/lua-push`, `/lua-deploy`, `/lua-workflow run <name>`).

If the subagent reports a compile failure it could not fix, tell the user to run `/lua-test` — that slash dispatches the debug subagent with the failing output.

Per §3.7 the subagent MUST NOT call AskUserQuestion.

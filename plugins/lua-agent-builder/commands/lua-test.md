---
description: Run a skill (one of its tools), webhook, job, preprocessor, postprocessor or workflow locally with `lua test --ci`. Inputs collected up-front; on failure hands the output to the lua-debug subagent.
---

You are `/lua-test`. The user wants to run a primitive in the local sandbox.

## Step 1 — collect inputs (single permission per §3.7)

If `$ARGUMENTS` names a type (and optionally a name), use them. Otherwise AskUserQuestion **once**:

- "Type?" (options: `skill`, `webhook`, `job`, `preprocessor`, `postprocessor`, `workflow`) — these are the six `lua test` types in lua-cli 3.33.0 (the help text omits the two processors; they work). A tool is tested with type `skill`.
- "Name?" (free-text). If `dist-v2/manifest.json` exists, `Read` it and pre-offer the names whose `kind` matches (`webhook`, `job`, `preprocessor`, `postprocessor`, `workflow`). **For `skill`, offer the `tool` names, not the skill names**: `lua test skill --name` takes a TOOL name (resolved across every skill; a skill name fails with exit 3 `not_found: Tool "<n>" not found`).
- "Input JSON?" (free-text). Defaults: skill — the tool's own fields from its Zod `inputSchema`, e.g. `{"city":"London"}` (there is **no** `{"tool": …}` envelope); webhook `{"body":{},"headers":{},"query":{}}`; job — none; processors — a representative message; workflow — an object matching its `inputSchema`.

## Step 2 — run

- skill / webhook / preprocessor / postprocessor → `Bash(lua test --ci <type> --name <name> --input '<json>' --json)`
- job → `Bash(lua test --ci job --name <name> --json)`
- workflow → `Bash(lua test --ci workflow --name <name> --input '<json>' --agents fake --fast-retries --json)`; if the user mentioned approvals/signals/branches, add `--approve <id>` / `--deny <id>` / `--signal <name>='<json>'` / `--step-output <stepId>='<json>'` (for richer scenarios point them at `/lua-workflow run <name>`).

`--input` is a JSON **string**; only `workflow` accepts `@file`. `lua test` compiles first and needs a credential + the project's agentId (platform API calls inside your code are real). **Never omit `--name`** (nor `--input` for a tool): `lua test skill --ci` without `--name` compiles, then renders a tool picker that ignores `--ci` and exits **0 having tested nothing** — a false pass (lua-cli 3.33.0 `src/commands/test.ts`). A `--name` with no type is exit 2. `lua test` reads `process.env` + `.env` locally and uploads nothing — it is the safe way to exercise code from a shell that holds secrets (unlike `lua chat -e sandbox`, which uploads the whole shell environment).

## Step 3 — handle the outcome

- Exit 0 **and** a result without `status: 'error'` → show the result (with `--json` it is the raw execution result; for workflows `{ success, data }`). Done.
- Exit 0 with a `{ status: 'error', error }` result (usually with a stack trace on stderr) → the handler **threw**: lua-cli 3.33.0 prints `✅ … execution successful!` anyway (`src/utils/sandbox.ts` swallows the throw; `test.ts` never checks the result). Treat it exactly like a non-zero exit — hand it to `lua-debug` as below; never report it as a pass.
- Non-zero → invoke the `lua-debug` subagent via the **Agent tool** (`subagent_type: "lua-debug"`) with the full command and output as the prompt. Do NOT re-prompt the user. Exit-code hints: `2` usage/schema, `9` auth (→ `/lua-auth`), `12` the model provider refused; workflow `4` a step failed, `5` fixture missing.

---
description: Scaffold a new Lua primitive (tool, skill, webhook, job, preprocessor, postprocessor, mcp). Spawns the lua-skill-builder subagent which generates the file, writes a Zod schema, and verifies with lua compile.
---

You are `/lua-new`. The user typed `/lua-new $ARGUMENTS`.

## Step 1 — parse arguments

`$ARGUMENTS` is `<type> [name]`. Type is required; name is optional.

Validate type against the 7 allowed values: `tool`, `skill`, `webhook`, `job`, `preprocessor`, `postprocessor`, `mcp`. If invalid, print: `Unknown primitive type "<type>". Valid: tool, skill, webhook, job, preprocessor, postprocessor, mcp.` and stop.

## Step 2 — collect missing inputs (single permission per §3.7)

If name was not in `$ARGUMENTS`, AskUserQuestion **once**:

- "Name for the new <type>?" (free-text, required)
- "One-line description?" (free-text — passed to the subagent for scaffolding)

## Step 3 — invoke lua-skill-builder via the Agent tool

Use the **Agent tool** with `subagent_type: "lua-skill-builder"` and a prompt containing `{ type, name, description }` verbatim. (Iteration-13 audit: explicit Task-tool invocation is the only way to actually dispatch a subagent from a slash.) The subagent:

1. Reads `lua.skill.yaml` to confirm naming conventions.
2. Locates the right `src/skills/` subdirectory.
3. Scaffolds the file with the class-based pattern + Zod schema.
4. Runs `lua compile --ci` until it passes.
5. On success, runs the type-appropriate test (iteration-13 audit: previously hardcoded to `--ci skill` regardless of type — wrong for 5 of 7 primitive types):
   - `type=tool` → `lua test --ci skill --name <parent-skill-name> --input '<representative-json>'` (tools are tested via their parent skill)
   - `type=skill` → `lua test --ci skill --name <name> --input '<representative-json>'`
   - `type=webhook` → `lua test --ci webhook --name <name> --input '<representative-json>'`
   - `type=job` → `lua test --ci job --name <name> --input '<representative-json>'`
   - `type=preprocessor` / `postprocessor` / `mcp` → skip the test step (`lua test` doesn't support these primitive types per `lua test --help`); print "Compile succeeded; <type> primitives have no `lua test` form — verify with a real chat invocation via `/lua-chat`."

Per §3.7, the subagent MUST NOT call AskUserQuestion. Errors abort cleanly with a next-action message.

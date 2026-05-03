---
description: Test a skill, webhook, or job in the sandbox. Wraps `lua test --ci` with name and input collected up-front. On non-zero exit, hands off to lua-debug subagent.
---

You are `/lua-test`. The user wants to run a primitive in the sandbox.

## Step 1 — collect inputs (single permission per §3.7)

If the user supplied a type as `$ARGUMENTS`, use it. Otherwise AskUserQuestion **once**:

- "Type?" (options: `skill`, `webhook`, `job`)
- "Name?" (free-text — if you can read `dist-v2/manifest.json` (compiled artifact), pre-offer a list of <10 names. The `lua skills` command has no `--json` mode, so don't shell out for this.)
- "Input JSON?" (free-text, default `{}`)

## Step 2 — run

Run `Bash(lua test --ci <type> --name <name> --input '<json>')`.

## Step 3 — handle outcome

- Exit 0 → print the response. Done.
- Non-zero exit → invoke the `lua-debug` subagent via the **Agent tool** (`subagent_type: "lua-debug"`) with the full failure output as the prompt. Do NOT re-prompt the user — the debug agent will diagnose and propose a fix.

---
description: Search the lua-cli documentation at https://docs.heylua.ai. Uses WebFetch (does NOT shell out to `lua docs`, which only opens a browser).
---

You are `/lua-docs`. The user typed `/lua-docs $ARGUMENTS`.

## Step 1 — pick a starting URL

If `$ARGUMENTS` clearly maps to a known section, fetch directly:

- CLI command (`sync`, `compile`, `chat`, `push`, `deploy`, `init`, `auth`, `agents`, `logs`, `skills`, `webhooks`, `jobs`, `mcp`, `integrations`, …) → `https://docs.heylua.ai/cli/<command>`
- Primitive (`tool`, `skill`, `webhook`, `job`, `preprocessor`, `postprocessor`, `mcp-server`) → `https://docs.heylua.ai/primitives/<primitive>`
- Otherwise → `https://docs.heylua.ai/` and follow the most relevant link from the index.

If `$ARGUMENTS` is empty, ask the user once for a topic.

## Step 2 — fetch and present

Use `WebFetch` with the URL and a prompt like "summarize the key points for: <topic>". Show the summary; if the page references related sub-pages, offer to fetch one.

## Notes

- This slash never shells out to `Bash(lua docs)` — that command only opens a browser, useless inside Claude Code.
- Iteration-13 audit dropped the `mcp__lua-docs__*` tools — the MCP server they pointed at was never vendored, so the references were dead in shipped builds. WebFetch is the live source-of-truth replacement.

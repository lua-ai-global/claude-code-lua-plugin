---
description: Look something up in the lua-cli / Lua platform documentation (docs.heylua.ai) via the public docs MCP server, with WebFetch as the fallback. Never shells out to `lua docs` (it only opens a browser).
---

You are `/lua-docs`. The user typed `/lua-docs $ARGUMENTS`.

lua-cli is a TypeScript SDK/CLI for building AI agents — it is unrelated to the Lua programming language; never search Lua-language docs.

## Step 1 — answer from the plugin's own knowledge first

The knowledge files in `${CLAUDE_PLUGIN_ROOT}/lib/knowledge/` (`primitives.md`, `workflows.md`, `cli-reference.md`, `integrations.md`, `decision-trees.md`) were verified against lua-cli 3.33.0 source and are more reliable than the public docs where the two disagree. `Grep` them for the topic.

## Step 2 — search the live docs

Use the docs MCP (registered by this plugin as `lua-docs`, the public endpoint https://docs.heylua.ai/mcp):

- `mcp__plugin_lua-agent-builder_lua-docs__search_lua_cli` with the user's question (semantic search with page links). That is the name Claude Code gives the plugin's `lua-docs` server; if it is absent but the same tool exists under the plain `lua-docs` server prefix (the user registered the docs server themselves), use that one — same tool.
- `mcp__plugin_lua-agent-builder_lua-docs__query_docs_filesystem_lua_cli` to read or grep pages: `tree / -L 2`, `rg -n "<keyword>" /`, `head -200 /cli/workflows-command.mdx`

Page paths (append `.mdx` for the filesystem tool; use as `https://docs.heylua.ai/<path>` for WebFetch): CLI commands at `/cli/<command>-command` (e.g. `/cli/sync-command`, `/cli/workflows-command`, `/cli/triggers-command`, `/cli/version-command`), `init/compile/test/push/deploy` at `/cli/skill-management`, auth at `/cli/authentication`, `status/agents/models/update/telemetry/governance` at `/cli/utility-commands`, `/cli/non-interactive-mode`, `/cli/troubleshooting`; SDK at `/api/<luaagent|luaskill|luatool|luawebhook|luatrigger|luajob|preprocessor|postprocessor|luamcpserver|device-definition|voice|user|data|products|baskets|orders|jobs|ai|agents|integrations|channels|inbox|templates|cdn|lua|environment|query>`; workflows at `/workflows/<quick-start|authoring|job-tier|connections|runs-and-events|from-chat>`; concepts at `/overview/<topic>`; channels at `/channels/<whatsapp|facebook-messenger|instagram|slack|teams|email|website-widget|http-api|proactive-messaging|channel-capabilities>`; marketplace at `/marketplace/<overview|agent-templates|publishing-templates|template-manifest|deploying-templates>`; devices at `/devices/*`; `/getting-started/quick-start`; `/changelog`.

If the MCP tools are unavailable, `WebFetch` the URL directly.

If `$ARGUMENTS` is empty, ask the user once for a topic.

## Step 3 — present

Summarise the answer with the page path(s) you used. If the docs contradict a knowledge file, say which is which — and prefer the knowledge file (it reflects the CLI source). Offer to open a related page.

## Notes

- Never run `Bash(lua docs)` — it opens a browser and is useless inside Claude Code.
- `mcp__plugin_lua-agent-builder_lua-docs__submit_feedback` exists for reporting a wrong or outdated docs page; use it only when the user asks to report a docs problem.

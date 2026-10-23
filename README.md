# claude-code-lua-plugin

A [Claude Code](https://code.claude.com) marketplace + plugin for building, testing, and deploying [Lua AI agents](https://heylua.ai) — skills, webhooks, triggers, jobs, workflows, voice, devices, integrations and marketplace templates — from inside your Claude Code session.

📖 **[User Guide →](./docs/USER_GUIDE.md)** — installation, walkthroughs, every slash command, hooks, MCP tools, safety model, troubleshooting.

🤖 **[Running in the Lua Job tier →](./docs/JOB_TIER.md)** — headless use (`LUA_PLUGIN_HEADLESS=1`, `claude -p`): inline playbooks, `--mcp-config`, and why the Lua-API proxy, not the hooks, is the boundary.

🛠️ **[Running in a Lua live build session →](./docs/BUILD_SESSION.md)** — session mode (`LUA_BUILD_SESSION=1`, 1.15.0): every `lua` command stays usable; reads run directly, production changes are approved by the user in Lua Desktop (`request_action` / `request_release`), secrets are typed there (`request_secret`). Laptop behaviour is unchanged.

lua-cli is a TypeScript SDK/CLI. It has nothing to do with the Lua programming language.

## Install

```
/plugin marketplace add lua-ai-global/claude-code-lua-plugin
/plugin install lua-agent-builder@claude-code-lua-plugin
/reload-plugins
/lua-doctor
```

Then `/lua-auth`: an existing credential is kept; a new login runs `lua auth configure` in your own terminal.

## What's inside

| Plugin | Description |
|---|---|
| [`lua-agent-builder`](./plugins/lua-agent-builder/) | 23 slash commands, 10 subagents, 15 hooks, a 10-file knowledge base verified against lua-cli source (3.33.0 base; 1.3.0 added per-step model classes and the workflow autonomy envelope from lua-cli 3.36.0, 1.4.0 the Job-tier billing rules and the lua-cli 3.37.0 cost read-outs, 1.5.0 log drains and the `lua logs` read window from lua-cli 3.38.0, read from `main`; 1.6.0 headless mode and a hardened production-gate parser; 1.7.0 `/lua-devices`, device credentials that never reach the conversation, and a re-check against lua-cli 3.44.0 / 3.45.0; 1.8.0 web apps (Lua Apps); 1.9.0 the full QA suite, `/lua-qa full`; 1.10.0 decisions, `/lua-decisions` and `/lua-new decision` from lua-cli 3.48.0 / 3.49.2; 1.11.0 `/lua-deploy webapp` scoped web-app deploys from lua-cli 3.49.0; 1.12.0 org-shared `Data.shared` and web-app viewer decisions from lua-cli 3.50.0; 1.13.0 `lua apps preview` from lua-cli 3.51.0; 1.14.0 web-app pages on `@lua-ai-global/ui` 0.3 from lua-cli 3.55.0; 1.15.0 live build session mode), a local read-only platform MCP server, the public docs MCP and the public UI component catalog MCP |

## Quick walkthrough

```
/lua-architect I want an agent that triages support tickets, drafts replies for approval, and posts to Slack
   → a plan: persona, tools vs integration MCPs, event handlers, a workflow with an approval step, build order
/lua-init                        → scaffold the project (new / existing / duplicate agent)
/lua-new skill ticket-triage     → scaffold + register + compile + test
/lua-new workflow reply-approval → workflow file, offline test with --approve
/lua-workflow run reply-approval → more offline scenarios
/lua-qa                          → quick: conversational + workflow QA against sandbox
/lua-qa full [smoke|medium|production-ready] [--interview] → diagrams, persona suite, red team, stress (not in smoke), PDF report (medium by default)
/lua-deploy                      → one confirmation, then the gated ship sequence
```

## Safety contracts

- Every production-affecting `lua` verb (`deploy`, `* deploy`, `workflows deploy|activate`, `version promote`, `mcp activate`, `marketplace template publish|apply`, plus every alias spelling lua-cli resolves and the `heylua`/`lua-ai` binaries) is blocked by the `confirm-deploy` hook on every Bash call unless emitted by the deploy flow with the `LUA_DEPLOY_CONFIRMED=1` prefix; a hook block wins over any allow rule. The permission template allows only the prefixed forms (Claude Code's deny/ask rules see through env prefixes, so the bare verbs are deliberately not denied there).
- `--auto-deploy` is never allowed.
- Credentials never enter the conversation.
- One permission prompt per slash.

See [`plugins/lua-agent-builder/SECURITY.md`](./plugins/lua-agent-builder/SECURITY.md).

## Contributing

`cd plugins/lua-agent-builder && npm ci && npm run lint && npm run test:coverage`. The 17 lint scripts encode known regression classes (wrong flags, dead MCP references, missing `-t` on chat, non-existent log fields, unregistered hooks…); if your change fixes a new bug class, add a guard.

## License

[MIT](./plugins/lua-agent-builder/LICENSE) © Lua AI

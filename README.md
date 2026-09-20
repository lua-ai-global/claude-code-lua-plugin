# claude-code-lua-plugin

A [Claude Code](https://code.claude.com) marketplace + plugin for building, testing, and deploying [Lua AI agents](https://heylua.ai) — skills, webhooks, triggers, jobs, workflows, voice, devices, integrations and marketplace templates — from inside your Claude Code session.

📖 **[User Guide →](./docs/USER_GUIDE.md)** — installation, walkthroughs, every slash command, hooks, MCP tools, safety model, troubleshooting.

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
| [`lua-agent-builder`](./plugins/lua-agent-builder/) | 20 slash commands, 5 subagents, 10 hooks, a 5-file knowledge base verified against lua-cli source (3.33.0 base; 1.3.0 added per-step model classes and the workflow autonomy envelope from lua-cli 3.36.0, 1.4.0 the Job-tier billing rules and the lua-cli 3.37.0 cost read-outs, read from `main`), a local read-only platform MCP server and the public docs MCP |

## Quick walkthrough

```
/lua-architect I want an agent that triages support tickets, drafts replies for approval, and posts to Slack
   → a plan: persona, tools vs integration MCPs, event handlers, a workflow with an approval step, build order
/lua-init                        → scaffold the project (new / existing / duplicate agent)
/lua-new skill ticket-triage     → scaffold + register + compile + test
/lua-new workflow reply-approval → workflow file, offline test with --approve
/lua-workflow run reply-approval → more offline scenarios
/lua-qa                          → conversational + workflow QA against sandbox
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

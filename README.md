# claude-code-lua-plugin

A [Claude Code](https://code.claude.com) marketplace + plugin for building, testing, and deploying [Lua AI agents](https://heylua.ai) directly from inside your Claude Code session.

## Install

```
/plugin marketplace add lua-ai-global/claude-code-lua-plugin
/plugin install lua-agent-builder@claude-code-lua-plugin
/reload-plugins
```

Then `/lua-auth` to authenticate (email + OTP, or paste an existing API key from [admin.heylua.ai](https://admin.heylua.ai)), and `/lua-doctor` to verify the full environment.

Once it's on the official Anthropic marketplace, install will simplify to:

```
/plugin install lua-agent-builder@claude-plugins-official
```

## What's inside

This repo is a **marketplace catalog** that ships one plugin:

| Plugin | Description |
|---|---|
| [`lua-agent-builder`](./plugins/lua-agent-builder/) | The full Lua agent toolchain — 14 slash commands, 5 subagents, 9 hooks, MCP server with 5 read-only platform tools |

See [`plugins/lua-agent-builder/README.md`](./plugins/lua-agent-builder/README.md) for the plugin's own docs (layout, hooks list, slash commands, design rationale).

## Layout

```
claude-code-lua-plugin/
├── .claude-plugin/
│   └── marketplace.json        ← marketplace catalog (this file points at the plugin below)
├── plugins/
│   └── lua-agent-builder/
│       ├── .claude-plugin/
│       │   └── plugin.json     ← plugin manifest
│       ├── commands/           ← 14 slash commands
│       ├── agents/             ← 5 subagents
│       ├── hooks/              ← 9 hooks
│       ├── lib/                ← shared utilities + permissions template
│       ├── mcp/lua-platform/   ← MCP server source + bundled dist/
│       ├── scripts/            ← 16 lints + 2 check scripts
│       └── test/               ← 216 jest tests
├── .github/workflows/          ← ci, release-beta, release-prod
├── LICENSE                     ← (in plugins/lua-agent-builder/)
├── SECURITY.md                 ← (in plugins/lua-agent-builder/)
└── README.md                   ← you are here
```

## Quick walkthrough

After install + `/lua-auth`:

```
/lua-architect I want to build a refund-handling agent
   → drafts a plan: persona, primitives, integrations, build order
/lua-init       → scaffolds project, asks for name + org + model
/lua-new tool refund_lookup
   → spawns lua-skill-builder, scaffolds + compiles + tests
/lua-test       → exercises the tool in sandbox
/lua-deploy     → ships to production with a single permission gate
```

For a fuller end-to-end walkthrough see the plugin's README and `/lua-doctor` (5-step environment diagnostic).

## Safety contracts

The plugin enforces several gates that show up at install time via `/lua-doctor` Step 5:

- **§3.3 deploy gate** — bare `lua deploy` is denied at the permissions layer; defense-in-depth via the `confirm-deploy.mjs` PreToolUse hook.
- **`--auto-deploy` block** — denied at permissions + blocked at the hook layer.
- **§3.7 single-permission contract** — each slash asks at most one prompt (multi-step diagnostic slashes use the documented `x-lua-multi-step: true` opt-out).
- **Credential isolation** — API key never enters the Claude conversation transcript; `/lua-doctor` Step 4 uses an authenticated metadata probe (`lua agents --json --ci`), not a key-printing command.

See [`plugins/lua-agent-builder/SECURITY.md`](./plugins/lua-agent-builder/SECURITY.md) for the disclosure path and a fuller scope statement.

## Contributing

Issues and PRs welcome. The plugin has 16 structural lint scripts that catch known regression classes — if your change adds a new bug class, the right fix is usually "add a lint guard so the next person doesn't repeat it." See `plugins/lua-agent-builder/scripts/lint-*.mjs` for examples.

## License

[MIT](./plugins/lua-agent-builder/LICENSE) © Lua AI

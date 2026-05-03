# Security Policy

## Reporting a vulnerability

Email **security@heylua.ai** with the details. Please do NOT open a public GitHub issue for security reports.

We aim to acknowledge within 2 business days and ship a fix within 30 days for high-severity issues.

## Scope

This plugin's surface includes:

- **Hooks** (`hooks/*.mjs`) — run as subprocesses of Claude Code on `SessionStart`, `UserPromptSubmit`, and `Pre/PostToolUse(Bash)` events.
- **MCP server** (`mcp/lua-platform/dist/server.js`) — a stdio MCP server exposing 5 read-only tools. Talks to `https://api.heylua.ai` over HTTPS using the user's API key.
- **Slash commands** (`commands/*.md`) — Markdown prompts that Claude reads and executes.
- **Permission rules** (`lib/permissions-template.json`) — auto-merged into the user's `.claude/settings.json` by `/lua-doctor` Step 5.

In scope for security reports:

- Credential exposure (API keys leaking into transcripts, logs, or external systems)
- Permission gate bypasses (deploys or destructive operations succeeding without the documented confirmation)
- Hook payload injection (malicious bash commands triggering unintended hook behavior)
- MCP server auth bypass

Out of scope:

- Bugs in `lua-cli` itself (report to https://github.com/lua-ai-global/lua-cli)
- Bugs in `lua-api` (report to security@heylua.ai with `[lua-api]` in the subject)
- Issues in user-installed third-party MCP servers

## Safety-critical contracts

The plugin enforces several safety contracts. Bypasses count as security issues:

| Contract | Where enforced |
|---|---|
| §3.3 deploy gate: bare `lua deploy` is denied | `lib/permissions-template.json` `deny` list + `hooks/confirm-deploy.mjs` |
| §3.3 auto-deploy block: `--auto-deploy` is denied | same |
| §3.7 single-permission contract: each slash asks at most one prompt | `scripts/lint-single-permission.mjs` |
| Credential isolation: API key never enters Claude conversation transcript | `commands/lua-doctor.md` Step 4 + `lib/permissions-template.json` deny rule on `lua auth key*` (bug 41) |

If you find a way to bypass any of these without an explicit user prompt, please report.

## Audit history

This plugin underwent 13 iterations of structured audit (commits prefixed with `iteration-`) before public release, fixing 78 documented bugs across the plugin / hook / MCP / knowledge-file surfaces. See the iteration-history comments in each lint script (`scripts/lint-*.mjs`) for the rationale behind each structural guard.

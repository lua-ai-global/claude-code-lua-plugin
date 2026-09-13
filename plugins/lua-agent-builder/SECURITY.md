# Security Policy

## Reporting a vulnerability

Email **security@heylua.ai** with the details. Please do NOT open a public GitHub issue for security reports.

We aim to acknowledge within 2 business days and ship a fix within 30 days for high-severity issues.

## Scope

This plugin's surface includes:

- **Hooks** (`hooks/*.mjs`) — run as subprocesses of Claude Code on `SessionStart`, `UserPromptSubmit`, and `Pre/PostToolUse(Bash)` events.
- **MCP servers** — `mcp/lua-platform/dist/server.js`, a local stdio server exposing 5 read-only tools; it talks to `https://api.heylua.ai` over HTTPS with the user's lua-cli credential (and, for a session login, refreshes the stored refresh token at Google's securetoken endpoint exactly like lua-cli does). `lua-docs` is the public remote MCP at `https://docs.heylua.ai/mcp` (read-only docs search).
- **Slash commands and subagents** (`commands/*.md`, `agents/*.md`) — Markdown prompts that Claude reads and executes.
- **Permission rules** (`lib/permissions-template.json`) — merged into the user's `.claude/settings.json` by `/lua-doctor` Step 5 with consent.

In scope for security reports:

- Credential exposure (API keys, session tokens or one-time codes leaking into transcripts, logs, or external systems)
- Production-gate bypasses (any of the gated verbs below succeeding without the documented confirmation)
- Hook payload injection (malicious bash commands triggering unintended hook behaviour)
- MCP server auth bypass

Out of scope:

- Bugs in `lua-cli` itself (report to https://github.com/lua-ai-global/lua-cli)
- Bugs in `lua-api` (report to security@heylua.ai with `[lua-api]` in the subject)
- Issues in user-installed third-party MCP servers

## Safety-critical contracts

| Contract | Where enforced |
|---|---|
| Production gate: `lua deploy`, `lua skills\|webhooks\|jobs\|preprocessors\|postprocessors deploy`, `lua persona production deploy`, `lua workflows deploy\|activate`, `lua version promote`, `lua mcp activate`, `lua marketplace template publish\|apply` are blocked in bare form; only the `LUA_DEPLOY_CONFIRMED=1`-prefixed form emitted after the user's confirmation runs. The gate covers every spelling lua-cli accepts: the action aliases from its `aliases.ts` (`publish`→deploy, `on`/`enable`→activate, `submit`/`publish_version`→template publish, `deploy`/`fleet-apply`/`rollout`→template apply, `prod`/`prd`/`live`→production) and all three installed binaries (`lua`, `heylua`, `lua-ai`) | **The hook is the gate.** `hooks/confirm-deploy.mjs` runs on **every** Bash call (no `if` glob to drift), classifies with `lib/tokenizer.mjs` (the single source of truth) and exits 2 on a bare verb — a hook block takes precedence over any allow rule, including a broad `Bash(lua *)` in the user's own settings. Wrappers and pipes are refused even with the prefix. `lib/permissions-template.json` allows the literal prefixed forms (so the confirmed command runs without a second prompt) and deliberately has **no** deny/ask rule for the bare verbs: Claude Code evaluates deny/ask rules past a leading env assignment (code.claude.com/docs/en/permissions: "A deny or ask rule matches past any leading assignment"), so a `Bash(lua deploy*)` deny would also block the confirmed form and make every deploy impossible — verified live on 2026-09-12. A bare verb that reaches the permission layer falls to Claude Code's default prompt (a denial in `-p` mode). `heylua`/`lua-ai` are denied wholesale. `test/lib/permissions-mirror.test.mjs` and `scripts/lint-permissions.mjs` fail if a deny/ask rule would shadow a confirmed form or an allow rule admits a bare one |
| `--auto-deploy` is never allowed | deny list (`Bash(lua * --auto-deploy*)` matches prefixed or not) + `hooks/block-auto-deploy.mjs` + `hooks/confirm-deploy.mjs` |
| Single-permission contract: each slash asks at most one prompt. For workflow run-control verbs (`lua workflows start\|approve\|signal\|resume\|retry-step\|resolve-step\|raise-budget\|cancel\|deactivate\|export\|schedules\|goals`) that single prompt is the **Bash permission prompt** from the `ask` tier, which shows the exact command; `/lua-workflow` does not add an AskUserQuestion on top. `/lua-env` (`lua env *`; listings are masked by the CLI, set values are never echoed by the slash) and `/lua-integrations` (connect/update/disconnect/convert, webhook and MCP toggles) rely on the same `ask`-tier prompt | `scripts/lint-single-permission.mjs`; `ask` tier of `lib/permissions-template.json` |
| Post-deploy smoke check fires after every verb that makes something live (`SMOKE_LABELS` in `lib/tokenizer.mjs`: deploy spellings, `persona production deploy`, `workflows deploy`, `version promote`, `mcp activate`) | `hooks/post-deploy-smoke.mjs` (PostToolUse on every Bash call) |
| Credential isolation: account details, one-time codes and credentials never enter the conversation | `commands/lua-auth.md` sends login to a private terminal; `hooks/block-auth-configure.mjs`; `lua auth configure\|key\|logout` denied in `lib/permissions-template.json` |
| Read-only MCP: no tool mutates platform state | `mcp/lua-platform/src/tools/*` (GET routes and `lua agents --json` only) |

If you find a way to bypass any of these without an explicit user prompt, please report it.

## Known platform-side exposure the plugin cannot close

**`lua chat -e sandbox` uploads the invoking shell's entire environment.** lua-cli 3.33.0 attaches `loadEnvironmentVariables()` — all of `process.env` merged with `.env` — as the `env` of every sandbox skill version it pushes (`src/utils/sandbox.ts` ~149-172, `src/services/sandbox.service.ts` ~232-238). lua-api and lua-agents accept the field unfiltered (`ValidationPipe whitelist:false`) and lua-agents caches it with the sandbox version in Redis for about 24 h; the runtime never reads it (a sandbox turn's `env()` resolves from the agent's server-side env — lua-core `skill-eligibility.resolver.ts`). Validated live on 2026-09-13 with a scrubbed shell. Consequence for this plugin: `/lua-chat` (sandbox) and the `lua-qa` subagent run `lua chat -e sandbox` from Claude Code's own process environment, so whatever that shell holds (cloud keys, `GITHUB_TOKEN`, npm tokens, …) leaves the machine on every sandbox chat. The plugin does not scrub the child environment itself — wrapping the command would break the single-permission contract and the `-t` lint — so the mitigation is operational: **start Claude Code from a shell that holds nothing you would not hand to the platform** (e.g. `env -i HOME="$HOME" PATH="$PATH" TERM="$TERM" zsh -f`, then `claude`, or a dedicated terminal profile), or use `-e production` / `lua test`, which upload nothing. The chat slash and the QA agent say this once before a sandbox chat. A platform ticket to upload `.env` only (or nothing) is open.

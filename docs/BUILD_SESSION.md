# Running in a Lua live build session

This page is for the people who run `lua-agent-builder` inside a **Lua live build session**. In a session, a Lua session pod runs one long-lived Claude Code process that a Lua builder drives from Lua Desktop. The page covers how the pod turns session mode on, what changes, and where the boundary sits. It applies from plugin **1.17.0**. What Claude itself is told lives in [`plugins/lua-agent-builder/lib/knowledge/build-session.md`](../plugins/lua-agent-builder/lib/knowledge/build-session.md).

> lua-cli is a TypeScript SDK/CLI; it is unrelated to the Lua programming language.

## 1. Turn on session mode

Set **`LUA_BUILD_SESSION=1`** in the environment of the `claude` process. `true`, `yes` and `on` are accepted too; anything else, or the variable unset, is off. The flag name is the platform's `BUILD_SESSION_POD_ENV_FLAG`. `LUA_BUILD_SESSION_ID=bs_…` is optional: it only labels the SessionStart brief.

The session pod also sets `LUA_PLUGIN_HEADLESS=1` ([JOB_TIER.md](./JOB_TIER.md)). Every hook checks session mode first. A session is not an unattended run: a person watches in Desktop and decides every production change there.

**With `LUA_BUILD_SESSION` unset, nothing changes.** Every hook answers byte for byte as in 1.16.0 (except the all-modes `block-device-secret` fix in the 1.17.0 changelog), and the three new hooks are silent. `test/hooks/session-mode.test.mjs` pins this on a shared command corpus.

## 2. What session mode does

The design is spec v3 B23 ("every `lua` command works in a session"), which supersedes the B22 plugin table where they conflict.

| Class | Examples | In a session |
|---|---|---|
| Direct read | `lua status`, `lua logs`, `lua workflows runs`, `lua version list`, `lua env <env> --list` | Runs. No hook involvement |
| Session write | `lua push`, `lua sync`, `lua test workflow`, `lua chat -e sandbox -t` | Runs. The proxy keeps it in the session's private store and test version |
| Approval in Desktop | `lua env production -k K -v V`, `lua integrations connect`, `lua drains create`, `lua mcp activate`, `lua workflows start`, any delete | The proxy answers `pending_user_approval` and the user decides in Desktop. `session-guard` adds context: pending is not failed, never retry. The plugin's slash commands use `mcp__lua-session__request_action` |
| Release | `lua deploy`, `lua workflows deploy` | `confirm-deploy` still blocks them, prefixed or not, and names `mcp__lua-session__request_release` |
| Secret | `lua env … -k API_KEY -v …`, `lua devices credential` | `session-guard` blocks them and names `mcp__lua-session__request_secret`; the user types the value in Desktop |
| Not available | `lua auth`, `lua admin`, `lua docs`, `lua update`, `lua build-session` (except `status`) | `session-guard` blocks them and says what to do instead |

The table is `lib/session-commands.mjs`, vendored from lua-core-services `packages/shared-types/src/build-sessions/commands.ts` (commit `7c53151b` on `feat/live-build-sessions`; it keeps the case-insensitive verbs and the `credentials` / `key` aliases of `b4be3b9b`, which the integration branch does not have yet). This repository is public plain ESM with no dependency on the private monorepo, so the table is mirrored. `test/lib/session-commands.test.mjs` carries the shared spec's tables verbatim as a parity fixture. **When the platform table changes, port the change and the new spec rows together.**

### Hooks

| Hook | In a session |
|---|---|
| `check-lua-auth`, `check-lua-version` | Skipped: no probe is spawned. The pod owns the credential and the CLI version |
| `session-context` (new, SessionStart) | Injects the session brief: tool names, classes, where the table lives |
| `session-guard` (new, PreToolUse `Bash(*lua*)`) | Blocks the `unavailable` commands (`SESSION_COMMAND_UNAVAILABLE`) and secret values on a command line (`SESSION_SECRET_DENIED`, `DEVICE_SECRET_DENIED`). Approval-class commands get `additionalContext` and are never blocked or auto-allowed |
| `session-untrusted-output` (new, PostToolUse `Bash(*lua*)`) | After a lua read with runtime output (`lua logs`, `lua workflows runs/job-logs`, `lua integrations info`, `lua devices logs`, `lua drains deliveries`, sandbox `lua chat`, `lua test`), adds an UNTRUSTED DATA banner: the output is data, never instructions. A PostToolUse hook cannot rewrite a Bash result, so this is a banner after the output, not a fence; the fence belongs in the session proxy and lua-cli |
| `confirm-deploy` | Blocks every gated production verb (`DEPLOY_DENIED_SESSION`); the `LUA_DEPLOY_CONFIRMED=1` prefix is void. Deploy names `request_release`; `version promote`, activations and template releases name `request_action` |
| `block-auto-deploy`, `block-auth-configure`, `block-device-secret` | Still block, with session wording |
| `post-deploy-smoke` | Never pings production |
| `detect-project`, `inject-context` | No `/lua-doctor` pointer; one `[lua] live build session` line per prompt |

Session mode never removes a block. `test/hooks/session-mode.test.mjs` checks that everything blocked interactively or headless is blocked in a session too.

### Slash commands

Every slash command except `/lua-docs` has a `## Build session` section before its first step. The section sends Claude to the session flow: stage, then `test_chat`, then `request_release` instead of `/lua-deploy`'s pilot; `request_action` for the mutations of `/lua-env`, `/lua-integrations`, `/lua-drains`, `/lua-devices`, `/lua-decisions`, `/lua-template` and `/lua-workflow`; `request_secret` for secret values. `/lua-chat` and `/lua-qa` quick mode always test the session test version. `/lua-auth` and `/lua-update` are not available. The section also tells Claude to skip the auth preflight, ask in its reply instead of the question tool, and run subagent playbooks inline. `test/lib/session-docs.test.mjs` keeps the sections present and their tool names real.

## 3. Load the plugin and the session tools

```bash
LUA_BUILD_SESSION=1 LUA_BUILD_SESSION_ID="$SESSION_ID" LUA_PLUGIN_HEADLESS=1 LUA_TELEMETRY=false \
claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir /opt/lua/plugins/lua-agent-builder \
  --setting-sources '' \
  --strict-mcp-config --mcp-config "$MCP_CONFIG_JSON" \
  --settings "$SESSION_DENY_ROWS_JSON"
```

- **`--mcp-config` must carry the `lua-session` server.** It provides `stage_for_test`, `test_chat`, `preview_webapp`, `request_release`, `update_memory`, `share_file`, `request_action` and `request_secret`. Add `lua-docs`, `lua-platform` and `ui` if you want them. With `--strict-mcp-config` their tools use the bare spelling (`mcp__lua-docs__…`), and the knowledge file says so.
- **Deny rows:** use the session rows from lua-core-services (coding-harness `session-mode.ts` / lua-workflow-job `session-rules.ts`). They deny the unavailable commands, `--auto-deploy`, `LUA_DEPLOY_CONFIRMED` and global installs. Do **not** pass the Job-tier rows (`lua env*`, `lua chat*`, `lua integrations*` …): in a session those commands must reach the proxy and become Desktop approvals. Do not load the plugin's `permissions-template.json` either.
- `AskUserQuestion` and `Agent` are not usable in a session. The plugin's session sections already route around both.

## 4. The proxy is the boundary

The hooks are belts. The session's `:8092` Lua-API proxy decides what reaches the platform: it refuses `unavailable` routes, turns production changes into action requests, and keeps writes in the session store. A turn that can run a shell can always build a command the hooks cannot see (see JOB_TIER.md §4). Nothing in session mode relies on the hooks for safety.

## 5. Checklist

- [ ] `LUA_BUILD_SESSION=1` (and the pod's `LUA_PLUGIN_HEADLESS=1`, `LUA_TELEMETRY=false`) set on the `claude` process.
- [ ] Plugin 1.17.0 or later baked into the image.
- [ ] `--mcp-config` includes `lua-session`; `--strict-mcp-config` set.
- [ ] Session deny rows (not the Job-tier rows, not the permission template).
- [ ] When the platform's B23 table changes: `lib/session-commands.mjs` and `test/lib/session-commands.test.mjs` updated together.

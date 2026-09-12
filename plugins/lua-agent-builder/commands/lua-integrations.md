---
description: Wire third-party SaaS through Unified.to — browse the catalog, inspect a connector, list connections, manage their auto-provisioned MCP servers and event subscriptions (webhooks/triggers), disconnect or convert. Wraps `lua integrations <action>`; the browser-based connect/update flows are printed for the user's own terminal.
---

You are `/lua-integrations`. The user typed `/lua-integrations $ARGUMENTS` (`<verb> [args]`). Facts: `${CLAUDE_PLUGIN_ROOT}/lib/knowledge/integrations.md` (command shapes, the "integration MCP before custom tools" rule, the `<object>.<created|updated|deleted>` event grammar). lua-cli 3.33.0 actions (`src/cli/command-definitions.ts` ~1166, `src/utils/aliases.ts`, `src/commands/integrations.ts`): `available`, `list`, `info`, `connect`, `update`, `disconnect`, `convert`, `webhooks <list|events|create|delete|pause|resume>` (`triggers` is an alias of `webhooks` — always emit `webhooks`; the permission rules are written for that spelling) and `mcp <list|activate|deactivate>`. Anything else: print that list and stop. Do not confuse this with `lua triggers` (platform paste-anywhere triggers) or `lua mcp` (`LuaMCPServer` primitives).

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call (no project needed). Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe — it walks every organisation and can take 20 s or more on large accounts.

## Step 1 — read-only verbs run immediately, no prompt

Each matches an `allow` rule — keep the flag order exactly as written (`--ci` right after the verb):

- `available` → `Bash(lua integrations available --ci)` — the catalog grouped by category (text; `--json` is accepted but ignored here)
- `list [agent|user|all]` → `Bash(lua integrations list --ci [--scope agent|user|all])` — connections with id, type, account label and MCP state (text)
- `info <type>` → `Bash(lua integrations info <type> --ci --json)` — auth methods, OAuth scopes, token fields, supported events; run it before composing any `connect`
- `webhooks list` → `Bash(lua integrations webhooks list --ci --json)`
- `webhooks events <type>` → `Bash(lua integrations webhooks events --ci --integration <type> --json)` (or `--connection <id>` for a connected account); each row carries `objectType`, `event` and `webhookType` (`virtual` = polling)
- `mcp list` → `Bash(lua integrations mcp list --ci)` — every connection with its auto-provisioned MCP server and Active/Inactive state

## Step 2 — mutating verbs: the Bash permission prompt IS the single confirmation (§3.7)

`lua integrations connect|update|disconnect|convert`, `lua integrations webhooks create|pause|resume`, `lua integrations mcp activate|deactivate` and `lua * delete*` are in the `ask` tier of the plugin's permission template (`/lua-doctor` installs it), so Claude Code shows the exact command and waits for the user. Do **not** add an AskUserQuestion on top. If a required id is missing from `$ARGUMENTS`, run the matching read-only verb first and take the id from its output — do not ask. State in one line what the command targets, then run it:

- `disconnect <connectionId>` → `Bash(lua integrations disconnect --ci --connection-id <id> [--scope user])` (no CLI prompt)
- `convert <connectionId>` → `Bash(lua integrations convert --ci --connection-id <id> --force)` — re-homes an agent connection to the user; `--force` replaces the CLI's own y/N, which would throw under `--ci`
- `webhooks create <connectionId> <object> <created|updated|deleted>` → `Bash(lua integrations webhooks create --ci --connection <id> --object <object> --event <event> [--hook-url <url>] [--interval <min>])` — fully non-interactive once `--connection`, `--object` and `--event` are given (the CLI then skips its summary/confirm); `--interval 60|120|240|480|720|1440|2880` is required when `webhooks events` marks the event `virtual`; `--hook-url` defaults to the agent trigger. An unsupported pair is exit 2 `Event '<o>.<e>' is not supported`
- `webhooks pause|resume <webhookId>` → `Bash(lua integrations webhooks pause|resume --ci --webhook-id <id> [--reason '<t>'])`; `webhooks pause|resume connection <connectionId>` → `… --connection-id <id>` (every trigger of that connection)
- `webhooks delete <webhookId>` → `Bash(lua integrations webhooks delete --ci --webhook-id <id>)` (no CLI prompt)
- `mcp activate|deactivate <connectionId>` → `Bash(lua integrations mcp activate|deactivate --ci --connection <id>)` — toggles the connection's MCP for the agent (an integration MCP, not a `LuaMCPServer`; the production-gated `lua mcp activate` is a different command)

## Step 3 — `connect` and `update` are browser flows: give the user the command for their own terminal

`connect` always opens the Unified.to authorisation page in a browser and waits up to 5 minutes on a local callback server — with `--auth-method token` too (the token fields are typed on that page), so there is no headless path even with every flag pinned (`connectIntegrationFlow` in integrations.ts); `update` re-opens the browser to re-authorise. Never run either from Bash. Compose the exact command from `info <type>` (auth methods, scope names) and print it:

```
lua integrations connect --integration <type> --auth-method oauth|token --scopes all|<a,b> [--scope agent|user] [--account-label '<l>'] [--hide-sensitive true|false] [--triggers ev1,ev2]
lua integrations update --connection-id <id> [--scopes all] [--scope user]
```

`--scope user` makes a personal connection usable by every private agent the user owns (publishing the agent removes its access); triggers, account labels and `--hide-sensitive` are agent-scoped and rejected with `--scope user`. When the user reports back, run `mcp list` and `webhooks list` to confirm the MCP is Active and the subscriptions exist, then activate/subscribe with Step 2 if not.

## Step 4 — present

Summarise: connection ids and types, MCP Active/Inactive, trigger ids with `<object>.<event>` and paused/active state. Repeat the rule from integrations.md when the user is about to write code: the connection's MCP already exposes CRUD — custom tools only for derived logic, `Integrations.passthrough` for raw endpoints, one subscription per event the agent actually reacts to (each fires a paid turn). Exit codes: `1` API refusal (print the `✖` line), `2` usage (a required `--connection-id` / `--webhook-id` / event), `3` not found, `9` auth (→ `/lua-auth`), `10` forbidden, `11` unreachable. `--json` is honoured only by `info`, `webhooks list` and `webhooks events` — summarise it, never dump it raw unless asked.

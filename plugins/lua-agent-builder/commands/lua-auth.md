---
description: Authenticate with Lua through lua-cli's private interactive login. Existing credentials (LUA_API_KEY, .env, the stored session, or the credentials file) remain valid and are never printed.
x-lua-multi-step: true
---

You are `/lua-auth`. The user wants to authenticate with the Lua platform.

## Step 1: keep a working credential

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call. Exit 0 or 10 (a typed key scoped away from the catalog route) means the credential works: then run `Bash(lua agents --json --ci)` (allow 20 s or more on accounts with many organisations), summarise the accessible organizations and agents (names and ids only) and stop. Do not replace, rotate, print, or rewrite the credential that worked. Exit 11 means the Lua API is unreachable — report that and stop; a login would not help. `Bash(lua status --json --ci)` additionally shows `auth.source` (`environment` | `stored` | `renewable session`) and `auth.credentialClass` if the user wants to know which credential is in use.

lua-cli 3.33.0 resolves credentials in this order: `LUA_API_KEY` (the environment, then a `.env` in the project), the renewable session in `~/.lua-cli/sessions/` (email + OTP login — the default), then `~/.lua-cli/credentials` (an API key). The plugin's MCP server follows the same order.

## Step 2: choose without collecting a secret

AskUserQuestion once: "Do you need a new Lua login, or do you already have a credential?" Options: `New login`, `Use an existing credential privately`, `Cancel`.

Existing credential → tell the user to run `lua auth configure` in a private terminal and choose the API-key option there, or to set `LUA_API_KEY` in their shell / the project `.env` outside this conversation. Continue to Step 4 after they confirm.

New login → run `Bash(lua --version)`. Typed scoped credentials and the renewable session need lua-cli 3.28.0 / 3.29.0 or newer (the plugin pins 3.33.0). If older, tell the user to run `/lua-update` and stop.

## Step 3: hand the secret input to the terminal

Tell the user to open a terminal outside Claude Code and run:

```bash
lua auth configure
```

For a new login they choose the email option; the CLI handles the email and one-time code in the terminal, then they select an organization, the exact agents and a role (Builder by default; the server caps it at their own authority). The CLI stores a renewable session under `~/.lua-cli/sessions/` (mode 0600). An API key chosen instead is stored at `~/.lua-cli/credentials`.

Never ask the user to paste an email, code, or credential into this conversation. Never run `lua auth configure` yourself (the hook blocks it). Ask the user to confirm when the terminal flow has finished — that question collects no account details.

## Step 4: verify

Run `Bash(lua models list --json --ci)`; on exit 0/10 run `Bash(lua agents --json --ci)` and report "✓ Authenticated; access to <N> org(s) and <M> agent(s)." Exit 9 → tell the user to rerun `lua auth configure` in the private terminal; a "session was signed out" message means a sign-out elsewhere (dashboard/app) ended the CLI session too. Exit 11 → the API is unreachable; retry later.

## Notes

- `lua auth sessions` lists the devices/apps signed in; `lua auth logout [--all]` signs out (the user runs these themselves).
- `lua auth key` prints the stored key — never run it from the plugin.
- For a full environment diagnostic, use `/lua-doctor`.

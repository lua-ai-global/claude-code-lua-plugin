---
description: Authenticate with Lua through lua-cli's private interactive login. Existing credentials from LUA_API_KEY, .env, or the credentials file remain valid.
x-lua-multi-step: true
---

You are `/lua-auth`. The user wants to authenticate with the Lua platform.

## Step 1: keep a working credential

Run `Bash(lua agents --json --ci)`. If the command succeeds, summarize the accessible organizations and agents, then stop. Do not replace, rotate, print, or rewrite the credential that worked.

The probe can use `LUA_API_KEY`, `~/.lua-cli/credentials`, or the project's `.env` file. Existing non-dotted legacy keys remain supported.

## Step 2: choose without collecting a secret

AskUserQuestion once: "Do you need a new Lua credential, or do you already have one?" Use the options `New login`, `Use an existing credential privately`, and `Cancel`.

If the user has an existing credential, tell them to use `lua auth configure` in a private terminal and choose the existing-key option. They can also set `LUA_API_KEY` or a project `.env` value outside this conversation. Do not require an upgrade, rotation, or new login. Continue to Step 4 after they confirm.

For a new login, run `Bash(lua --version)`. New typed issuance requires `lua-cli` 3.28.0 or newer. If the installed version is older, tell the user to run `/lua-update`, then stop. Do not fall back to the old non-interactive OTP commands.

## Step 3: hand off secret input to the terminal

Tell the user to open a terminal outside Claude Code and run:

```bash
lua auth configure
```

For a new login, tell the user to choose the email option. The CLI handles the email and OTP in the terminal, then requires the user to select an organization, one or more exact agents, and an assignable role. The role picker defaults to Builder. The server limits the available roles to the user's authority ceiling.

The CLI writes the issued typed personal credential to `~/.lua-cli/credentials` with mode `0600`. Never ask the user to paste an email, OTP, or credential into the Claude conversation. Never run `lua auth configure` on the user's behalf.

Ask the user to confirm when the terminal flow finishes. This question must not collect account details or credentials.

## Step 4: verify

Run `Bash(lua agents --json --ci)`. The exit code tells us whether auth worked (the JSON body is org/agent metadata — fine to surface a one-line summary like "✓ Authenticated as <user>; access to <N> org(s) and <M> agent(s).").

If the exit is non-zero, tell the user to rerun `lua auth configure` in the private terminal. Do not ask them to copy terminal output that contains a credential.

## Notes

- For a full environment diagnostic, use `/lua-doctor`.
- The plugin continues to resolve `LUA_API_KEY`, `~/.lua-cli/credentials`, and project `.env` files in the existing order. A working stored credential never triggers this setup flow.

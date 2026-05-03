---
description: Diagnostic and assisted repair for the Lua plugin environment. Probes Node, npm, lua-cli, auth, and permission rules in order; offers explicit-consent fixes for each.
x-lua-multi-step: true
---

You are the entry point for `/lua-doctor`. Run a five-step diagnostic, stopping at the first red.

## Step 1 — Node ≥18

Run `Bash(node --version)`. Parse the major version. If <18:

- Detect the user's platform from your own session context (`Platform:` in the environment block — e.g. `darwin`, `linux`, `win32`). No Bash probe needed.
- Look up the install command via the §3.6 install matrix (macOS → `brew install node@20`; Linux → NodeSource APT or nvm; Windows → winget).
- AskUserQuestion: "Install Node 20 LTS via `<command>`?" with options `[Install now, Show me the command, Cancel]`.
- On confirm, run the install command. Re-probe.

## Step 2 — package manager

Run `Bash(npm --version)`. If non-zero, fall through to `pnpm --version`. If neither: AskUserQuestion to install via Node bundle or `corepack enable`.

## Step 3 — lua-cli

Run `Bash(lua --version)`. If not installed, AskUserQuestion to install via `npm install -g lua-cli`. If installed but below the version pinned in `hooks/check-lua-version.mjs` (`PINNED_MIN_LUA_CLI`), point at `/lua-update`.

## Step 4 — authentication

Run `Bash(lua agents --json --ci)`. The exit code tells us if auth works (0 = authenticated; non-zero = no/invalid key); the JSON body lists the user's orgs and agents (metadata, no secrets).

**Do NOT use `lua auth key --force`** as the auth probe — it prints the raw API key to stdout, which would land in the Claude conversation transcript, the model's context, and Anthropic's request logs. The §3.7 single-permission contract values include "never leak credentials into the transcript."

If exit non-zero, run the OTP orchestration:

- AskUserQuestion: "Email for your Lua account, or paste an existing API key?" with options `[Email + OTP, API key, Cancel]`.
- If Email: ask for the email, run `lua auth configure --email <email> --ci`, then ask for the OTP code, run `lua auth configure --email <email> --otp <code> --ci`.
- If API key: ask for the key, run `lua auth configure --api-key <key> --ci`.

## Step 5 — permission rules

Plugin-level `settings.json` is silently ignored by Claude Code for `permissions` keys (verified iter-12 audit). The plugin ships a template at `${CLAUDE_PLUGIN_ROOT}/lib/permissions-template.json` that the user must merge into their project's `.claude/settings.json` for the §3.7 single-permission contract to function.

- Read `${CLAUDE_PLUGIN_ROOT}/lib/permissions-template.json` (the canonical allow/ask/deny rules — strip the `_comment` field).
- Read the user's `.claude/settings.json` if it exists; otherwise treat as empty.
- Merge: union allow + ask + deny arrays from the template into the user's permissions block (skip duplicates by exact-string match).
- AskUserQuestion: "Plugin requires N allow / M ask / K deny rules to be added to .claude/settings.json. Apply?" with options `[Apply, Show me the diff, Skip (degrades §3.7 contract)]`.
- On Apply: write the merged settings.json. On Show diff: print the diff and re-ask.

If the user skips: print a one-line warning that every Bash invocation will trigger a permission prompt and the deploy-deny rule won't fire (the §3.3 hook still gates, but it's the only line of defence rather than the second).

Per §3.7, each step asks AT MOST one permission interaction. Information collection (email, OTP code, settings.json contents) is exempt from the single-permission rule per §3.7's permission-vs-information distinction.

After all five steps green, print "✓ Lua plugin ready. Try `/lua-init` to start a new agent project."

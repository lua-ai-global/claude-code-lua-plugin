---
description: Diagnostic and assisted repair for the Lua plugin environment. Probes Node, npm, lua-cli, authentication and the permission rules in order; offers explicit-consent fixes for each.
x-lua-multi-step: true
---

You are the entry point for `/lua-doctor`. Run a five-step diagnostic, stopping at the first red.

## Step 1 — Node ≥ 18

Run `Bash(node --version)`. If the major is < 18: detect the platform from your session context (`darwin`, `linux`, `win32`), look up the install command (macOS `brew install node@20`; Debian/Ubuntu NodeSource APT; other Linux `nvm install 20`; Windows `winget install OpenJS.NodeJS.LTS`), and AskUserQuestion: "Install Node 20 LTS via `<command>`?" with `[Install now, Show me the command, Cancel]`. On confirm run it and re-probe.

## Step 2 — package manager

Run `Bash(npm --version)`; if non-zero try `pnpm --version`. If neither, AskUserQuestion to install via the Node bundle or `corepack enable`.

## Step 3 — lua-cli

Run `Bash(lua --version)`. Not installed → AskUserQuestion to install via `npm install -g lua-cli`. Installed but below `PINNED_MIN_LUA_CLI` in `${CLAUDE_PLUGIN_ROOT}/hooks/check-lua-version.mjs` (3.36.0 — the plugin's knowledge describes workflow verbs that do not exist below it) → point at `/lua-update`.

## Step 4 — authentication

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call. Exit 0 or 10 = authenticated; 9 = not authenticated; 11 = the Lua API is unreachable (report that instead of starting a login). `Bash(lua status --json --ci)` additionally shows `auth.source`, `auth.credentialClass` and your organisations (slower — it resolves every org).

**Never use `lua auth key`** as the probe — it prints the stored key into the transcript.

If the probe fails, use the Skill tool with `skill: "lua-auth"`. It keeps a working credential and sends a new login to `lua auth configure` in a private terminal. Do not collect an email, code or credential here.

## Step 5 — permission rules

Claude Code ignores a plugin's own `settings.json` `permissions` block, so the plugin ships `${CLAUDE_PLUGIN_ROOT}/lib/permissions-template.json` and merges it into the project's `.claude/settings.json` on consent:

- `Read` the template (strip `_comment`) and the user's `.claude/settings.json` if present.
- Merge: union the `allow`, `ask`, `deny` arrays (exact-string dedupe).
- Before merging, check the user's existing `deny` and `ask` arrays for any rule that matches a bare production verb (`lua deploy*`, `lua * deploy*`, `lua workflows deploy*`, `lua workflows activate*`, `lua version promote*`, `lua mcp activate*`, `lua marketplace template publish*|apply*`, or a catch-all like `lua *`). Claude Code evaluates deny/ask rules past a leading env assignment, so such a rule also blocks the confirmed `LUA_DEPLOY_CONFIRMED=1 …` form and `/lua-deploy` can never go live. If you find one, name it in the report and tell the user to remove it — do not delete it yourself. (Production verbs are gated by the `confirm-deploy` hook, not by deny rules.)
- AskUserQuestion: "The Lua plugin wants to add N allow / M ask / K deny rules to `.claude/settings.json` (safe read-only lua commands run without prompts; the user-confirmed `LUA_DEPLOY_CONFIRMED=1 lua deploy|workflows deploy|version promote|mcp activate|…` forms the deploy flow emits run without a second prompt; `--auto-deploy`, `lua auth configure|key|logout` and the `heylua`/`lua-ai` binaries are denied; deletes, env edits and workflow run-control ask). Apply?" with `[Apply, Show me the diff, Skip]`.
- Apply → write the merged file. Show diff → print and re-ask.

If skipped, warn once: every Bash invocation will prompt — including the confirmed deploy command, which in a non-interactive session means it is denied. The `confirm-deploy` hook still blocks bare production verbs either way.

Per §3.7 each step asks at most one permission interaction. Account details and credentials never enter this conversation.

After all five steps are green: "✓ Lua plugin ready. `/lua-status` shows the project state; `/lua-init` starts a new agent project; `/lua-architect <goal>` plans one."

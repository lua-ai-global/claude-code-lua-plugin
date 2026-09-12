---
description: Update lua-cli to the latest published version via `npm install -g lua-cli@latest` (the CLI's own `lua update` has no flags and is interactive-free but we run npm directly so the result is visible).
---

You are `/lua-update`. The user wants to update their lua-cli installation.

## Step 1 — capture the current version

Run `Bash(lua --version)`; capture as `OLD_VERSION`. The plugin targets lua-cli ≥ 3.33.0 (`PINNED_MIN_LUA_CLI` in `${CLAUDE_PLUGIN_ROOT}/hooks/check-lua-version.mjs`).

## Step 2 — confirm (single permission per §3.7)

AskUserQuestion **once**: "Update lua-cli? Current: `<OLD_VERSION>`. This runs `npm install -g lua-cli@latest`." (options: `Update now`, `Cancel`).

## Step 3 — run

`Bash(npm install -g lua-cli@latest --silent --no-fund --no-audit)`. If the install was made with `npm link` or Homebrew's node, npm may refuse or the binary may not change — report what npm says.

## Step 4 — verify

`Bash(lua --version)` → `NEW_VERSION`. Equal → "Already on latest." Otherwise "Updated: `<OLD>` → `<NEW>`. Changelog: https://docs.heylua.ai/changelog." If the new version raises the Node minimum, point at `/lua-doctor`.

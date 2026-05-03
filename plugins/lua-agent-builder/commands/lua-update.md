---
description: Update lua-cli to the latest version. Wraps `npm install -g lua-cli@latest` (lua update itself has no non-interactive flags — see §9.1).
---

You are `/lua-update`. The user wants to update their lua-cli installation.

## Step 1 — capture current version

Run `Bash(lua --version)`. Capture the output as `OLD_VERSION`.

## Step 2 — collect confirmation (single permission per §3.7)

AskUserQuestion **once**:

- "Update lua-cli? Current: `<OLD_VERSION>`. The latest will be installed via `npm install -g lua-cli@latest`." (options: `Update now`, `Cancel`)

## Step 3 — run

Run `Bash(npm install -g lua-cli@latest --silent --no-fund --no-audit)`. This is the workaround for §9.1 — `lua update` exposes no non-interactive flags.

## Step 4 — verify

Re-run `Bash(lua --version)`. Capture as `NEW_VERSION`.

If `NEW_VERSION === OLD_VERSION`, print "Already on latest." Otherwise print "Updated: `<OLD_VERSION>` → `<NEW_VERSION>`. See https://docs.heylua.ai/changelog for details."

If the new version raises Node minimum, point at `/lua-doctor`.

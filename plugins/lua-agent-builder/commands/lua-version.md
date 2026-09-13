---
description: Agent versions — atomic snapshots of the whole staged agent. List, show, diff and compare against local (`lua version list|show|diff|status`), create a snapshot (`lua version create`). Promoting a version to live (incl. rollback) goes through /lua-deploy.
---

You are `/lua-version`. The user typed `/lua-version $ARGUMENTS` (`<verb> [args]`). Agent versioning facts: `${CLAUDE_PLUGIN_ROOT}/lib/knowledge/cli-reference.md` §4–5.

## Step 0 — auth preflight (auto-resolve via Skill tool)

Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call (no project needed). Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe — it walks every organisation and can take 20 s or more on large accounts.

## Step 1 — route by verb

**Read-only, run immediately:**

- `list` → `Bash(lua version list --json)` (flags: `--status active|staged|superseded|deleted|all`, `--limit <n>`, `--all`); render version · status · message · createdAt, mark the active one.
- `show <v>` → `Bash(lua version show <v> --json)` (`3` or `v3`).
- `diff <a> <b>` → `Bash(lua version diff <a> <b> --json)`; summarise what changed per primitive.
- `status` → `Bash(lua version status)` — which local primitives differ from the active version (`mismatch` / `localBehind`).

**`create` needs one confirmation (single permission per §3.7)** — it stages a new agent version on the server (not live). Collect the message from `$ARGUMENTS` or AskUserQuestion **once**: "Create an agent version snapshot with message `<m>`? It stages the current state (pushes first if you choose auto-push)." options `[Create, Create with --auto-push (runs lua push all first), Cancel]`. Then `Bash(lua version create --ci -m '<message>' [--auto-push])`. Report the new version number. If `lua git connect` is enabled, the CLI also commits and tags `lua/v<N>`.

**Production-affecting verbs are not run here**: `promote <v>` (swap the live version — also the rollback path) and `delete <v>` → tell the user to run `/lua-deploy` with target `agent-version` for promote (it emits `LUA_DEPLOY_CONFIRMED=1 lua version promote <v>` after its own confirmation). `lua version delete <v>` is an explicit user decision — give them the command to run in a terminal (`--force` skips the CLI's confirmation, and so do `--ci` or a non-TTY stdin: the delete then runs unconfirmed, which is why this slash never runs it).

Agent versioning is server-gated per agent; an `AGENT_VERSIONING_NOT_ENABLED` refusal means the agent deploys per primitive (`/lua-deploy` with a primitive type) instead.

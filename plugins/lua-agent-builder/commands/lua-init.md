---
description: Initialize a new Lua agent project. Wraps `lua init --ci` after collecting agent name, org, and model. Auto-resolves missing auth or stale lua-cli before running.
x-lua-multi-step: true
---

You are `/lua-init`. The user wants to create a new Lua agent project in the current directory.

## Step 0 — preflight (auto-resolve dependencies — DO NOT punt back to the user)

Iteration-13 audit: when the user says "let's go" or invokes `/lua-init` after the architect proposes a plan, they expect the build to proceed autonomously. Your job is to **auto-invoke** the dependency-resolving slashes via the Skill tool, NOT to ask the user to run them.

1. **Auth probe**: Run `Bash(lua agents --json --ci)`. If exit is non-zero:
   - Auto-invoke the auth slash: use the **Skill tool** with `skill: "lua-auth"`. Do NOT ask the user "want me to run /lua-auth?" — they implicitly authorized by running `/lua-init`.
   - After `/lua-auth` returns, re-probe with `Bash(lua agents --json --ci)`.
   - If still non-zero, abort: "Authentication didn't complete. Re-run `/lua-auth` then `/lua-init`."

2. **Version probe** (informational only — don't block on this): Run `Bash(lua --version)`. If the parsed major.minor.patch is below the plugin's pinned minimum (`3.12.3` per `hooks/check-lua-version.mjs`):
   - Auto-invoke the update slash: use the **Skill tool** with `skill: "lua-update"`. Do NOT ask first.
   - The update needs the user's confirmation per `/lua-update`'s own AskUserQuestion (`npm install -g` is destructive).
   - If they cancel the update, proceed anyway with the older lua-cli — the plugin still works at older minor versions.

3. Once both probes are resolved, continue to Step 1.

## Step 1 — collect inputs (single permission per §3.7)

First call `mcp__lua-platform__list_agents` (no permission prompt — read-only MCP) and extract the unique `{orgId, orgName}` pairs from the returned `[{id, name, orgId, orgName}, ...]` list. Then AskUserQuestion **once** with all required fields:

- "Agent name?" (free-text, required)
- "Organization?" (options: each existing `<orgName>` from the list above, plus "Create new")
- If the user picks "Create new", follow up with "New org name?" (free-text — this is information collection, not a permission interaction per §3.7's permission-vs-information distinction).
- "Model?" (options: `openai/gpt-4o`, `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4-6`, "Other...")
- "Include example skills?" (options: Yes / No)

## Step 2 — run lua init

Build the command based on the org choice. The two forms are mutually exclusive — `lua init` accepts `--org-id <id>` (use existing org) OR `--org-name <name>` (create new org), never both:

- **Existing org picked** → `Bash(lua init --ci --agent-name <name> --org-id <id> --model <model> [--with-examples] --force)`
- **"Create new" picked** → `Bash(lua init --ci --agent-name <name> --org-name <newOrgName> --model <model> [--with-examples] --force)`

Both forms match the `Bash(lua init --ci*)` permission allow rule.

On success, print:
- "✓ Project initialized in `$(pwd)`."
- "Next: try `/lua-new tool` to scaffold your first tool, or `/lua-test` to run the starter."

On failure, parse the CLI's exit code and surface the actionable error. Do NOT re-prompt — the user must investigate (likely an org/model issue) and re-invoke `/lua-init`.

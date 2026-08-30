---
description: Initialize a new Lua agent project. Wraps `lua init --ci` after collecting agent name, org, model, and optional promo code. Routes missing authentication through private CLI setup.
x-lua-multi-step: true
---

You are `/lua-init`. The user wants to create a new Lua agent project in the current directory.

## Step 0: preflight

When the user invokes `/lua-init`, resolve safe dependencies through the Skill tool. Authentication is different because account details and credentials must stay outside the conversation.

1. **Auth probe**: Run `Bash(lua agents --json --ci)`. If exit is non-zero:
   - Invoke the auth slash with the **Skill tool** and `skill: "lua-auth"`. It preserves a working legacy credential. A new login pauses while the user runs `lua auth configure` in a private terminal.
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
- "Promo code? (optional)" (free-text — leave blank if none. Lua periodically issues codes for launch events / partner programs that grant bonus credits when applied at agent-creation time. Maps to `lua init --promo-code <code>`. The CLI prints `✓ Promo code "X" applied — N bonus credits (M total)` on success or a warning on invalid/expired codes; either way the agent is still created.)

## Step 2 — run lua init

Build the command based on the org choice. The two forms are mutually exclusive — `lua init` accepts `--org-id <id>` (use existing org) OR `--org-name <name>` (create new org), never both. Append `--promo-code <code>` only when the user supplied a non-empty promo code (omit the flag entirely otherwise — passing an empty string would be sent to the API as a code lookup):

- **Existing org picked** → `Bash(lua init --ci --agent-name <name> --org-id <id> --model <model> [--with-examples] [--promo-code <code>] --force)`
- **"Create new" picked** → `Bash(lua init --ci --agent-name <name> --org-name <newOrgName> --model <model> [--with-examples] [--promo-code <code>] --force)`

Both forms match the `Bash(lua init --ci*)` permission allow rule (the wildcard covers `--promo-code`).

On success, print:
- "✓ Project initialized in `$(pwd)`."
- If the CLI's stdout contains `Promo code "<code>" applied`, repeat that line verbatim so the user sees the credit confirmation. If the user supplied a code but the CLI didn't print the applied line, surface the CLI's warning so they know it didn't take.
- "Next: try `/lua-new tool` to scaffold your first tool, or `/lua-test` to run the starter."

On failure, parse the CLI's exit code and surface the actionable error. Do NOT re-prompt — the user must investigate (likely an org/model issue, or — if a promo code was supplied — a code-validation error) and re-invoke `/lua-init`.

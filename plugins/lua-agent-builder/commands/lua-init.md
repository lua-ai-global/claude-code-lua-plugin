---
description: Initialize a Lua agent project in the current directory — new agent, existing agent, or a duplicate — with `lua init --ci`. Collects name, organization, model (from the live catalog), examples and promo code; routes missing authentication through the private CLI login.
x-lua-multi-step: true
---

You are `/lua-init`. The user wants a Lua agent project in the current directory.

## Step 0 — preflight

1. **Auth probe**: Run `Bash(lua models list --json --ci)` — a 1–2 s authenticated call (no project needed). Exit 0 or 10 = authenticated (10 = a typed key scoped away from the model catalog; fine). Exit 9 = not authenticated: use the **Skill tool** with `skill: "lua-auth"`, then re-probe; if still 9, abort with the CLI error verbatim. Exit 11 = the Lua API is unreachable: abort with that line (do not start a login). Do not use `lua agents` as the probe — it walks every organisation and can take 20 s or more on large accounts. If authentication cannot be established, abort: "Authentication didn't complete. Re-run `/lua-auth` then `/lua-init`."
2. **Version probe** (informational): `Bash(lua --version)`. If below the plugin's pinned minimum (`PINNED_MIN_LUA_CLI` in `${CLAUDE_PLUGIN_ROOT}/hooks/check-lua-version.mjs`, currently 3.33.0), use the **Skill tool** with `skill: "lua-update"` — that slash asks its own confirmation. If declined, continue with the older CLI.
3. **Existing project**: if `lua.skill.yaml` exists here, say so; `lua init` over it requires `--force` (exit 2 otherwise) — only proceed if the user's request clearly means re-init.

## Step 1 — collect inputs (single permission per §3.7)

Gather the choices first: run `Bash(lua agents --json --ci)` (this walks every organisation the credential can reach — allow 20 s or more on large accounts); its output is `[{ orgId, name, agents: [{ agentId, name, visibility }] }]` — extract the org list and the agent list. Run `Bash(lua models list --json --ci)` for the model catalog (`{ models: [{ code, displayName, description }] }`); pick 4–6 sensible codes to offer (e.g. the `openai/gpt-5.4*`, `anthropic/claude-sonnet-5`, `google/gemini-3.8-flash` entries present in the list) — never invent a code.

Then AskUserQuestion **once** with:

- "New agent, existing agent, or duplicate an agent?" (options: `Create a new agent`, `Bind to an existing agent` (lists `<name> (<agentId>)` from the probe), `Duplicate an existing agent`)
- "Agent name?" (free-text; required for new/duplicate)
- "Organization?" (options: each `<orgName>` from the probe, plus "Create new org" — then also collect the new org name; information collection, not a permission)
- "Model?" (options: the catalog codes chosen above, plus `Platform default (alibaba/qwen3.8-flash — omit --model)`)
- "Include example code (skills, tools, jobs, webhooks, processors, workflows)?" (Yes / No)
- "Promo code? (optional)" (free-text; maps to `--promo-code <code>`; the CLI prints a confirmation or a warning — the agent is created either way)

## Step 2 — run lua init

Build exactly one of these (all flags verified against lua-cli 3.33.0; `--org-id` and `--org-name` are mutually exclusive; omit `--model` for the platform default; append `--with-examples` / `--promo-code <c>` only when chosen):

- New agent in an existing org → `Bash(lua init --ci --agent-name <name> --org-id <orgId> [--model <code>] [--with-examples] [--promo-code <c>] --force)`
- New agent in a new org → `Bash(lua init --ci --agent-name <name> --org-name <newOrg> [--model <code>] [--with-examples] [--promo-code <c>] --force)`
- Existing agent → `Bash(lua init --ci --agent-id <agentId> --restore-sources [--with-examples] --force)` (restores the latest source backup when one exists and pulls name/persona/model into `src/index.ts`)
- Duplicate → `Bash(lua init --ci --from-agent-id <agentId> [--org-id <orgId>] [--include-resources] [--include-custom-data] [--include-devices] [--include-ecommerce-catalog] --force)`

All match the `Bash(lua init --ci*)` allow rule. `lua init` copies the template, writes `lua.skill.yaml` (`agent.agentId/orgId`) and `src/index.ts`, then runs `npm install --force`.

## Step 3 — report

On success:
- "✓ Project initialized in `$(pwd)`: `src/index.ts` (the `LuaAgent`), `lua.skill.yaml` (CLI-managed), `env.example`." Mention `examples/` if included, with the caveat that it shows layout and builder chains but does not type-check against lua-cli 3.33.0 (`tsc --strict`: 23 errors in 10 files — `Channels.email.send` `body`→`text`, passthrough `body`→`data`, a non-existent `Payments`, `Orders.list`, `job.jobId`, unchecked `User.get()` nulls, broken relative imports) and that, being inside the template's `strict` compile graph, a plain `tsc` in the project fails until it is removed or fixed — `/lua-new` writes shapes from the plugin's knowledge base, not from those files.
- Repeat the CLI's `Promo code "<code>" applied` line if present; surface its warning if a code was given but not applied.
- "Next: `/lua-architect <goal>` to plan, `/lua-new tool <name>` for the first tool, `/lua-test` to run it, `/lua-chat` to talk to the sandbox."

On failure surface the CLI line. Exit `10` with "cannot create/duplicate agents" means the credential is a typed personal key scoped to existing agents — offer the **existing agent** path or a login with broader scope via `/lua-auth`. Do NOT re-prompt; the user re-invokes `/lua-init`.

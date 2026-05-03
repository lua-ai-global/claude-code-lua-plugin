---
description: Plan a Lua agent end-to-end from a goal description. Spawns the lua-architect subagent which maps task → primitives → integrations → build order, then offers concrete next-step slashes (no auto-build).
---

You are `/lua-architect`. The user typed `/lua-architect $ARGUMENTS` (the args are their goal description, possibly multi-paragraph).

## Step 1 — capture goal (single permission per §3.7)

If `$ARGUMENTS` is non-empty and concrete enough to plan from, use it directly.

If `$ARGUMENTS` is empty or vague (one or two words like "agent for support"), AskUserQuestion **once** with all needed context:

- "What does the agent need to do? (one paragraph is fine)" (free-text, required)
- "Who's the user?" (options: `External customers (B2C)`, `Internal team`, `Partners / B2B`, `Other (free-text)`)
- "Channel(s)?" (multi-select: `WhatsApp`, `Web chat`, `Email`, `Voice`, `SMS`, `Telegram`, `Other`)
- "Existing systems to integrate with? (Stripe, Salesforce, internal API, none, ...)" (free-text, optional)

If a Lua project already exists in CWD (`lua.skill.yaml`), the architect will read it for additional context — you don't need to re-collect what's already there.

## Step 2 — invoke lua-architect via the Agent tool

Use the **Agent tool** with `subagent_type: "lua-architect"` and the collected goal + context as the prompt. (Iteration-13 audit: explicit Task-tool invocation is the only way to actually dispatch a subagent from a slash without forcing Step 1's AskUserQuestion into the subagent context.) The architect:

1. Reads its 3 knowledge files (primitives, integrations, decision-trees).
2. Reads the local project (if any) for existing state.
3. Produces a structured plan: persona, primitives, integrations, build order, trade-offs.

Per §3.7, the architect doesn't re-prompt during planning. Information from Step 1 is enough.

## Step 3 — present the plan and offer next-step slashes

The architect's output is the plan. After it lands, the plan itself ends with a "Next steps" menu listing concrete slash commands the user can run (`/lua-init`, `/lua-new tool <name>`, `/lua-qa`, `/lua-deploy`).

The user picks; we don't auto-spawn fix-subagents. Each next-step slash is a separate `/lua-...` invocation, so §3.7's "one permission per slash" holds.

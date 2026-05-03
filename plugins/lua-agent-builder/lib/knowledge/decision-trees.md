# Decision trees

Quick-reference flowcharts the architect uses when mapping a user's task to primitives. Each tree is opinionated — it represents the *recommended* path, with deviations called out.

---

## "What kind of agent do I need?"

```
What's the agent's primary job?
├── React to user messages with information
│   └── Q&A / customer support → minimal: persona + 2-5 tools + (optional) RAG via Data API
├── Take actions in external systems
│   └── Workflow agent → persona + tools that wrap integrations + webhooks for incoming events
├── Run on a schedule
│   └── Background agent → minimal persona + Jobs that drive everything; chat surface optional
└── Multi-modal: chat + actions + scheduled work
    └── Full agent → all primitives. Plan in stages: chat first, integrations second, jobs last.
```

---

## "User said: I want to do X with my agent"

For each new feature request, walk this:

```
1. Is this triggered by a user chatting? → Tool inside a Skill
2. Is this triggered by an external event? → Webhook (subscribe via Unified.to or raw HTTP)
3. Is this triggered by time? → Job (cron) or dynamic `Jobs.create({ schedule: { type: 'once', executeAt: ... } })` (one-off)
4. Is this a uniform transformation of every message? → Pre/PostProcessor
5. Is this composing with another agent? → Agents.invoke
6. Is this a one-shot LLM call inside other logic? → AI.generate
```

If multiple apply, the agent usually needs all of them. Stage in order: tools → webhooks → jobs → processors. Test each stage before moving on.

---

## "How should I store this data?"

```
Is the data tied to a specific user?
├── Yes → User API (UserDataInstance.update / .save)
└── No
    ├── Is it agent-wide config or lookup data?
    │   └── Yes → Data API (DataEntryInstance)
    ├── Is it commerce-related (cart, order, product)?
    │   └── Yes → Baskets / Orders / Products primitives
    └── Is it a binary blob (image, PDF)?
        └── Yes → CDN (returns URL; store URL via User or Data)
```

Edge case: **never** store secrets via Data API — use `lua env` and read with `env(key)`.

---

## "Should I use an existing integration or build custom?"

```
Is the system in the Unified.to catalog (integrations.md)?
├── Yes
│   ├── Does the integration cover the operations I need?
│   │   ├── Yes → use the integration. Set up via `lua integrations connect`.
│   │   └── No (need lower-level access) → custom Tool with fetch()
│   └── Does it support webhooks for the events I care about?
│       ├── Yes → use triggers (real-time)
│       └── No → use a Job for polling (last resort)
└── No → custom Tool/Webhook with fetch(); store auth via `lua env`
```

---

## "How do I split logic across primitives?"

The pattern: **Tools do one thing. Skills group related tools. Webhooks/Jobs orchestrate.**

Anti-patterns:
- ❌ One mega-tool that does 5 things based on a `mode` parameter — split into 5 tools.
- ❌ A webhook that calls 3 tools and chains them — put the orchestration in the webhook directly, OR use `Agents.invoke` if it's complex enough to deserve its own agent.
- ❌ Per-user logic in a Job (jobs run agent-wide; if you need per-user, iterate users INSIDE the job's execute()).
- ❌ State stored in process memory — the VM doesn't persist between invocations. Use `Data` or `User`.

---

## "What's the build order?"

For a new agent:

1. **Persona first.** `lua init` then refine `agent.persona` until the basic chat feels right. Test via `/lua-chat`.
2. **One tool at a time.** Add a tool, `/lua-test` it, verify the agent picks it up correctly.
3. **Integrations last.** OAuth flows are interactive — get the local-only stuff working before introducing external dependencies.
4. **Webhooks after tools.** Webhooks usually mutate state that tools then read; build the read path first.
5. **Jobs after the rest.** Jobs are the easiest to test wrong (cron timing makes feedback slow); add them only when the rest of the agent is stable.
6. **QA pass before production.** Use `/lua-qa` against sandbox.
7. **Deploy.** `/lua-deploy` (which spawns the deploy-pilot subagent).

---

## "Do I need a single agent or multiple?"

Single agent is usually right. Reach for multiple when:

- **Distinct personas needed** — a customer-facing support agent and an internal-team admin agent shouldn't share a persona.
- **Sensitive routing** — escalating from a general agent to a billing agent that has access to payment data; smaller blast radius.
- **Cost** — a cheap front-line agent (gpt-4o-mini) escalating to a more expensive agent (claude-opus) for hard cases.

The pattern: parent agent uses `Agents.invoke(targetAgentId, prompt)` to escalate.

**Don't** split agents just for code organisation — that's what skills are for.

---

## "How do I handle authentication for users?"

Lua's `User` API auto-links across channels. The architect doesn't need to design auth — but should advise:

- For **anonymous/identified hybrid** flows (chat starts anon, user logs in mid-conversation): use a Tool that calls an internal endpoint to verify, then:
  ```ts
  const user = await User.get(verifiedId);
  if (user) await user.update({ authenticated: true });   // .update() is async + persists
  ```
- For **multi-tenant** scenarios (one agent serves multiple orgs): store `orgId` per user; partition all `Data` reads by it.
- For **handoff to a human** (live agent escalation): use a webhook to notify the human's tool (Slack, Zendesk), then on the relevant user:
  ```ts
  const user = await User.get(userId);
  if (user) await user.update({ humanHandoff: true });
  ```
  Combined with a PreProcessor that intercepts further messages while the flag is set.

**Note**: the `User` namespace exposes only `User.get()` and `User.getChatHistory()`. To mutate user data you fetch the `UserDataInstance` first and call `.update({...})` on it (async, persists immediately). Do NOT call `User.update(...)` — the namespace doesn't have it. Do NOT pass args to `.save()` — it takes no arguments and persists the instance's current `this.data` (so the pattern is `update()` for mutate-and-persist, `save()` only when you've been mutating `instance.data` directly).

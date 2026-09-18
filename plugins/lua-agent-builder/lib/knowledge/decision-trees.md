# Decision trees

Quick-reference flowcharts the architect uses when mapping a user's task to primitives. Each tree is opinionated — the *recommended* path, with deviations called out. Shapes referenced here are defined in `primitives.md`, `workflows.md`, `integrations.md`, `cli-reference.md`.

---

## "What kind of agent do I need?"

```
What's the agent's primary job?
├── Answer questions / support users              → persona + 2-5 tools (+ Data for a knowledge table, or the RAG feature via `lua features enable --feature-name rag` + `lua resources`)
├── Take actions in external systems              → integrations (MCP auto-provisioned) + tools for derived logic + integration event subscriptions
├── Run on a schedule with no chat                → LuaJob(s) for simple recurring work; a workflow with `schedule` when the job is multi-step
├── Orchestrate multi-step / long-running work    → createWorkflow (approvals, fan-out, retries, budgets, Job-tier code)
├── Talk on the phone                             → LuaVoice (+ the persona's `voice` variant, fast tools)
├── Control hardware / a local machine            → defineDevice + defineDeviceTrigger
└── Several of the above                          → one agent, built in stages: persona → tools → integrations → webhooks/triggers → jobs → workflows → QA → deploy
```

Package the finished agent for other orgs? → a marketplace **agent template** (`lua marketplace template create|draft|publish`).

---

## "User said: I want to do X with my agent"

```
1. Triggered by a user chatting?                                  → LuaTool inside a LuaSkill
2. Triggered by an external event and you want to run code?       → LuaWebhook (full request/response control)
3. Triggered by an external event and the agent should react?     → defineTrigger (message turn, one direct tool, or { startWorkflow })
   Triggered by a known SaaS event?                               → `lua integrations webhooks create` subscription + (2) or (3)
4. Triggered by time?                                             → LuaJob (cron/interval/once); "remind this user in 1 h" → dynamic Jobs.create from a tool
5. Several steps, approvals, fan-out, waiting on humans/signals, or > 10 minutes of work?   → createWorkflow
6. Uniform transform of every message / reply?                    → PreProcessor / PostProcessor
7. Composing with another agent?                                  → Agents.invoke (full turn) — or a workflow agentStep when it is one step of many
8. One-shot LLM call inside code?                                 → AI.generate
9. Proactive outbound (WhatsApp template, email, SMS, Teams)?     → Channels.* (or User.get(id).send for "their last chat channel" — it never reaches email)
10. Phone call out?                                               → Voice.call
```

If several apply, the agent usually needs all of them. Stage: tools → integrations → webhooks/triggers → jobs → workflows → processors. Test each stage before the next.

---

## "Job or workflow?"

```
Is it one unit of work under ~10 minutes with no human in the loop?
├── Yes → LuaJob (cron / interval / once) or Jobs.create for user-scheduled one-offs
└── No → createWorkflow when ANY of: several dependent steps · needs approval / a signal / an input request ·
         fan-out over a list (foreach) · retries with backoff and a credit budget · long Job-tier code (git workspace, `ctx.$`) ·
         a schedule whose fires must not overlap (`concurrencyPolicy: 'forbid'` — guards scheduled fires only; manual/API/SDK starts are not checked today, workflows.md §1) · an iterative goal with a judge
```
A workflow can itself be on a `schedule` (it becomes a platform Job) — prefer that over a LuaJob that calls `Workflows.start`.

---

## "Webhook or trigger?"

```
Do you need to shape the HTTP response, run arbitrary code, or update state without involving the agent?
├── Yes → LuaWebhook (execute({ query, headers, body }) — safeParse the body yourself, the Zod schemas are never applied; `secret` is Lua's own signature for callers you control, not for vendor-signed calls; keep it short and idempotent — deployed webhooks have no wall timeout)
└── No — the event should become an agent turn / a direct tool call / a workflow run
        → defineTrigger({ verify?, filter?, transform?, tool? }); `lua triggers create` gives you the paste-anywhere URL
```

---

## "How should I store this data?"

```
Tied to a specific user?                      → User.get(id) → .update({...}) / .patch({ set, unset })  (cross-channel profile)
Agent-wide config, lookups, cache, vector search? → Data.create/get/search — declare `index` on the fields you filter (from a `lua test` run: the deployed runtime drops `index`, primitives.md §12)
Cart / order / catalog and no external shop?  → Products / Baskets / Orders
Binary (image, PDF, audio)?                   → CDN.upload → store the fileId in Data/User
Run-scoped state inside a workflow?           → ctx.state.get/set (≤ 64 KB) and step outputs; large outputs → ctx.artefacts
Secrets?                                      → NEVER Data. `lua env production -k KEY -v …` and env('KEY')
```

---

## "Existing integration or custom code?"

```
Is the system in `lua integrations available`?
├── Yes
│   ├── Single CRUD operation → the auto-provisioned MCP (no code)
│   ├── Raw endpoint the MCP lacks → Integrations.passthrough inside a tool
│   ├── React to its events → `lua integrations webhooks create` + LuaWebhook / defineTrigger / Workflows.start
│   └── Derived computation → custom LuaTool composing MCP / passthrough results
└── No → LuaTool / LuaWebhook with fetch() + env(); consider LuaMCPServer if the vendor ships an MCP server
```

---

## "How do I split logic across primitives?"

Tools do one thing. Skills group related tools and carry shared `context`. Webhooks/triggers/jobs/workflows orchestrate.

Anti-patterns:
- ❌ One mega-tool with a `mode` parameter — split into tools with precise `description`s (the LLM picks by description).
- ❌ A webhook that chains three tools by hand — if it is that complex, make it a workflow.
- ❌ Per-user logic in a LuaJob — jobs run agent-wide; iterate users inside `execute`.
- ❌ Module-level state — the VM does not persist between invocations. Use `Data`/`User`/`ctx.state`.
- ❌ Closures in `Jobs.create` `execute` — it is serialised with `toString()`; pass data via `metadata`.
- ❌ A second `LuaMCPServer` for a SaaS that Unified.to already covers.

---

## "What's the build order?"

1. **Persona first.** `lua init`, then refine `persona` in `src/index.ts` until chat feels right (`lua chat --ci -e sandbox -m "…" -t`).
2. **One tool at a time.** `lua compile`, `lua test skill --name <tool_name> --input '{<the tool's own fields>}'` (`--name` is the TOOL, the skill is auto-resolved; there is no `"tool"` envelope), then a sandbox chat.
3. **Integrations.** OAuth is interactive — connect in a terminal, then `lua integrations mcp list`; discover the MCP's tools before writing any custom ones.
4. **Webhooks / triggers** after the read path works (they usually mutate what tools read).
5. **Jobs.** Cron feedback is slow; add them once the rest is stable. Test with `lua test job --name <n>`.
6. **Workflows.** Compile → `lua test workflow --name <n> --input @in.json --step-output … --approve …` (offline, both predicate branches) → `lua push workflow` → `lua workflows deploy <n> -v latest` → `lua workflows start … --follow`.
7. **QA** (`/lua-qa`) against sandbox; **deploy** (`/lua-deploy`) — per primitive, or `lua version create` → `promote` for the whole agent.

---

## "Single agent or several?"

Single is usually right. Split when personas must differ (customer-facing vs internal), when routing is sensitive (payments data behind a separate agent), or for cost (cheap front-line model, expensive specialist). Compose with `Agents.invoke(targetAgentId, …)`; in a workflow use `agentStep({ agentId })` per step. Don't split for code organisation — that's what skills are for. Spaces route between agents using `LuaAgent.description`.

---

## "Which model?"

Omit `model` for the platform default (`alibaba/qwen3.8-flash`). Pick from `lua models list --json` — never invent a code. Per-channel or per-request choice → a model resolver function `(req) => …`. Tune with `modelSettings` (`temperature`, `reasoning.effort`, `maxOutputTokens`).

**Per agent step inside a workflow** (⏳ lua-cli 3.36.0 or later; workflows.md §2):

```
What does the step do?                                  → taskClass                  → model
├── label / route / yes-no · pull fields · reshape data → classify · extract · transform → 'class/fast'
├── write prose · gather and summarise · grade output   → draft · research · judge      → 'class/balanced'
└── multi-step reasoning · write or review code         → reason · code                  → 'class/strong'
Needs a trait the class must satisfy?                   → requires: ['structured'] (any outputSchema) · ['vision'] · ['largeContext'] · ['codeExecution']
Must it be one exact model?                             → pin an approved code from `lua models list --workflows --json` (checked at push against the org's set); otherwise never pin
Reasoning depth?                                        → effort 'low' (tool-heavy orchestration) · 'medium' · 'high' (reason, code) — recorded only; applied from `lua push workflow --apply-effort`
```

A pushed step that names a `taskClass` must also carry a `model` (`task-class-without-model` at push). The org's ceiling and overrides are `lua workflows policy models get` (`maxClass`, `classMap`, `allow`, `pins`).

---

## "Will a workflow start without asking a person?"

Only agent-initiated starts are scored (the compose tool, a saved workflow the agent's tool starts, batch starts); `lua workflows start` / REST / SDK starts are not (workflows.md §3).

```
Estimate ≤ 15 steps AND ≤ 20 credits AND expected wall ≤ 1 h?
├── Yes → auto (nobody asked; no stamp)
└── No
    ├── org config askAboveThresholds: false                       → refuse (autonomy never changes this)
    ├── goal run or batch start                                    → ask (these legs never auto-start)
    ├── org autonomy envelope enabled (⏳ `lua workflows policy autonomy get`: enabled true)
    │   AND form admitted (default graph,static — script opts in)
    │   AND ≤ maxSteps (15) · ≤ maxCredits (20) · ≤ maxDurationSeconds (1 d) · ≤ maxActions (org consentActions)
    │   ├── hourly allowance left (maxRunsPerHour, default 20 per agent) → auto (policy) — `Consent: auto (policy) — ≤ …` on `status`
    │   └── allowance spent, or the meter unreachable                  → ask (the safe answer, never refuse)
    └── otherwise                                                  → ask: the run is `gated` (`start-consent`) until a person clears it from the desktop
```

Design for the top branch (small composed graphs, short waits — an approval or signal wait counts toward the expected wall) and put the exact `lua workflows policy autonomy set …` line in the plan when the org needs a wider envelope; it is an org-wide consent surface the plugin asks before running.

---

## "How do I handle identity / authentication for users?"

The `User` profile is cross-channel; the architect does not design auth. Patterns:

- **Anonymous → identified mid-conversation**: a tool verifies against your backend, then `const user = await User.get(); if (user) await user.update({ authenticated: true, customerId })`.
- **Multi-tenant**: store `orgId` on the user; partition `Data` filters by it (and declare an index on that field from a `lua test` run — deployed code cannot).
- **Handoff to a human**: `await user.update({ humanHandoff: true })` + a `PreProcessor` that returns `{ action: 'block', response: '…' }` while the flag is set; notify the human via `Channels.send` / a Slack or Teams integration.
- **Approvals inside automation**: a workflow `approval()` step, not a chat back-and-forth.

`User` exposes only `get`, `getChatHistory`, `Inbox.push`; mutation is on the instance (`update`, `patch`, `unset`, `save`). There is no `User.update()`.

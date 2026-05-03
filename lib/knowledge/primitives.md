# Lua primitive reference

Source-of-truth reference for every primitive `lua-architect` reasons about. When in doubt, fall back to the live lua-cli docs via `WebFetch https://docs.heylua.ai/primitives/<name>` — this file is a curated digest, not a substitute.

## Top-level container

### `LuaAgent`

The unified agent configuration object. Combines persona, skills, webhooks, jobs, preprocessors, postprocessors, MCP servers, and channels. Defined once per project in `src/agent.ts`.

**When to use**: always. Every project has exactly one.

**Knobs that matter**:
- `name` — agent identifier
- `persona` — system prompt; defines voice/tone/refusal behaviour
- `model` — `openai/gpt-4o`, `anthropic/claude-sonnet-4-6`, etc.
- `welcomeMessage` — shown on first interaction
- `skills`, `webhooks`, `jobs`, `preprocessors`, `postprocessors`, `mcpServers` — primitive arrays

**Decision rule**: if the user's task can be expressed as "Claude has [persona] + [tools]", LuaAgent is the only top-level decision. Everything else slots inside it.

---

## Functional primitives (what the agent can do)

### `LuaSkill` + `LuaTool`

A `LuaSkill` is a **named collection of related tools** with shared context. A `LuaTool` is an individual function the agent can call.

**File**: `src/skills/<skill-name>.ts` (skill) + `src/skills/tools/<tool-name>.ts` (tool).

**When to use Tool**: any time the agent needs to execute deterministic logic — fetch weather, look up a customer, compute a quote.

**When to use Skill**: when 2+ tools share context (e.g. all "shopping cart" tools share an internal cart ID), OR when you want the agent to enable/disable a *group* of tools as a feature flag.

**Tool shape (always Zod-typed)**:
```typescript
import { LuaTool } from 'lua-cli';
import { z } from 'zod';

export default class WeatherTool implements LuaTool {
  name = 'get_weather';
  description = 'Get current weather for any city';
  inputSchema = z.object({ city: z.string() });

  async execute(input: z.infer<typeof this.inputSchema>) {
    return { temperature: 72, condition: 'sunny' };
  }
}
```

**Gotcha**: tool `description` is what the LLM uses to decide *when* to call the tool. Vague descriptions = wrong tool selection. The architect should review descriptions for clarity.

### `LuaWebhook`

HTTP endpoint the agent exposes. **External systems push events to it.**

**File**: `src/webhooks/<webhook-name>.ts`.

**When to use**: any time something *outside* needs to trigger agent behaviour — Stripe payment events, Shopify order placement, GitHub PR comments, calendar invites.

**When NOT to use**: if the agent is initiating the action (use a Tool); if the trigger is time-based (use a Job); if the trigger is another agent (use `Agents.invoke`).

**Shape**:
```typescript
import { LuaWebhook } from 'lua-cli';

export default new LuaWebhook({
  name: 'stripe-payment',
  execute: async ({ body, headers, query }) => {
    // Verify webhook signature, then react
    // body = parsed JSON; headers/query = raw HTTP
  }
});
```

**Gotcha**: webhooks run OUTSIDE the conversation context. They cannot reply to a user — they can only mutate state (Data, User) or invoke an agent via `Agents.invoke` to send a proactive message.

### `LuaJob`

Scheduled background task. Cron, one-shot, or interval.

**File**: `src/jobs/<job-name>.ts`.

**When to use**: anything time-driven — daily digests, hourly polling, retry queues, end-of-day reports, abandoned-cart reminders.

**Schedule types**:
- `{ type: 'cron', pattern: '0 9 * * *' }` — daily at 9am
- `{ type: 'once', at: '2026-12-31T23:59:00Z' }` — single fire
- `{ type: 'interval', ms: 60000 }` — every N milliseconds

**Shape**:
```typescript
import { LuaJob } from 'lua-cli';

export default new LuaJob({
  name: 'daily-digest',
  schedule: { type: 'cron', pattern: '0 9 * * *' },
  execute: async (job) => {
    // job.user(userId) gives you the user context
  }
});
```

**Gotcha**: jobs are NOT a substitute for webhooks. If the trigger is "external thing happened", use a webhook. If it's "the clock said so", use a job.

### `PreProcessor` / `PostProcessor`

`PreProcessor` runs on every incoming user message *before* the agent sees it. `PostProcessor` runs on every outgoing agent response *before* the user sees it.

**Files**: `src/preprocessors/<name>.ts` / `src/postprocessors/<name>.ts`.

**When to use Pre**: filter spam, route by language, redact PII, enforce rate limits, add user context that should be invisible to the agent.

**When to use Post**: format markdown for a specific channel (WhatsApp's restricted markdown, Slack's mrkdwn), strip tool-call metadata, attach disclaimers, enforce response-length limits.

**Decision rule**: if the transformation should be **applied uniformly across the agent**, use Pre/Post. If it's specific to one tool's response, do it inside the tool's `execute()`.

**PreProcessor return shape**:

- To **block** the message reaching the agent:
  ```ts
  return { action: 'block', response: 'Sorry, I cannot help with that.', metadata?: {...} };
  ```
- To **proceed** (optionally rewriting the message):
  ```ts
  return { action: 'proceed', modifiedMessage?: ChatMessage[], metadata?: {...} };
  ```

There is no separate `'allow'` or `'modify'` action — modification happens via the `modifiedMessage` field on a `'proceed'` response.

### `LuaMCPServer`

Connect an external MCP server to your Lua agent. Lets the agent use third-party tools (filesystem, GitHub API, custom internal services).

**File**: `src/mcp/<server-name>.ts`.

**When to use**: when functionality already exists as an MCP server (your team has an internal MCP, or you want to use a public one like GitHub's). Avoids re-implementing as a custom Tool.

**When NOT to use**: if the functionality is a single function — a Tool is simpler. MCP shines when there's a coherent suite of related tools (e.g. all GitHub operations).

---

## Platform APIs (available inside any primitive's execute())

These are runtime APIs the agent's code can call. Available in tools, webhooks, jobs, processors.

### `User`

User data operations. `User.get(userId)` returns a `UserDataInstance` with `update`, `send`, `save` methods.

**When to use**: persist anything user-scoped — preferences, history, balance, subscription tier.

**Cross-channel**: a user identified by phone in WhatsApp is the same user identified by email in webchat — User API handles the linking.

### `Data`

Generic key-value store, agent-scoped (NOT user-scoped). Returns `DataEntryInstance`.

**When to use**: anything that's NOT per-user — config tables, lookup maps, feature flags, cached external API responses.

**Decision rule**: if the data lives "per user", use `User`. If it lives "per agent", use `Data`. If it lives "in an external system you control", use direct HTTP from a Tool.

### `Products`, `Baskets`, `Orders`

Built-in e-commerce primitives. `Baskets` have status `ACTIVE | CHECKED_OUT | ABANDONED | EXPIRED`; `Orders` have `PENDING | CONFIRMED | FULFILLED | CANCELLED`.

**When to use**: any commerce flow. Saves you from re-implementing carts.

**When NOT to use**: if you have an existing e-commerce backend (Shopify, WooCommerce) — use the integration's webhooks instead and let the existing system own the cart.

### `Jobs` (dynamic API)

Inside any tool, you can create a job at runtime via `Jobs.create(...)`. Different from `LuaJob` (defined-at-build-time).

```typescript
const job = await Jobs.create({
  name: `check-basket-${basketId}`,
  description: 'Check if basket was abandoned',
  schedule: {
    type: 'once',                                       // or 'cron' / 'interval'
    executeAt: new Date(Date.now() + 3 * 60 * 60 * 1000),  // for type: 'once'
  },
  metadata: { basketId, checkType: 'abandoned-cart' },  // accessible inside execute()
  execute: async (job, user) => {
    // Job logic. user gives you UserDataInstance for the metadata.userId, if any.
  },
});
// Returns a JobInstance; the job is created, versioned 1.0.0, and active.
```

**When to use**: deferred user-triggered actions ("remind me in 1 hour", "send reminder if no reply in 24h").

**Note**: the method is `Jobs.create`, NOT `Jobs.schedule`. The schedule is a NESTED object with `type: 'once' | 'cron' | 'interval'` and the appropriate timing field (`executeAt` for once, `pattern` for cron, `intervalMs` for interval). The handler is named `execute`, not `handler`.

### `Templates`

WhatsApp template messages. Required for any WhatsApp message sent OUTSIDE the 24-hour customer-service window.

**When to use**: only when the WhatsApp channel is in use. Other channels don't need templates.

### `CDN`

File upload/download. Returns URL.

**When to use**: any time the agent generates or receives binary content (images, PDFs, audio).

### `AI.generate`

Isolated AI text generation. NOT routed through the agent's persona — calls the LLM directly with your own prompt.

**When to use**: classification, summarisation, structured extraction within a tool — anything where you want a one-shot LLM call without polluting the conversation.

**When NOT to use**: anything user-facing — that's the agent's job.

### `Agents.invoke`

Call ANOTHER agent from inside this one. Goes through the full chat pipeline (persona, billing, preprocessor, postprocessor, governance).

**When to use**: agent composition — "the support agent escalates to the billing agent for refunds".

**Gotcha**: invoking another agent IS a chargeable conversation. Don't use this for cheap classification — that's `AI.generate`'s job.

### `env(key)`

Read environment variables. Set via `lua env`.

---

## Channels

Communication surface — how users reach the agent.

Available channel types (managed via `lua channels`): `whatsapp`, `telegram`, `messenger`, `webchat`, `voice` (LiveKit), `email`, `sms`.

**When the architect should care**: channel choice constrains primitive choice.
- WhatsApp → must use `Templates` for proactive messages outside the 24h window.
- Voice → response latency matters; tools should be fast or stream.
- Email → multi-paragraph responses are OK; markdown not rendered.

---

## Quick decision matrix

| Task description | Primitive |
|---|---|
| "Look up X for the user" | Tool |
| "When event happens in external system, do Y" | Webhook |
| "At time T, do Z" | Job |
| "Filter messages before the agent sees them" | PreProcessor |
| "Reformat the agent's responses for channel X" | PostProcessor |
| "Persist preference per user" | `User` API |
| "Cache lookup table across users" | `Data` API |
| "Composable tool suite from external system" | LuaMCPServer (or new Tool if it's just one) |
| "Classify or summarise inside a tool" | `AI.generate` |
| "Hand off to another agent" | `Agents.invoke` |
| "Schedule a one-off action triggered by user" | dynamic `Jobs.create` (not LuaJob — see correction above) |
| "Send proactive WhatsApp outside 24h window" | `Templates` |
| "Store image/PDF" | `CDN` |

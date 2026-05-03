# Integrations reference

Lua agents connect to external systems through **four layers**, in order of preference:

1. **Built-in channels** (WhatsApp, voice, etc.) — handled by `lua channels`. For user-facing messaging surfaces.
2. **Unified.to integrations** — managed via `lua integrations`. Catalog below. **Each integration comes with an auto-provisioned MCP server** (see [Architecture pattern](#architecture-pattern-the-right-way-to-use-integrations)) that exposes the integration's CRUD to the agent. This is the canonical way to connect to known SaaS systems.
3. **Webhook triggers** for the integration — fire when state changes in the external system (new event, updated record, etc.).
4. **Custom HTTP** — only when none of the above fit. Build a Tool or Webhook with `fetch()`.

This catalog is curated for the architect's decision-making — fall back to `WebFetch https://docs.heylua.ai/integrations` for the live source-of-truth.

---

## Architecture pattern: the right way to use integrations

**THE MOST COMMON ARCHITECT MISTAKE**: proposing custom tools (`list_events`, `create_event`, `update_record`, etc.) when the integration's MCP server already exposes those operations. **Don't do this.** Custom tools are for **derived logic** the MCP doesn't cover.

### When the user wants to build an agent that talks to an external system, the canonical flow is:

1. **Pick the integration** (`crm`, `calendar`, `messaging`, etc. from the catalog below).
2. **Connect via OAuth**: `lua integrations connect --integration <name>` — opens a browser for OAuth, creates a connection, and **auto-provisions an MCP server** for that connection. The MCP exposes the integration's read/write API as MCP tools the agent can call.
3. **Activate the MCP for the agent**: `lua integrations mcp activate --connection <connection-id>`. The agent now has direct access to the integration's CRUD without you writing any tool code.
4. **Add webhook triggers** for events the agent should react to: `lua integrations webhooks create` (interactive) — picks an object type (`calendar_event`, `task_task`, etc.) and event type (`created`, `updated`, `deleted`).
5. **Add custom tools ONLY for derived logic** not exposed by the MCP — e.g., "find optimal meeting slot given participants' availability" (needs to query calendar + apply business logic), "send Slack notification when calendar event is created" (needs to compose two integrations).

### Concrete example: Google Calendar agent

**Wrong** (what the architect used to do):

> "Build a `calendar` skill with three tools: `list_upcoming_events`, `find_free_slots`, `create_event`."

This duplicates what the integration's MCP already provides.

**Right**:

> "Connect Google Calendar via `lua integrations connect --integration googlecalendar`. Activate the MCP via `lua integrations mcp activate --connection <id>` — the agent now has read/write calendar access through MCP tools (no code needed). Add webhook triggers for `calendar_event.created` and `calendar_event.updated` if the agent should react to changes. The only custom tool worth building is `find_optimal_meeting_slot` — it queries the MCP to get availability across multiple calendars and applies scheduling logic the MCP can't do on its own."

The MCP server provides operations like `list-events`, `get-event`, `create-event`, `update-event`, `delete-event`, `list-calendars`, etc. — directly accessible to the agent. **Don't assume — verify the actual tool surface before planning custom tools:**

- `lua integrations mcp list` → shows MCP **status** for each connection (Active / Inactive). Use this to confirm the MCP is activated, not to list tools.
- To list the tools the MCP exposes, either (a) inspect the user's Claude Code session for `mcp__<integration>__*` entries, or (b) run `lua chat -e sandbox -m "Enumerate every tool you have available, grouped by source. Don't call any." -t mcp-discovery-1` and have the agent itself recite its tool surface.

Coverage varies by integration and by OAuth scopes granted; the catalog gives you the shape, the discovery step gives you the truth.

### Decision tree for "do I need a custom tool?"

```
User wants the agent to do X involving an integration.
├── Is X a single CRUD operation on the integration's API?
│   └── YES → use the integration's MCP. No custom tool. Done.
├── Is X a "react to event Y in the integration"?
│   └── YES → add a webhook trigger via `lua integrations webhooks create`. Maybe one
│             custom LuaWebhook to do something with the event payload. Done.
├── Is X a derived computation across multiple data points (find best slot,
│   summarize last week's meetings, detect duplicates)?
│   └── YES → custom Tool that queries the MCP under the hood + applies the logic
└── Is X cross-integration (calendar + Slack, CRM + email)?
    └── YES → custom Tool or Webhook that orchestrates calls across multiple MCPs
```

### What the architect's plan should look like

For an agent that uses an integration, the plan section should be:

```markdown
## Integration setup
- `lua integrations connect --integration <name>`  → OAuth + MCP auto-provisioned
- `lua integrations mcp activate --connection <id>` → MCP available to the agent

## Webhooks (only the events the agent should react to)
- `<object_type>.<event>` — e.g. `calendar_event.created` to react to new meetings

## Tools (only the derived logic NOT exposed by the MCP)
- `find_optimal_meeting_slot` — queries calendar via MCP, applies scheduling logic
- (if no derived logic needed: NONE — the MCP is the agent's interface)
```

---

## Decision flow

```
External system needed?
├── Yes — does Lua have a built-in channel for it (whatsapp, voice, email, sms, etc.)?
│   ├── Yes → use Channel (run `lua channels` and follow the interactive prompts —
│   │         there is no non-interactive `add` action)
│   └── No — is it a known SaaS (Stripe, Gmail, Salesforce, Google Calendar, ...)?
│       ├── Yes → Unified.to integration:
│       │       1. `lua integrations connect --integration <name>` (OAuth + MCP auto-
│       │          provisioned)
│       │       2. `lua integrations mcp activate --connection <id>` (agent gets MCP
│       │          access — most CRUD operations are now available without writing
│       │          any tool code)
│       │       3. `lua integrations webhooks create` (only for the events the agent
│       │          should react to — don't subscribe to everything)
│       │       4. Custom Tools/Webhooks ONLY for derived logic the MCP doesn't
│       │          expose (cross-integration orchestration, business-specific
│       │          computations)
│       └── No → custom Tool/Webhook with fetch()
└── No — task is self-contained → just a Tool with logic
```

---

## Built-in channels

| Channel | Use when | Gotchas |
|---|---|---|
| `whatsapp` | B2C messaging, mobile-first audiences | 24h customer-service window; `Templates` required outside it |
| `telegram` | International / privacy-conscious audiences | Bot-API based; no proactive without prior interaction |
| `messenger` | Facebook-native flows | 24h window similar to WhatsApp |
| `webchat` | Embed in your website | `Lua.request.channel === 'webchat'` to detect |
| `voice` | Phone or LiveKit-room interactions | Tool latency matters more (<2s); responses are TTS'd |
| `email` | Long-form async exchanges | Markdown not rendered; structure with plain text or HTML |
| `sms` | Quick transactional alerts | 160-char segments; cost-per-message |

---

## Unified.to integration catalog

Lua uses Unified.to for SaaS connectors. **Every connector comes with an MCP server** (auto-provisioned on `lua integrations connect`) that exposes the connector's CRUD operations as MCP tools. **Canonical category list**:

| Category    | What it covers              | Common integrations the architect should know |
|-------------|------------------------------|------------------------------------------------|
| `crm`       | Customer relationship mgmt   | Salesforce, HubSpot, Pipedrive, Zoho           |
| `commerce`  | E-commerce platforms         | Shopify, WooCommerce, BigCommerce              |
| `payment`   | Payments / subscriptions     | Stripe                                         |
| `accounting`| Books / invoicing            | Xero, QuickBooks, Sage                         |
| `calendar`  | Scheduling                   | Google Calendar, Outlook Calendar, Calendly    |
| `messaging` | Chat / channels              | Slack, Discord, Microsoft Teams                |
| `uc`        | Unified communications / email | Gmail, Outlook, Zoom                         |
| `ticketing` | Support / helpdesk           | Zendesk, Intercom, Freshdesk                   |
| `task`      | Task / project management    | Asana, Trello, Monday, Jira                    |
| `repo`      | Code repositories            | GitHub, GitLab, Bitbucket                      |
| `storage`   | File storage                 | Google Drive, Dropbox, OneDrive                |
| `kms`       | Knowledge management         | Notion, Confluence                             |
| `martech`   | Marketing automation         | Mailchimp, Klaviyo, ActiveCampaign             |
| `ads`       | Ad platforms                 | Google Ads, Facebook Ads                       |
| `forms`     | Form builders                | Typeform, Google Forms, Jotform                |
| `enrich`    | Data enrichment              | Clearbit, Apollo, ZoomInfo                     |
| `genai`     | Generative AI APIs           | OpenAI, Anthropic                              |
| `hris`      | HR information systems       | BambooHR, Workday, Rippling                    |
| `ats`       | Applicant tracking           | Greenhouse, Lever, Workable                    |
| `lms`       | Learning management          | Cornerstone, Docebo                            |
| `scim`      | Identity provisioning        | Okta, Azure AD                                 |
| `shipping`  | Shipping / fulfilment        | Shippo, EasyPost                               |

The category names are **canonical** — they're what `lua integrations list` returns and what the architect's recommendations should reference. The integration roster within each category comes from Unified.to's catalog and is **runtime-discoverable** via the `lua integrations` command. Don't claim a specific connector exists if you're not sure; instead say "in the `<category>` category" and let the user confirm via the live list.

### Role-based suggestion shortcuts (lua-api feature)

The lua-api server defines a `KEYWORD_CATEGORY_MAP` that maps user roles to relevant categories:

| User role          | Suggested categories                               |
|--------------------|----------------------------------------------------|
| `executive`        | crm, accounting, calendar, genai                   |
| `sales`            | crm, commerce, payment, enrich                     |
| `customer_support` | ticketing, uc, messaging, crm                      |
| `marketing`        | martech, ads, forms, enrich, crm                   |
| `engineering`      | task, repo, genai, kms                             |
| `operations`       | accounting, storage, task, commerce, shipping     |
| `product`          | task, genai, kms, forms                            |
| `hr`               | hris, ats, lms, scim                               |

When the architect asks "Who's the user?" in Step 1, it should map the answer to one of these roles and lead with the corresponding categories rather than enumerating from scratch.

---

## Triggers (webhooks) vs polling

Lua exposes integration events via two mechanisms:

- **Triggers** — `lua integrations webhooks create` sets up a Unified.to webhook → Lua webhook → your `LuaWebhook` runs. Real-time. **Always preferred.**
- **Polling** — a `LuaJob` that calls the MCP (or the integration's REST API directly) on a schedule. Last resort, only when triggers aren't supported by the integration or the trigger frequency is impractical (e.g. you only need a daily snapshot).

### Setting up triggers

**Two paths — pick one based on whether the events are decided up front:**

**Path A — inline at connect time** (recommended when you already know which events the agent should react to):

```bash
lua integrations connect --integration <name> --auth-method oauth --scopes all \
  --triggers <event1>,<event2>,<event3>
# Example:
lua integrations connect --integration googlecalendar --auth-method oauth --scopes all \
  --triggers calendar_event.created,calendar_event.updated,calendar_event.deleted
```

**Path B — discover-then-subscribe** (when you want to start with the MCP and layer in triggers later):

```bash
# 1. Connect (no triggers — they're opt-in by default since v3.8)
lua integrations connect --integration <name> --auth-method oauth --scopes all

# 2. Discover what's available
lua integrations webhooks events --integration <name> --json

# 3. Check what's already active (avoid duplicates)
lua integrations webhooks list --json
# (filter by connectionId in the output to see this integration's triggers)

# 4. Subscribe to one event
lua integrations webhooks create
# (interactive: picks connection, object, event)
# OR alias: lua triggers create
```

The trigger will POST to a Lua-managed webhook endpoint. You then write a `LuaWebhook` primitive to handle the payload — typically the handler extracts the payload's relevant fields and calls `Agents.invoke` with a system message instructing the agent what to do (e.g. "A new meeting was added: <details>. Acknowledge and offer to prep a summary."). The MCP exposes the integration's API; the webhook handler tells the agent **what to do when the event arrives**.

### Manage existing triggers

Once subscribed, you can list/pause/resume/delete from the CLI (added in v3.10 as the top-level `lua triggers` command):

```bash
lua triggers list                          # all triggers across all connections
lua triggers pause   --webhook-id <id>     # suspend a single trigger
lua triggers resume  --webhook-id <id>     # restore a single trigger
lua triggers pause   --connection-id <id>  # suspend all triggers on a connection
lua triggers delete  --webhook-id <id>     # remove permanently
```

Status icons in the list output: ✅ active, ⏸️ paused by you, 💳 credit-suspended, 🔴 unhealthy (needs re-auth), ⚪ paused externally.

---

## Integration auth

Unified.to integrations require OAuth — handled via `lua integrations connect` which opens a browser. The architect should:

1. Identify which integration is needed.
2. Tell the user to run `lua integrations connect --integration <name>` (Tier C terminal pass-through — opens browser for OAuth).
3. After OAuth completes, the connection ID is shown; the user runs `lua integrations mcp activate --connection <connection-id>` to make the MCP available to the agent.
4. Configure triggers if real-time events are needed: `lua integrations webhooks create` (interactive) or `lua triggers create` (alias). Don't confuse this with `lua webhooks subscribe`, which is for user-defined `LuaWebhook` primitives subscribing to PLATFORM events like `message.delivered`.

---

## When to build custom tools (the rare cases)

After the integration's MCP is activated, the agent can already do most CRUD operations. **Don't build custom tools that duplicate MCP capabilities.** Custom tools (and custom webhook handlers) are appropriate when:

1. **Derived computations** the MCP doesn't expose:
   - "Find the next 30-min slot when both Alice and Bob are free" → custom tool that queries calendar via MCP, applies overlap logic
   - "Summarize last quarter's deals over $10k" → custom tool that queries CRM via MCP, applies filtering + summarization
2. **Cross-integration orchestration**:
   - "When a calendar event is created, post a summary to Slack" → custom webhook that handles the calendar trigger, then calls the Slack MCP
3. **Custom output formatting**:
   - "Render upcoming meetings as a markdown agenda the user can copy-paste" → custom tool that queries calendar via MCP, formats the output
4. **Integration not in the catalog**:
   - Internal company API → custom Tool with `fetch()`
5. **MCP doesn't expose the operation you need**:
   - Some integrations have limited MCP surface; run `lua integrations mcp list` after connecting to see all your connections and their MCP status. The exposed MCP tools are visible in the agent's session via the `mcp__<integration>__*` tool prefix once activated.

**Pattern for custom tools that compose with an MCP**:

```typescript
import { LuaTool } from 'lua-cli';
import { z } from 'zod';

export default class FindOptimalSlotTool implements LuaTool {
  name = 'find_optimal_slot';
  description = 'Find the next 30-minute window when all listed participants are free';
  inputSchema = z.object({
    participants: z.array(z.string()),  // emails
    durationMinutes: z.number().default(30),
    horizonDays: z.number().default(7),
  });

  async execute({ participants, durationMinutes, horizonDays }: z.infer<typeof this.inputSchema>) {
    // The agent's main loop calls list-events (Calendar MCP) for each
    // participant — this tool just composes the results.
    // (In practice, the agent does the MCP calls; this tool receives
    // pre-fetched calendar data and applies the slot-finding logic.)
    // ...
  }
}
```

**Pattern for custom HTTP tools** (integration not in catalog, or internal API):

```typescript
import { LuaTool, env } from 'lua-cli';
import { z } from 'zod';

export default class CustomApiTool implements LuaTool {
  name = 'create_invoice';
  description = 'Create an invoice in our internal billing system';
  inputSchema = z.object({ customerId: z.string(), amount: z.number() });

  async execute({ customerId, amount }: z.infer<typeof this.inputSchema>) {
    const res = await fetch(`${env('BILLING_API')}/invoices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('BILLING_API_KEY')}` },
      body: JSON.stringify({ customerId, amount }),
    });
    return await res.json();
  }
}
```

**Auth**: store secrets via `lua env --key BILLING_API_KEY --value ...`. Never hardcode.

---

## Cost model considerations

When recommending integrations, the architect should mention cost surfaces:

- **Unified.to connectors** — per-API-call pricing on Lua's side. MCP calls are also per-call.
- **WhatsApp Business** — per-message cost via Meta.
- **Voice (LiveKit)** — per-minute billing.
- **AI.generate** — per-token; cheap LLM calls for classification.
- **Agents.invoke** — full chat pricing; expensive for cheap classification.

Don't over-spec on integrations the user won't actually use. Recommend the minimum viable set and note where to expand later.

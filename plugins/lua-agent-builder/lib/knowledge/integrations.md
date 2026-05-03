# Integrations reference

Lua agents connect to external systems through three layers:

1. **Built-in channels** (WhatsApp, voice, etc.) — handled by `lua channels`.
2. **Unified.to integrations** — managed via `lua integrations` (Tier C, terminal-pane handoff). Catalog below.
3. **Custom HTTP** — when none of the above fit. Build a Tool or Webhook with `fetch()`.

This catalog is curated for the architect's decision-making — fall back to `WebFetch https://docs.heylua.ai/integrations` for the live source-of-truth.

---

## Decision flow

```
External system needed?
├── Yes — does Lua have a built-in channel for it?
│   ├── Yes → use Channel (run `lua channels` and follow the interactive prompts — there is no non-interactive `add` action)
│   └── No — is it a known SaaS (Stripe, Gmail, Salesforce, ...)?
│       ├── Yes → use Unified.to integration (lua integrations connect)
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

Lua uses Unified.to for SaaS connectors. **Canonical category list**:

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

The category names are **canonical** — they're what `lua integrations list` returns and what the architect's recommendations should reference. The integration roster within each category comes from Unified.to's catalog and is **runtime-discoverable** via the `lua integrations` command (Tier C — interactive). Don't claim a specific connector exists if you're not sure; instead say "in the `<category>` category" and let the user confirm via the live list.

### Role-based suggestion shortcuts (lua-api feature)

The lua-api server defines a `KEYWORD_CATEGORY_MAP` that maps user roles to relevant categories. The architect should leverage this when the user describes the agent's audience:

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

## Triggers vs polling

Lua exposes integrations via two mechanisms:

- **Triggers** — Unified.to webhooks → Lua webhook → your `LuaWebhook`. Real-time. Preferred.
- **Polling** — a `LuaJob` that calls the integration's API directly via `fetch()` (passing the connection's bearer token from `env`), or hits Unified.to's REST endpoints. The CLI does not expose a generic data-fetch subcommand under `lua integrations`.

**Decision**: always prefer triggers when the integration supports them. Polling is only for systems without webhooks (rare) or when the trigger frequency is impractical (e.g. you only need a daily snapshot).

---

## When to build custom

Use a custom Tool with `fetch()` when:

1. The integration isn't in the Unified.to catalog above.
2. The Unified.to abstraction loses fidelity you need (e.g. you need raw Salesforce SOQL, not the abstracted Lead/Contact shape).
3. You're integrating with an internal system (your own API).

**Pattern**:
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

## Integration auth

Unified.to integrations require OAuth — handled via `lua integrations connect` which opens a browser. The architect should:

1. Identify which integration is needed.
2. Tell the user to run `/lua integrations connect <name>` (Tier C terminal pass-through per §3.1.2).
3. After connection, identify the connection ID via `lua integrations list`.
4. Configure Unified.to triggers if real-time events are needed: `lua integrations webhooks create` (interactive) or `lua triggers create` (alias). Don't confuse this with `lua webhooks subscribe`, which is for user-defined `LuaWebhook` primitives subscribing to PLATFORM events like `message.delivered`.

---

## Cost model considerations

When recommending integrations, the architect should mention cost surfaces:

- **Unified.to connectors** — per-API-call pricing on Lua's side.
- **WhatsApp Business** — per-message cost via Meta.
- **Voice (LiveKit)** — per-minute billing.
- **AI.generate** — per-token; cheap LLM calls for classification.
- **Agents.invoke** — full chat pricing; expensive for cheap classification.

Don't over-spec on integrations the user won't actually use. Recommend the minimum viable set and note where to expand later.

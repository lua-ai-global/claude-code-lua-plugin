# Integrations reference (lua-cli 3.33.0)

Lua agents connect to external systems through **four layers**, in order of preference:

1. **Built-in channels** (WhatsApp, Messenger, Instagram, Slack, Teams, email, website widget, HTTP API, voice) — user-facing messaging surfaces, managed via `lua channels` and the admin dashboard.
2. **Unified.to integrations** — `lua integrations connect --integration <type>`. Every connection **auto-provisions an MCP server** that exposes the integration's CRUD to the agent, and can be called raw from code with `Integrations.passthrough`. The canonical way to talk to known SaaS.
3. **Integration event subscriptions** — `lua integrations webhooks …` (alias `lua integrations triggers …`) fire when state changes in the external system and wake the agent.
4. **Custom HTTP** — only when none of the above fit: a `LuaTool`/`LuaWebhook` with `fetch()` and secrets from `env()`.

Command shapes below are verified against `command-definitions.ts` (lua-cli 3.33.0). The live integration catalog is server-side: `lua integrations available --ci --json` is the truth for what exists.

---

## The commands

```bash
lua integrations available                                           # catalog (250+ connectors grouped by category; text)
lua integrations list [--scope agent|user|all]                       # this agent's / your personal connections (text)
lua integrations info <integration-type> [--json]                    # one connector: auth methods, OAuth scopes, token fields, events
lua integrations connect --integration <type> [--auth-method oauth|token] [--scopes all|a,b] [--scope agent|user]
                         [--account-label <l>] [--hide-sensitive true|false] [--triggers ev1,ev2,…]
                         # ALWAYS a browser round-trip: opens the Unified.to authorisation page (token credentials are typed
                         # there too) and waits ≤ 5 min on a local callback server — the user's own terminal, never the plugin
lua integrations update --connection-id <id> [--scopes all] [--scope user]   # re-authorise one connection in place (browser again)
lua integrations convert --connection-id <id> --force                # re-home an agent connection to yourself (y/N without --force)
lua integrations disconnect --connection-id <id> [--scope user]      # no prompt
lua integrations mcp list | activate --connection <id> | deactivate --connection <id>
lua integrations webhooks list [--json] | events (--integration <type> | --connection <id>) [--json]
                         | create --connection <id> --object <type> --event created|updated|deleted --hook-url <url> [--interval 60|120|240|480|720|1440|2880]
                         | delete --webhook-id <id> | pause --webhook-id <id> [--reason <t>] | resume --webhook-id <id>
                         | pause --connection-id <id> | resume --connection-id <id>       # all triggers of a connection
```

- ⚠ `--json` is honoured only by `info`, `webhooks list` and `webhooks events` (`src/commands/integrations.ts`); `available`, `list` and `mcp list` accept the flag and print text anyway.
- `webhooks create` is non-interactive **only when `--connection`, `--object`, `--event` and `--hook-url` are all given** (`src/commands/integrations.ts` ~2959-2984: without `--hook-url` it prompts "Where should events be sent?" → exit 1 under `--ci`); `--interval 60|120|240|480|720|1440|2880` is likewise required for an event `webhooks events` marks `virtual` (polling; ~3028-3042). There is **no `--hook-url` default** — the prompt's "Wake up my Lua agent" choice resolves to `AGENT_WEBHOOK_URL` = `<LUA_API_URL>/webhook/unifiedto/data`, i.e. `https://api.heylua.ai/webhook/unifiedto/data` by default — pass that explicitly to wake the agent. Without `--connection` it prompts (exit 1 under `--ci`). `disconnect`, `webhooks delete|pause|resume`, `mcp activate|deactivate` never prompt. Slash: `/lua-integrations`.
- ⚠ **Ignore the post-connect hint.** A successful `connect` ends with `⚡ Triggers: none (add later with: lua triggers create --connection <id>)` (`integrations.ts` ~1459). That command is a tombstone: `lua triggers` treats `--connection` as a moved flag, prints "Integration triggers now live at `lua integrations webhooks <action>`" and returns exit 0 without creating anything (`src/commands/triggers.ts` ~76-86). The working follow-up is `lua integrations webhooks create --connection <id> --object <object> --event <event> --hook-url https://api.heylua.ai/webhook/unifiedto/data [--interval <min>]`.

- `--scope user` makes a **personal** connection usable by every private agent you own (publishing the agent removes its access). Triggers, account labels and `--hide-sensitive` are agent-scoped only.
- Multiple accounts of one integration are supported; use `--connection-id` to target one.
- **`lua triggers` is NOT for integrations any more.** Since 3.18 `lua triggers <list|create|logs|activate|deactivate|rotate-token|delete>` manages *platform* triggers (paste-anywhere URLs and `defineTrigger` records). Passing the old integration flags (`--webhook-id`, `--connection-id`) to it only prints a redirect. Integration subscriptions are `lua integrations webhooks …`.
- Don't confuse either with `lua webhooks subscribe --webhook-name x --event message.delivered`, which subscribes one of **your** `LuaWebhook` primitives to *platform* events (delivery receipts etc.).

---

## Architecture pattern: the right way to use an integration

**The most common architect mistake** is proposing custom tools (`list_events`, `create_record`, `send_message`) that the integration's auto-provisioned MCP already exposes. Custom tools are for *derived* logic the MCP does not cover.

```
The agent needs to do X with an external system.
├── X is a single CRUD operation on a known SaaS?         → the integration's MCP. No custom tool.
├── X is "react when Y happens in the SaaS"?              → lua integrations webhooks create (one event) + a LuaWebhook / defineTrigger
│                                                            that tells the agent what to do, or Workflows.start for a multi-step reaction
├── X needs the provider's raw API (a diff, an endpoint the MCP lacks)? → Integrations.passthrough(<type>, { method, path, … }) inside a tool
├── X is a derived computation (best slot, dedupe, summarise)? → a custom LuaTool that composes MCP data / passthrough calls
├── X is cross-integration (calendar + Slack)?            → a LuaWebhook or workflow that orchestrates both
└── X is not in the catalog (internal API)?               → custom LuaTool / LuaWebhook with fetch() + env('API_KEY')
```

### Concrete flow for "an agent that talks to Google Calendar"

```bash
lua integrations connect --integration googlecalendar --auth-method oauth --scopes all \
  --triggers calendar_event.created,calendar_event.updated      # OAuth in the browser; MCP auto-provisioned; two triggers inline
lua integrations mcp list                                        # confirm the MCP is Active for the connection
lua integrations mcp activate --connection <connection-id>       # if not
lua integrations webhooks events --integration googlecalendar --json   # what else the connector can emit
lua integrations webhooks list --json                            # what is already subscribed (avoid duplicates)
```

Then the only custom code is (a) a `LuaWebhook` or `defineTrigger` that reacts to the subscribed events and (b) tools for derived logic (e.g. `find_optimal_meeting_slot`). Discover the MCP's actual tool names before planning anything custom: in a Claude Code session the connection's tools show up as `mcp__<integration>__<tool>`, or run `lua chat --ci -e sandbox -m "List every tool you have available, grouped by source. Do not call any." -t mcp-discovery-1` and let the agent recite its surface.

### Raw provider access from code

```ts
import { Integrations } from 'lua-cli';
const diff = await Integrations.passthrough('github', { method: 'GET', path: 'repos/acme/app/pulls/42', headers: { Accept: 'application/vnd.github.diff' } });
if (diff.status !== 200) throw new Error(`github ${diff.status}`);   // provider errors come back in `status`, not thrown
await Integrations.passthrough('github', { method: 'POST', path: 'repos/acme/app/pulls/42/reviews', data: { event: 'APPROVE' } });
```
The agent's own connection for that integration type is used; credentials never reach your code. Workflows declare connections by key (`connections: [{ key: 'github', integrationType: 'github' }]`) and Job-tier coding turns mount them via `toolScope.connectionIds` — see workflows.md.

---

## Decision flow

```
External system needed?
├── Yes — is it a messaging surface users talk to (WhatsApp, Messenger, Instagram, Slack, Teams, email, web, voice)?
│   ├── Yes → a channel: run `lua channels` interactively (only `list` is non-interactive) or use the admin dashboard
│   └── No — is it in `lua integrations available`?
│       ├── Yes → connect (OAuth + MCP), activate the MCP, subscribe only to the events the agent reacts to,
│       │         custom tools ONLY for derived logic; raw endpoints via Integrations.passthrough
│       └── No → custom LuaTool / LuaWebhook with fetch(); secrets via `lua env production -k KEY -v …` + env('KEY')
└── No — self-contained → just a tool
```

---

## Built-in channels

| Channel | Use when | Gotchas |
|---|---|---|
| `whatsapp` | B2C, mobile-first | 24 h customer-service window; proactive sends outside it need an approved template (`Channels.whatsapp.sendTemplate`) |
| `facebook` (Messenger), `instagram` | social DMs | warm-only for outbound (a prior inbound message is required) |
| `slack`, `teams` | internal teams | Teams group chats: `Channels.send({ channel:'teams', to:{ conversationId } })`, never persisted to a user thread; Teams BYO Azure bot supported |
| `web` / `pop` (website widget / chat API) | embed on a site, programmatic chat | the deployed widget sends `channel=pop`, so `Lua.request.channel` is `'pop'` for widget turns and `'web'` for the HTTP chat API and other web clients — compare against both (primitives.md §12; the `Channel` typing still spells only `'web'`); widget SDK docs under `/chat-widget/*` |
| `email` | long-form async | plain text / HTML, no markdown rendering; `Channels.email.send` for proactive (body is `text` / `html` / `richBody`; needs an email channel linked to the agent — or the platform's global one — and a recipient address or a user with a prior email conversation) |
| `sms` | transactional alerts | outbound via `Channels.send({ channel:'sms' })`; inbound capabilities are partial (see `/channels/channel-capabilities`) |
| voice (phone / LiveKit / browser) | calls | a `LuaVoice` on the agent; tool latency matters; `Voice.call` for outbound |

Telegram is **not** available (docs: coming soon). Detect the inbound channel with `Lua.request.channel`.

---

## Unified.to categories (for planning; the roster is runtime-discoverable)

`crm` (Salesforce, HubSpot, Pipedrive, Zoho) · `commerce` (Shopify, WooCommerce, BigCommerce) · `payment` (Stripe) · `accounting` (Xero, QuickBooks) · `calendar` (Google Calendar, Outlook) · `messaging` (Slack, Discord, Teams) · `uc` (Gmail, Outlook, Zoom) · `ticketing` (Zendesk, Intercom, Freshdesk) · `task` (Linear, Jira, Asana, Trello, Monday) · `repo` (GitHub, GitLab, Bitbucket) · `storage` (Drive, Dropbox, OneDrive) · `kms` (Notion, Confluence) · `martech` (Mailchimp, Klaviyo) · `ads` · `forms` · `enrich` · `genai` · `hris` · `ats` · `lms` · `scim` · `shipping`.

Say "in the `<category>` category" when unsure whether a specific connector exists, and let `lua integrations available` settle it. Two families exist and the docs have a page for each of the second: Shopify and WooCommerce are ALSO Unified.to connectors (`lua integrations available` lists `shopify` and `woocommerce`, token auth via `lua integrations connect`), while the catalog integrations documented at docs.heylua.ai/integrations (Shopify, WooCommerce, Square e-commerce and appointments, SimplyBook) are connected from the admin dashboard and expose their data through `Products`/`Baskets`/`Orders` and booking tools — Square and SimplyBook are dashboard-only (not in `lua integrations available`).

Role shortcuts the architect can lead with: executive → crm, accounting, calendar · sales → crm, commerce, payment, enrich · support → ticketing, uc, messaging, crm · marketing → martech, ads, forms, enrich · engineering → task, repo, kms · operations → accounting, storage, task, commerce, shipping · HR → hris, ats, lms, scim.

---

## Triggers (event subscriptions) vs polling

- **Subscriptions** (`lua integrations webhooks create`, or `--triggers ev1,ev2` at connect time) are real-time and always preferred. Each fires an agent turn (credits) — subscribe only to events the agent has work for.
- **Polling** with a `LuaJob` that calls the MCP / `Integrations.passthrough` is the last resort (a daily snapshot, or a connector without the event).
- Object/event names follow Unified.to's `<object>.<created|updated|deleted>` grammar (`task_task.created`, `calendar_event.updated`, `crm_deal.updated`). `lua integrations webhooks events --integration <type> --json` is the truth per connector.
- Virtual webhooks (connectors without push) poll on `--interval 60|120|240|480|720|1440|2880` minutes.

### Handling a subscribed event

Write the reaction in code. Typical handler:

```ts
import { LuaWebhook, Agents, Workflows } from 'lua-cli';

export default new LuaWebhook({
  name: 'calendar-event-created',
  description: 'Reacts to new calendar events from the Google Calendar integration',
  async execute({ body }) {
    const ev = body?.data ?? body;
    // Simple reaction — let the agent reply in the user's thread:
    await Agents.invoke(env('SELF_AGENT_ID'), { prompt: `A new meeting was added: ${ev.title} at ${ev.start}. Acknowledge it briefly and offer to prep a summary.`, userId: ev.ownerUserId });
    // Multi-step reaction — start a workflow instead:
    // await Workflows.start('meeting-prep', { eventId: ev.id }, { idempotencyKey: `meeting-prep:${ev.id}` });
  },
});
```
A `defineTrigger` with `transform: (ctx) => ({ startWorkflow: { name: 'meeting-prep', input: {...}, idempotencyKey } })` does the same declaratively (primitives.md §5).

---

## Secrets and auth for custom HTTP

- `lua env production -k BILLING_API_KEY -v '<value>'` (and `lua env sandbox …` for local runs — it rewrites `.env`). Read with `env('BILLING_API_KEY')` inside `execute`. Never hardcode; never store in `Data`.
- Sign and verify inbound webhooks. `LuaWebhook.secret` is Lua's **own** `x-lua-signature` HMAC, for callers you control that can sign with it; it must be a compile-time literal (`secret: env('X')` fails `lua compile`) and it rejects every delivery from a vendor that signs with its own header (Stripe, GitHub, …) — leave it unset on their webhook. Verify a vendor's HMAC yourself: in `defineTrigger` `verify` over `ctx.rawBody` (exact bytes), or in a `LuaWebhook` `execute` when the vendor's scheme can be recomputed from the parsed body (the webhook event has no `rawBody`). And `safeParse` the payload — webhook Zod schemas are not enforced (primitives.md §4).

---

## Cost surfaces to mention in a plan

Unified.to connector calls and MCP calls are per-call; WhatsApp Business messages are per-message (Meta); voice is per-minute; `AI.generate` is per-token; `Agents.invoke` is a full chat turn; every active integration trigger wakes the agent. Recommend the minimum viable set and note where to expand.

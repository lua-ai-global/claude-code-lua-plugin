# Lua SDK primitive reference (lua-cli 3.33.0)

Source of truth for every primitive and runtime API the plugin's agents reason about. Every shape below is read from the lua-cli 3.33.0 source (`src/types/skill.ts`, `src/types/voice.ts`, `src/types/workflow.ts`, `src/api-exports.ts`, `src/interfaces/*.ts`, `template/`) — not from the public docs, which lag in places. When this file and the live docs disagree, this file wins; when this file and the installed CLI disagree, check `lua --cli-version` (the plugin targets ≥ 3.33.0) and look the symbol up with the `mcp__plugin_lua-agent-builder_lua-docs__query_docs_filesystem_lua_cli` tool (`rg -n "<symbol>" /api/`).

Workflows have their own file: `workflows.md`. CLI commands, exit codes and the push/deploy matrix: `cli-reference.md`.

The code blocks below are **illustrative shapes**, not copy-paste-verified programs: field names, optionality and unions were read from the typings, but when in doubt the builder copies names from the installed package's declarations — `node_modules/lua-cli/dist/api-exports.d.ts` (the root `'lua-cli'` types), `dist/workflow-builder.d.ts`, `dist/voice-exports.d.ts` (e.g. `rg -n "interface LuaToolCtx" node_modules/lua-cli/dist`) — never from memory or the public docs.

---

## 0. Import rules (get these right or nothing compiles)

```ts
import { LuaAgent, LuaSkill, LuaTool, LuaWebhook, LuaJob, PreProcessor, PostProcessor,
         LuaMCPServer, defineTrigger, defineDevice, defineDeviceTrigger, defineVoice,
         createWorkflow, createStep,
         User, Data, Products, Baskets, Orders, Jobs, Workflows, AI, Agents, Integrations,
         Voice, Channels, Team, Templates, CDN, Lua, env, ToolFlag } from 'lua-cli';
import { z } from 'zod';
```

- **Only the root specifier `'lua-cli'` exists.** `package.json` `exports` has `.`, `./voice`, `./voice/test`, `./workflow-builder` — there is **no `lua-cli/skill`** (some older docs show it; it fails type-checking). `lua-cli/voice` re-exports LiveKit plugin namespaces (`deepgram`, `elevenlabs`, `openai`, `google`, `xai`, `inference`) for class-form voice models only.
- **`defineTool`, `defineSkill`, `defineWebhook`, `defineJob`, `definePreProcessor`, `definePostProcessor`, `defineMCPServer` do NOT exist as exports.** The only `define*` helpers are `defineTrigger`, `defineDevice`, `defineDeviceTrigger`, `defineVoice`, `defineWorkflow`. Tools, skills, webhooks, jobs, processors and MCP servers use `new LuaX({...})` or `class X implements LuaTool`.
- **Value exports** (usable at runtime): `LuaSkill`, `LuaWebhook`, `LuaTrigger`, `LuaJob`, `PreProcessor` (alias `LuaPreprocessor`), `PostProcessor` (alias `LuaPostprocessor`), `LuaAgent`, `LuaMCPServer`, `LuaDevice`, `LuaDeviceTrigger`, `LuaVoice`, `LuaVoiceTool`, `defineVoice`, `defineDevice`, `defineDeviceTrigger`, `defineTrigger`, `ToolFlag`, `BasketStatus`, `OrderStatus`, `env`, `CHANNEL_SEND_CHANNELS`, the API objects (`User` … `Lua`), the instance classes (`JobInstance`, `UserDataInstance`, `DataEntryInstance`, `ProductInstance`, `BasketInstance`, `OrderInstance`), and the workflow builder values (see workflows.md).
- **Type-only exports** (use with `import type`): `LuaTool`, `LuaWebhookConfig`, `LuaTriggerConfig`, `TriggerContext`, `LuaJobConfig`, `JobSchedule`, `PreProcessorConfig`, `PreProcessorResult`, `PostProcessorConfig`, `PostProcessorResponse`, `LuaAgentConfig`, `LuaAgentModel`, `LuaMCPServerConfig`, `LuaDeviceConfig`, `LuaDeviceTriggerConfig`, `LuaVoiceConfig`, `LuaVoiceToolConfig`, `LuaVoiceToolCtx`, `PersonaText`, `ChatMessage`, `ChatHistoryMessage`, `Channel`, `LuaRequest`, `UserLookupOptions`, `AiGenerateInput`, `AiGenerateOutput`, `LuaQuery`, `AgentModelSettings`, `IntegrationPassthroughRequest/Response`, `ChannelSendInput/Output`, `EmailSendInput`, `WhatsAppTemplateSendInput`, `DeliveryView`, `DirectoryResolveResult`, and the workflow types.
- **Runtime model**: the compiler strips every `lua-cli` import and rewrites `new LuaX(...)` to bare object literals. `User`, `Data`, `AI`, `Agents`, `Jobs`, `Workflows`, `Channels`, `Lua`, `env` … are **globals injected by the sandbox at runtime**; the imported objects exist for type-checking and `lua test`. Never store state in module scope — the VM does not persist between invocations.

---

## 1. Project layout and registration

`lua init` copies the template:

```
src/index.ts          # const agent = new LuaAgent({...})  — the ONLY required source file
lua.skill.yaml        # CLI-managed state manifest (ids + versions). Do not hand-edit primitive arrays.
package.json          # "lua-cli": "^3.33.0" (template/package.json at tag lua-cli@3.33.0 and in the published 3.33.0; an older pin
                      # means an older CLI wrote it — bump it to `lua --version`), zod ^3.24.1, devDeps tsx ^4.7.0 + typescript ^5.9.2,
                      # plus template extras you can drop (axios, inquirer, js-yaml, openai, stripe, uuid, @pinecone-database/pinecone)
tsconfig.json         # ESNext, bundler resolution, strict; paths @/* and @/services/*
env.example           # copy to .env (LUA_API_KEY optional fallback; `lua env sandbox` rewrites .env)
examples/             # only with `lua init --with-examples` — skills/, skills/tools/, jobs/, webhooks/,
                      # preprocessors/, postprocessors/, services/, workflows/ (incl. a .workflow.script.js)
dist-v2/              # `lua compile` output: manifest.json + artifacts/<kind>/… (gitignored)
```

**Primitives are compiled only if they are referenced from the `LuaAgent` config arrays** in `src/index.ts` (the compiler traverses `skills`, `webhooks`, `triggers`, `jobs`, `workflows`, `preProcessors`, `postProcessors`, `mcpServers`, `devices`, `deviceTriggers`, `voices`, following imports). A file that is never imported into the agent is never compiled. Entry-file search order: `index.ts`, `src/index.ts`, `agent.ts`, `src/agent.ts`.

Conventions from the template: `src/skills/<name>.skill.ts` (default-exports `new LuaSkill`), `src/skills/tools/<PascalCase>Tool.ts` (class `implements LuaTool`), `src/jobs/<PascalCase>Job.ts`, `src/webhooks/<PascalCase>Webhook.ts`, `src/preprocessors/<camelCase>.ts`, `src/postprocessors/<camelCase>.ts`, `src/triggers/<name>.trigger.ts`, `src/workflows/<name>.ts` (graph) or `src/workflows/<name>.workflow.script.js` (script form). Names in source are kebab-case or snake_case.

`lua.skill.yaml` rows the CLI writes: `agent { agentId, orgId }`, `skills[] { name, version, skillId }`, `webhooks[]`, `triggers[]`, `jobs[] { …, schedule? }`, `workflows[]`, `preprocessors[]`, `postprocessors[]`, `mcpServers[] { name, mcpServerId }` (no version), `devices[]`, `deviceTriggers[]`, `voices[]`, `backup { lastHash, lastPushedAt, activeVersion }`, `git { enabled, autoPush? }` (written by `lua git connect`), and the user-authored `template:` section for marketplace templates (see cli-reference.md).

---

## 2. `LuaAgent` — the top-level container

```ts
export interface LuaAgentConfig {
  name: string;
  description?: string;            // Space routing hint ("what this agent is for")
  persona: PersonaText;            // string | { base?: string; voice?: string; text?: string }
  model?: LuaAgentModel;           // 'provider/model' | (request: LuaRequest) => string | Promise<string>
  modelSettings?: AgentModelSettings;
  skills?: LuaSkill[];
  webhooks?: LuaWebhook[];
  triggers?: LuaTrigger[];
  jobs?: LuaJob[];
  workflows?: LuaWorkflow[];
  preProcessors?: PreProcessor[];  // note the capital P
  postProcessors?: PostProcessor[];
  mcpServers?: LuaMCPServer[];
  devices?: LuaDevice[];
  deviceTriggers?: LuaDeviceTrigger[];
  voices?: LuaVoice[];
  batching?: { firstMessageDelayMs?; debounceWindowMs? /* 0 = off */; maxBatchMessages?; serializeProcessing? };
  governance?: { mode: 'sdk' | 'api'; preset?: 'security'; injection?: { threshold; ml?; mlThreshold? };
                 rules?: { blockTools?: string[]; requireToolApproval?: string[]; tokenBudget? }; serverUrl? };
  browser?: boolean | { engine?: 'auto' | 'browser-use' | 'agent-browser'; allowedDomains?: string[]; credentials?: string[]; maxSessionMinutes? };
}
```

- **There is no `welcomeMessage`, `channels`, or `tools` field.** Tools live inside skills.
- `persona` object form: `base` always rendered, `voice` appended on voice channels, `text` on text channels (no cross-fallback). Throws `Agent persona object must have at least one of: base, voice, text`.
- `model` omitted ⇒ the CLI sends no model and the platform applies its server-side default — `PLATFORM_DEFAULT_MODEL = 'alibaba/qwen3.8-flash'` (`@lua/shared-types` `model-registry.ts`, overridable on the server by `LUA_DEFAULT_MODEL`); lua-cli never names it (`lua models list --json` shows `currentModel`, printed as `(platform default)` when unset; `lua models unset` reverts to it). **Model fallback is conditional, not absent** (lua-core `src/mastra/common/models.ts` `modelFromString`, `src/mastra/common/fallback-chain.ts` `planLegs`, `src/mastra/common/services/execute.model-resolver.service.ts`): **(1)** a model code that is not in the server's approved registry is **silently swapped for the platform default** at resolve time (`fallback: { requestedModel, fallbackModel: defaultModel, reason: 'model not in approved list' }`) — a typo in `model` does not error, the turn runs on the default; `AI.generate({ model })` goes through the same gate (`ai-generation.service.ts`). **(2)** A **cross-model fallback chain** for provider transients (429 / 5xx / transport errors) exists but is an operator-side opt-in that is off by default: when on, a turn's legs are the registry's per-model `fallbackChain` (or, for the platform default only, an operator-configured list), with the platform default appended as a last resort when the pinned model runs on another provider; the list is capped at 3 legs, each gated by a per-model circuit breaker; a BYOK (org-owned key) primary never gets a chain, `azure`/`bedrock` models are never legs, and a leg is dropped when it is unapproved, is the primary itself, or repeats an earlier leg. With the chain off — or once every leg fails — the provider refusal reaches lua-cli as exit 12 `provider rejected`. The SDK exposes none of this: builders cannot read or configure the chain, so do not design around it. Valid codes come from `lua models list --json` (server catalog; examples today: `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `anthropic/claude-sonnet-5`, `anthropic/claude-opus-5`, `google/gemini-3.8-flash`, `alibaba/qwen3.8-max`). A model **resolver function** runs per request in the full sandbox (`(req) => req.channel === 'whatsapp' ? 'openai/gpt-5.4-mini' : 'anthropic/claude-sonnet-5'`). `lua models set --model <code>` edits the literal in `src/index.ts` and PATCHes the agent.
- `modelSettings` is validated at construction: `temperature` 0..2, `topP` 0..1, `maxOutputTokens` ≥ 1, finite numbers for `topK`, `presencePenalty`, `frequencyPenalty`, `seed`; `stopSequences: string[]`; `reasoning: { effort?: 'off'|'minimal'|'low'|'medium'|'high'|'max'; show?: boolean }`.
- `governance` never stores a token — API mode reads `GOVERNANCE_API_KEY` from env at runtime. `lua governance add` scaffolds `src/governance.ts` interactively.
- `browser: true` costs money per session; off by default.
- Pushed with `lua push agent` (alias `lua push persona`; also part of `lua push all`): routing description, persona, model / model resolver, modelSettings, batching, browser, voice links — **all of it live at once**. ⚠ The persona is **not staged**: the push creates a persona version that lua-agents persists as `published` and writes straight onto `subAgent.persona` (`persona.service.ts` `createPersonaVersion` → `persistPersona(…, 'published')` → `updateAgentPersona`), and lua-core reads `subAgent.persona` on every turn (`prompt.service.ts`). `lua deploy persona --set-version <n>` re-points the served persona to an earlier version (the rollback verb); `lua version promote` never changes the served persona (it only flips persona-version status flags) — cli-reference.md §5. Treat `lua push agent` as a production change.
- ⚠ **The agent push is a full overwrite, not a merge** (`src/primitives/agent.handler.ts`): a `LuaAgent` with no `model` and no resolver sends `model: null` → "Model configuration cleared"; missing `modelSettings` / `batching` / `voices` are likewise sent as null and cleared on the server. So if someone set the model in the dashboard and `src/index.ts` doesn't name one, the next `lua push all` / `lua push agent` silently reverts the agent to the platform default. `lua sync --check` reports this as model drift beforehand; fix by writing the value into `new LuaAgent({ model: '…' })` (or `lua models set --model <code>`) before pushing.

---

## 3. `LuaSkill` + `LuaTool`

A **skill** is a named group of tools with shared `context` (text injected into the prompt while the skill is active). A **tool** is one function the LLM can call.

```ts
export interface LuaTool<TInput extends ZodType = ZodType> {
  name: string;            // /^[a-zA-Z0-9_-]+$/ — hyphens and underscores both allowed
  description: string;     // what the LLM reads to decide WHEN to call it — be specific
  inputSchema: TInput;     // Zod schema
  execute: (input: any, ctx?: LuaToolCtx) => Promise<any>;   // ctx only set on voice sessions
  condition?: () => Promise<boolean>;   // false ⇒ tool hidden this request; a throw ⇒ disabled (fail-closed)
  voice?: { flags?: ToolFlag[] };       // ToolFlag.NONE | IGNORE_ON_ENTER | DISALLOW_INTERRUPTION
}

// LuaSkill constructor config (type not exported — use inline):
new LuaSkill({
  name: string;                         // required, non-empty — the server identifier
  description: string;
  context: string | { base?: string; voice?: string; text?: string };   // required
  tools?: LuaTool<any>[];
  condition?: () => Promise<boolean>;   // false ⇒ hides ALL tools and omits the context
});
```

Canonical tool:

```ts
import { LuaTool } from 'lua-cli';
import { z } from 'zod';

export default class GetWeatherTool implements LuaTool {
  name = 'get_weather';
  description = 'Get the current weather for a city. Use when the user asks about weather or temperature.';
  inputSchema = z.object({ city: z.string().describe('City name, e.g. "London"') });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const res = await fetch(`https://api.example.com/weather?q=${encodeURIComponent(input.city)}&key=${env('WEATHER_API_KEY')}`);
    if (!res.ok) throw new Error(`weather api ${res.status}`);
    return await res.json();   // plain JSON-serialisable object
  }
}
```

Canonical skill (`src/skills/weather.skill.ts`):

```ts
import { LuaSkill } from 'lua-cli';
import GetWeatherTool from './tools/GetWeatherTool';

export default new LuaSkill({
  name: 'weather',
  description: 'Weather lookups',
  context: 'You can look up live weather. Always ask for the city if it is missing.',
  tools: [new GetWeatherTool()],
});
```

Gotchas: `LuaSkill` throws on an empty `name`; tool names are validated only when added to a skill; there is no uniqueness check across tools; `LuaSkill` exposes `getContext()`, `getCondition()`, `addTool()`, `addTools()`, `run(input)` (the in-SDK `run` path selects by `input.tool`, but the CLI does NOT use it — see next). Tools are **not versioned or pushed on their own** — the skill is (`lua push skill --name weather`). **Testing a tool**: `lua test skill --name get_weather --input '{"city":"London"}'` — `--name` is the **tool** name (test.ts resolves it with `findToolByName` across every skill in the manifest and errors `not_found: Tool "<n>" not found` if you pass a skill name), and `--input` is the tool's own fields with **no `{"tool": …}` envelope**. Without `--name` the interactive form lists the tools.

---

## 4. `LuaWebhook` — an HTTP endpoint the agent exposes

```ts
new LuaWebhook({
  name: string;                  // required, non-empty
  description: string;           // required
  querySchema?: ZodType; headerSchema?: ZodType; bodySchema?: ZodType;   // ⚠ typed only — NEVER applied at run time (see below)
  secret?: string;               // HMAC-SHA256 key for Lua's OWN scheme: the platform rejects calls without a valid
                                 // `x-lua-signature: sha256=<hex of raw body>`; MUST be a string literal / compile-time const
                                 // (`secret: env('X')` fails `lua compile`); `secret: ''` clears it on the next push
  execute: async ({ query, headers, body, timestamp }) => any;   // ONE event argument
});
```

- URL: `https://webhook.heylua.ai/<agentId>/<webhookId>` (or `/<agentId>/<webhook-name>`). Shown by `lua webhooks view`.
- Runs **outside** any conversation: it cannot answer a user directly. It mutates state (`Data`, `User.get(userId)…`), sends proactively (`Channels.send`, `User.get(id).send()`), starts or signals a workflow (`Workflows.start`, `Workflows.signal`), or hands the event to the agent with `Agents.invoke`.
- Platform **event subscriptions** (`lua webhooks subscribe --webhook-name x --event message.delivered`, `lua webhooks list-events`) make Lua itself call your webhook on platform events (delivery receipts etc.).
- Versioned: `lua push webhook --name x`, live via `lua deploy webhook --name x --set-version latest --force`; `lua webhooks activate|deactivate`.
- Test: `lua test webhook --name x --input '{"body":{...},"headers":{...},"query":{...}}'`.
- ⚠ **The Zod schemas are not enforced anywhere the webhook runs.** `querySchema` / `headerSchema` / `bodySchema` are parsed only by the `LuaWebhook` class's own `execute(query, headers, body)` helper (`src/types/skill.ts` ~694-712), but the bundler rewrites `new LuaWebhook({...})` to a bare object literal (`src/compiler/bundler.ts` ~78-96) and both `lua test` (`src/utils/sandbox.ts` ~492-533) and lua-core (`execute.webhook.service.ts` ~171-176) call `primitive.execute(event)` directly — a body that violates `bodySchema` reaches `execute` with HTTP 200 (seen live on 2026-09-13, locally and deployed). Validate as the first line of `execute`: `const parsed = BodySchema.safeParse(body); if (!parsed.success) return { error: 'invalid body', issues: parsed.error.flatten() };`. The declared schemas are documentation, not a guard.
- ⚠ **`secret` is Lua's own signing scheme, not the vendor's.** The compiler accepts `secret` only as a string literal or a compile-time-resolvable constant and fails the build otherwise (`src/compiler/plugins/webhook.plugin.ts` ~144-152: ``Webhook `secret` must be a string literal or a compile-time-resolvable constant``) — `secret: env('STRIPE_WEBHOOK_SECRET')`, which the public docs still show as the good pattern, does not compile; the literal is stripped from the bundle and stored write-only on the server. The check itself is `x-lua-signature` over the raw body (lua-core `webhook.service.ts` ~250-262), so a third party that signs with its own header and scheme (Stripe `Stripe-Signature`, GitHub `X-Hub-Signature-256`, …) can never satisfy it: a `secret` on a webhook those services call rejects every delivery with 401. Use `secret` only for callers you control; for vendor-signed events leave it unset and verify the vendor's HMAC yourself — in a `defineTrigger` `verify` over `ctx.rawBody` (§5; the `LuaWebhook` event has no `rawBody`), or inside `execute` when the vendor's scheme can be recomputed from the parsed body.
- ⚠ **No wall timeout when deployed.** The direct path (`POST webhook.heylua.ai/…`) runs the handler in-process in lua-core (`webhook.service.ts` ~327-340 → `execute.webhook.service.ts` ~40-56): the only bound is the VM `timeout`, which covers the *synchronous* prefix of the code (`sandbox-runtime` `runner.ts` ~57-68 says so in its own comment) — the awaited tail is unbounded. Validated live 2026-09-13: a handler that awaited 200 s ran to completion (`Execute function completed in 200006 ms`) while the caller received the ingress 504 at ~90 s, so the response was lost and the handler kept running invisibly. Tools do not behave this way: production routes them to the remote runner (`LUA_SANDBOX_ROUTING_DEFAULT=remote`) with a 180 s wall (`execute-function.service.ts` `TOOL_TIMEOUT_MS`), and the same code was killed with `wall timeout after 180000ms`. Builder rule: keep webhook handlers **short** (answer in seconds; hand long work to `Workflows.start`, `Agents.invoke` or a `Jobs.create` one-off), **idempotent** (a caller that saw the 504 retries while the first run is still executing — dedupe on the vendor's delivery id in `Data`), and never rely on a server-side cut to stop a runaway loop or a slow upstream.

**Webhook vs trigger**: a webhook gives you full request/response control and runs your code. A trigger (next section) is declarative and always ends in an agent turn, a direct tool call, or a workflow start.

---

## 5. `LuaTrigger` / `defineTrigger` — wake the agent from an external event

```ts
export interface TriggerContext<T = any> {
  body: T;                   // parsed, typed by inputSchema
  rawBody?: string;          // exact bytes — for HMAC verification
  headers: Record<string, any>;   // lower-cased keys
  query: Record<string, any>;
  triggerName: string;
  source: string;            // 'webhook' in v1
}

export const stripeTrigger = defineTrigger({
  name: 'stripe-payments',              // required
  description: 'Fires on a successful Stripe payment',   // dashboard note, NOT sent to the agent
  source?: 'webhook',                   // the only source today; default
  inputSchema?: z.object({ type: z.string() }),
  verify?: (ctx) => boolean | Promise<boolean>,    // false ⇒ HTTP 401, nothing runs
  filter?: (ctx) => boolean | Promise<boolean>,    // false ⇒ HTTP 200, nothing runs
  transform?: (ctx) => string                      // the message the agent receives
                     | AgentInvocationInput         // you own the turn (prompt, systemPrompt, threadId, userId…)
                     | { startWorkflow: { name, input?, idempotencyKey?, notify?, correlationKey?, tags?, initialState?, replyTo?, onBehalfOf? } },
  tool?: { name: string; input?: (ctx) => Record<string, unknown> },   // run ONE skill tool directly — no LLM turn
});
```

Rules (constructor-enforced or server-enforced):
- At least one of `verify`, `filter`, `transform`, `tool` is required; `tool.name` must be a static string literal.
- `transform` returning `null`/`undefined` is an error — use `filter` to skip. Omit `transform` to get the default `body → message` (payload capped ~50k chars).
- `tool` beats `transform` when both are declared (compiler warns). `tool.input` runs in the 15 s slot sandbox shared with verify/filter and **cannot call platform APIs**. Approval-gated tools are refused server-side.
- `{ startWorkflow }` creates the run synchronously in the delivery request (`200 { status:'accepted', executionId, runId }`) as the **system principal**; no chat turn fires. `idempotencyKey` is the one uniqueness key — set it from the vendor's delivery id, otherwise every redelivery starts a run. `notify` defaults `'off'`. Unknown workflow / input-schema failure are typed `failed` rows in `lua triggers logs` on a 200; `skipped_overlap` is typed for a `concurrencyPolicy:'forbid'` overlap but is **never produced today** — the start path (`WorkflowRunService.createRun`) has no overlap check (§12 `Workflows`), so a redelivery without an `idempotencyKey` starts a second run.
- Register on `LuaAgent.triggers`. The trigger **record** (paste-anywhere URL + token) is managed by `lua triggers create|list|logs|activate|deactivate|rotate-token|delete`; `lua push trigger --name x` attaches the SDK bundle as a version; `lua deploy trigger --name x --set-version latest --force` makes it live (a scoped promote). The URL's host comes from a **server-side base-URL setting** (lua-api `developer.trigger.service.ts` `requireTriggerBaseUrl()`, a 503 when unset) — `https://trigger.heylua.ai` appears in no shipped code, so never hard-code a trigger host: take the URL from `lua triggers create` / `lua triggers list` output.
- `lua triggers` is for THESE platform triggers. Integration (Unified.to) event subscriptions are `lua integrations webhooks …` — see integrations.md.

---

## 6. `LuaJob` — scheduled background task

```ts
export type JobSchedule =
  | { type: 'cron'; expression: string; timezone?: string }   // NOT `pattern`
  | { type: 'once'; executeAt: Date | string }                // NOT `at`
  | { type: 'interval'; seconds: number };                    // NOT `ms` / `intervalMs`

const job = new LuaJob({
  name: 'daily-digest',                 // required, non-empty
  description: 'Send the morning digest',
  schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
  timeout?: number,                     // seconds; integer 1..600; default 300 — a non-integer throws TypeError
  retry?: { maxAttempts: number; backoffSeconds?: number },
  metadata?: Record<string, any>,
  execute: async (job: JobInstance) => { /* job.metadata, await job.user() */ },   // ONE argument
});
export default job;
```

- Jobs run agent-wide. For per-user work iterate users inside `execute`; `job.user()` resolves only for dynamic jobs created from a user's tool (throws `User API not initialized` otherwise).
- **Retries** (`retry: { maxAttempts, backoffSeconds? }`; lua-core `src/services/job.service.ts`). Production and staging run code jobs through the **queued (heavy-jobs) path**: lua-iac pins `LUA_JOBS_INTAKE_MODE = "enqueue"` in both environments (`services/lua-core/{prod,staging}/k8s/config-map.tf`) and `run()` routes to `enqueueJob` whenever that queue is wired (~302-323). The algorithm is flat: a **fixed** wait of `backoffSeconds` (default **60**, no jitter) before every retry (`backoff: { type: 'fixed', delay: backoffSeconds * 1000 }` ~372/~409; `scheduleHeavyRetry` ~572-607), and `effectiveMaxAttempts = min(maxAttempts, 10)` — 10 is a platform ceiling (`PLATFORM_MAX_HEAVY_ATTEMPTS` ~132), your `maxAttempts` still bounds it, and a job with **no finite `maxAttempts` gets zero app-level retries** (`getHeavyRetryEligibility` ~512-531: `!Number.isFinite(retryConfig.maxAttempts)` ⇒ ineligible). Every deployed run receives `job.execution = { executionId, attempt, occurrenceId, … }` from the runner (`lua-sandbox-runner` `executor-entry.ts` ~231-239; `attempt` is 1 on a fresh run) — read it as `job.execution?.attempt ?? 1` so the same code runs under `lua test`, which never sets it. The exponential-backoff-with-jitter path in the same file (base × 2^n, +≤ 25 %, 900 s cap, ~1363-1374) belongs to the legacy in-process executor, which production reaches only for the platform's own `agent`-kind jobs (scheduled agent turns — `enqueueJob` ~349 sends those to `processJob`, and `DEFAULT_AGENT_JOB_RETRY` applies to them alone); your `LuaJob` / `Jobs.create` code never sees it. Practical rule: always set a finite `maxAttempts` (otherwise you get one attempt), expect each retry after exactly `backoffSeconds`, and make `execute` idempotent.
- Versioned: `lua push job --name daily-digest`; live via `lua deploy job --name daily-digest --set-version latest --force`; `lua jobs activate|deactivate|trigger|history -i <name>`.
- Test: `lua test job --name daily-digest` (executes it once, locally).
- Dynamic (runtime-created) jobs: `Jobs.create(...)` in §12.

---

## 7. `PreProcessor` / `PostProcessor`

```ts
type ChatMessage = { type: 'text'; text: string }
                 | { type: 'image'; image: string; mediaType: string }
                 | { type: 'file'; data: string; mediaType: string };

new PreProcessor({
  name: string; description: string;
  async?: boolean;          // default false (blocking). true ⇒ runs in the background server-side
  priority?: number;        // default 100; lower runs first
  execute: async (user: UserDataInstance, messages: ChatMessage[], channel: string): Promise<PreProcessorResult> =>
    ({ action: 'block', response: 'Sorry, I cannot help with that.', metadata?: {} })
    // or
    ({ action: 'proceed', modifiedMessage?: ChatMessage[], metadata?: {} }),   // modifiedMessage is an ARRAY
});

new PostProcessor({
  name: string; description: string; priority?: number;
  execute: async (user: UserDataInstance, message: string, response: string, channel: string) =>
    ({ modifiedResponse: string }),   // MUST return this shape
});
```

There is no `'allow'`/`'modify'` action and no `async` flag on PostProcessor. Registered on `preProcessors` / `postProcessors`. Versioned: `lua push preprocessor|postprocessor --name x`, live via `lua deploy preprocessor|postprocessor …`, toggled with `lua preprocessors activate|deactivate`. **Testable**: `lua test preprocessor --name x --input '…'` and `lua test postprocessor --name x --input '…'` exist (the `lua test --help` text omits them but `aliases.ts` and `test.ts` accept them).

Use them for agent-wide uniform transforms (PII redaction, language routing, channel-specific formatting, disclaimers). For one tool's output, do it inside that tool.

---

## 8. `LuaMCPServer` — attach an external MCP server

```ts
export default new LuaMCPServer({
  name: 'github',                       // required
  transport: 'streamable-http',         // or 'sse'; 'stdio' is NOT supported (throws with a migration hint)
  url: 'https://mcp.example.com/mcp' | () => string,
  headers?: Record<string,string> | () => ({ Authorization: `Bearer ${env('GITHUB_TOKEN')}` }),   // function form resolves secrets at runtime
  timeout?: number,                     // ms, default 60000
});
```

⚠ **There is no `description` field.** `LuaMCPServerConfig = MCPSSEServerConfig | MCPStreamableHttpServerConfig`, each `MCPServerBaseConfig { name; timeout? }` plus `transport`/`url`/`headers?` — no `description`, no index signature — so `new LuaMCPServer({ …, description: '…' })` is an excess-property **type error** on the object literal under `tsc` (strict or not). `lua compile` does **not** warn: it silently reads `description` into the manifest (`src/compiler/plugins/mcp-server.plugin.ts`). Leave it out; describe the server in the skill `context` or the agent persona instead.

Non-versioned (upsert by name): `lua push mcp`, enable/disable with `lua mcp activate|deactivate <name>` (activation changes the live agent — it is gated by the plugin like a deploy), `lua mcp list`. `lua deploy mcp` is not a valid type. Unified.to integrations auto-provision their own MCP servers — don't hand-write one for Linear/HubSpot/etc. (see integrations.md).

---

## 9. `LuaDevice` / `defineDevice` and `LuaDeviceTrigger` / `defineDeviceTrigger` — IoT and local machines

```ts
export const printer = defineDevice({
  name: 'label-printer',                          // lowercase, hyphens
  description?: string, group?: string,           // group = fan-out group
  commands?: { print: { description: string; inputSchema?: ZodType; timeoutMs?: number /* 30000 */; retry?: { maxAttempts; backoffMs } } },  // agent → device; each command becomes a tool
  triggers?:  { paper_low: { description: string; payloadSchema?: ZodType; execute?: async (payload, ctx) => any } },   // device → agent
});

export const paperLow = defineDeviceTrigger({   // standalone, versioned on its own
  name: 'paper-low', description?: string, payloadSchema?: ZodType,
  execute: async (payload, ctx) => {
    const trigger = (ctx as any).trigger?.name ?? 'paper-low';           // see the context caveat below
    await Agents.invoke(env('SELF_AGENT_ID'), { prompt: `Printer ${ctx.device.name} (${trigger}) reports paper low: ${payload.level}%` });
  },
});
```

⚠ **The execute context is mistyped in both directions.** At runtime the deployed wrapper passes `{ device: { name }, trigger: { name, triggerId } }` (`sandbox-runtime` `wrapper-templates.ts` device-trigger wrapper; the legacy single-function branch passes `trigger: { name }` only), but `LuaDeviceTriggerConfig.execute` is typed `(payload, context: { agent: any; device: { name: string } })` (`src/types/skill.ts`, `api-exports.d.ts`): **`trigger` is missing from the type** — `ctx.trigger.name` is a type error, hence the `(ctx as any).trigger?.name` cast — and **`agent` is declared but never passed** — `ctx.agent` is `undefined` at runtime, and since it is typed `any` the failure is silent. Never call `ctx.agent.*`; reach the agent through the platform globals, which device-trigger handlers do get (`Agents.invoke`, `Channels.send`, `User.get(id)…`, `Workflows.start` / `Workflows.signal` — the runtime attributes a device-trigger `Workflows.signal` as an inbound-event site).

**Group fan-out**: a command sent to a `group` (`lua devices … --group`, or the group tool) is dispatched to **every device registered in that group** — there is no online filter — as one `/internal/devices/:agentId/command` call per device (lua-core `device-tool.service.ts`); an offline or unregistered member answers **404 `Device '<n>' is offline or not registered`** (lua-api `device.service.ts`) and is counted in the result's `failed` (`{ total, failed, … }`). Expect `failed > 0` whenever a member is offline and make commands idempotent per device. **`trigger_result` is never emitted**: the device-client libraries subscribe to it (`lua-device-client` `mqtt-transport.ts`, `client.ts`) and the broker ACL allows it, but the platform publishes only `trigger_ack` (`device.gateway.ts`, `mqtt-gateway.service.ts`) — a device waiting for a trigger *result* waits forever; treat device triggers as fire-and-forget from the device side. Device-triggers have **no HTTP URL** (they are MQTT-only, `lua/devices/{agentId}/{deviceName}/trigger`) — the URL-bearing primitive is `defineTrigger` (§5).

Register on `devices` / `deviceTriggers`. Push: `lua push device`, `lua push device-trigger`. Manage: `lua devices list|status|enable|disable|remove|test|test-trigger --device-name x`. They are **not** `lua deploy` types — a pushed device/device-trigger goes live through a single-primitive `lua push … --auto-deploy` (blocked in this plugin) or an agent version promote (`lua version create` → `lua version promote`). Device clients (Node, MQTT, MicroPython) are documented under `/devices/*` on docs.heylua.ai.

---

## 10. `LuaVoice` / `defineVoice` — a voice agent (phone, LiveKit room, browser)

```ts
export default defineVoice({
  name: 'support-line',                 // /^[a-zA-Z0-9_-]+$/, required
  description?: string,
  llm: 'openai/gpt-5.2-chat-latest',    // descriptor string | LiveKit plugin instance | { model, voice }; realtime providers: openai, google, xai
  stt: 'deepgram/nova-3',               // required unless llm is realtime
  tts: { model: 'cartesia/sonic-3', voice: '<voice-id>' },   // required; plugin-route providers: deepgram, elevenlabs
  greeting?: string, vad?: 'silero', vadOptions?: {...}, turnDetection?: 'multilingual'|'english'|'vad'|'stt'|'manual',
  maxToolSteps?: 1..20, userAwayTimeout?: number, preemptiveGeneration?: boolean,
  interruption?: { enabled?, mode?: 'adaptive'|'vad', falseInterruptionTimeout?, resumeFalseInterruption?, minDelay?, maxDelay? },
  sttLanguage?: string, krispEnabled?: boolean, backgroundAudio?: { ambient?, thinking? }, volume?: 0..100,
  pronunciations?: Record<string,string>, persistTranscript?: boolean, onToolFailureSay?: string, excludeTools?: string[],
  tools?: Array<LuaTool | LuaVoiceTool>,        // LuaVoiceTool adds flags + ctx.voice.say/transferToHuman/endCall/handoff
  onEnter?: async (ctx) => {}, onUserTurnCompleted?: async (turnCtx, message) => {}, onExit?: async (ctx) => {},
});
```

Register on `voices`; each channel picks one via its config (first voice is the fallback). Versioned: `lua push voice`. Outbound calls from code: `Voice.call(...)` (§12). Phone numbers: `lua channels` / admin dashboard.

CLI (`src/cli/command-definitions.ts` ~1437, `src/commands/voice.ts`):

```
lua voice [--agent <name>] [--voice <name>] (--terminal | --phone <+E164> [--caller-id <+E164>]) [--context '{"orderId":"ABC"}'] [--thread-id <id>]
lua voice test [--voice <name>] [--pattern <regex>] [--watch] [--bail] [--runner jest|vitest|auto]
lua voice list [--json]
```

`lua voice` opens a live session against the sandbox: `--phone` has the agent call that E.164 number (`--caller-id` must be a number the org owns); `--terminal` uses your mic/speaker (needs `sox`); neither flag ⇒ an interactive browser/terminal picker, which throws under `--ci` (browser mode cannot be pinned by a flag). `--agent` / `--voice` skip the pickers when the manifest has several; `--context` must be a JSON object; `--thread-id` suffixes the sandbox thread. `lua voice test` runs `*.voice.test.ts` (`--voice` = filename match; errors when neither Jest nor Vitest is installed). `lua voice list` reads `dist-v2/manifest.json` — the only voice verb the plugin runs itself; the live session is the user's own terminal.

---

## 11. `LuaWorkflow` — durable multi-step orchestration

`createWorkflow({...}).then(step).agentStep(...).approval(...).commit()` registered on `LuaAgent.workflows`. Pushed with `lua push workflow --name <n>`, deployed with `lua workflows deploy <n> -v latest` (`lua deploy` has no workflow type), tested offline with `lua test workflow --name <n> --input @in.json …`. **Full reference: workflows.md.** Use a workflow when the job is multi-step, long-running, needs human approval/signals, fan-out, retries with budgets, or Job-tier code with a git workspace. Use a plain tool/job/webhook otherwise.

---

## 12. Platform APIs (sandbox globals, importable from `'lua-cli'` for types)

Available inside tools, webhooks, triggers' transform is NOT a sandbox (no platform APIs there), jobs, processors, workflow code steps, and model resolvers.

### `User`
```ts
User.get(identifier?: string | { email?: string } | { phone?: string }): Promise<UserDataInstance | null>
  // no arg = current conversation user (tools/processors); a userId string is REQUIRED in webhooks/jobs;
  // email/phone lookup returns null on miss; a userId-scoped instance binds update/save/send to THAT user
User.getChatHistory(): Promise<ChatHistoryMessage[]>
User.Inbox.push({ title, body, detail?, deeplink?, priority?: 'urgent'|'high'|'normal'|'low', actions?: ('approve'|'redirect'|'fix')[],
                  options?: {label, description?}[], key?, threadId? }): Promise<{ outcome: 'deposited'|'updated'|'exists'|'capped'; kind; key }>
  // a card in YOUR OWN inbox; 5/day per agent; same `key` revises in place; cap-hit never throws
```
`UserDataInstance`: `data` (proxied — `user.name` ≡ `user.data.name`), `_luaProfile` (`{ userId, fullName, mobileNumbers[], emailAddresses[] }`, read-only), `update(data)`, `patch({ set?, unset? })`, `unset(...fields)`, `clear()`, `save()` (PUTs `this.data`; no args), `send(messages: Message[])` — a proactive message delivered on that user's **last-interaction channel** (deployed: `POST /internal/chat/send-message` → lua-api `sendToUserLastInteraction`); ⚠ under `lua test` it returns `true` or **throws** (`src/instances/user.instance.ts`), but deployed it returns **`true` even when delivery failed**: `sandbox-runtime` `devtools/common/user.instance.ts` awaits `userAPI.sendMessage` and returns `true` unconditionally, and nothing beneath it throws (`platform-http.ts` turns non-OK responses and fetch errors into `{ success: false }`, which `sendMessage` reduces to a discarded `false`) — so in production there is **no failure signal at all**. The last-interaction send (lua-whatsapp `channel.service.ts` `sendToLastInteraction`) reaches **WhatsApp, Instagram, Messenger (`facebook`), Teams personal chats (needs a stored conversation reference), MessageBird and SMS (`phone` channels) — and nothing else**. **Email is unreachable**: the dispatcher resolves the channel from the user's most recent *channel window*, and the only writer of channel windows is lua-whatsapp's `upsertChannelWindow` (`utils/channel-window.util.ts`), called from its WhatsApp, Facebook, Instagram, MessageBird, SMS and Teams services — lua-email never writes one, so a user's last window is never an email window and the `type === 'email'` branch (~407) is dead code. Any other last channel (Slack, Front, iMessage, RCS, the web widget / `pop`) is `400 Cannot send via channel type '<type>' — unsupported for last-interaction send`, which deployed code never sees. To email a user use `Channels.email.send(...)` (below). lua-api also fires a best-effort webchat copy. When you need a delivery result use `Channels.send(...)` (returns `{ deliveryId, status, delivered, persisted }`) or confirm with `Channels.listDeliveries({ userId })` / `Channels.getStatus(deliveryId)` — `getChatHistory()`. **There is no `User.update()`, no `user.get()`, no `user.id`** — use `user._luaProfile.userId`. Users are cross-channel: one profile across WhatsApp/web/email.

### `Data` — agent-scoped collections with vector search and declared indexes
```ts
Data.collections(): Promise<{ data: CustomDataCollectionInfo[], count }>      // ⚠ typed, and works under `lua test`, but NOT injected by the deployed runtime (its CustomDataApi has no `collections`) → TypeError in production
Data.create(collection, data, options?: string | { searchText?: string; index?: Array<string | string[]> }): Promise<DataEntryInstance>
Data.get(collection, filter?: LuaQuery, page = 1, limit = 10): Promise<{ data: CustomDataEntry[], pagination }>   // NOT an array; items are plain { id, data, createdAt, updatedAt }
Data.getEntry(collection, entryId): Promise<DataEntryInstance>
Data.update(collection, entryId, data, options?): Promise<{ status, message }>
Data.search(collection, searchText, limit = 10, scoreThreshold = 0.6): Promise<DataEntryInstance[]>   // vector search; items carry .score
Data.delete(collection, entryId): Promise<{ status, message }>
```
`LuaQuery` is a bounded Mongo-style filter: `$eq $ne $gt $gte $lt $lte $in $nin $exists`, root `$and`/`$or`. **Indexes** — ⚠ runtime caveat first: the `{ searchText?, index? }` options object is what lua-cli 3.33.0 types and what `lua test` (lua-cli's local VM) sends, but the **production sandbox runtime** (`sandbox-runtime` `src/devtools/apis/custom.data.api.service.ts`) still has `create(collection, data, searchText?: string)` **and** `update(collection, entryId, data, searchText?: string)` and posts that argument as `searchText` (lua-api's DTO is `@IsString() searchText?`), so a deployed `Data.create(c, doc, { index: [...] })` **or** `Data.update(c, id, doc, { … })` fails with `400 searchText must be a string` (seen live on 2026-09-12) while the same calls pass locally — lua-cli's own local service normalises the object form, the deployed one does not. Until the runtime ships the object form, deployed code must use the legacy shapes `Data.create(c, doc)` / `Data.create(c, doc, 'search text')` / `Data.update(c, id, doc, 'search text')`. **The deployed service never forwards `index` at all** — not from the object form (400) and not from the string form (its `create`/`update` bodies are `{ data, searchText }`, `custom.data.api.service.ts` ~38-48 / ~160-175; the word `index` does not occur in that file) — so **an index can only be declared from a `lua test` run** (lua-cli's local `custom.data.api.service.ts` sends `{ data, searchText, index }`; validated live 2026-09-13). Recipe: put the declaring write in a small seed tool and run it once locally — `lua test skill --name seed_indexes --input '{}'` where the tool calls `Data.create(c, doc, { index: ['business_id'] })` against the real agent (local runs hit the real dev API) — then ship deployed code that writes with the legacy shapes and only *filters* on those fields. (`CreateCustomDataOptions` is also not exported, so the options type cannot even be named.) Index semantics: declare the fields you filter on — `{ index: ['business_id'] }`; compound = nested array `{ index: [['country','business_id']] }` (serves leftmost prefixes only). Builds are async (minutes); limits 2 fields/index, 3 declarations/call, 5 indexes/agent; invalid ones are rejected (visible in `Data.collections()`), unused ones expire after ~14 days. A large unindexed filter eventually fails with a message naming the field. Never store secrets in `Data` — use `lua env` + `env()`.

### `Products`, `Baskets`, `Orders` — built-in commerce
```ts
Products.get(page?, limit?) | Products.get({ page?, limit?, filter?: LuaQuery }) → ProductPaginationInstance (products[], pagination, nextPage())
Products.create(product) → ProductInstance;  Products.getById(id) → ProductInstance (THROWS on miss);  Products.search(query) → ProductSearchInstance;  Products.delete(id)
Baskets.create({ currency, metadata? }) | .get(status?) | .getById(id) | .addItem(basketId, { id, price, quantity, SKU? }) | .removeItem(basketId, itemId) | .clear(basketId)
       | .updateStatus(basketId, BasketStatus) | .updateMetadata(basketId, metadata) | .placeOrder(data, basketId)   // data FIRST
Orders.create({ basketId, data }) | .get(status?) | .getById(id) | .updateStatus(OrderStatus, orderId) | .updateData(data, orderId)   // status FIRST
BasketStatus: ACTIVE | CHECKED_OUT | ABANDONED | EXPIRED;   OrderStatus: PENDING | CONFIRMED | FULFILLED | CANCELLED
```
`BasketInstance`/`OrderInstance` identity fields are TS-private — read `basket.toJSON().id` or cast. If the user already has Shopify/WooCommerce, use the integration and let it own the cart. ⚠ **`OrderStatus.FULFILLED` does not match the platform's spelling.** The SDK enum is `FULFILLED = 'fulfilled'` (`src/interfaces/orders.ts`), but the platform spells the status `fullfilled` — two l's — everywhere server-side: the `EcommerceOrderStatus` enum (`shared-schemas` `ecommerce-order.schema.ts`), lua-api's Swagger enums for `?status=` and the `:status` path param (`controllers/developer/orders/base.controller.ts`), and the dashboard charts that count fulfilled orders (`chart.service.ts`). `Orders.updateStatus(OrderStatus.FULFILLED, id)` puts the enum value straight into the path (`order.api.service.ts` ~42-44) and the server stores **any** string unvalidated (200 even for `bogus-status`), so the write succeeds silently and the order is then invisible to `?status=fullfilled` filters (`Orders.get(status)` included) and to the dashboard — validated 2026-09-13. Until lua-cli aligns: pick one spelling per agent and read back with the same one; when the dashboard or the REST filter must see the order, send the platform spelling with a cast — `await Orders.updateStatus('fullfilled' as OrderStatus, orderId)` — and filter with the same literal. `PENDING` / `CONFIRMED` / `CANCELLED` are spelled identically on both sides. Also: lua-api's order routes answer **200 with `{ success: false, message }`** for a missing order or a failed precondition, and the SDK turns that into a thrown generic `Error('Failed to update order status')` / `'Failed to get user orders'` (it reads `response.error?.message`, which those bodies do not carry) — catch it and treat it as not-found; there is no 404.

### `Jobs` — dynamic jobs created at runtime
```ts
Jobs.create({ name, description?, schedule: JobSchedule, execute: async (job: JobInstance) => any,
              timeout?, retry?: { maxAttempts, backoffSeconds? }, metadata?, activate?: boolean /* default true */ }): Promise<JobInstance>
Jobs.getJob(jobId) | Jobs.getAll({ includeDynamic?: boolean })
```
The `execute` function is **serialised with `toString()`**: it cannot close over variables — pass everything through `metadata` and read `job.metadata` inside. Created as version 1.0.0 and activated in one call. Use for "remind me in 1 hour" / "check this basket in 3 hours". `JobInstance`: `id`, `name`, `metadata`, `activeVersion`, `data`, `updateMetadata()`, `delete()`, `user()`, `trigger()`, `activate()`, `deactivate()` — **no `job.jobId`, no `job.schedule`**.

### `Workflows` — start/inspect/steer runs from code
`Workflows.start(nameOrId, input?, { idempotencyKey?, budget?, waitSeconds? (≤55), initialState?, correlationKey?, tags?, replyTo?, onBehalfOf?, workflowVersionId? })` (always fire-and-return; from a code step it is a DETACHED run — use `.workflow()` to wait), `.get(runId)`, `.list({...})`, `.cancel(runId, { mode?: 'request'|'force', reason? })`, `.resume(runId, stepId, resumeData)`, `.signal(runId, name, payload?, { dedupeKey? })`, `.signalByKey(...)`, `.startBatch(...)`, `.setGoal`, `.goals.*`. **All of those work in production** — `resume`, `signal`, `signalByKey`, `startBatch`, `setGoal` and `goals.*` were exercised live on 2026-09-13 and reached their real providers (`RUN_NOT_FOUND` / `CORRELATION_KEY_NOT_FOUND` / `WORKFLOW_NOT_FOUND` for bogus ids, `goals.list()` → `[]`). The `resume_unavailable` / `signal_unavailable` / `not_implemented` codes in lua-core `workflow-sandbox-bridge.ts` are thrown only when the optional provider is not injected (`!this.delegates?.resume|signal`, `!this.batches`, `!this.goals`) — a guard for platforms without it, not production's behaviour, whatever the bridge's own header comment still says. ⚠ **`Workflows.raiseBudget` is the one member that never works from the SDK**: under `lua test` it throws `WorkflowApiError{ code: 'WORKFLOWS_API_UNAVAILABLE', status: 501 }` (`src/api/workflow.api.service.ts`: `raiseBudget: unavailable('raiseBudget', 'R45')`); deployed it is `raiseBudget: notImplemented('raiseBudget')` in the bridge → 501 `not_implemented` ("Workflows.raiseBudget is not available on this server yet") — two different error codes for the same dead member, so never branch on them. Raise a parked run's budget with the CLI: `lua workflows raise-budget <runId> --credits <n>`. ⚠ **Deployed `list` ignores the typed `workflow` filter**: the bridge reads only `status` and an untyped `workflowId` (`workflow-sandbox-bridge.ts` ~223-230), so `Workflows.list({ workflow: 'x' })` returns every run of the agent in production (2 of 2 on the probe) while `lua test` resolves the name first — pass `workflowId` (the id from `lua workflows view <name> --json`; it is not in the typed options, so cast) or filter the returned runs by their `workflowId` yourself. ⚠ **`concurrencyPolicy:'forbid'` is not enforced on `Workflows.start`** (nor on `lua workflows start`, the REST start route or a trigger's `{ startWorkflow }`): `WorkflowRunService.createRun` has no overlap check (lua-core `workflow-run.service.ts` header: forbid-overlap "lands with later slices"); only the schedule dispatcher, the agent compose-tool start and batch starts check it. Two `lua workflows start` calls 2 s apart on a `forbid` workflow both ran (2026-09-13). `RUNS_IN_FLIGHT` is typed for every start path but today none of these produce it — dedupe with `idempotencyKey`, guard non-reentrant work inside the workflow (`ctx.once`, a `Data` lock row), and never rely on the policy alone. Details in workflows.md.

### `AI` — one-shot generation outside the agent's persona
```ts
AI.generate(prompt: string): Promise<string>
AI.generate(systemPrompt: string, content: UserContent /* string | [{type:'text',text}, {type:'image', image: Buffer|string, mediaType}] */): Promise<string>   // first arg becomes the SYSTEM prompt
AI.generate({ model?, system?, prompt?, messages?, temperature?, maxOutputTokens?, structuredOutput?: { schema } }): Promise<AiGenerateOutput>
  // → { text, finishReason, usage: { inputTokens, outputTokens, totalTokens }, reasoning?, sources?, output?, warnings? }
```
Cheap classification/extraction/summarisation inside a tool. Not user-facing. `Agents.invoke` is the expensive full-agent alternative. ⚠ **`output` is JSON-parsed, not schema-validated**: with `structuredOutput: { schema }` the runtime builds `jsonSchema(schema)` without a validate hook, so any parsed value passes (lua-core `ai-generation.service.ts` says so in its own comment); the typings' "Shape conforms to the supplied JSON Schema" is false. `output` is present only when `finishReason === 'stop'`. Validate before use — `const parsed = MySchema.safeParse(res.output); if (!parsed.success) …` — and never index into `output` on trust.

### `Agents` — invoke another agent
```ts
Agents.invoke(targetAgentId, prompt): Promise<string>
Agents.invoke(targetAgentId, { prompt? | messages?, systemPrompt?, threadId?, channel?, userId?, webhookPayload?, timeoutMs?, model? }): Promise<{ text, threadId?, finishReason?, usage?, toolsUsed? }>
```
Full chat pipeline on the target (persona, skills, billing, processors). From webhooks/jobs pass `userId` to act as a specific user; omit `threadId` to use that user's default thread with the target. A chargeable conversation — don't use it for classification. ⚠ **`lua test` and production differ in two ways.** (1) The local implementation forwards only `prompt|messages`, `systemPrompt`, `runtimeContext`, `threadId`, `webhookPayload`, `clientContext` (plus `channel` as a query param) — **`userId`, `model` and `timeoutMs` are silently dropped** under `lua test` (`src/api/agents.api.service.ts` `toChatGenerateBody`); deployed forwards them all, so a local run cannot prove that acting-as-user or the model override works. (2) A **blocked** target turn (preprocessor `{ action: 'block' }` or governance) comes back locally as a *value* — `{ text, finishReason: 'preprocessor_blocked' | 'governance_blocked' }` — whereas the deployed runtime **throws** `AgentInvocationError` (`code: 'PREPROCESSOR_BLOCKED'` / governance). A `try/catch` around `Agents.invoke` is never entered in `lua test` and is the only path in production: handle both (`catch`, and check `finishReason`).

### `Integrations.passthrough` — raw provider API through a connected integration
```ts
Integrations.passthrough('github', { method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD', path: 'repos/acme/app/pulls/42', query?, data?, headers? })
  → { status, headers, data }   // provider 4xx/5xx come back in `status`, NOT thrown; non-JSON bodies are strings
```
Uses the agent's own connection for that integration type (`lua integrations connect --integration github`). Credentials never reach your code. The request body field is **`data`**, not `body` (`IntegrationPassthroughRequest { method, path, query?, data?, headers? }`), there is **no `connectionId`** (the agent's bound connection for that type is chosen server-side), and the response body is `data` as well — `res.data`, never `res.body`. Failures other than the provider's own non-2xx are **thrown** as an error whose class, `IntegrationPassthroughError`, is **not exported** from `'lua-cli'` (it exists in `src/api/integrations.api.service.ts` but not in `api-exports`): duck-type on `err.name === 'IntegrationPassthroughError'` and `err.code` — `VENDOR_UNAVAILABLE` (503) · `VENDOR_REJECTED` (422) · `passthrough_disabled` · `passthrough_no_connection` · `passthrough_rate_limited` · `passthrough_invalid_request` · `passthrough_unavailable` (the runtime has no passthrough wired) — plus `statusCode?`, `retryAfterSeconds?`, `vendor?`, `vendorStatus?`, `requestId?`.

### `Voice` — outbound calls
`Voice.call({ to: '+15551234567' | { kind:'phone', number, callerId? } | { kind:'meet', url } | { kind:'web', returnToken? }, voice?, context?, threadId?, channel? }) → { sessionId, roomName, callId?, joinUrl? }`; `Voice.createSession({ userId?, voiceId?, displayName? }) → { url, roomName, token, participantIdentity, agentName }` is **typed but not injected anywhere agent code runs**: both the deployed `Voice` global (`sandbox-runtime` `context.ts`) and `lua test`'s (`src/utils/sandbox.ts`) expose only `call` — calling it is `Voice.createSession is not a function` in production *and* locally (both validated on 2026-09-13). It exists only when `lua-cli` is imported as a library with imports intact; mint LiveKit sessions from your own backend, not from a tool.

### `Channels` — proactive outbound messages
```ts
CHANNEL_SEND_CHANNELS = ['whatsapp', 'sms', 'email', 'webchat', 'teams', 'instagram', 'messenger']   // teams/instagram/messenger need a prior inbound
Channels.send({ channel, to: { userId? | phoneNumber? | email? | conversationId? /* teams only */ }, text, options?: { channelIdentifier?, whatsapp?: { onClosedWindow?: 'queue'|'fail' } } })
  → { deliveryId, status, delivered, persisted, queued?, warning? }     // delivered:true + persisted:false is a 200, check `persisted`
  // `status` on the immediate result is only 'accepted' (dispatched — the default in lua-api `channel-send.service.ts` `persistOutbound`)
  // or 'queued' (WhatsApp closed-window queue); 'sent' is in the DeliveryView union but is never produced by the send path.
  // Later states (delivered | read | failed) come from `Channels.getStatus`, and today only WhatsApp records deliveries.
Channels.whatsapp.sendTemplate({ to, templateName, languageCode?, components? })   // outside the 24 h window
Channels.whatsapp.sendReaction({ to, messageId /* wamid, ≤30 days */, emoji /* '' removes */ })
Channels.email.send({ to: { userId? | email? }, subject?, text?, html?, richBody?, cc?, bcc?, attachments?: [{ filename, contentType, url }], inReplyTo?, references? })
  // body is one of text | html | richBody (400 otherwise — there is NO `body` field). Needs an email channel: the agent's own, the user's
  // existing email window, or the platform's global email channel as a last resort — none ⇒ 400 'No email channel configuration found.
  // Ensure the agent has an email channel linked.'; `to: { userId }` alone with no prior email conversation ⇒ 400 'email send requires a
  // recipient email, or a userId with an existing email conversation' (lua-api channel-send.service.ts sendEmail → lua-whatsapp channel.service.ts).
Channels.getStatus(deliveryId) → DeliveryView { status: queued|accepted|sent|delivered|read|failed|expired, error?: { category, provider, code, title, retryable } }
Channels.listDeliveries({ userId?, status?, channel?, since?, limit? /* ≤200 */ })
```

### `Team.findMember(name)` → `{ query, matches: [{ userId, fullName?, primaryEmail?, targets: [{ channel: 'whatsapp'|'sms'|'email', value, validated }] }] }` — resolve a colleague in the agent's org, then `Channels.send` to a target.

### `Templates.whatsapp` — `list(channelId, { page?, limit?, search? })`, `get(channelId, templateId)`, `send(channelId, templateId, { phoneNumbers: string[], values?: { header?, body?, buttons? } })` → `{ results: any[], errors: any[], totalProcessed, totalErrors }`. Each `results[i]` is **Meta's raw per-recipient Graph API response body, passed through untouched** (lua-whatsapp `whatsapp-api.ts` returns `response.json()`; lua-api `template.service.ts` and its batch processor push `result.data` as-is) — including a 200-with-`error`-in-body from Meta, which is returned verbatim. ⚠ **Only successful sends land in `results`; failures go to `errors`**, so `results[i]` does *not* correspond to `phoneNumbers[i]` — correlate through the recipient identifiers inside Meta's body, never by index. A non-2xx from Meta makes the whole call throw (a 400 from lua-api). The element shape is untyped (`any`); inspect it at runtime. (`Channels.whatsapp.sendTemplate` is the simpler per-user form.)

### `CDN` — `CDN.upload(file: File): Promise<string /* fileId */>`, `CDN.get(fileId): Promise<File>`. Base `https://cdn.heylua.ai`. Pair with `AI.generate` for image analysis.

### `Lua.request` — `{ channel: Channel, webhook?: { payload } }`. `Channel` values the runtime tags: `'web' | 'whatsapp' | 'facebook' | 'instagram' | 'slack' | 'teams' | 'front' | 'messagebird' | 'api' | 'dev' | 'email' | string`. Use in tools, conditions, processors and model resolvers (`if (Lua.request.channel === 'whatsapp') …`). ⚠ **The website widget arrives as `'pop'`, not `'web'`** (typings lag): the deployed widget (lua-web `lua-pop/src/api/chat.ts`, `streamChat`) posts to `/chat/stream?channel=pop`; the platform keeps `pop` as its own runtime channel next to `web` (never an alias of it), the sandbox runner forwards the request channel unchanged and the deployed runtime injects it verbatim (`sandbox-runtime` `context.ts`: `Lua.request.channel = config.channel`) — so `Lua.request.channel === 'web'` is **false** for widget turns. The `Channel` union still spells it `'web'` (the trailing `| string` is what lets `'pop'` type-check). Compare against both: `const isWidget = Lua.request.channel === 'pop' || Lua.request.channel === 'web'` — `'web'` is what the HTTP chat API and other web clients send. Log entries for widget traffic carry `metadata.channel: 'pop'` as well; filter on `pop` when you scan widget turns.

### `env(key)` — reads the agent's environment. **Locally** (`lua test`, `lua test workflow` / `lua workflows run`): `src/utils/sandbox.ts` `loadEnvironmentVariables()` merges `process.env` with `./.env` (the `.env` value wins; `parseEnvFile` reads `KEY=value` lines, skips `#` lines, strips surrounding quotes) and the sandbox's `env` global reads that map — `env('X')` and `process.env.X` both work; `lua test` prints `📄 Loaded environment variables from .env file` when one exists. `lua env sandbox -k KEY -v VALUE` writes that `.env` in full (`staging` = `sandbox`; comments are dropped) and never calls the env API. **Sandbox chat**: `lua chat -e sandbox` compiles locally and pushes each skill to the sandbox as a sandbox skill version whose payload carries `env: loadEnvironmentVariables()` — the **whole `process.env`** merged with `.env` (`src/services/sandbox.service.ts` ~232-238) — ⚠ and the runtime **never reads that uploaded map**: a sandbox turn's `env('X')` resolves from the agent's server-side env (`subAgent.env` — the map the `production` env commands manage — plus any request overrides; lua-core `skill-eligibility.resolver.ts` ~317-318 / ~418), not from the version's `env`. Validated live 2026-09-13: a marker present only in the shell was uploaded with the version and `env('AUDIT_MARKER')` still returned `null` in the sandbox turn. So `.env` is what `lua test` reads; a sandbox *chat* turn sees the server-side env map. **Security consequence**: every `lua chat -e sandbox` ships every variable of the invoking shell (cloud credentials, tokens, `PATH`, `HOME`, …) to `api.heylua.ai`, where lua-api and lua-agents accept it unfiltered and lua-agents stores it with the sandbox version in Redis for ~24 h, for no functional gain. Never run sandbox chat from a shell holding secrets you would not hand to the platform — use a clean shell (`env -i HOME="$HOME" PATH="$PATH" lua chat --ci -e sandbox -m '…' -t`) or a scrubbed terminal profile. A platform fix (upload `.env` only, or nothing) is tracked. **Deployed**: `lua env production -k KEY -v VALUE` PUTs the agent's production env map and the runtime injects it into every invocation; `lua env production --list` prints keys with masked values (first 4 chars + `*`); `lua env production -k KEY --delete` removes one. Slash: `/lua-env`. Never hardcode a secret, never store one in `Data`. `env.template('KEY')` is a **workflow-only** compile-time placeholder (`{ __envRef }`) for agentIds/prompts/schedules, refused for keys ending in `SECRET|TOKEN|KEY|PASSWORD` — read those with `env()` inside `execute`. At module top level in a workflow file `env()` is stubbed to `''` at compile time.

---

## 13. Versioned vs non-versioned, and how each goes live

| Primitive | Versioned | Push | Goes live via |
|---|---|---|---|
| skill (tools inside) | yes | `lua push skill --name x` | unversioned agent: `lua deploy skill --name x --set-version latest --force`; agent with agent versions: `lua version create` → `lua version promote <n>` (`lua deploy skill` there is live at once but is undone by the next promote — cli-reference.md §5) |
| webhook | yes | `lua push webhook --name x` | `lua deploy webhook …` (scoped promote: immediate, snapshot-consistent) |
| trigger (`defineTrigger`) | yes | `lua push trigger --name x` | `lua deploy trigger …` (scoped promote) |
| job | yes | `lua push job --name x` | `lua deploy job …` (scoped promote) |
| preprocessor / postprocessor | yes | `lua push preprocessor|postprocessor --name x` | `lua deploy preprocessor|postprocessor …` (scoped promote) |
| persona (part of agent) | integer versions | `lua push agent` | **live on push** (the version is persisted `published` and served at once); `lua deploy persona --set-version <n> --force` re-points to an earlier version (rollback); `lua version promote` does not change the served persona |
| mcp-server | **no** (upsert by name) | `lua push mcp` | `lua mcp activate <name>` |
| device / device-trigger / voice | yes | `lua push device|device-trigger|voice` | agent version promote (`lua version create` → `lua version promote <n>`); not `lua deploy` types |
| workflow | yes | `lua push workflow --name x` (never part of `lua push all`) | `lua workflows deploy x -v latest` (scoped promote; not `lua deploy`); `lua workflows activate x -v <ver>` also deploys that version |
| whole agent | agent versions | `lua push` / `lua push all --force` (stage-all; the agent config in it — persona included — is live at once) | `lua version create` → `lua version promote <n>` (atomic, also the rollback path — it rewrites the live skill pins from the snapshot; the served persona is unaffected) |

Every production-affecting verb above is gated by this plugin: bare forms are denied; the slash commands emit `LUA_DEPLOY_CONFIRMED=1 …` after your one confirmation.

---

## 14. Gotchas the agents must not get wrong

1. `LuaSkill`, `LuaJob`, `LuaWebhook`, `LuaTrigger`, `PreProcessor`, `PostProcessor`, `LuaMCPServer`, `LuaVoice` throw on an empty `name`. `LuaAgent` does not validate `name`/`persona` strings (the template ships them empty and `lua init` fills them).
2. `JobSchedule` keys are `expression` / `executeAt` / `seconds`. `LuaJob.timeout` is an integer 1..600.
3. `Jobs.create` serialises `execute` — no closures; `activate` defaults true.
4. `Data.get` returns `{ data, pagination }`; `Data.search` returns `DataEntryInstance[]`.
5. `AI.generate(a, b)` — `a` is the **system** prompt when `b` is present.
6. `Channels.send` may return `{ delivered: true, persisted: false, warning }` (HTTP 200).
7. `Integrations.passthrough` relays provider errors in `status` instead of throwing.
8. `Agents.invoke` from a Bearer client ignores `outputSchema`/`toolScope`/`operationId` (internal-auth only); `userId` is ignored during a user-authenticated turn.
9. `LuaWebhook.secret` must be a compile-time literal/const.
10. A trigger has no `execute`; `tool.input` cannot call platform APIs; `tool` beats `transform`.
11. `env.template()` refuses secret-looking keys; `env()` in `execute` is the runtime read.
12. `Lua.request` is a sandbox global; the imported const is a placeholder with `channel: 'unknown'`.
13. `Products.getById` throws on miss; `Products.search(query)` has no limit argument.
14. `lua test` supports `skill | webhook | job | preprocessor | postprocessor | workflow`; `--input` is a JSON **string** (only `workflow` accepts `@file`). For `skill`, `--name` is a **tool** name and `--input` is that tool's fields — `--name <skill>` fails with `not_found: Tool "<skill>" not found`, and a `{"tool": …}` wrapper is not recognised. Always pass `--name`: without it the tool picker ignores `--ci` and exits 0 having tested nothing.
15. Never import from `'lua-cli/skill'`; never call `defineTool`.
16. **Typings run ahead of the deployed runtime** (3.33.0): `Data.create`/`Data.update` with an options object → `400 searchText must be a string` in production (use the string/2-arg forms), and the deployed service never forwards `index` — an index can be declared only from a `lua test` run; `Data.collections()` is not injected deployed; `Voice.createSession` is not injected deployed **or** under `lua test` (validated in both, 2026-09-13); `Workflows.raiseBudget` fails in both (use `lua workflows raise-budget`) while `resume` / `signal` / `signalByKey` / `startBatch` / `setGoal` / `goals.*` work deployed; deployed `Workflows.list` ignores the `workflow` filter; `LuaMCPServerConfig` has no `description`.
17. `Integrations.passthrough` takes `data` (not `body`), returns `data` (not `body`), has no `connectionId`; `IntegrationPassthroughError` is not exported — duck-type on `name`/`code`.
18. `user.send(messages)` returns `true` or throws locally but **always `true`** deployed (delivery failures are swallowed) — use `Channels.send` when you need a delivery result.
19. `AI.generate` `output` is parsed, never validated against your schema — `safeParse` it.
20. `Agents.invoke` under `lua test` drops `userId`/`model`/`timeoutMs` and returns blocked turns as `{ text, finishReason }`; deployed it throws `AgentInvocationError` — handle both.
21. A `defineDeviceTrigger` / device `triggers.*` `execute` receives `{ device: { name }, trigger: { name, triggerId } }` at runtime — there is **no `agent`** in the context although the type declares one, and no `trigger` in the type although the runtime passes it (§9).
22. `Lua.request.channel` is `'pop'` for the website widget, `'web'` for other web clients (§12).
23. `lua init --with-examples` examples do not type-check against 3.33.0 (`tsc --strict`: 23 errors in 10 files, skills and workflows alike) — mirror their layout, never copy their API calls (workflows.md §1).
24. `LuaWebhook` `querySchema` / `headerSchema` / `bodySchema` are never applied at run time (`lua test` or deployed) — `safeParse` the event yourself first thing in `execute` (§4).
25. `LuaWebhook.secret` is Lua's own `x-lua-signature` scheme and a compile-time literal: it cannot read `env()`, and it rejects every delivery from a vendor that signs with its own header — leave it unset for Stripe/GitHub-style senders and verify their HMAC yourself (`defineTrigger` `verify` over `rawBody`) (§4).
26. Deployed webhooks have **no wall timeout** — the handler keeps running after the caller's ~90 s ingress 504; tools are cut at 180 s on the remote runner. Keep handlers short and idempotent; never rely on a server-side cut (§4).
27. Deployed job retries: a fixed `backoffSeconds` (default 60) wait, `min(maxAttempts, 10)` attempts, **no retries without a finite `maxAttempts`**; `job.execution.attempt` is set on every deployed run (§6).
28. `user.send()` never reaches email — no service writes an email channel window; use `Channels.email.send` (§12).
29. `concurrencyPolicy: 'forbid'` is **not enforced** on `Workflows.start` / `lua workflows start` / REST / trigger starts today — overlapping runs are possible; dedupe with `idempotencyKey` and guard inside the workflow (§12, workflows.md §1).
30. `OrderStatus.FULFILLED` sends `fulfilled`; the platform's enum, filters and dashboards use `fullfilled` (two l's) and the status param is never validated — the mismatch is silent (§12).
31. `lua chat -e sandbox` uploads the **entire shell environment** with each sandbox skill version and the runtime never reads it — run it from a clean shell (`env -i …`); `lua test` reads `.env` locally and uploads nothing (§12 `env(key)`, cli-reference.md §4).
32. `lua test skill|webhook|job|…` prints `✅ … execution successful!` and exits **0 when `execute` throws** — the throw comes back as the result `{ status: 'error', error }` (`src/utils/sandbox.ts` ~463-467; `test.ts` ~390-399, ~497-501). Check the result, not the exit code. Likewise `lua push all` / `lua deploy all` exit 0 after per-item failures and `No versions … skipping` — parse the summary (cli-reference.md §4).

---

## 15. Inbound channels (where users talk to the agent)

Managed via `lua channels` (interactive; `lua channels list` is the only non-interactive action) and the admin dashboard. Runtime `Lua.request.channel` values: `pop` (the website widget — it sends `channel=pop`; see §12 `Lua.request`), `web` (HTTP chat API and other web clients — not the widget), `whatsapp`, `facebook` (Messenger), `instagram`, `slack`, `teams`, `email`, `api`, `dev`, `front`, `messagebird`; voice calls run through a `LuaVoice` (phone numbers via `lua channels`). **Telegram is not available** (docs list it as coming soon). Outbound-capable channels are the `CHANNEL_SEND_CHANNELS` list in §12; WhatsApp needs an approved template outside the 24 h customer-service window.

Channel constraints the architect should plan for: WhatsApp → template strategy for proactive sends; voice → tool latency (< 2 s) and `persona.voice`; email → multi-paragraph plain text/HTML, no markdown rendering; Teams group chats → `conversationId` sends are never persisted to a user thread.

---

## 16. Quick decision matrix

| Task | Primitive |
|---|---|
| "Look up X for the user" | `LuaTool` inside a `LuaSkill` |
| "When an external system posts an event, run my code" | `LuaWebhook` |
| "When an external system posts an event, wake the agent / run one tool / start a workflow" | `defineTrigger` |
| "At time T / every N, do Z" | `LuaJob` (cron / interval / once) |
| "Remind this user in 1 hour" | dynamic `Jobs.create` from a tool |
| "Multi-step, long-running, approvals, fan-out, retries, Job-tier code" | `createWorkflow` (workflows.md) |
| "Filter / rewrite every message before the agent" | `PreProcessor` |
| "Reformat every reply for a channel" | `PostProcessor` |
| "Per-user state" | `User.get(...)` + `update`/`patch` |
| "Agent-wide data, lookup tables, vector search" | `Data` (+ `index` declarations — from a `lua test` run only, §12) |
| "Known SaaS (Linear, HubSpot, Gmail, Stripe, GitHub …)" | `lua integrations connect` → auto-provisioned MCP (+ `Integrations.passthrough` for raw calls) |
| "My own MCP server" | `LuaMCPServer` |
| "Classify / summarise inside code" | `AI.generate` |
| "Hand off to another agent" | `Agents.invoke` |
| "Proactive message / email / WhatsApp template" | `Channels.*` (`User.get(id).send` reaches the user's last chat channel — never email) |
| "Phone call" | `LuaVoice` + `Voice.call` |
| "Hardware / local machine" | `defineDevice` / `defineDeviceTrigger` |
| "Package the agent for other orgs" | marketplace agent template (`lua marketplace template …`, cli-reference.md) |

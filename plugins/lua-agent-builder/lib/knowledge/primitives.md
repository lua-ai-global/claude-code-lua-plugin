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
- `model` omitted ⇒ the CLI sends no model and the platform applies its server-side default — `PLATFORM_DEFAULT_MODEL = 'alibaba/qwen3.8-flash'` (`@lua/shared-types` `model-registry.ts`, overridable on the server by `LUA_DEFAULT_MODEL`); lua-cli never names it (`lua models list --json` shows `currentModel`, printed as `(platform default)` when unset; `lua models unset` reverts to it). There is **no automatic provider fallback** anywhere in lua-cli or the model resolver: a model the provider refuses is exit 12 `provider rejected`, never a silent switch to another model. Valid codes come from `lua models list --json` (server catalog; examples today: `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `anthropic/claude-sonnet-5`, `anthropic/claude-opus-5`, `google/gemini-3.8-flash`, `alibaba/qwen3.8-max`). A model **resolver function** runs per request in the full sandbox (`(req) => req.channel === 'whatsapp' ? 'openai/gpt-5.4-mini' : 'anthropic/claude-sonnet-5'`). `lua models set --model <code>` edits the literal in `src/index.ts` and PATCHes the agent.
- `modelSettings` is validated at construction: `temperature` 0..2, `topP` 0..1, `maxOutputTokens` ≥ 1, finite numbers for `topK`, `presencePenalty`, `frequencyPenalty`, `seed`; `stopSequences: string[]`; `reasoning: { effort?: 'off'|'minimal'|'low'|'medium'|'high'|'max'; show?: boolean }`.
- `governance` never stores a token — API mode reads `GOVERNANCE_API_KEY` from env at runtime. `lua governance add` scaffolds `src/governance.ts` interactively.
- `browser: true` costs money per session; off by default.
- Pushed with `lua push agent` (alias `lua push persona`; also part of `lua push all`): routing description, persona (as a new persona **version**, not live), model / model resolver, modelSettings, batching, browser, voice links. Persona goes live with `lua deploy persona --set-version <n|latest>`.
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
  querySchema?: ZodType; headerSchema?: ZodType; bodySchema?: ZodType;
  secret?: string;               // HMAC-SHA256 key: the platform rejects calls without a valid
                                 // `x-lua-signature: sha256=<hex of raw body>`; must be a literal / compile-time const;
                                 // `secret: ''` clears it on the next push
  execute: async ({ query, headers, body, timestamp }) => any;   // ONE event argument
});
```

- URL: `https://webhook.heylua.ai/<agentId>/<webhookId>` (or `/<agentId>/<webhook-name>`). Shown by `lua webhooks view`.
- Runs **outside** any conversation: it cannot answer a user directly. It mutates state (`Data`, `User.get(userId)…`), sends proactively (`Channels.send`, `User.get(id).send()`), starts or signals a workflow (`Workflows.start`, `Workflows.signal`), or hands the event to the agent with `Agents.invoke`.
- Platform **event subscriptions** (`lua webhooks subscribe --webhook-name x --event message.delivered`, `lua webhooks list-events`) make Lua itself call your webhook on platform events (delivery receipts etc.).
- Versioned: `lua push webhook --name x`, live via `lua deploy webhook --name x --set-version latest --force`; `lua webhooks activate|deactivate`.
- Test: `lua test webhook --name x --input '{"body":{...},"headers":{...},"query":{...}}'`.

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
- `{ startWorkflow }` creates the run synchronously in the delivery request (`200 { status:'accepted', executionId, runId }`) as the **system principal**; no chat turn fires. `idempotencyKey` is the one uniqueness key — set it from the vendor's delivery id, otherwise every redelivery starts a run. `notify` defaults `'off'`. Unknown workflow / input-schema failure / `concurrencyPolicy:'forbid'` overlap are typed rows in `lua triggers logs` (`failed` / `skipped_overlap`) on a 200.
- Register on `LuaAgent.triggers`. The trigger **record** (paste-anywhere URL + token) is managed by `lua triggers create|list|logs|activate|deactivate|rotate-token|delete`; `lua push trigger --name x` attaches the SDK bundle as a version; `lua deploy trigger --name x --set-version latest --force` makes it live.
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

Non-versioned (upsert by name): `lua push mcp`, enable/disable with `lua mcp activate|deactivate <name>` (activation changes the live agent — it is gated by the plugin like a deploy), `lua mcp list`. `lua deploy mcp` is not a valid type. Unified.to integrations auto-provision their own MCP servers — don't hand-write one for Linear/HubSpot/etc. (see integrations.md).

---

## 9. `LuaDevice` / `defineDevice` and `LuaDeviceTrigger` / `defineDeviceTrigger` — IoT and local machines

```ts
export const printer = defineDevice({
  name: 'label-printer',                          // lowercase, hyphens
  description?: string, group?: string,           // group = fan-out group
  commands?: { print: { description: string; inputSchema?: ZodType; timeoutMs?: number /* 30000 */; retry?: { maxAttempts; backoffMs } } },  // agent → device; each command becomes a tool
  triggers?:  { paper_low: { description: string; payloadSchema?: ZodType; execute?: async (payload, { agent, device, trigger }) => any } },   // device → agent
});

export const paperLow = defineDeviceTrigger({   // standalone, versioned on its own
  name: 'paper-low', description?: string, payloadSchema?: ZodType,
  execute: async (payload, { agent, device: { name } }) => { await agent.chat(`Printer ${device.name} paper low: ${payload.level}%`); },
});
```

Register on `devices` / `deviceTriggers`. Push: `lua push device`, `lua push device-trigger`. Manage: `lua devices list|status|enable|disable|remove|test|test-trigger --device-name x`. They are **not** `lua deploy` types — a pushed device/device-trigger goes live through `lua push … --auto-deploy` (blocked in this plugin) or an agent version promote (`lua version create` → `lua version promote`). Device clients (Node, MQTT, MicroPython) are documented under `/devices/*` on docs.heylua.ai.

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
`UserDataInstance`: `data` (proxied — `user.name` ≡ `user.data.name`), `_luaProfile` (`{ userId, fullName, mobileNumbers[], emailAddresses[] }`, read-only), `update(data)`, `patch({ set?, unset? })`, `unset(...fields)`, `clear()`, `save()` (PUTs `this.data`; no args), `send(messages)` (proactive message to that user on their channel), `getChatHistory()`. **There is no `User.update()`, no `user.get()`, no `user.id`** — use `user._luaProfile.userId`. Users are cross-channel: one profile across WhatsApp/web/email.

### `Data` — agent-scoped collections with vector search and declared indexes
```ts
Data.collections(): Promise<{ data: CustomDataCollectionInfo[], count }>      // incl. index status pending|building|ready|failed|rejected
Data.create(collection, data, options?: string | { searchText?: string; index?: Array<string | string[]> }): Promise<DataEntryInstance>
Data.get(collection, filter?: LuaQuery, page = 1, limit = 10): Promise<{ data: CustomDataEntry[], pagination }>   // NOT an array; items are plain { id, data, createdAt, updatedAt }
Data.getEntry(collection, entryId): Promise<DataEntryInstance>
Data.update(collection, entryId, data, options?): Promise<{ status, message }>
Data.search(collection, searchText, limit = 10, scoreThreshold = 0.6): Promise<DataEntryInstance[]>   // vector search; items carry .score
Data.delete(collection, entryId): Promise<{ status, message }>
```
`LuaQuery` is a bounded Mongo-style filter: `$eq $ne $gt $gte $lt $lte $in $nin $exists`, root `$and`/`$or`. **Indexes** — ⚠ runtime caveat first: the `{ searchText?, index? }` options object is what lua-cli 3.33.0 types and what `lua test` (lua-cli's local VM) sends, but the **production sandbox runtime** (`packages/sandbox-runtime/src/devtools/apis/custom.data.api.service.ts`) still has `create(collection, data, searchText?: string)` and posts the third argument as `searchText`, so a deployed tool calling `Data.create(c, doc, { index: [...] })` fails with `400 searchText must be a string` (seen live on 2026-09-12) while the same call passes locally. Until the runtime ships the object form, deployed code must use the legacy shape `Data.create(c, doc)` / `Data.create(c, doc, 'search text')` and declare no indexes from tool code. When it does ship: declare the fields you filter on where you write — `{ index: ['business_id'] }`; compound = nested array `{ index: [['country','business_id']] }` (serves leftmost prefixes only). Builds are async (minutes); limits 2 fields/index, 3 declarations/call, 5 indexes/agent; invalid ones are rejected (visible in `Data.collections()`), unused ones expire after ~14 days. A large unindexed filter eventually fails with a message naming the field. Never store secrets in `Data` — use `lua env` + `env()`.

### `Products`, `Baskets`, `Orders` — built-in commerce
```ts
Products.get(page?, limit?) | Products.get({ page?, limit?, filter?: LuaQuery }) → ProductPaginationInstance (products[], pagination, nextPage())
Products.create(product) → ProductInstance;  Products.getById(id) → ProductInstance (THROWS on miss);  Products.search(query) → ProductSearchInstance;  Products.delete(id)
Baskets.create({ currency, metadata? }) | .get(status?) | .getById(id) | .addItem(basketId, { id, price, quantity, SKU? }) | .removeItem(basketId, itemId) | .clear(basketId)
       | .updateStatus(basketId, BasketStatus) | .updateMetadata(basketId, metadata) | .placeOrder(data, basketId)   // data FIRST
Orders.create({ basketId, data }) | .get(status?) | .getById(id) | .updateStatus(OrderStatus, orderId) | .updateData(data, orderId)   // status FIRST
BasketStatus: ACTIVE | CHECKED_OUT | ABANDONED | EXPIRED;   OrderStatus: PENDING | CONFIRMED | FULFILLED | CANCELLED
```
`BasketInstance`/`OrderInstance` identity fields are TS-private — read `basket.toJSON().id` or cast. If the user already has Shopify/WooCommerce, use the integration and let it own the cart.

### `Jobs` — dynamic jobs created at runtime
```ts
Jobs.create({ name, description?, schedule: JobSchedule, execute: async (job: JobInstance) => any,
              timeout?, retry?: { maxAttempts, backoffSeconds? }, metadata?, activate?: boolean /* default true */ }): Promise<JobInstance>
Jobs.getJob(jobId) | Jobs.getAll({ includeDynamic?: boolean })
```
The `execute` function is **serialised with `toString()`**: it cannot close over variables — pass everything through `metadata` and read `job.metadata` inside. Created as version 1.0.0 and activated in one call. Use for "remind me in 1 hour" / "check this basket in 3 hours". `JobInstance`: `id`, `name`, `metadata`, `activeVersion`, `data`, `updateMetadata()`, `delete()`, `user()`, `trigger()`, `activate()`, `deactivate()` — **no `job.jobId`, no `job.schedule`**.

### `Workflows` — start/inspect/steer runs from code
`Workflows.start(nameOrId, input?, { idempotencyKey?, budget?, waitSeconds? (≤55), initialState?, correlationKey?, tags?, replyTo?, onBehalfOf?, workflowVersionId? })` (always fire-and-return; from a code step it is a DETACHED run — use `.workflow()` to wait), `.get(runId)`, `.list({...})`, `.cancel(runId, { mode?: 'request'|'force', reason? })`, `.resume(runId, stepId, resumeData)`, `.signal(runId, name, payload?, { dedupeKey? })`, `.signalByKey(...)`, `.startBatch(...)`, `.setGoal`, `.goals.*`. `raiseBudget` throws `WORKFLOWS_API_UNAVAILABLE` today. `concurrencyPolicy:'forbid'` overlap throws `WorkflowApiError{ code:'RUNS_IN_FLIGHT' }`. Details in workflows.md.

### `AI` — one-shot generation outside the agent's persona
```ts
AI.generate(prompt: string): Promise<string>
AI.generate(systemPrompt: string, content: UserContent /* string | [{type:'text',text}, {type:'image', image: Buffer|string, mediaType}] */): Promise<string>   // first arg becomes the SYSTEM prompt
AI.generate({ model?, system?, prompt?, messages?, temperature?, maxOutputTokens?, structuredOutput?: { schema } }): Promise<AiGenerateOutput>
  // → { text, finishReason, usage: { inputTokens, outputTokens, totalTokens }, reasoning?, sources?, output?, warnings? }
```
Cheap classification/extraction/summarisation inside a tool. Not user-facing. `Agents.invoke` is the expensive full-agent alternative.

### `Agents` — invoke another agent
```ts
Agents.invoke(targetAgentId, prompt): Promise<string>
Agents.invoke(targetAgentId, { prompt? | messages?, systemPrompt?, threadId?, channel?, userId?, webhookPayload?, timeoutMs?, model? }): Promise<{ text, threadId?, finishReason?, usage?, toolsUsed? }>
```
Full chat pipeline on the target (persona, skills, billing, processors). From webhooks/jobs pass `userId` to act as a specific user; omit `threadId` to use that user's default thread with the target. A chargeable conversation — don't use it for classification.

### `Integrations.passthrough` — raw provider API through a connected integration
```ts
Integrations.passthrough('github', { method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD', path: 'repos/acme/app/pulls/42', query?, data?, headers? })
  → { status, headers, data }   // provider 4xx/5xx come back in `status`, NOT thrown; non-JSON bodies are strings
```
Uses the agent's own connection for that integration type (`lua integrations connect --integration github`). Credentials never reach your code.

### `Voice` — outbound calls
`Voice.call({ to: '+15551234567' | { kind:'phone', number, callerId? } | { kind:'meet', url } | { kind:'web', returnToken? }, voice?, context?, threadId?, channel? }) → { sessionId, roomName, callId?, joinUrl? }`; `Voice.createSession({ userId?, voiceId?, displayName? }) → { url, roomName, token, participantIdentity, agentName }` for your own LiveKit frontend.

### `Channels` — proactive outbound messages
```ts
CHANNEL_SEND_CHANNELS = ['whatsapp', 'sms', 'email', 'webchat', 'teams', 'instagram', 'messenger']   // teams/instagram/messenger need a prior inbound
Channels.send({ channel, to: { userId? | phoneNumber? | email? | conversationId? /* teams only */ }, text, options?: { channelIdentifier?, whatsapp?: { onClosedWindow?: 'queue'|'fail' } } })
  → { deliveryId, status, delivered, persisted, queued?, warning? }     // delivered:true + persisted:false is a 200, check `persisted`
Channels.whatsapp.sendTemplate({ to, templateName, languageCode?, components? })   // outside the 24 h window
Channels.whatsapp.sendReaction({ to, messageId /* wamid, ≤30 days */, emoji /* '' removes */ })
Channels.email.send({ to: { userId? | email? }, subject?, text?, html?, richBody?, cc?, bcc?, attachments?: [{ filename, contentType, url }], inReplyTo?, references? })
Channels.getStatus(deliveryId) → DeliveryView { status: queued|accepted|sent|delivered|read|failed|expired, error?: { category, provider, code, title, retryable } }
Channels.listDeliveries({ userId?, status?, channel?, since?, limit? /* ≤200 */ })
```

### `Team.findMember(name)` → `{ query, matches: [{ userId, fullName?, primaryEmail?, targets: [{ channel: 'whatsapp'|'sms'|'email', value, validated }] }] }` — resolve a colleague in the agent's org, then `Channels.send` to a target.

### `Templates.whatsapp` — `list(channelId, { page?, limit?, search? })`, `get(channelId, templateId)`, `send(channelId, templateId, { phoneNumbers: string[], values?: { header?, body?, buttons? } })`. (`Channels.whatsapp.sendTemplate` is the simpler per-user form.)

### `CDN` — `CDN.upload(file: File): Promise<string /* fileId */>`, `CDN.get(fileId): Promise<File>`. Base `https://cdn.heylua.ai`. Pair with `AI.generate` for image analysis.

### `Lua.request` — `{ channel: Channel, webhook?: { payload } }`. `Channel` values the runtime tags: `'web' | 'whatsapp' | 'facebook' | 'instagram' | 'slack' | 'teams' | 'front' | 'messagebird' | 'api' | 'dev' | 'email' | string`. Use in tools, conditions, processors and model resolvers (`if (Lua.request.channel === 'whatsapp') …`).

### `env(key)` — reads the agent's environment. **Locally** (`lua test`, `lua test workflow` / `lua workflows run`): `src/utils/sandbox.ts` `loadEnvironmentVariables()` merges `process.env` with `./.env` (the `.env` value wins; `parseEnvFile` reads `KEY=value` lines, skips `#` lines, strips surrounding quotes) and the sandbox's `env` global reads that map — `env('X')` and `process.env.X` both work; `lua test` prints `📄 Loaded environment variables from .env file` when one exists. `lua env sandbox -k KEY -v VALUE` writes that `.env` in full (`staging` = `sandbox`; comments are dropped). **Deployed**: `lua env production -k KEY -v VALUE` PUTs the agent's production env map and the runtime injects it into every invocation; `lua env production --list` prints keys with masked values (first 4 chars + `*`); `lua env production -k KEY --delete` removes one. Slash: `/lua-env`. Never hardcode a secret, never store one in `Data`. `env.template('KEY')` is a **workflow-only** compile-time placeholder (`{ __envRef }`) for agentIds/prompts/schedules, refused for keys ending in `SECRET|TOKEN|KEY|PASSWORD` — read those with `env()` inside `execute`. At module top level in a workflow file `env()` is stubbed to `''` at compile time.

---

## 13. Versioned vs non-versioned, and how each goes live

| Primitive | Versioned | Push | Goes live via |
|---|---|---|---|
| skill (tools inside) | yes | `lua push skill --name x` | `lua deploy skill --name x --set-version latest --force` |
| webhook | yes | `lua push webhook --name x` | `lua deploy webhook …` |
| trigger (`defineTrigger`) | yes | `lua push trigger --name x` | `lua deploy trigger …` |
| job | yes | `lua push job --name x` | `lua deploy job …` |
| preprocessor / postprocessor | yes | `lua push preprocessor|postprocessor --name x` | `lua deploy preprocessor|postprocessor …` |
| persona (part of agent) | integer versions | `lua push agent` | `lua deploy persona --set-version latest --force` |
| mcp-server | **no** (upsert by name) | `lua push mcp` | `lua mcp activate <name>` |
| device / device-trigger / voice | yes | `lua push device|device-trigger|voice` | agent version promote (`lua version create` → `lua version promote <n>`); not `lua deploy` types |
| workflow | yes | `lua push workflow --name x` | `lua workflows deploy x -v latest` (not `lua deploy`) |
| whole agent | agent versions | `lua push` / `lua push all --force` (stage-all) | `lua version create` → `lua version promote <n>` (atomic, also the rollback path) |

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
14. `lua test` supports `skill | webhook | job | preprocessor | postprocessor | workflow`; `--input` is a JSON **string** (only `workflow` accepts `@file`). For `skill`, `--name` is a **tool** name and `--input` is that tool's fields — `--name <skill>` fails with `not_found: Tool "<skill>" not found`, and a `{"tool": …}` wrapper is not recognised.
15. Never import from `'lua-cli/skill'`; never call `defineTool`.

---

## 15. Inbound channels (where users talk to the agent)

Managed via `lua channels` (interactive; `lua channels list` is the only non-interactive action) and the admin dashboard. Runtime `Lua.request.channel` values: `web` (website widget / HTTP chat API), `whatsapp`, `facebook` (Messenger), `instagram`, `slack`, `teams`, `email`, `api`, `dev`, `front`, `messagebird`; voice calls run through a `LuaVoice` (phone numbers via `lua channels`). **Telegram is not available** (docs list it as coming soon). Outbound-capable channels are the `CHANNEL_SEND_CHANNELS` list in §12; WhatsApp needs an approved template outside the 24 h customer-service window.

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
| "Agent-wide data, lookup tables, vector search" | `Data` (+ `index` declarations) |
| "Known SaaS (Linear, HubSpot, Gmail, Stripe, GitHub …)" | `lua integrations connect` → auto-provisioned MCP (+ `Integrations.passthrough` for raw calls) |
| "My own MCP server" | `LuaMCPServer` |
| "Classify / summarise inside code" | `AI.generate` |
| "Hand off to another agent" | `Agents.invoke` |
| "Proactive message / email / WhatsApp template" | `Channels.*` (or `User.get(id).send`) |
| "Phone call" | `LuaVoice` + `Voice.call` |
| "Hardware / local machine" | `defineDevice` / `defineDeviceTrigger` |
| "Package the agent for other orgs" | marketplace agent template (`lua marketplace template …`, cli-reference.md) |

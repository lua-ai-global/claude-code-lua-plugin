# Decisions reference (⏳ requires lua-cli 3.48.0 or later; `--model` and OpenRouter ids need 3.49.2)

Read from the lua-cli source and its shipped docs, not from memory: `docs/api/Decisions.md`, `docs/api/LuaDecision.md`, `docs/CLI_REFERENCE.md` (`lua decisions`), `src/cli/command-definitions.ts` (the `decisions` declaration), `src/commands/decisions.ts`, `src/utils/aliases.ts` (`decisions.action`), `src/compiler/plugins/decision.plugin.ts`, and `@lua/shared-types` `decisions.types.ts` / `decisions.schema.ts`.

**⏳ Everything in this file needs lua-cli 3.48.0 or later.** `lua decisions` does not exist below it (exit 1, `unknown command`) and `LuaDecision` is not exported. `lua decisions run --model <id>` and `--provider openrouter` need **3.49.2**; below it `--model` is an unknown option (exit 1) and `openrouter` is refused by `--provider` (exit 2).

lua-cli is a TypeScript toolchain. It has nothing to do with the Lua programming language.

---

## 1. What a decision is

A **decision** is one call that takes some state and typed questions and returns typed answers with probabilities. Code branches on the numbers instead of parsing prose. There are two ways to call it:

- **`Decisions.ask(state, questions, options?)`** — inline, from any agent code: tools, jobs, webhooks, triggers, pre- and post-processors and workflow steps. Nothing to declare or push.
- **`Decisions.run('<name>', state, options?)`** — runs a **named decision** declared with `LuaDecision` (or `defineDecision`) and listed in the agent's `decisions: [...]`. The questions live on the server as a **versioned primitive**: every `lua push` stages a new version, the dashboard can edit and publish one, and `lua decisions publish` rolls back. Code keeps calling the name.

A decision is **agent-scoped**: it belongs to the agent in `lua.skill.yaml`, so `lua decisions` needs a project directory (or `--agent-id`). Nothing here is organization-wide.

The call never goes through the chat pipeline, costs a flat per-call amount, and typically answers in a few hundred milliseconds on the default provider.

## 2. Questions and answers

Three builders, checked locally before any network call (`decision_invalid` on a bad one):

| Builder | Answer `type` | Fields on the answer |
|---|---|---|
| `Decisions.odds(instructions, criteria?)` | `odds` | `odds` (0 to 1, the probability that the answer is yes) |
| `Decisions.choice(instructions, options)` where `options` is `{ key: 'description', … }` (2 to 64 keys) | `choice` | `choice` (one of the keys, typed as the literal union), `confidence`, `probabilities`, `uncertain` |
| `Decisions.score(instructions, levels)` where `levels` is 2 to 10 labels or `{ label, description }` | `score` | `score`, `level` (the label), `confidence`, `probabilities`, `uncertain` |

Any answer can instead be `{ type: 'refused' }` (OpenAI declined the question; Jev never refuses). **Code checks `answer.type` before reading** `.odds` / `.choice` / `.score`; TypeScript enforces it. `uncertain: true` means the confidence is below `minConfidence` (default 0.7).

Limits (`DECISION_LIMITS`): 64 questions per call, instructions ≤ 4,000 chars, state ≤ 120,000 chars, question names and option labels ≤ 64 chars (any name works, `constructor` included), images 4 per call / 5 MB each / 6 MB total, timeout 100 to 15,000 ms (default 3,000, clamped), cache ≤ 86,400 s.

## 3. Result shape

```ts
interface DecisionResult {
  decisionId: string;                       // the id of the call's log row
  answers: Record<string, DecisionAnswer>;
  provider: 'jev' | 'openai' | 'openrouter';
  model: string;                            // the exact model that answered (OpenRouter returns a dated id, e.g. liquid/d1-20260930)
  rule: 'pinned' | 'images' | 'region' | 'zero_retention' | 'default' | 'fallback';
  usage: { inputTokens: number | null };    // 0 on a cached hit
  durationMs: number;
  cached: boolean;
  fallback?: { from: 'jev' | 'openai' | 'openrouter'; reason: string };
}
```

`Decisions.run` results also carry `decisionName` and `decisionVersion`.

## 4. Providers and routing

| Provider | Default model | When it answers | Takes images | Per-call price |
|---|---|---|---|---|
| `jev` (default) | `jev-latest` (also `jev-preview`) | `auto` picks it unless the call carries images, sets `region: 'eu'` or `zeroRetention` | no | 0.005 actions |
| `openai` | `gpt-6-luna` | images, `region: 'eu'`, `zeroRetention`, or pinned | yes | 0.01 actions |
| `openrouter` | none — **needs a `model`** | only when pinned by `provider: 'openrouter'` or by a `vendor/model` id | per model | 0.01 actions |

Routing rules, in order: a pinned `provider` wins over everything (so `provider: 'jev'` with images fails `decision_rejected`); otherwise a `model` picks its own provider (`jev-*` → Jev, `gpt-*` → OpenAI, `vendor/model` → OpenRouter) and counts as a pin; otherwise `auto`. **`auto` never picks an OpenRouter model**, and `fallback` can name only `jev`, `openai` or `none`.

Fallback: on `auto`, when the routed provider times out or is unavailable (5xx, 401/402/403/429, breaker open), the other provider answers once with the time left (none under 100 ms) and the call is charged at the answering provider's price; the result says `rule: 'fallback'` and `fallback.from`. A pinned provider never falls back unless `fallback` is set. A 4xx from the model itself (`decision_rejected`) never falls back.

Jev takes about 32,000 tokens of input. On `auto` a larger state falls back to OpenAI; pinned to Jev it fails `decision_rejected` with Jev's message.

### OpenRouter models (⏳ 3.49.2)

Set `model` to a `vendor/model` id and the call runs on that model with the same request and answer shape; the result reports `provider: 'openrouter'`. Which ids are served is the list in the public docs (`/reference/sdk/decisions#other-decision-models-through-openrouter`; today `perplexity/pplx-decider-v1.1-27b`, `liquid/d1`, `microsoft/microsoft-decision-1`, `cloudflare/clef-flash`, `cloudflare/clef`, `inception/mercury-decide`, `togethercomputer/tev1-4b-experimental`, `upstage/solar-decide-flash`, `upstage/solar-decide`, `jaredpalmer/kev-4b`, `nace-ai/drex-v1.5`, `scaledown/classify-1`). Read the docs for the current list; never invent an id.

- `provider: 'openrouter'` without a `model` → `decision_invalid` (`provider openrouter needs a model id, such as liquid/d1`).
- `typesafe/...` or `openai/...` ids on openrouter → `decision_invalid` with a message naming the provider to set instead (Jev and OpenAI run on Lua's own providers, never through OpenRouter). Both of these are also **compile errors** for a `LuaDecision`, so `lua compile` / `lua push` stop before anything is written.
- Any other `vendor/model` id is accepted locally and checked when the call is made: an unknown id, or a model Lua does not serve because its vendor retains request data (`respan/span-01`, `cloudflare/clef-omni`, `inception/mercury-decide:free`, `openai/gpt-6-luna-decisions`), fails with `decision_rejected` (HTTP 422) and the upstream message. No fallback.
- Images are sent to every model; a model its vendor lists as text-only may read or ignore them. `scaledown/classify-1` takes one png or jpeg image; a second image or another format fails `decision_rejected` before the call. It answers in 3 to 6 s, past the 3 s default timeout, so set `timeoutMs` (up to 15000) when pinning it.

## 5. Options (`Decisions.ask` options and `LuaDecision` config share them)

| Option | Values | Default |
|---|---|---|
| `provider` | `'auto' \| 'jev' \| 'openai' \| 'openrouter'` | `'auto'` |
| `model` | a model id of that provider | the provider's default |
| `fallback` | `'jev' \| 'openai' \| 'none'` | the other provider |
| `region` | `'eu'` | none (routes to OpenAI's EU endpoint) |
| `zeroRetention` | boolean | `false` (routes to OpenAI only) |
| `minConfidence` | 0 to 1 | `0.7` |
| `timeoutMs` | 100 to 15000 | `3000` |
| `cache` | `{ ttlSeconds }` | none |
| `logState` | `'summary' \| 'full' \| 'none'` | `'summary'` |
| `images` | up to 4 `{ data (base64), mimeType }` | none (`ask` only; on a `run` it overrides for that call) |

On `Decisions.run`, any option overrides the version's value **for that call only**.

## 6. `LuaDecision` (the named, versioned form)

```ts
import { LuaAgent, LuaDecision, Decisions } from 'lua-cli';

export const triage = new LuaDecision({
  name: 'triage',                       // 1 to 64 letters, digits, _ or -; unique on the agent
  description: 'Route an inbound message to the right team',
  questions: {
    refund: Decisions.odds('Is the customer asking for a refund?'),
    team: Decisions.choice('Which team should handle this?', {
      billing: 'Payments, invoices, refunds and charges.',
      tech: 'Bugs, errors and anything that does not work.',
      sales: 'Pricing, plans and buying more.',
    }),
  },
  minConfidence: 0.7,
});

export const agent = new LuaAgent({ name: 'support', persona: '…', decisions: [triage] });
```

Rules the compiler enforces (`decision.plugin.ts`, `DecisionDefinitionWriteSchema`):
- Write it as `new LuaDecision({...})` or `defineDecision({...})` with **literal** questions built by the three builders, exported under a name. A decision built by a helper function cannot be read and fails the compile naming the export. Namespace imports work (`decisions: [shared.triage]`).
- Two decisions with one name in a project fail the compile, naming both files.
- `provider: 'openrouter'` needs `model`; a `typesafe/…` or `openai/…` model on openrouter fails. Both are compile errors.

Lifecycle: `lua push` (or `lua push decision --name <n>`) **stages** a version; it does not change what `Decisions.run` asks. The first push writes **1.0.1** (the push bumps `lua.skill.yaml` from 1.0.0 first, like every versioned primitive). A staged version goes live through `lua version create` + `lua version promote`, or straight away through `lua decisions publish <name> <version>`. A dashboard-saved draft is never pinned by a promote; it goes live only when published. Until a decision has a current version, `Decisions.run` throws `decision_not_found`. Promoting an older agent version brings back the decision versions it included; promoting the already-active one changes nothing. Each lua-core pod caches the current version and a promote/publish/rename/delete clears it at once.

`lua version status` lists each decision with the live version, the version the active agent version pins when that differs (`live 1.5.0, agent version pins 2.0.7`, or `deleted`), and the version in `lua.skill.yaml`. If a decision was deleted or renamed on the server while the code still declares it, the next push says so in one line, pushes to the active decision with the code's name (creating one when there is none) and rewrites `lua.skill.yaml`.

## 7. The verbs (`lua decisions [action] [name] [version]`)

`validateOrSuggest('decisions.action', …)`: canonical `list` (default) · `versions` · `publish` · `run` · `delete`. Aliases: `ls`/`view` → list; `history`/`list-versions` → versions; `rollback`/`deploy` → publish; `try`/`test` → run; `rm`/`remove`/`del` → delete.

| Verb | Shape | Effect | Tier |
|---|---|---|---|
| `list` | `lua decisions [list] [--json]` | the active decisions with current version, source (`from code` / dashboard) and created date | read |
| `versions <name>` | `lua decisions versions <name> [--json]` | every version newest first with questions, provider and `minConfidence`; the current one marked; **also finds a deleted decision** | read |
| `run <name>` | `lua decisions run <name> (--message '<text>' \| --state '<json>') [--provider p] [--model id] [--min-confidence n] [--json]` | runs the **current** version on the server and prints one line per answer, then provider, rule, model, duration, tokens, fallback. `--message` is sent as `{ message }`; `--state` is any JSON; both at once is exit 2, an empty message is exit 2 | read (a billed call, no config change) |
| `publish <name> <version>` | `lua decisions publish <name> <version> [--force]` | makes that version current now (the rollback); prints `old → new` and the questions added/removed; asks first unless `--force` or `--ci`; **on a deleted decision this turns it back on** (409 → exit 10 if another decision took the name) | **ask** |
| `delete <name>` | `lua decisions delete <name> [--force]` | deactivates and keeps the versions; `Decisions.run` then throws `decision_not_found`; asks first, and in CI needs `--force` (exit 2 without) | **ask** |

`--json` applies to `list`, `versions` and `run`. `--force` applies to `publish` and `delete`. All verbs take the project's agent (`lua.skill.yaml`) or `--agent-id`.

Exit codes: `0` ok · `2` usage (unknown decision name or version, missing argument, bad `--state` JSON, empty `--message`, `--provider`/`--min-confidence` out of range, `delete` in CI without `--force`) · `3` not found · `9` not authenticated · `10` forbidden, including the 409 name conflict on `publish` · `11` the API is unreachable **and** a failed `run` whose decision error is a 503 (`decision_timeout`, `decision_unavailable`, `decision_disabled`): the CLI prints the decision error's own message and exits 11. `lua logs --type decisions` shows the failed call's row.

## 8. Error codes (`DecisionError.code`, with `decisionId`)

| Code | HTTP | Meaning |
|---|---|---|
| `decision_invalid` | 400 | a field out of range, empty state, images over 6 MB, questions over 100,000 chars as JSON, `model` of another provider or of none, openrouter without a model |
| `decision_insufficient_credits` | 402 | the org ran out; the call that empties the balance still answers (billing runs after); then 402 for 60 s |
| `decision_not_found` | 404 | `Decisions.run` named a decision the agent does not declare, deleted, or never made current |
| `decision_rejected` | 422 | the provider refused the request itself: Jev pinned with images, a model the provider does not know, a blocked OpenRouter model, state over the provider's limit, a model's own option limit |
| `decision_timeout` | 503 | the whole call, fallback included, ran out of `timeoutMs`; also a call that waited longer than its budget for an identical in-flight call |
| `decision_unavailable` | 503 | both providers failed or the breaker is open |
| `decision_disabled` | 503 | the provider has no API key on the server |
| `decision_cancelled` | 400 | the caller went away before the answer; costs nothing |

The SDK sends a call once and never retries. A failed, cancelled or cached call costs nothing.

## 9. Sharing, caching, logs, billing

- Identical cacheable calls made at the same time share **one** provider call across the whole platform; the joiners come back `cached: true`. With `cache: { ttlSeconds }` the answer is reused for that long. A cached hit reports `usage.inputTokens: 0` and is free. Calls that differ in `region` or `zeroRetention` never share.
- Every call writes one log row under the **`decisions`** source: `lua logs --type decisions [--json]` (`/lua-logs`). The row carries `metadata.model`, `metadata.channel`, and `metadata.decision` with `decisionId`, `decisionName`/`decisionVersion` for a run, `provider`, `rule`, the questions, the answers with probabilities, `inputTokens`, `costUsd` (the provider's reported or estimated cost, not what the org is charged), `cached`, `fallback`, `errorCode`, and `state` per `logState`. A failed call's row records the model and the questions that were requested; a row leaves out `runId` when the call has none.
- Billing is per call in **actions**: 0.005 on Jev, 0.01 on OpenAI or an OpenRouter model, charged once at the answering provider's price after a fallback. Usage rows are durable, so a charged call is never missing from the usage report.
- Under `lua test` a tool, job, webhook or processor that calls `Decisions.ask` / `Decisions.run` makes the real call against the server with the project's credential (a `lua test preprocessor` that throws reports `proceed`, the same as live).

## 10. Dashboard

Agent → Decisions in admin.heylua.ai: the editor (questions, options), versions (publish, roll back), runs with answers and confidence, and a confidence chart. A version saved there is a draft until published; a promote never puts a draft live.

## 11. Public docs

`/reference/sdk/decisions` (API, answer types, routing, limits, the OpenRouter model list), `/reference/sdk/luadecision` (the named form, versions, the CLI verbs). The docs MCP reads them as `/reference/sdk/decisions.mdx` and `/reference/sdk/luadecision.mdx`.

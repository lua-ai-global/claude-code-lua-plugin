# Log drains reference (⏳ requires lua-cli 3.38.0 or later)

Read from the lua-cli source, not from the public docs: `src/cli/command-definitions.ts` (the `drains` and `logs` declarations), `src/commands/drains.ts` (context, the read verbs, the dispatcher), `src/commands/drains.mutations.ts` (create/update/delete/test/verify/pause/resume/rotate-secret), `src/api/drains.api.service.ts`, `src/utils/aliases.ts` (`drains.action`, `logs.type`), `@lua/shared-types` `log-drain.types.ts` / `vm-execution-log.types.ts`, and `@lua/shared-observability` `drain-scrubber.ts`. The reference pages (`/reference/cli/drains`, `/drains/*`) agree with all of it and are the place to send a user, never the place to learn a flag from.

**⏳ Everything in this file needs lua-cli 3.38.0 or later.** `lua drains` does not exist below it (exit 1, `unknown command`), and `lua logs --since / --until / --follow / --environment` are unknown options (commander exits 1). The plugin's pin is 3.38.0 since 1.5.0.

lua-cli is a TypeScript toolchain. It has nothing to do with the Lua programming language.

---

## 1. What a drain is

A **log drain** copies agent execution log records to a destination the customer owns — an HTTPS receiver, an OTLP collector, Datadog or Better Stack — as they happen. It is a **copy, not a move**: everything a drain ships is still readable with `lua logs` and still counts against the platform's retention window.

A drain lives on the **organization**, never on one agent. That is why the command needs no project directory: the org comes from `--org <id>`, else from the project's `lua.skill.yaml`, else from the credential's own authorization projection **when it reaches exactly one org** — a credential that reaches several exits 2 with the ids listed (`resolveDrainsContext` / `orgFromCredential`, `drains.ts`).

Roll-out is per organization. Until an org is enabled, every verb answers **404** → exit 3. That is the first thing to check when `lua drains list` fails for a user whose credential is fine.

A drain is: a **destination** (type + endpoint/site + headers), **selectors** (sources, severity, agents, environments, sampling, content), a **state**, **health counters** (24 h) and a **quota**. Caps: 5 drains per org, 10 on Enterprise (`LOG_DRAIN_MAX_PER_ORG*`).

## 2. The verbs (`lua drains [action] [id]`)

`validateOrSuggest('drains.action', …)` accepts these eleven canonical actions; no action at all means `list`. Aliases the CLI resolves: `ls`/`view` → list, `show`/`info`/`health` → status, `history`/`attempts`/`deliver` → deliveries, `new`/`add` → create, `edit` → update.

| Verb | Shape | Notes |
|---|---|---|
| `list` | `lua drains list [--json]` | Every drain in the org. Bare `lua drains` is the same thing — there is no interactive picker |
| `status` | `lua drains status [<id>] [--json]` | Health + quota; with an id, one drain in detail. **Exit 2 when any drain is `failing`**, set on `process.exitCode` *after* printing so `--json` still emits |
| `deliveries` | `lua drains deliveries <id> [--limit <n>] [--kind <k>] [--json]` | Recent attempts, newest first. `--limit` 1..100 (default 20); `--kind` ∈ `batch test verify heartbeat dropped truncated`. Never a request body |
| `create` | `lua drains create --name … --type … [--endpoint\|--site] …` | Prints the signing secret **once** |
| `update` | `lua drains update <id> <field flags> [--no-include-content]` | PATCH: only the flags given are sent. An empty patch is exit 2, and `--type` is rejected — a drain cannot change kind in place |
| `delete` | `lua drains delete <id> [--yes]` | Soft delete: destination credentials purged, queued records dropped. Confirms unless `--yes`; under `--ci` without `--yes` it exits 2 having changed nothing |
| `test` | `lua drains test <id>` | Sends one `lua.drain.test` record down the **real** delivery path |
| `verify` | `lua drains verify <id>` | Re-runs ownership verification |
| `pause` | `lua drains pause <id> [--reason <text>]` | Stops delivering; **buffering continues** |
| `resume` | `lua drains resume <id>` | Returns to `degraded`, never straight to `healthy` |
| `rotate-secret` | `lua drains rotate-secret <id> [--finalize]` | New HMAC secret, printed **once**; `--finalize` closes the overlap window early and mints nothing |

Every verb takes `--org <id>` and `--json`. Every verb needs an id except `list`, `status` and `create`; a missing id is exit 2 naming the verb.

**`test` and `verify` are asynchronous on the wire.** Both POST (the route answers 202) and then poll the customer-visible evidence — the deliveries log matched on the 202's `batchId` for `test`, the drain's own `verification` block for `verify`. `test` waits up to **30 s** (30 × 1 s), `verify` up to **60 s** (`DRAIN_POLL`). Nothing landed in time ⇒ exit 1 with `pending: true` in the JSON and the command that reads the outcome later (`lua drains deliveries <id> --kind test`, `lua drains status <id>`). The request is already enqueued when the wait starts — a timeout is not a failure to send.

## 3. States

| State | Delivering? | Buffering? | Meaning |
|---|---|---|---|
| `pending_verification` | no | yes | Created, or the endpoint changed. Records queue until ownership is proved |
| `healthy` | yes | — | Verified and succeeding |
| `degraded` | yes | — | >10% of the last five minutes' attempts failed, or it has just resumed |
| `failing` | yes | — | No success for 15 minutes. Still trying |
| `paused` | no | yes | Stopped by a person, by the quota ladder, or automatically after 24 h without a success (reason `auto`) |
| `disabled` | no | **no** | Turned off. Nothing is queued while it is off |

`LOG_DRAIN_STATES`; pause reasons `manual | auto | quota | operations`. Changing the endpoint or the type sends a drain back to `pending_verification` and records buffer meanwhile. A drain 24 h in `failing` pauses itself.

⚠ `lua drains status` exit **2** is also the usage exit code. A script that must tell a failing drain from a mistyped command reads `drains[].state` out of `--json`, never the exit status alone.

## 4. Selectors

**Sources** — 19 selectable in phase 1: the 18 `AGENT_LOG_SOURCES` (`skill job webhook trigger preprocessor postprocessor user_message agent_response agent_error runtime mcp rag device device-trigger model-resolver workflow-step workflow-script workflow`) plus **`execution`** (the `type: 'metric'` start/complete/error rows, which no `lua logs --type` value reaches). `LOG_DRAIN_SOURCES` also declares five phase-2 members (`delivery`, `trigger-execution`, `job-execution`, `workflow-run`, `workflow-audit`) that `--sources` refuses today. The default set is every selectable source **except** the two content ones.

**Content** — `user_message` and `agent_response` are `LOG_DRAIN_CONTENT_SOURCES`: off unless `--include-content`. Naming either in `--sources` turns content on implicitly and triggers the same acknowledgement (`wantsContent`).

**Severity** — `--min-severity debug|info|warn|error`, default `info` (so `debug` is dropped, which is most agents' volume). `--sampling debug=0.1` keeps a deterministic tenth of `debug` instead; sampling is by execution, and only `debug` is sampleable — any other key is exit 2.

**Agents** — `--agents all` (→ `'*'`, every agent in the org including ones created later) or a comma-separated id list. Inside a project directory the default is **that project's agent**; outside one it is `'*'` (`context.agentId` is absent there).

**Environments** — `--environments production` (the default) and/or `sandbox` (`AGENT_LOG_ENVIRONMENTS`). A row with **no** environment reads as `production`. A sandbox-only drain is the cheapest way to prove a destination before production traffic reaches it.

## 5. The verification handshake

A new drain starts in `pending_verification` and buffers rather than delivers. `lua drains verify <id>` mints a **single-use token, valid 10 minutes**, and sends one batch carrying one `lua.drain.test` record.

- **`http` is the only type that verifies by echo** (`TOKEN_ECHO_TYPES`). The receiver must answer 2xx **and** copy the request's `X-Lua-Verify` value back as its own response header. If the response carries no such header, one follow-up `GET {origin}/.well-known/lua-drain-verify` is made and a body whose trimmed content equals the token is accepted instead — the escape hatch for a proxy that strips unknown response headers.
- **`otlp`, `datadog` and `betterstack` verify by test post**: one record to the intake, and any 2xx is accepted.

`verification.outcome` and the line the CLI prints (`VERIFY_OUTCOME_TEXT`): `ok` → "verified" · `no_2xx` → "the endpoint did not answer 2xx" · **`token_not_echoed` → "token not echoed"** · `ssrf_refused` → "the endpoint was refused by the SSRF guard" · `timeout` → "the endpoint did not answer in time" · `error` → "the verification request failed". `token_not_echoed` is the commonest failure and the phrase the docs tell people to search for: the receiver answered, but dropped the header.

Verification is limited to **5 attempts per drain per hour** (429 `DRAIN_VERIFY_RATE_LIMITED`). `create` prints a copy-pasteable `curl` that proves the receiver does what verification needs — with `$ENV_VAR` for an env-backed header and a placeholder for a prompted one, never a value.

## 6. Destination presets

| `--type` | Endpoint | Auth | Signed? | Verification |
|---|---|---|---|---|
| `http` | `--endpoint`, the full HTTPS URL | your own `--header`s | **yes**, `X-Lua-Signature` | token echo |
| `otlp` | `--endpoint`, the **full `/v1/logs` URL**, used verbatim — the CLI appends nothing | your own `--header`s | no | test post |
| `datadog` | derived from `--site`; `--endpoint` is refused | `--header DD-API-KEY` | no | test post |
| `betterstack` | `--endpoint`, the source's own ingesting host (there is no template — it is per source and per region) | `--header Authorization`, entered as `Bearer <source token>` | no | test post |

`--site` values (`LOG_DRAIN_DATADOG_SITES`): `datadoghq.com`, `datadoghq.eu`, `us3.datadoghq.com`, `us5.datadoghq.com`, `ap1.datadoghq.com`, `ddog-gov.com`. `--format json|ndjson` is a generic-HTTPS choice; OTLP and the two vendor presets fix their own encoding. `LOG_DRAIN_TYPES` also declares the phase-2/3 types (`splunk loki axiom newrelic sumologic s3 syslog`) — lua-api answers 422 `DRAIN_TYPE_UNAVAILABLE` for them and the CLI refuses them locally against `LOG_DRAIN_TYPES_PHASE1`.

Generic-HTTPS request contract: `Content-Type: application/json` (or `application/x-ndjson`), `Content-Encoding: gzip` (bodies are **always** gzipped), `X-Lua-Signature: t=<unix seconds>,v1=<hex>` — HMAC-SHA256 over the **uncompressed** body, with a second `v1=` during a rotation window — `X-Lua-Batch-Id`, `X-Lua-Schema`, `X-Lua-Drain-Id`, `X-Lua-Verify` (verification batches only), `User-Agent: LuaDrain/1.0 (+https://docs.heylua.ai/drains)`.

## 7. Delivery, retries and quotas

At-least-once, unordered. **Consumers dedup on `records[].id`, never on `X-Lua-Batch-Id`** — a retried record comes back under a new batch id alongside whatever else is due. One batch carries exactly one `resource`, so records from three agents become three batches.

Flush is about every 2 s. Caps: 500 records / 1 MiB per batch (Datadog 1,000 / 5 MiB, 1 MiB per record), 10 s per attempt, 4 concurrent requests per drain, **6-hour retry horizon** (older records are dropped), 10 custom headers per drain. An over-long record body is cut and suffixed `…[truncated for destination]` rather than dropped.

Retry backoff is full jitter — a delay drawn uniformly from 0 up to a ceiling that doubles per consecutive failure (2, 4, 8, 16, 32 s) and stops at 60 s. **A `Retry-After` header (delta-seconds or an HTTP date) overrides that and is honoured exactly, clamped at one hour.** Retried statuses are `408 429 500 502 503 504`; every `3xx` (never followed) and every other `4xx` is terminal — the batch is dropped and counted under `rejected`. **OTLP is the exception**: only `429 502 503 504` are retried there and `400`/`500` are terminal, so a collector that answers `500` under load loses those batches — make it answer `503` while it sheds.

`deliveries[].errorClass`: `network timeout dns ssrf redirect http_4xx http_429 http_5xx rejected partial encode`.

Quota (per day, reset 00:00 UTC, visible under `quota` in `status --json`): 1,000,000 events / 1 GiB on Team, 10,000,000 / 10 GiB on Business, unmetered on Enterprise. The ladder degrades rather than cutting off — **80%** notify, **100%** drop `debug`, **125%** drop `info` too, **150%** pause the drain with reason `quota`. `warn` and `error` are never dropped before the drain pauses.

The drain **routes** themselves are rate-limited: **429 with `code: "DRAIN_RATE_LIMITED"` and a bare `Retry-After` in seconds**. There are no `X-RateLimit-*` headers — that header is the whole signal, so back off for exactly what it says.

## 8. The scrubber, and what never leaves Lua

Three things hold on every drain with no way to turn them off:

1. **Credential shapes are masked.** Every record body and every string attribute passes `@lua/shared-observability` `drain-scrubber.ts` before encoding. Built-in rules cover authorization and basic/bearer headers, JWTs, private-key blocks, connection-string passwords, URL secret parameters, JSON secret values, AWS access keys, typed and legacy Lua API keys, Lua handoff codes and scoped keys, and vendor keys for Anthropic, OpenAI, Stripe, Slack, GitHub, Twilio and Google. The mask is **`[redacted:<rule>]`**, where `<rule>` is the rule's **class** for a built-in — `[redacted:builtin]`, `[redacted:lua-token]`, `[redacted:vendor-key]` — and **`org:<rule-id>`** for an organization rule, i.e. `[redacted:org:<rule-id>]`. An org may add up to **20** regexes of at most 256 characters each.
2. **Destination credentials are never readable.** Header values and the signing secret are write-only. A read of a drain (`list`, `status`, REST) returns header **names** and the last four characters, never a value.
3. **No request body is stored.** A delivery row keeps status code, latency, bytes, record count, error class and up to 1 KB of the destination's *response*, scrubbed. There is no field that could hold what was sent.

⚠ Scrubbing is **not** a substitute for not logging secrets: whatever a tool prints with `console.log` is stored as printed, and the scrubber only catches shapes it recognises. Say this whenever a user asks whether `--include-content` is safe.

## 9. Scopes

| Surface | Scope |
|---|---|
| Every `lua drains` verb, and the deliveries log | `logs:manage` |
| Reading log records (`lua logs`, the A4 read routes, the `tail_logs` MCP tool) | `logs:read` |

`logs:manage` is **sensitive**: a wildcard such as `logs:*` does not satisfy it — a scoped key holds it only when it was granted by exact name. `logs:read` is an ordinary read scope, so a key with `*:read` already has it. A key without `logs:manage` gets one line and no `💡` block, because the remedy is in the message: `✖ forbidden: Missing scope: logs:manage. Create a key with that scope (lua auth key) or ask an org admin.` → **exit 10** (`MISSING_SCOPE_MESSAGE`, `drainsCall`). ⚠ Never run `lua auth key` for the user — it prints the raw key; tell them to run it in their own terminal.

The log read routes moved to `logs:read` and accept the previous scope (`knowledge:read`, `automations:read`, `analytics:read`) for **two releases**, answering with `Deprecation: true`, a `299` warning and a `Sunset` header. A user still on an old key should re-mint before that date.

## 10. Secrets: the rules the plugin must never break

- **The signing secret is never an input.** The server mints it; the CLI prints it exactly once, at `create` and at a non-`--finalize` `rotate-secret`. It is in the output in exactly one place and nothing stores it. **Never copy it into a file, an env var, a commit, a summary or the transcript** — tell the user it is on their screen and that a lost secret is rotated, not recovered.
- **Header values are never flags.** `--header <name>` takes a NAME and prompts for the value hidden (`type: 'password'`); passing `--header NAME=value` is exit 2 by design, because a shell history and a CI log both keep it. Under `--ci` the prompt is impossible, so the only form is `--header-from-env <NAME>=<ENV_VAR>`, which reads the value from that variable — and an unset or empty variable is exit 2 naming the **variable**, never its value.
- A rotation opens a **24-hour overlap window** in which every batch carries **two** `v1=` signatures, so a receiver can be updated without dropping a batch; `--finalize` closes it early and mints no new secret. The two answers are different shapes and are told apart by the **flag**, never by whether a `secret` key happens to be present.
- `--include-content` prints `CONTENT_WARNING_TEXT` and `CONTENT_ACKNOWLEDGEMENT_TEXT` **first** and only then requires a confirmation or `--yes`; without either it exits non-zero having printed both, so the operator reads what they were asked to accept. Reproduce those two paragraphs verbatim — never paraphrase them.
- `lua drains update <id> --no-include-content` is the opposite of the acknowledgement and needs none. The drain **keeps its sources**: `user_message` / `agent_response` records keep arriving with the body withheld and `lua.content.withheld` set, so the customer still sees that a turn happened, on what channel, for which end user — without the words. Drop the sources too if the records should stop. Naming a content source and `--no-include-content` in one update is exit 2 rather than silently resolved.

## 11. Output contract (`--json` on stdout, hints on stderr)

Every verb supports `--json`, and under it **stdout is the machine's**: `lua drains create --json | jq -r '.secret'` has to work. Human chrome that must survive — the verification instructions, the content acknowledgement — goes to **stderr** instead of being dropped (`emitAside`); none of it ever carries a secret or a header value. A refusal that escapes a verb under `--json` is the typed envelope on stdout, never the `✖` line.

| Verb | `--json` payload |
|---|---|
| `list` | the API object unchanged — `{ drains: [...] }` plus whatever the server added |
| `status` | `{ drains: [{ id, name, state, health, quota }] }` — that projection and nothing else |
| `deliveries` | the page object, including `nextCursor` |
| `create` | `{ drain, secret }` (`secret` only when the server minted one) |
| `update` / `pause` / `resume` / `rotate-secret --finalize` | `{ drain }` |
| `delete` | `{ id, deleted: true }` |
| `test` | `{ batchId, statusCode, latencyMs, responseExcerpt, ok, errorClass }` + `pending: true` if nothing landed in time |
| `verify` | `{ verificationId, expiresAt, outcome, message, statusCode, latencyMs, responseExcerpt, state, verifiedAt, verified }` + `pending: true` |
| `rotate-secret` | `{ secret, rotation }` |

`status --json` field names to read (`printDrainDetail` prints the same set): `health.{backlog, backlogBytes, deliveredCount24h, droppedCount24h, rejectedCount24h, p50LatencyMs, scrubHits24h, lastSuccessAt, lastFailureAt, lastStatusCode, lastError, pauseReason}` and `quota.{usedEvents, eventsPerDay, usedBytes, bytesPerDay, degradation, resetsAt}`.

Exit codes: `0` ok · `1` a `test` that was not delivered or a `verify` that did not reach `ok` · **`2` usage, and "some drain is `failing`" on `status`** · `3` not found (including an org without the feature) · `10` the credential lacks `logs:manage` · `11` the API is unreachable.

## 12. Reading the platform's own copy

A drain never replaces `lua logs` — the records stay readable, and the two filters line up: a drain's `--sources` are the same vocabulary as `lua logs --type` (minus `execution`, which no `--type` value reaches), and its `--environments` are the same two values as `lua logs --environment`. The read window (`--since`, `--until`, `--follow`, `--environment`) is in `cli-reference.md` §4 under the `lua logs` row; the field that makes `--environment` possible is `metadata.environment`, added platform-side and **absent on every row written before it shipped** — a row with no `environment` reads as `production`, on the drain matcher and in a report alike.

Typical triage order for "the drain is not delivering": `lua drains status <id>` (state, `lastError`, `lastStatusCode`, quota `degradation`) → `lua drains deliveries <id> --limit 20` (per-attempt `errorClass`) → `lua drains test <id>` (does one record get through right now?) → `lua drains verify <id>` if the state is `pending_verification`.

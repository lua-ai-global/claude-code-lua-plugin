# Lua Workflows reference (lua-cli 3.33.0)

Read from the lua-cli source (`src/types/workflow.ts`, `src/compiler/plugins/workflow.plugin.ts`, `src/commands/workflows.ts`, `src/commands/workflow-local-run.ts`, `src/api-exports.ts`) and the shipped examples (`template/examples/workflows/*`). Where the public docs disagree with the source, the source wins (differences are flagged ⚠).

A workflow is a durable, resumable graph of steps the platform runs for you: code steps, agent steps, tool steps, approvals, signals, timers, fan-out, nested workflows, with budgets, retries, schedules and goals. Use one when a tool or job is not enough: multi-step, long-running, human-in-the-loop, or Job-tier code with a git workspace.

---

## 1. Writing a workflow file

```ts
// src/workflows/research-brief.ts
import { z } from 'zod';
import { createStep, createWorkflow, stepOf, fromStep, template, gt, lit } from 'lua-cli';

const fetchSources = createStep({
  id: 'fetchSources',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ urls: z.array(z.string().url()) }),
  timeoutSeconds: 60,
  async execute({ inputData, log }) {
    const res = await fetch(`https://api.example.com/search?q=${encodeURIComponent(inputData.topic)}`);
    if (!res.ok) throw new Error(`search failed: ${res.status}`);
    const json = (await res.json()) as { url: string }[];
    log(`found ${json.length} sources`);
    return { urls: json.slice(0, 10).map((r) => r.url) };
  },
});
const angle = z.object({ summary: z.string(), confidence: z.number() });

export const researchBrief = createWorkflow({
  name: 'research-brief',                       // /^[a-z][a-z0-9-_]*$/ — the server identifier
  description: 'Fetch sources, summarise from two angles in parallel, merge — or fall back when confidence is low.',
  inputSchema: z.object({ topic: z.string() }), // required
  outputSchema: z.object({ brief: z.string() }),
  budget: { maxCredits: 40 },
})
  .then(fetchSources)
  .parallel(['techAngle', 'marketAngle'])       // arms DECLARED below by string id
  .agentStep('techAngle',   { agentId: 'analyst', prompt: template('Summarise the technical angle of ${initData.topic} using ${stepResults.fetchSources.urls}'), outputSchema: angle })
  .agentStep('marketAngle', { agentId: 'analyst', prompt: template('Summarise the market angle of ${initData.topic} using ${stepResults.fetchSources.urls}'), outputSchema: angle })
  .switch([[gt(stepOf<typeof angle>('techAngle').path('confidence'), lit(0.6)), 'merge']], 'lowConfidence')
  .map({ brief: fromStep('techAngle', 'summary'), market: fromStep('marketAngle', 'summary') }, { id: 'merge' })
  .agentStep('lowConfidence', { agentId: 'analyst', prompt: template('Confidence was low. Write a cautious brief on ${initData.topic}…'), outputSchema: z.object({ brief: z.string() }) })
  .commit();
```

Register it: `new LuaAgent({ …, workflows: [researchBrief] })` in `src/index.ts` (the const must be exported and imported there — the compiler only compiles workflows reachable from the agent).

Rules the compiler enforces:
- **Canonical entry is `createWorkflow({...})….commit()`** (or `defineWorkflow(cfg, (wf) => wf….commit())`). Never `new LuaWorkflow({...})`. The config argument **must be an inline object literal** — a config held in a variable is not detected.
- Graph files are any `.ts` in the project (convention `src/workflows/<name>.ts`). Script-form files must be `src/workflows/<name>.workflow.script.js` (§5).
- `lua init --with-examples` drops canonical examples in `examples/workflows/` (`research-brief`, `outreach`, `refund-approval`, `provision-tenant`, `reviewed-brief`, `ticket-to-pr` + `pr-review-round`, `support-triage`, `vendor-invoices`, `linear-ready.trigger.ts`, `github-review.webhook.ts`, `adversarial-verify.workflow.script.js`). Copy from those.

### `createWorkflow` config

| Field | Type | Notes |
|---|---|---|
| `name` | string | required; `/^[a-z][a-z0-9-_]*$/` |
| `description` | string? | |
| `inputSchema` | ZodType | **required**; `lua workflows start --input` and `scheduleInput` are validated against it |
| `outputSchema`, `stateSchema` | ZodType? | `stateSchema` types `ctx.state` (≤ 64 KB) |
| `concurrencyPolicy` | `'allow' \| 'forbid'` | `forbid` ⇒ a second start throws `RUNS_IN_FLIGHT` (409); scheduled fires are skipped |
| `budget` | `{ maxCredits?, maxSteps?, maxDurationSeconds? }` | `maxDurationSeconds` 60..2 592 000; default 604 800, or 2 592 000 when the graph has approvals/signals/suspend-capable steps (warning `hitl-duration-defaulted`). ⚠ `maxJobSeconds` is NOT a config member (only on `raise-budget`) |
| `schedule` | `JobSchedule & { runAs?: 'installer' \| 'system' }` | `{ type:'cron', expression, timezone? }` etc.; becomes a platform Job on publish; `runAs` matters only when frozen into a marketplace template |
| `scheduleInput` | object | literal run input on every scheduled fire; must validate (warnings `schedule-input-required` / `-invalid`, push blocker) |
| `backfillOnEnable` | `{ maxOccurrences?: 1..200 }` | replay missed fires on re-enable |
| `outputVisibility` | `{ roles: string[] (≤20, non-empty); users?: string[] (≤50); ownerBypass? }` | restricted readers get `restricted:true` and no output |
| `goal` | `{ objective, judge: { agentId \| '$self', role?, schema }, cadence: JobSchedule[], maxRuns, budget?, maxTotalCredits?, initialState? }` | iterative goal runs; `lua workflows goals …` |
| `workspace` | `{ kind:'git', repo, ref?, credentialsRef?, sizeGb?, ttlHours?, verify?, keepArtefacts?, backend? } \| { kind:'empty', … }` | Job-tier checkout (§4) |
| `connections` | `[{ key: /^[a-z][a-z0-9_-]{0,63}$/, integrationType, required?, description? }]` | declared connection keys that steps reference via `requiredConnections` / `credentialsRef` |

`env.template('KEY')` is legal where a `template()` is (agentId, prompt, `schedule.timezone`, workspace) and is resolved at push into the version's env overlay; keys ending in `SECRET|TOKEN|KEY|PASSWORD` are refused (`env-template-secret-key`) — read those with `env('KEY')` inside `execute`.

---

## 2. Steps and the placement rule

Builder methods (each returns the builder; end with `.commit()`):

```ts
.then(step)                                   // place a createStep object, or a string id declared elsewhere
.map(mapping, { id })                         // project data; `id` REQUIRED once a workflow has ≥ 2 maps
.parallel(arms, { merge? })                   // 2..16 arms: StepRef | [LuaMapConfig, StepRef]; output { [stepId]: output }
.branch(arms, { exclusive? })                 // [[predicate, StepRef], …]; all true arms run unless exclusive
.switch(arms, otherwise?)                     // exclusive branch with a fallback
.foreach(step, { items, concurrency? /*≤16, default 4*/, maxItems? /*≤20000, default 256, fail-fast*/, chunk?: { size }, rateLimit?: { perSecond } | { perMinute } })
.dowhile(step, predicate, { maxIterations? /*100*/, intervalSeconds? })   .dountil(...)
.sleep(ms, { id?, businessHours? })           // literal milliseconds
.sleepUntil(isoOrTemplate, { id?, businessHours?, round?: 'next-open' | 'next-close' })
.agentStep(id, { agentId, prompt, outputSchema?, model?, toolScope?, systemPrompt?, timeoutSeconds?, retry?, onError?, requiredConnections?, tier?: 'job', workspace?, jobResources?, harness?, maxTurns?, maxMessages?, maxInputTokens? })
.specialistStep(id, { role: { name, instructions (≤4000), tools: string[] } | { ref }, prompt, outputSchema?, model?, toolScope?, timeoutSeconds?, retry?, onError?, requiredConnections? })
.toolStep(id, toolObject, { input?, timeoutSeconds?, retry?, sideEffects?, onError?, requiredConnections? })   // a LuaTool imported by identifier from its own module
.approval(id, { title, details?, approver?, excludeInitiator?, fourEyes?, timeoutHours?, onTimeout?, onDeny?, businessHours?, editable?, editablePaths?, editedPayloadSchema?, itemsPath?, itemApprover?, itemTimeout? })
.waitForSignal(id, { signal, schema?, timeoutHours?, onTimeout?: 'fail' | 'continue', businessHours?, acceptedSources? })
.workflow(id, childWorkflowOrName, input?, { workspace?: 'inherit', retry? })   // nested run; parent WAITS; depth ≤ 3
.commit()
```

**The one placement rule**: a call site places exactly one entry. Inside a container (`parallel`, `branch`, `switch`, `foreach`, `dowhile`) a **string** names an entry *declared* somewhere in the chain by `agentStep` / `specialistStep` / `toolStep` / `map(…, { id })` / `workflow(…)` / `approval(…)` / `waitForSignal(…)` — "declare here, run inside me". Declarations may come before or after. An unreferenced declaration is placed where it is called (like `.then`). A `createStep` object placed in no workflow is `WORKFLOW_UNPLACED_STEP` (warning at compile, **refused at push**). The last entry's output is the run output.

### `createStep` (code step)

```ts
createStep({
  id: 'sendEmails',                // /^[a-z][a-zA-Z0-9_-]{0,63}$/
  inputSchema: z.object({...}).passthrough(),   // step input is validated additionalProperties:false unless passthrough
  outputSchema: z.object({ sent: z.number() }), // validated after every attempt
  timeoutSeconds?: 300,            // worker tier ≤ 600; Job tier code/tool ≤ 14 400 (agent steps ≤ 86 400)
  tier?: 'job',                    // implied by `workspace`
  workspace?: { mount: 'rw' | 'ro', isolation?: 'shared' | 'worktree' },
  jobResources?: 'small' | 'medium' | 'large',
  jobTools?: ['shell','read','write','edit','glob','grep','git','gh','fetch','ripwire'],
  retry?: { maxAttempts: 1..20, backoffSeconds?, backoff?: 'fixed' | 'exponential', maxBackoffSeconds? },
  sideEffects?: 'none' | 'external',   // 'external' ⇒ park on platform-fault reclaim instead of re-running
  onError?: 'fail' | 'continue' | 'park',
  requiredConnections?: ['stripe'],    // connection ids or declared connections[].key
  resumeTimeoutHours?: 168, businessHours?: { tz, calendar? }, onSuspendTimeout?: 'fail' | 'cancel-run',
  async execute(ctx) { … return output; },
});
```

**`ctx` (WorkflowStepContext)**: `runId`, `workflowId`, `stepId`, `attempt`, `occurrenceId` (stable across retries — THE side-effect dedup key), `lineageId`, `inputData`, `resumeData?`, `suspendData?`, `getInitData<T>()`, `getStepResult<T>(stepId)` (ancestors only; throws `WorkflowStepResultError` with `code` `STEP_RESULT_NOT_ANCESTOR | STEP_RESULT_TOO_LARGE | STEP_RESULT_OFFLOADED`), `state.get/set` (run KV, ≤ 64 KB), `suspend(payload)` (park for input; on resume `execute` re-runs from the top with `ctx.resumeData`), `bail(result)` / `bailRun(output)` (early success), `log(msg)` (≤ 1000/attempt), `signal: AbortSignal`, `env`, `once(key, fn)` (exactly-once keyed on `{occurrenceId,key}`; result ≤ 32 KB), `artefacts.put/get/list` (≤ 50 per step; `get(id).rows({offset,limit})` pages datasets), `runtime` (`trigger`, `parentRunId`, `correlationKey`, `tags`, `principalKind`, `replyTo`), and on the Job tier only `workspace` (`{ root:'/workspace', mount, branch?, headSha?, isolation? }`), `exec(argv, { cwd?, timeoutMs?, env? })` → `{ code, stdout, stderr, durationMs, truncated, timedOut }` (`exec.strict` throws), and the tagged template `$\`gh pr create --title ${title}\`` (each `${}` is ONE argv). ⚠ There is no `ctx.datasets` / `ctx.knowledge`.

Platform APIs (`AI`, `Channels`, `Integrations`, `Workflows`, `Data`, …) are available inside `execute`.

### Data flow

`.then(step)` receives the **previous node's output**. Project with `.map({ field: fromStep('id', 'path'), other: fromInit('path'), literal: value(1), text: template('${initData.topic} / ${stepResults.x.y} / ${state.k}') }, { id })`. Special key `''` means "the output IS this value" — how you hand `foreach` a raw array: `.map({ '': fromStep('leads', 'leads') }, { id: 'items' }).foreach(draft)`. `fromStep(['a','b'])` is a fan-in; `rows(step, path, { offset, limit })` pages a dataset; `fromKnowledge({ source, query, maxChars?, topK? })` binds retrieval. A **closure** where a descriptor is expected is `closure-binding`.

**Request context** (`fromRequest` at `src/types/workflow.ts:563`, resolver in `@lua/workflow-graph` `mapping.ts`): `fromRequest('runId')` is a `MapDescriptor` (`{ requestContextPath }`) bound to the run's read-only identity — `runId`, `workflowId`, `workflowVersionId?`, `orgId`, `agentId`, `userId` (`system:<agentId>` for system starts), `trigger` (`chat | sdk | api | schedule | webhook | template | workflow | device`), `triggerId?`, `eventId?`, `threadId`, `originThreadId?`, `parentRunId?`, `depth`, `startedAt` (ms, `run.createdAt` — stable across ticks; the deterministic "now"). The same fields form the **fourth template namespace**: `template('run ${requestContext.runId} for ${requestContext.userId}')` next to `${initData.*}`, `${state.*}`, `${stepResults.<id>.*}` (`${inputData.*}` is not a namespace — `binding_unresolved`). Legal wherever a descriptor is: `.map` values, a `[map, step]` `parallel` arm, `toolStep(…, { input })`, `.workflow(id, ref, input)`. **Not** legal as `foreach.items`: the lowering carries only `fromInit(path)`, a single-step `fromStep(step, path)` or a typed path ref — `value` / `template` / `fromRequest` / `rows` / `fromKnowledge` / a fan-in `fromStep([…])` there are `invalid-envelope` (`src/types/workflow.ts` ~755, ~1077); `.map({ '': … }, { id })` first. Inside `execute` the same data is `ctx.runId` / `ctx.runtime.trigger` / `ctx.runtime.parentRunId`. Offline (`lua test workflow`) the driver fills `orgId`, `agentId`, `threadId`, `userId` with `'local'`, `trigger: 'sdk'`, `depth: 0` (`src/utils/workflow-local-driver.ts` ~530).

### Predicates

`step(id).path('p')` / `stepOf<typeof schema>('id').path('p')` (typed) / `init<T>('path')` / `state<T>('path')` produce refs; combine with `eq ne gt gte lt lte inSet notIn exists notExists truthy falsy and or not` and `lit(v)`. A function where a predicate is expected is `closure-predicate` — compute the condition in a `createStep` and reference its output.

---

## 3. Human in the loop

**Approvals** — `.approval('reviewDrafts', { title: 'Approve outreach batch', details: template('${stepResults.drafts.drafts.length} drafts ready'), approver: 'creator' | 'org-admins' | { users } | { role } | { group } | { governance: { policyId } }, excludeInitiator?: true, fourEyes?: { edit, approve }, timeoutHours?: 168 (≤720), onTimeout?: 'deny' | 'cancel-run' | 'fail' | 'continue' | [{ escalateTo, timeoutHours }, …, 'deny'] (≤3 hops), onDeny?: 'continue' (default; denial is data) | 'fail', businessHours?, editable?, editablePaths?: ['drafts', 'drafts[*].body'], editedPayloadSchema?, itemsPath?, itemApprover?: { fromItem: 'approverEmail' }, itemTimeout? })`. A non-empty `editablePaths` implies `editable:true`. Output: `{ approved, decision: 'approved'|'denied'|'timed_out', text, note?, editedPayload?, editRevision?, decidedBy?, timedOut?, escalations?, items? }` — the next step reads `inputData.approved` / `inputData.editedPayload` and the original payload with `getStepResult('<map id>')`. Approvals are declarations: a container can claim one by id (one approval per `foreach` item). Resolve with `lua workflows approve <runId> --approval <wfa_…> [--decision approve|deny] [--note] [--edit @f.json --fingerprint <f>]` (the approval id is `suspend.approvalId` in `status --steps --json`; `approval-payload` prints the payload + fingerprint) or from the desktop inbox.

**Signals** — `.waitForSignal('review', { signal: 'github.review', schema?, timeoutHours?, onTimeout: 'fail'|'continue', acceptedSources?: ['webhook','api','user'] })`; completes with `{ payload, source, signalId, receivedAt }`. Send from a webhook with `Workflows.signal(runId, 'github.review', payload, { dedupeKey })` or `lua workflows signal <runId> <name> --payload @f.json`. Keys like `token`, `password`, `api_key` in a payload are persisted redacted.

**Input requests** — `ctx.suspend(payload)` in a code step; resume with `Workflows.resume(runId, stepId, data)` or `lua workflows resume <runId> --step <id> --data '{…}'`.

**Business hours / escalation chains** — `businessHours: { tz: 'Europe/London', calendar: 'mon-fri' | { days, start, end, holidays? } }` on approvals, waits, code steps, `sleep`, `sleepUntil`.

**Reply channels** — a run started with `replyTo: { channel, threadId }` posts its outcome back when it ends (`whatsapp` is the only registered adapter today ⚠).

---

## 4. Job tier, workspaces, coding turns

- Default (worker) tier: `timeoutSeconds` ≤ 600, no filesystem, no `exec`/`$`.
- `tier: 'job'` (or any `workspace`): a Kubernetes Job per attempt with a real filesystem; code/tool steps ≤ 14 400 s, agent steps ≤ 86 400 s (as ≤ 4 h segments with checkpoints; > 14 400 s requires a `workspace`). `child_process`, code-from-strings and WebAssembly compile are refused. Flat metering: inline agent step = 1 credit, Job attempt = 4 credits at claim.
- Declare `workspace: { kind: 'git', repo: 'https://github.com/acme/app', ref?: 'main', credentialsRef: 'github' /* a connection id or a declared connections[].key */ }` on the workflow and `workspace: { mount: 'rw' | 'ro', isolation?: 'worktree' }` on steps. Worktree arms in `parallel` need `{ merge: { strategy: 'rebase' | 'merge', onConflict: 'fail' | 'agent' } }`. Committed work lands on branch `lua/wf-<lineageId>`.
- `ctx.exec`/`ctx.$` allowlist: `git gh pnpm npm npx node yarn python3 pytest make` (today's image ships `git gh node npm npx`); argv only — no pipes, globs, `&&`, `cd`; `git push --force|--delete|--mirror|--all|--tags` refused, pre-push secret scan. `jobTools: ['gh']` mints a `GH_TOKEN` through a sidecar for `gh pr create|edit|comment` on the pinned repo.
- Coding turns: a Job-tier `agentStep` with `harness: 'claude-code' | 'generic'`, `jobTools`, `maxTurns`, `toolScope.connectionIds` (MCP connections via a local proxy; approval-needing tools are refused inside the turn). `ro` mounts drop write/edit/git/shell tools (compile warns `ro-step-has-no-tools` if nothing is left).
- Limits: `budget.maxCredits` over the org cap is a push blocker (`budget-exceeds-cap`); a budget-parked run resumes with `lua workflows raise-budget <runId> --credits <n>`; billing gates expire after 168 h. Private-network egress from code steps is `EGRESS_DENIED`.

---

## 5. Script form (`src/workflows/<name>.workflow.script.js`)

Plain JS ES module, no imports; first statement `export const meta = { name, description, phases?, whenToUse?, concurrency?, sampleArgs? }` (a pure literal ≤ 4096 bytes; `name` must equal the file stem). The body runs in an async context with host bindings `agent`, `tool`, `workflow`, `parallel` (thunks), `foreach`, `sleep`, `sleepUntil`, `approval`, `waitForSignal`, `signal`, `memo`, `step(label, fn, { timeoutSeconds? })`, `shell`, `merge`, `log`, `phase`, `once`, `bail`, plus `args` (run input) and `env.now()`/`env.random()`. A top-level `return` is the run output. Banned: `Date.now()`, `new Date()`, `Math.random()`, `globalThis`, `eval`, `new Function`, imports (`SCRIPT_NONDETERMINISM`, `SCRIPT_IMPORT_FORBIDDEN`). Use it for dynamic fan-out a static graph can't express; a workflow's form is fixed by its first version.

---

## 6. Runtime API from tools / webhooks / jobs

```ts
const { runId, status } = await Workflows.start('outreach', { leads }, { idempotencyKey: `outreach:${batchId}`, tags: ['nightly'], correlationKey: customerId, waitSeconds: 30 });
const run = await Workflows.get(runId);            // restricted runs: { restricted: true }, no output — never an error
await Workflows.signal(runId, 'review', { approved: true }, { dedupeKey: deliveryId });
await Workflows.resume(runId, 'ask', { answer: 42 });
await Workflows.cancel(runId, { mode: 'request' | 'force', reason });
await Workflows.list({ workflow: 'outreach', status: 'failed', limit: 20, sort: '-createdAt' });
```
`start` is always fire-and-return (`waitSeconds` ≤ 55 only changes the response); `status: 'gated'` = no org slot (quota/billing/consent). From a code step `start` is a DETACHED run — use `.workflow()` for a child the parent waits on. Run statuses: `queued running cancellation_requested gated suspended waiting completed failed cancelled abandoned timed_out`. A trigger's `transform` may return `{ startWorkflow: {...} }` (primitives.md §5) and a `LuaWebhook` may call `Workflows.start`/`signal`.

---

## 7. CLI

```
lua workflows list [--all]                         lua workflows view <name> [--json]        lua workflows versions <name>
lua workflows run <name> …                         ≡ lua test workflow --name <name> …       (offline local driver — no API call)
lua push workflow --name <name> [--set-version x.y.z] [--force]   creates a version (not live); resolves env.template keys from env/.env (missing ⇒ env-template-missing, exit 1)
lua workflows env-overlay <name> -v latest         presence table of env.template keys
lua workflows deploy <name> -v <semver|latest|versionId>          makes a version live   (`lua deploy` has no workflow type)
lua workflows activate|deactivate <name> [-v]      enable/pause schedules + triggers (activate -v also deploys)
lua workflows start <name> --input '{…}'|@file [--idempotency-key k] [--correlation-key k] [--tag t] [--budget-credits n] [-v ver] [--wait ≤55] [--follow [--wait-for-human] [--timeout s]]
lua workflows runs [--workflow n] [--status s] [--correlation-key k] [--tag t] [--limit n] [--cursor c] [--sort -createdAt]
lua workflows status <runId> [--steps] [--strict] [--json]        lua workflows watch <runId> [--after seq] [--timeout s] [--wait-for-human] [--events]
lua workflows logs <runId> [--step id] [--since 1h] [--follow]     lua workflows cancel <runId> [--reason t]
lua workflows resume <runId> --step <id> --data '{…}'             lua workflows retry-step <runId> --step <id> [--note t]
lua workflows resolve-step <runId> --step <id> --outcome skip|complete|fail [--output '{…}'] [--note t]
lua workflows raise-budget <runId> --credits n | --max-steps n | --max-job-seconds n | --max-duration-seconds n
lua workflows approval-payload <runId> --approval <wfa_id> [--path arr --limit ≤100 --cursor c]
lua workflows approve <runId> --approval <wfa_id> [--decision approve|deny] [--note t] [--edit @f --fingerprint f]
lua workflows signal <runId> <name> --payload '{…}'|@file [--dedupe-key k]
lua workflows replay <runId> --local                              lua workflows export <name> [-v] [--out dir] [--force]
lua workflows delete <name> [--yes] [--force]                     lua workflows delete-run <runId> [--yes]
lua workflows archive-runs --since 8d --out ./archive [--until iso] [--workflow n] [--concurrency ≤5] [--no-inputs] [--no-artefacts]
lua workflows workspace <runId> [--release]   lua workflows jobs <runId>   lua workflows job-logs <runId> <stepId> [--attempt n] [--tail ≤2000] [--follow]
lua workflows schedules list|create|patch|pause|resume|delete …    lua workflows goals list|get|create|edit|raise|pause|resume|close …
```

Exit codes: `0` ok · `1` API refusal (4xx other than 404) · `2` usage · `3` not found · `4` run failed / timed out · `5` run cancelled · `6` run gated (consent) · `7` `--timeout` reached · `8` run parked waiting for a human (`start --follow`/`watch` exit here unless `--wait-for-human`) · `9` auth · `10` forbidden · `11` unavailable · `12` provider rejected. `--json` prints `{ success, data }` or `{ success:false, error:{ code, statusCode?, message, issues? } }`.

### Offline runner flags (`lua test workflow` / `lua workflows run`)

`--input <json|@file>` · `--step-output <id=json|@file>` (complete a step with this output — how you give a predicate both truth values) · `--approve <id[=@payload]>` · `--deny <id[=@reason]>` · `--signal <name=json>` · `--from-run <runId> [--force]` (`src/commands/workflow-local-run.ts` `loadSeedFromRun` → `@lua/workflow-graph` `seed.ts`: fetches the platform run and every planned step through the API, seeds each `completed` step whose ancestors are all seeded — latest attempt wins — with its output and `once` effects, prints `[from-run] N step(s) seeded from <runId>` and re-drives from the first pending step, so only what did not finish re-executes; `ledger.seededFrom` records it. Exit `3` when the run is not found; exit `2` `[from-run] graph differs (N steps changed) — pass --force to seed anyway` when the run's `graphHash` ≠ the compiled one) · `--record <dir>` / `--fixtures <dir>` (exit 5 on a missing fixture) · `--agents fake|live` (fake = schema-shaped stubs) · `--now <iso>` (virtual clock for business-hour math) · `--park <id>` then `retry/skip/complete/fail` on stdin · `--fast-retries` · `--real-time` · `--step-wall <s>` · `--job-wall <s>` · `--artefacts-dir <dir>` · `--workspace <dir>` (Job-tier `ctx.$` against your PATH) · `--env KEY=value` (`lua workflows run` only) · `--max-ticks <n>` (script form) · `--ledger-out <file>` · `--json`. Exit `0` completed · `2` flag/schema problem (`input-schema`, `unknown-step`, `step-output-schema`, `edit-path-not-allowed`, `env-template-missing`) · `3` unknown workflow · `4` a step failed · `5` fixture missing. Not emulated offline: org pacing, schedules, knowledge retrieval (fails `binding_unresolved` unless `--step-output`), MCP connections, credential minting.

---

## 8. Build → test → ship recipe

1. Write `src/workflows/<name>.ts`; export the const; register in `src/index.ts` `workflows: [...]`.
2. `lua compile` — fix build errors (§9); `WORKFLOW_UNPLACED_STEP` and `map-id-required` are warnings here but errors at push.
3. `lua test workflow --name <name> --input @in.json --step-output <agentStepId>='{…}' --approve <approvalId> --signal <sig>='{…}' --fast-retries --ledger-out ledger.json` — exercise both sides of every predicate with different `--step-output`s; `--deny`; `--park <externalStep>`; `--now` for chains.
4. `lua push workflow --name <name> [--set-version x.y.z] --force` (a version; not live). Check `lua workflows env-overlay <name> -v latest`.
5. Deploy: `lua workflows deploy <name> -v latest` (gated by the plugin: `LUA_DEPLOY_CONFIRMED=1 …` via `/lua-deploy`; `lua deploy` itself has no workflow type). `lua workflows activate <name>` turns on schedules/triggers.
6. Run on the platform: `lua workflows start <name> --input @in.json --follow --timeout 3600` (exit `8` when it parks — the approval id is in the output; `--wait-for-human` would instead keep streaming through the park until a human acts or the timeout fires with exit `7`); inspect `lua workflows status <runId> --steps`; answer gates with `approve` / `signal` / `resume` / `retry-step` / `resolve-step` / `raise-budget`; `lua workflows replay <runId> --local` checks the run against your compiled artifact.
7. Evidence: `lua workflows archive-runs --since 8d --out ./archive`.

Chat-composed ("dynamic") workflows cannot be deployed from the CLI (`WORKFLOW_DYNAMIC`, 409) — recompose them in chat, or `lua workflows export <name>` to bring one into source.

---

## 9. Errors you will hit and the fix

**`LuaWorkflowBuildError`** (`src/types/workflow.ts:875`; a value export of `'lua-cli'` and `'lua-cli/workflow-builder'`) is what the builder throws synchronously while your module evaluates — `createStep` validation, every chain method, `.commit()`, `env.template()`. Fields: `code: LuaWorkflowBuildCode` (every first-column code below plus `timeout-out-of-range`, `workspace-inherit-without-parent-workspace`, `workspace-inherit-conflict`, `max-turns-invalid`, `chunk-size-invalid`, `rate-limit-invalid`, `backoff-invalid`, `loop-interval-out-of-range`, `container-arm-empty`, `ephemeral-role-too-long`, `role-ref-and-inline`; `workspace-not-declared` and `approval-inside-container` are deprecated members no longer thrown), `message`, `hint?` (the thrown `.message` reads `<message> — <hint>`), `name = 'LuaWorkflowBuildError'`. `lua compile` evaluates the bundled module in a VM (`src/compiler/utils/graph-serializer.ts`), recognises the error **by shape** — `name` + a string `code`, because the bundle carries its own copy of the class — and reports it as a compile issue whose code IS `error.code`, severity `error` ⇒ `compile_failed`, exit 1 (`src/compiler/plugins/workflow.plugin.ts` ~441). Anything else thrown at module top level is `WORKFLOW_MODULE_EVALUATION_FAILED`. Non-fatal findings are `LuaWorkflowBuildWarning { code, message, stepId? }` from `getBuildWarnings()` — `map-id-required`, `hitl-duration-defaulted`, `schedule-input-required` / `-invalid`, `WORKFLOW_UNPLACED_STEP` — printed by the compiler, and several of them refused at push.

| Code / message | Fix |
|---|---|
| `invalid-workflow-name` / `invalid-step-id` | lower-case, `[a-z][a-z0-9-_]*` / `[a-z][a-zA-Z0-9_-]{0,63}` |
| `invalid-step: step "x" needs an execute function` | add `execute` to `createStep` |
| `unknown-step-ref` | a string StepRef must name an entry declared by `agentStep`/`specialistStep`/`toolStep`/`map(…,{id})`/`workflow`/`approval`/`waitForSignal`; otherwise pass the `createStep` object |
| `duplicate-step-id` / `empty-graph` | unique ids / add a step |
| `closure-predicate` / `closure-binding` | use `eq/gt/…` over `step(x).path()`; use `fromStep/fromInit/value/template` |
| `timeout-exceeds-tier` (>600 s worker) | add `tier:'job'` |
| `job-timeout-exceeds-cap` | code/tool ≤ 14 400 s; agent ≤ 86 400 s |
| `long-job-requires-workspace` | > 4 h steps need a `workspace` |
| `workspace-requires-job-tier`, `harness-requires-job-tier`, `max-turns-requires-job-tier`, `job-tools-require-job-tier` | set `tier:'job'` |
| `cap-exceeded` | parallel 2..16 arms, foreach concurrency ≤16 / items ≤20 000, retry ≤20, role.tools ≤64 |
| `invalid-envelope: agentStep("x") needs an agentId` / `approval("x") needs a title` / `waitForSignal("x") needs a signal name` / `toolStep("x") needs a LuaTool` / `retry.maxAttempts must be an integer 1..20` / `foreach.items takes fromInit(path) / fromStep(step, path) …` | as named; for foreach use `.map({ '': … }, { id })` before it |
| `mapping-placement`, `node-type-unsupported-in-container` | a `[map, step]` body is not allowed in foreach/loops; HITL nodes are placed by id |
| `approver-excludes-only-candidate`, `four-eyes-requires-editable`, `editable-path-invalid`, `escalation-chain-too-long` / `-not-terminal` | approval option conflicts |
| `env-template-secret-key` | read with `env('X')` inside execute |
| `WORKFLOW_GRAPH_NOT_STATIC` / `WORKFLOW_MODULE_EVALUATION_FAILED` | module top level must be pure (no I/O, env, clock); move reads into `execute` |
| `WORKFLOW_UNPLACED_STEP` (push: `unplaced_step`) | place or delete the `createStep` |
| `WORKFLOW_TOOL_REF_UNRESOLVED` / `WORKFLOW_TOOL_UNBUNDLED` (push: `tool_unbundled`) | import the tool object from its own module; it must compile as a tool primitive |
| `map-id-required` | add `{ id }` to every `.map` once there are ≥ 2 |
| `connection-key-undeclared` | add `connections: [{ key, integrationType }]` |
| `env-template-missing` (push exit 1) | set the key in env / `.env` before `lua push workflow` |
| `WORKFLOW_NAME_TAKEN` (409) / `WORKFLOW_FORM_MISMATCH` (400) | rename, or `lua workflows delete` then push |
| `WORKFLOW_DYNAMIC` (409 on deploy) | chat-composed workflow — recompose in chat or export to source |
| `RUNS_IN_FLIGHT` (409 on start) | `concurrencyPolicy:'forbid'` and a run is live |
| `SCRIPT_META_INVALID{…}`, `SCRIPT_NONDETERMINISM{…}`, `SCRIPT_IMPORT_FORBIDDEN` | script-form lint (§5) |

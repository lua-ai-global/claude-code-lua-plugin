# Changelog

All notable changes to the `lua-agent-builder` plugin. Versions follow the tag `release-prod.yml` cuts from `package.json` (`v<version>`). lua-cli is a TypeScript SDK/CLI; it is unrelated to the Lua programming language.

## 1.6.0 — 2026-09-26

**Headless hardening and a standalone MCP server (EM-WS8).** Three findings from the Lua Job-tier audit, where the plugin runs unattended inside `claude -p`:
- the `lua-platform` MCP server could not start without an `npm ci` nobody runs;
- the `confirm-deploy` parser was a start-anchored regex with five known bypasses;
- the hooks steered an unattended model into interactive flows that cannot complete.

The lua-cli pin is unchanged (3.38.0).

### `lua-platform` runs with no `node_modules`

- `mcp/lua-platform/scripts/bundle.mjs` no longer marks `@modelcontextprotocol/sdk` external. `dist/server.js` now inlines every npm dependency from the committed lockfile: 106 KB → 529 KB, against a 5 MB budget.
  - Before this, a marketplace install, or the plugin baked into an image, died with `ERR_MODULE_NOT_FOUND`, which Claude Code reports as `lua-platform CONNECTION_CLOSED`. The plugin ships no `node_modules`, and `.mcp.json` launches `dist/server.js` directly.
  - A `createRequire` banner gives the ESM bundle a real `require` for any CommonJS dependency.
- New `tests/standalone-bundle.test.mjs`:
  - copies the bundle into an empty temp directory, asserting no `node_modules` exists anywhere above it;
  - spawns it with `NODE_PATH` removed and runs `initialize` → `tools/list` over stdio;
  - asserts the five tools, and that `serverInfo.version` equals `package.json`, which catches a version bump that forgot to rebuild `dist/`.
  - Against the 1.5.0 bundle it fails with `ERR_MODULE_NOT_FOUND`, as intended.

### `confirm-deploy`: the parser reads the whole command

`lib/tokenizer.mjs` used to test one regex anchored at the start of the string. These all ran a production verb straight past it:
- `cd x && lua deploy …`
- `true; lua version promote 3`
- `FOO=1 lua deploy all`
- `/usr/local/bin/lua deploy all`
- `npx lua deploy all`

It now lexes the command the way a POSIX shell does (quotes, escapes, `&& || ; | |& &`, newlines, `( )` and `{ }` groups, redirections, heredocs) and checks **every simple command**:

- **The binary is found at any word position, by basename.** That covers:
  - `./node_modules/.bin/lua`, `C:/…/npm/lua.cmd`, and `"lua"` or `l\ua` spellings;
  - env-assignment prefixes, and the `sudo` / `env` / `command` / `exec` / `timeout N` wrappers;
  - launchers: `npx lua`, `npx lua-cli`, `npx -y lua-cli@3.38.0`, `pnpm exec lua`, `pnpm dlx lua-cli`, `yarn lua`, `npm exec -- lua`, `bunx lua-cli`;
  - `node [opts] …/lua-cli/dist/index.js` and a directly executed `…/lua-cli/dist/index.js`.
  - A bare `lua-cli` at the head is still unclassified, as in 1.5.0: it is not an installed binary.
- **Options between the binary and the verb are skipped**, both as boolean flags and as `--flag value` pairs. `lua --ci deploy`, `lua workflows -v 3 deploy x`.
- **Substitutions are parsed recursively.** That covers `$( )`, backticks and `<( )`, including inside double quotes.
- **Strings run by another shell are parsed too.** That covers `bash -c` / `sh -lc` / `eval` / `ssh host "…"` / `watch` / `npx -c`, `… | sh`, heredocs and here-strings fed to a shell, and `alias` / `trap` bodies.
  - Inline interpreter code (`node -e`, `python3 -c`, `perl -e`) is searched as text.
- **A shell variable in the binary or verb position is blocked**, because it cannot be resolved: `L=lua; $L deploy all`, `lua $VERB all`, `… | xargs lua`. The label is `lua <unresolved command>`.
- **Input the lexer cannot close** (an unterminated quote or substitution) falls back to an unanchored textual search, reported as unprefixed.
- **Alias gaps closed**, from lua-cli `aliases.ts`:
  - `marketplace.noun` maps `templates`, `agent-template` and `agent-templates` to `template`;
  - `normalizeArg` lower-cases action words, so `lua workflows DEPLOY x` is live. Matching is now case-insensitive.
- **`LUA_DEPLOY_CONFIRMED=1` counts only in its canonical shape.** It must be the first word of the very simple command that runs the verb (optionally after `env`), with the binary spelled bare, outside any pipe, group, substitution or wrapper string.
  - Each verb in a chain needs its own prefix, and one unprefixed verb blocks the whole command.
  - Blocked: `export LUA_DEPLOY_CONFIRMED=1; lua deploy all`, `LUA_DEPLOY_CONFIRMED=1 true && lua deploy all`, `LUA_DEPLOY_CONFIRMED=1 npx lua deploy all`, `FOO=1 LUA_DEPLOY_CONFIRMED=1 lua deploy all`.
  - Allowed: `cd agent && LUA_DEPLOY_CONFIRMED=1 lua deploy skill …`, and redirections such as `> deploy.log 2>&1`.
  - Every form `/lua-deploy`, the deploy pilot and `/lua-template` emit is unchanged and still allowed.
- **Text that only *mentions* a verb stays unclassified**: `git commit -m "lua deploy all"`, `grep -r "lua deploy" .`, `lua chat … -m "please lua deploy all"`, and a heredoc written to a file.
- **Fails closed, and stays fast.** A hook that throws or runs past its 10 s timeout fails *open*, so:
  - an internal classifier error now returns an unresolved, unprefixed hit for any command that mentions a lua binary;
  - the textual-fallback option pattern has exactly one parse per option. A draft with `-{1,2}[\w-]+` backtracked exponentially (28 options ≈ 200 s); it now takes under 1 ms.
  - Tests bound pathological inputs to 500 ms and fuzz 3,000 random shell strings.
- `classifyProductionCommand` keeps its `{ label, slash, prefixed }` shape, and `PRODUCTION_COMMANDS` keeps `label` / `slash` / `re`, now with a `seq` token table. `lex()` and `UNRESOLVED_LABEL` are new exports.
- The `DEPLOY_DENIED_BARE` text now explains where the prefix counts.
- New `test/lib/tokenizer-hardening.test.mjs`, about 170 cases:
  - every audit bypass and its neighbours;
  - the prefix rule in both directions;
  - false-positive guards;
  - the fail-closed fallbacks;
  - the lexer.
- The spawned `confirm-deploy` integration test gains the chain cases.

This is still a belt, not a sandbox. A command assembled at runtime (`base64 -d | sh`, a script file, an npm script, a raw HTTP call) is out of any static classifier's reach. `SECURITY.md` now says so, and names the Lua-API proxy as the boundary for unattended runs.

### Headless mode: `LUA_PLUGIN_HEADLESS=1`

New `lib/headless.mjs`. With `LUA_PLUGIN_HEADLESS=1` (or `true` / `yes` / `on`):

- **`check-lua-auth`**: every failure (exit 9, exit 11, other, timeout) becomes one neutral note. Authentication could not be confirmed; behind a Lua-API proxy that often means only that the probe route (`GET /agents/self-serve/models`) is refused; carry on. The note never says "run /lua-auth", which led the model into an `AskUserQuestion` flow that cannot complete in `-p` mode.
- **`check-lua-version` and `detect-project`**: the same findings, with no `/lua-doctor`, `/lua-update` or `npm i -g` instruction.
- **`confirm-deploy`**: the `LUA_DEPLOY_CONFIRMED=1` prefix is **void**, and every production verb is blocked with `DEPLOY_DENIED_HEADLESS`. The prefix means a person confirmed; headless, the model would be confirming to itself. `block-auto-deploy` loses its slash pointer as well.
- **`post-deploy-smoke`**: never sends its production `lua chat` ping.
- **`lib/hook-runtime.mjs`**: the too-old-Node message drops "re-run /lua-doctor".
- Interactive behaviour and text are unchanged. New `test/hooks/headless.test.mjs` asserts:
  - no headless message matches `/lua-…`;
  - nothing blocked interactively is allowed headless;
  - a spawned headless `confirm-deploy` exits 2 on a prefixed deploy.

### Docs

- New **`docs/JOB_TIER.md`, "Running in the Lua Job tier"**. It covers:
  - what headless mode changes;
  - `--strict-mcp-config` dropping plugin MCP servers, so pass `lua-docs` (http) and `lua-platform` (stdio) through `--mcp-config`;
  - the denied `Agent` tool, so read `agents/lua-skill-builder.md`, `lua-debug.md` and `lua-qa.md` inline as playbooks;
  - which slashes work with full arguments and which need `AskUserQuestion`;
  - the proxy as the boundary, with suggested inline deny rows because allow rules do nothing under `bypassPermissions`;
  - allowing `GET /agents/self-serve/models` rather than disabling hooks;
  - `LUA_TELEMETRY=false`, and environment scrubbing.
- Also updated: `SECURITY.md` (the gate row, the MCP bundle, the headless row), both READMEs, and the MCP README's build section.
- Bump 1.5.0 → 1.6.0 everywhere `lint-release-version` checks, plus both lockfiles. `dist/server.js` is rebuilt.

## 1.5.0 — 2026-09-22

**Log drains, and a `lua logs` that reads a window instead of a page.** Two shipped CLI surfaces reach the plugin: the whole `lua drains` command — the rules that copy an organization's agent log records to a destination the customer owns — and the `lua logs` read window `--since` / `--until` / `--environment` / `--follow`, with all **18** log sources finally reachable through `--type`. Everything below was read from lua-core-services `main`: `packages/lua-cli/src/cli/command-definitions.ts` (the `drains` and `logs` declarations), `src/commands/drains.ts`, `src/commands/drains.mutations.ts`, `src/commands/logs.ts`, `src/api/drains.api.service.ts`, `src/utils/aliases.ts` (`drains.action`, `logs.type`), `@lua/shared-types` `log-drain.types.ts` / `vm-execution-log.types.ts` and `@lua/shared-observability` `drain-scrubber.ts` — never from the public docs, which agree with all of it and are cited only as a destination for the user. [PRO-1896]

**Version.** lua-cli **3.38.0** carries all of it and nothing below it does: `lua drains` exits 1 as an unknown command, and the four new `lua logs` options exit 1 as unknown options. `PINNED_MIN_LUA_CLI` moves 3.37.0 → 3.38.0, and unlike the last two bumps this one adds real **command surface**, so every addition is marked "⏳ lua-cli 3.38.0 or later" in the text that emits it.

### `/lua-drains` (new)

- `commands/lua-drains.md` covers all eleven verbs — `list`, `status`, `deliveries`, `create`, `update`, `delete`, `test`, `verify`, `pause`, `resume`, `rotate-secret` — with the plugin's single-permission pattern: one `AskUserQuestion`, then the Bash prompt (the `ask` tier) as the single confirmation for a mutation, and no `AskUserQuestion` on top of it.
- **Secret handling is the point of the file.** The HMAC signing secret is never an input: the platform mints it and the CLI prints it once (at `create`, and at a `rotate-secret` without `--finalize`), so the slash never copies it into a file, an env var, a commit or its own reply. A header VALUE never reaches a command line — `--header <NAME>` prompts hidden and therefore cannot work under `--ci`; the CI form is `--header-from-env <NAME>=<ENV_VAR>`, and an unset variable is exit 2 naming the *variable*. For a vendor preset (`--header DD-API-KEY`, `--header Authorization` as `Bearer <token>`) the slash stops at the secret and hands the user the exact line to run in their own terminal.
- **The JSON contract**: `--json` on **stdout** (`lua drains create --json | jq -r '.secret'` has to work), the verification instructions and the content acknowledgement on **stderr** (`emitAside`), a typed envelope rather than the `✖` line for a refusal that escapes a verb. The per-verb payloads are tabulated.
- `--include-content` is run **without** `--yes` first: the CLI prints `CONTENT_WARNING_TEXT` and `CONTENT_ACKNOWLEDGEMENT_TEXT` and exits non-zero having created nothing, the slash quotes both verbatim, and the user's approval of the re-run *is* the acknowledgement.
- ⚠ `lua drains status` exits **2** both for a usage error and for "some drain is `failing`" — decide from `drains[].state` in `--json`, never from the exit code. `test` (30 s) and `verify` (60 s) are 202-then-poll: `pending: true` with exit 1 means *not yet*, not *failed*.

### `lib/knowledge/log-drains.md` (new, the sixth knowledge file)

What a drain is (an **organization** resource — `--org`, else `lua.skill.yaml`, else a credential that reaches exactly one org) · the eleven verbs and their aliases · the six states (`pending_verification healthy degraded failing paused disabled`) and the transitions that surprise people (a resume lands in `degraded`, an endpoint change returns to `pending_verification`, 24 h failing auto-pauses) · the selectors, including the 19 selectable sources (the 18 `AGENT_LOG_SOURCES` plus `execution`) and the two content ones · the **verification handshake** (only `http` echoes `X-Lua-Verify`, with the `/.well-known/lua-drain-verify` fallback; `otlp`/`datadog`/`betterstack` accept any 2xx test post; `token_not_echoed` is the common failure and the phrase to search for; 5 attempts per drain per hour) · the four presets and what each does with `--endpoint` / `--site` / `--format` · delivery guarantees, the retry/terminal status split (OTLP is the one place a `500` is terminal), the 6-hour horizon and the **`Retry-After`** contract — honoured exactly, clamped at an hour, and the drain *routes* answer `429 DRAIN_RATE_LIMITED` with a bare `Retry-After` and no `X-RateLimit-*` headers · the quota ladder (80% notify → 100% drop `debug` → 125% drop `info` → 150% pause with reason `quota`; `warn` and `error` never go first) · the **scrubber**, its built-in rule classes and the `[redacted:builtin]` / `[redacted:lua-token]` / `[redacted:vendor-key]` / `[redacted:org:<rule-id>]` markers — with the warning that scrubbing only catches shapes it recognises · **`logs:read` vs `logs:manage`**, the second being *sensitive* (a `logs:*` wildcard does not satisfy it) and the deprecation window on the old read scopes.

### `--since` / `--follow` everywhere a window was being reconstructed

- `commands/lua-logs.md`: the full 18-source `--type` list (on 3.37.0 and older the alias table was hand-listed and `trigger`, `model-resolver`, `workflow-step`, `workflow-script`, `workflow` were exit 2, reachable only through the `tail_logs` MCP tool — 3.38.0 derives `logs.type` from `AGENT_LOG_SOURCES`), the read window, and `--follow`'s real semantics: it POLLS (no SSE route), refuses `--page`, advances on the newest timestamp it printed with id de-duplication, and under `--json` emits one `{ logs, nextCursor, pagination }` envelope per poll that produced rows.
- `agents/lua-debug.md` gains step **2b** and the **"watch a promote"** recipe — `lua logs --ci --type all --since <the instant the promote returned> --follow --json`, selecting `subType` `error`/`warn` client-side — plus a drain-triage entry (`status` → `deliveries` → `test` → `verify`) routing the fix to `/lua-drains`.
- `hooks/post-deploy-smoke.mjs` — the other half of the ticket's Context sentence. It pulled a 20-row page and filtered it against **this machine's** clock; it now asks the route for the window with `--since 1m`, which the SERVER resolves, and trusts it. A lua-cli older than 3.38.0 exits 1 on the unknown option, so one fallback to the pre-3.38.0 shape (page + local clock) keeps the check working instead of silently reporting nothing — the pin only warns, so those sessions are still in the field. `--environment production` is deliberately **not** passed: the step-1 ping goes through `lua chat`, whose rows the A1 call sites may stamp `sandbox`, and a smoke check that hid its own ping's errors would be worse than a slightly wider scan. Four new tests cover both paths.
- `agents/lua-qa.md` records `T0` before the first turn and scans with `--since <T0> --environment <target>` instead of pulling 100 rows and filtering by timestamp; `--follow` is called out as wrong for an unattended suite.
- ⚠ **`lua logs` has no severity flag.** `--min-severity` is a log-*drain* selector; severity on a log read is filtered client-side on `subType`. `scripts/lint-cli-flags.mjs` now denies `lua logs --min-severity` so the confusion cannot ship.
- ⚠ **A log entry now HAS an environment field.** The plugin said "there is no `environment` field" in `lua-logs.md`, `lua-qa.md` and `cli-reference.md`; `AgentLogMetadata` gained `orgId`, `environment`, `agentVersion`, `executionId`, `executionSeq`, `traceparent`, `truncated` / `droppedLines`. It is optional and additive, and a row without it reads as **`production`** — on the drain matcher and under `--environment` alike — so its absence never means sandbox. `metadata.channel === 'dev'` is still CLI traffic in *either* environment and is still not an environment marker.

### Plugin machinery

- `lib/permissions-template.json`: allow `lua drains list|status|deliveries|test`; ask `lua drains create|update|delete|verify|pause|resume|rotate-secret`. They are **not** added to `lib/tokenizer.mjs`: nothing a drain verb does changes what runs in production, and `LUA_DEPLOY_CONFIRMED=1` (“the user confirmed a deploy”) would be the wrong sentence — `confirm-deploy` would send the user to `/lua-deploy` for a log-shipping change. The per-verb spelling is deliberate: a blanket `Bash(lua drains *)` would either prompt for a read or admit `rotate-secret`. `test/lib/permissions-mirror.test.mjs` pins every one of the eleven.
- `scripts/lint-knowledge-commands.mjs`: the eleven `drains.action` verbs join the action table. `scripts/lint-cli-flags.mjs`: `lua logs --follow` is **removed** from the denylist — it was denied because it did not exist, and PRO-1838 shipped it; the entry is deleted rather than inverted, which is the mistake that made the plugin emit `lua sync --accept` for months. Two new entries take its place (`lua logs --min-severity`, `lua drains update --type`).
- Bump 1.4.0 → 1.5.0 everywhere; `mcp/lua-platform/dist/server.js` rebuilt; `PINNED_MIN_LUA_CLI` 3.37.0 → 3.38.0 (`hooks/check-lua-version.mjs`, both READMEs, the user guide). `scripts/lint-pinned-version.mjs` compares the pin with npm's `latest` and is therefore **red by design until lua-cli 3.38.0 is published** — the same window 1.4.0 sat in before 3.37.0 shipped; it was not weakened.

### Unchanged on purpose

- No gate behaviour changes: `hooks/hooks.json`, `confirm-deploy` and `lib/tokenizer.mjs` are untouched, because a log drain is organization configuration and not a production verb. `post-deploy-smoke` changed only in HOW it reads the window — same trigger set (`SMOKE_LABELS`), same warning, same non-blocking behaviour.
- The `tail_logs` MCP tool is unchanged and has no window parameter; it stays documented as the fallback when the installed CLI is older than 3.38.0.

## 1.4.0 — 2026-09-20

**What a workflow run costs, and why.** The plugin described a Job-tier attempt as a flat 4 credits and every run budget in "credits". Both are wrong for a priced run: a Job step is billed per model **REPLY** — one credit per reply on a legacy plan, **actions** (the call's price band × the resolved model's multiplier, cached prompt tokens at the fraction the provider charges) on a seat plan — and a coding turn makes dozens of replies in ONE attempt. Read from lua-core-services `main` at `ebcf6689c` (the lua-cli 3.37.0 release, `#3095`; the billing train `#3094`) — the CLI renderers in `src/commands/workflows.ts`, the wire shapes in `src/interfaces/workflows.ts`, the deploy advisory in lua-api's developer workflow service, the Job model legs and their labels in shared-types, the cache weighting in lua-core's Job rate module — never from the public docs.

**Version.** lua-cli **3.37.0** adds **no command and no option**: its only `src/cli/command-definitions.ts` change is the `--credits` help string, so every shape the plugin emits runs unchanged on 3.36.0 and only prints less. `PINNED_MIN_LUA_CLI` moves 3.36.0 → 3.37.0 because the plugin's agents now READ output that only 3.37.0 prints. The existing "⏳ 3.36.0 or later" markers are untouched; new material is marked "⏳ 3.37.0".

### The billing rule (true on every CLI — not gated on 3.37.0)

- `workflows.md` §4 — the flat rule ("an inline agent step is 1 credit, a Job-tier attempt is 4, tokens never metered") is now scoped to a run the platform is still metering flat, which is exactly what `lua workflows status` still prints for such a run, and the **priced** legacy and seat rules stand beside it. Budget a Job workflow from model replies, not steps.
- `workflows.md` §4 — **which model a Job step runs on is not the agent's model**: the step's own `model`, failing that the platform's Job default, failing that the organization's. Every reply is billed at that model's multiplier, so pinning `model` on a Job step is a cost decision. Mirrored in `decision-trees.md` ("Which model?"), `primitives.md` §11 and gotcha 35, `agents/lua-architect.md` (decision 6), `agents/lua-skill-builder.md` and `agents/lua-qa.md` (an unpinned Job step is now a QA finding).
- `lua workflows raise-budget <runId> --credits <n>` — the **flag keeps its name on both plans**, but `<n>` is a cap in the run's own unit (actions on a seat plan). Corrected in `workflows.md` §4 and §7, `primitives.md` §12, `commands/lua-workflow.md`, `commands/lua-status.md`, `agents/lua-debug.md` and the user guide; `decision-trees.md`'s "credit budget" is now "run budget (credits, or actions on a seat plan)". The consent ladder's own "≤ 20 credits" is a different quantity and is deliberately unchanged.

### The lua-cli 3.37.0 read-outs (⏳, and printed only when the server projects them)

- `workflows.md` §2 gains **"Reading what a run cost"**: the engine-aware `Budget:` sentence and `finished past the cap`; the run-level `Tokens:` line; the `Uncached` / `Cached` / `Output` step columns (`Cached` folds reads and writes for width; `—`, never `0`, for a step nobody reported); the `⚙` Job-model line naming the model, the multiplier and the leg that chose it; and the reminder that these are **signals, not charges** and must never be summed — a cache read is a subset of the uncached input figure. A missing line means "not projected", not a defect.
- `lua workflows logs` now renders `step.job_model_resolved` and the three budget events (`run.budget_parked`, `run.budget_raised`, `run.budget_exceeded`), which below 3.37.0 it did not print at all; the unit inside them is the gate's own word and is quoted verbatim (`workflows.md` §2, `commands/lua-logs.md`, `commands/lua-workflow.md`).
- `lua workflows deploy` prints a `job-model-default` **advisory** (`  ⚠ <message>`) for a Job step that names no `model` — advisory only, the deploy still succeeds, like the older `job-tier-not-enabled` (`workflows.md` §4 and §8, `cli-reference.md` §4, `commands/lua-deploy.md`, `agents/lua-deploy-pilot.md`, `decision-trees.md`).
- `raise-budget` names the unit it raised, and a seat run parked before its first priced call no longer reads the legacy sentence.

### Unchanged on purpose

- No new verb, flag, permission rule or hook behaviour: `lib/permissions-template.json`, `hooks/hooks.json`, `confirm-deploy`, `tokenizer`, `scripts/lint-knowledge-commands.mjs` and `scripts/lint-cli-flags.mjs` all hold, because 3.37.0 adds no command surface.
- `budget.unit`, `budget.reserved` and `usage.engine` are **not** new in 3.37.0 — 3.36.0 already sent them; `reserved` still has no human line and is `--json` only.

### Housekeeping

- Bump 1.3.0 → 1.4.0 everywhere; `mcp/lua-platform/dist/server.js` rebuilt; `PINNED_MIN_LUA_CLI` 3.36.0 → 3.37.0 (`hooks/check-lua-version.mjs`, `/lua-init`, `/lua-update`, `/lua-doctor`, both READMEs and the user guide). `scripts/lint-pinned-version.mjs` compares the pin with npm's `latest` and is therefore **red by design until lua-cli 3.37.0 is published**; it was not weakened.

## 1.3.0 — 2026-09-18

Two shipped platform features reach the knowledge base, the slash commands and the subagents: **per-step model classes** for workflows and the **workflow autonomy envelope** (pre-consented starts). Every claim was read from lua-core-services — lua-cli `main` at `12cefb7ec` (WMC-E7 `#2969`, hotfixes H7 `#3053` and H8 `#3051`, the stage-all fix `#3024`) and `feat/workflow-autonomy` at `378403322` (WMC-A1…A7) — never from the public docs. **Version**: lua-cli 3.36.0 — cut from those two refs and published 2026-09-18 — carries all of it and nothing below it does (3.35.0, tag `8d65d1ba8`, has none of the verbs), so every addition is marked "⏳ requires lua-cli 3.36.0 or later" and `PINNED_MIN_LUA_CLI` moves 3.33.0 → 3.36.0 (the session hook now also names `npm i -g lua-cli@latest`). That pin is the only hook change (no hook reads a `lua workflows` exit code); the permission template gains the new verbs.

### Per-step model classes (`workflows.md` §2, §7–§9; `cli-reference.md` §1, §4–§5; `decision-trees.md`; `primitives.md` §11, §14; `commands/lua-workflow.md`, `lua-push.md`, `lua-status.md`, `lua-logs.md`, `lua-deploy.md`; every subagent)

- `agentStep` gains `taskClass` (`classify extract transform draft research reason code judge`), `model: 'class/fast|balanced|strong'`, `requires` (`vision structured largeContext codeExecution`), `modelReason` (≤ 160) and `effort` (`low medium high`) — `src/types/workflow.ts` `AgentStepOptions`; the default task-class map (classify/extract/transform → fast, draft/research/judge → balanced, reason/code → strong) is `@lua/shared-types` `WORKFLOW_DEFAULT_TASK_CLASS_MAP`.
- `effort` is **recorded, estimated and not applied**: a plain push keeps `luaWorkflow: 1`; only `lua push workflow --apply-effort` (`push-helpers.ts` `applyEffortMarker`, `WORKFLOW_EFFORT_MARKER = 2`; `lua push all --apply-effort` stamps every workflow) or a new compose with assignment on moves it.
- Push-time refusals: locally, before any POST, `model-class-unknown` / `task-class-unknown` / `model-trait-unknown` / `requires-invalid` / `effort-unknown` / `model-reason-invalid|-too-long` (`src/interfaces/workflow-model-classes.ts` `validateGraphModelMembers`, `workflow.handler.ts` `workflowModelMemberError`); server-side `task-class-without-model` (`@lua/workflow-graph` `validate.ts` `checkTaskClass`, static definitions only — `lua compile` calls `validateGraph` without `static`, so compile passes it) and `model-class-resolution-off` (with the CLI's hint, `push-helpers.ts`).
- `lua models list --workflows [--json]` — `Class · Model · Best for · Speed · Cost · Efforts · Notes`, footnotes for `awaiting confirmation` / `own key` / `rate not calibrated` (`src/commands/models-workflow-view.ts`, `models.ts`).
- `lua workflows policy models get|set` with `--compose on|off --max-class fast|balanced|strong --consent-actions <n≥1> --allow <codes> --class-fast|--class-balanced|--class-strong <codes> --class-map <task>=<class> --pins class-only|allowed --fallback same-class|same-provider` (`commands/workflows.ts` `buildModelsPolicyPatch`, `policyCore`; `command-definitions.ts`); `lua workflows clear-gate <runId> --kind model_policy` (alias `ungate`; `clearGateCore`) for the `model_policy` park that `status` prints as `⏸️ Paused — a step's model request cannot be resolved…`; `lua workflows recompose <name>` (alias `recompile`; `recomposeCore`, lua-api `workflow-model-admin.service.ts`).
- `lua workflows start` prints the server-rendered consent card (`consentCardLines`) and exits 6 on a gated start; `status` prints the `🧠 By model` roll-up (`modelRollupBlock`, from `usage.byModel` or the step receipts); `status --steps --json` rows carry `taskClass` / `modelRequested` / `modelResolved` / `modelReason` / `effortApplied` / `modelFallback[]` (lua-api `workflow-projection.ts`); `lua workflows logs` shows `step.model_resolved` / `step.model_policy_warning` (`WORKFLOW_LOG_EVENT_PATTERN`, `modelEventDetail`). The `🤖 Agent steps` block of `lua workflows view` is **not** described: lua-api projects no `agentModels` on a version, so the CLI never prints it.
- ⚠ Forward-looking: lua-cli main `push.ts` (`#3024`, `af66332ee`) adds workflows to stage-all and **always activates** the pushed version — on lua-cli 3.36.0 `lua push all` is a workflow go-live. `cli-reference.md` §4/§5, `primitives.md` §14 (34), `/lua-push`, `/lua-deploy` and the deploy pilot say so; the hook gate is unchanged (open question in the audit report).

### Consent and the autonomy envelope (`workflows.md` §3; `decision-trees.md` "Will a workflow start without asking a person?"; `agents/lua-architect.md`, `lua-debug.md`; `commands/lua-workflow.md`, `lua-status.md`; `docs/USER_GUIDE.md`)

- The consent ladder (lua-core `compose/workflow-consent.service.ts` `decide()`): `auto | ask | refuse` on `maxAutoSteps` 15 · `maxAutoCredits` 20 · `maxAutoDurationSeconds` 3600 (`WORKFLOW_CONSENT_DEFAULTS`; ceilings 40 / 604 800), `refuse` when `askAboveThresholds: false`; the duration input is the expected wall since H7; it runs on the agent's compose, tool and batch legs only (`decide()` call sites), not on `lua workflows start` / REST / SDK starts; the gate is `{ kind: 'start-consent', approvalLinkId, since, expiresAt }` and a person clears it — `lua workflows approve` cannot (`docs/api/Workflows.md` on main).
- H7 (`#3053`): `lua workflows status --strict` exits **6** on a gated run (`exitCodeForRunStatus`; it exited 0); H8 (`#3051`): `status --steps` prints `⇅ <step>: approver escalated <from> → <to> — the initiator is excluded (maker-checker)` from `suspend.approverFallback` (`approverFallbackLine`).
- The envelope `autonomy { enabled, maxCredits, maxSteps, maxDurationSeconds, maxActions, maxRunsPerHour, forms }`: `enabled` absent ⇒ false; defaults 20 / 15 / 86 400 / the org's `models.consentActions` / 20 / `['graph','static']`; ceilings 40 / 604 800 / `caps.maxCreditsPerRun` / 200 (`LUA_WF_AUTONOMY_MAX_RUNS_PER_HOUR`) — `@lua/shared-types` `workflow-node-policy.ts`, `@lua/shared-schemas` `effectiveWorkflowAutonomy` (org narrowed by agent, clamped). The one flip — `ask` → `auto` when `enabled`, the form is admitted and every dimension fits — stamps `consent { approvedBy: 'system:policy', via: 'autonomy', envelope }` and audits `workflow.run.autonomy_applied`; `refuse` is never touched; goal and batch legs never flip (`workflow-tool-runtime.service.ts` `meter`); the hourly bucket `wf:org:<orgId>:autonomy:<agentId>` (`workflow-autonomy-rate-limit.service.ts`) turns an over-quota flip back into `ask`, never a refuse.
- `lua workflows policy autonomy get` (one `?effective=true` request: stored + effective blocks) and `set --enabled on|off --max-credits --max-steps --max-duration <seconds> --max-actions --max-runs-per-hour --forms graph,script,static --clear <keys>`; `--agent` is refused because no route writes a per-agent envelope (`autonomyPolicyCore`, `buildAutonomyPolicyPatch`, `src/interfaces/workflow-autonomy.ts`); `status` prints `Consent:  auto (policy) — ≤ 20 credits · 15 steps · 1 d` for a `via: 'autonomy'` stamp and nothing otherwise (`consentLine`, D28).
- The architect composes for starting without a question (inside the ladder or the envelope, short waits, graph/static form) and writes the exact `policy autonomy set` line for an admin when a wider envelope is needed.

### Plugin machinery

- `lib/permissions-template.json`: allow `lua workflows policy * get*`; ask `lua workflows policy * set*`, `clear-gate` / `ungate`, `recompose` / `recompile` (all confirm once through the Bash prompt like the other run-control verbs). `test/lib/permissions-mirror.test.mjs` pins them.
- `scripts/lint-knowledge-commands.mjs`: `policy`, `clear-gate`, `recompose` join the `workflows` action list (read against a lua-cli `main` checkout). `scripts/lint-cli-flags.mjs`: denies `policy autonomy set --max-duration-seconds` and `policy autonomy set --agent`.
- Bump 1.2.2 → 1.3.0 everywhere; `mcp/lua-platform/dist/server.js` rebuilt; `PINNED_MIN_LUA_CLI` 3.33.0 → 3.36.0 (`hooks/check-lua-version.mjs`, `test/hooks/check-lua-version.test.mjs`, `/lua-init`, `/lua-update`, `/lua-doctor`, the user guide and READMEs).

## 1.2.2 — 2026-09-13

Knowledge-only release: corrections validated against production by the system audit of 2026-09-13 (live probes on the E2E agents, re-verified in lua-core-services and lua-iac source), applied to the knowledge base, subagent prompts, slash commands, SECURITY notes and user guide. No hook, permission or MCP behaviour changed. Every line names its source.

### Jobs (`primitives.md` §6, §14; `agents/lua-skill-builder.md`)

- Dropped the "two retry algorithms" hedge. Production and staging pin `LUA_JOBS_INTAKE_MODE = "enqueue"` (lua-iac `services/lua-core/{prod,staging}/k8s/config-map.tf`), so code jobs retry on the queued path only: a fixed `backoffSeconds` wait (default 60, no jitter), `min(maxAttempts, 10)` attempts, zero retries without a finite `maxAttempts`, and `job.execution` on every deployed run (lua-core `job.service.ts` `run` → `enqueueJob`, `getHeavyRetryEligibility`, `scheduleHeavyRetry`; `lua-sandbox-runner` `executor-entry.ts`). The exponential path is reached only by the platform's own `agent`-kind jobs (`enqueueJob` routes them to `processJob`; `DEFAULT_AGENT_JOB_RETRY`).

### `user.send()` reach (`primitives.md` §12, §16; `decision-trees.md`)

- Email removed from the last-interaction reach list: the only channel-window writer is lua-whatsapp `upsertChannelWindow` (`utils/channel-window.util.ts`, called from its WhatsApp, Facebook, Instagram, MessageBird, SMS and Teams services); lua-email never writes one, so the `type === 'email'` branch of `channel.service.ts` `sendToLastInteraction` is unreachable. Use `Channels.email.send`.

### Workflows runtime (`primitives.md` §5, §12, §14; `workflows.md` §1, §6, §9; `commands/lua-workflow.md`; `decision-trees.md`)

- `Workflows.resume` / `signal` / `signalByKey` / `startBatch` / `setGoal` / `goals.*` **work in production** (live probe 2026-09-13 reached `RUN_NOT_FOUND` / `CORRELATION_KEY_NOT_FOUND` / `WORKFLOW_NOT_FOUND` / `[]`); the `resume_unavailable` / `signal_unavailable` / `not_implemented` codes in lua-core `workflow-sandbox-bridge.ts` guard an unbound optional provider. Only `raiseBudget` is 501 in both runtimes (`raiseBudget: notImplemented(...)`; lua-cli `workflow.api.service.ts` `unavailable('raiseBudget', 'R45')`).
- Deployed `Workflows.list` applies only `status` and an untyped `workflowId`; the typed `workflow` filter is ignored in production (`workflow-sandbox-bridge.ts` `list`).
- `concurrencyPolicy: 'forbid'` is not enforced on `lua workflows start`, the REST start route, `Workflows.start()` or a trigger's `{ startWorkflow }`: `WorkflowRunService.createRun` has no overlap check (lua-core `workflow-run.service.ts` header; two starts 2 s apart both ran). Only the schedule dispatcher (`workflow-schedule-dispatch.service.ts`), the compose-tool start and batch starts check it. Guidance no longer relies on `RUNS_IN_FLIGHT`; the trigger `skipped_overlap` row is described as never produced today.

### Deployed runtime vs typings (`primitives.md` §4, §12, §14; `decision-trees.md`; `integrations.md`; `agents/lua-architect.md`, `agents/lua-skill-builder.md`)

- `Data.create` / `Data.update` deployed never forward `index` in any form (`sandbox-runtime` `custom.data.api.service.ts` bodies are `{ data, searchText }`); an index can only be declared from a `lua test` run (lua-cli `custom.data.api.service.ts`). Added the seed-tool recipe.
- `Voice.createSession` re-validated as absent in every runtime, `lua test` included (`sandbox-runtime` `context.ts`; lua-cli `utils/sandbox.ts`).
- `LuaWebhook` Zod schemas are never applied: the bundler rewrites the constructor to an object literal (`compiler/bundler.ts`) and both `lua test` (`utils/sandbox.ts`) and lua-core (`execute.webhook.service.ts`) call `primitive.execute(event)` directly — a schema-violating body reached `execute` with HTTP 200 live. Guidance: `safeParse` in `execute`.
- `LuaWebhook.secret` must be a string literal / compile-time constant (`compiler/plugins/webhook.plugin.ts`: `env('X')` fails `lua compile`) and verifies Lua's own `x-lua-signature` (lua-core `webhook.service.ts`), so it blocks vendors that sign with their own scheme — leave it unset for them and verify their HMAC in a `defineTrigger` `verify` over `rawBody`.
- Deployed webhooks have no wall timeout: the direct path runs in-process with only the VM's synchronous-prefix `timeout` (`webhook.service.ts` → `execute.webhook.service.ts`; `sandbox-runtime` `runner.ts`); a 200 s handler completed after the ~90 s ingress 504, while tools on the remote runner are cut at 180 s (`execute-function.service.ts` `TOOL_TIMEOUT_MS`; lua-iac `LUA_SANDBOX_ROUTING_DEFAULT = "remote"`). Guidance: short, idempotent handlers; never rely on a server-side cut.
- Commerce: SDK `OrderStatus.FULFILLED` sends `fulfilled` (lua-cli `interfaces/orders.ts`; `order.api.service.ts` puts it in the path unmapped) while the platform stores, filters and charts `fullfilled` (`shared-schemas` `ecommerce-order.schema.ts`, lua-api `orders/base.controller.ts`, `chart.service.ts`) and never validates the status param; order routes answer 200 `success:false`, which the SDK rethrows as a generic error. Guidance added.

### Sandbox chat uploads the shell environment (`primitives.md` §12 `env(key)`, §14; `cli-reference.md` §4; `commands/lua-chat.md`, `commands/lua-test.md`, `commands/lua-env.md`; `agents/lua-qa.md`; `SECURITY.md`; `docs/USER_GUIDE.md`)

- 1.2.1 already said `lua chat -e sandbox` uploads `process.env` merged with `.env`; 1.2.2 adds what the live probe showed — the runtime never reads it (a sandbox turn's `env()` resolves from `subAgent.env`, lua-core `skill-eligibility.resolver.ts`), lua-api/lua-agents accept it unfiltered (`ValidationPipe whitelist:false`) and lua-agents caches it ~24 h with the sandbox version. Corrected the 1.2.1 claim that sandbox turns read the uploaded map. New guidance wherever sandbox chat is offered: never run it from a shell holding secrets you would not hand to the platform; prefer `env -i` / a clean shell; `lua test` uploads nothing. A platform ticket is open.

### `--ci` exit codes (`cli-reference.md` §4; `commands/lua-test.md`, `commands/lua-push.md`, `commands/lua-deploy.md`; `agents/lua-skill-builder.md`, `agents/lua-debug.md`, `agents/lua-deploy-pilot.md`; `primitives.md` §14)

- Raw prompts exiting 0 under `--ci` were already covered in 1.2.1 (`prompt-handler.ts` `safePrompt`; `test.ts` `promptToolSelection`) — unchanged.
- Added: `lua test skill|webhook|job|…` prints `✅ … execution successful!` and exits 0 when `execute` throws — `utils/sandbox.ts` returns `{ status: 'error', error }` and `test.ts` never checks it. The test slash, skill-builder and debug agents now treat `status: 'error'` as a failure (the debug agent previously said "exit 1 with a stack").
- Added: `lua push all` and `lua deploy all` exit 0 after per-item failures (`push.ts` `failedItems` → summary only; `deploy.ts` `No versions … skipping`, no exit code). The push slash and the deploy pilot now parse the output.

## 1.2.1 — 2026-09-12

Knowledge-only release: reconciles the plugin's knowledge base, subagent prompts and slash commands with facts the docs rewrite verified against lua-cli 3.33.0 source and the platform packages (lua-api, lua-agents, lua-core, sandbox-runtime, lua-sandbox-runner, shared-types, lua-whatsapp, lua-web). No hook, permission or MCP behaviour changed; one lint guard was added. Every line below names the source that supports it.

### Deploy semantics (`cli-reference.md` §4–5, `primitives.md` §13, `agents/lua-deploy-pilot.md`, `commands/lua-deploy.md`)

- `lua deploy webhook|job|preprocessor|postprocessor|trigger` and `lua workflows deploy` perform a server-side **scoped promote** (a new agent version scoped to that primitive is created and promoted); the `ScopedPromotePrimitiveType` union is exactly those six kinds (lua-agents `agent-version.service.ts`, lua-api `scoped-promote.util.ts`).
- `lua deploy skill` has **no scoped promote**: it only moves the skill's pointer. It is live at once even on a versioned agent, but the active agent version's snapshot keeps its old pin, and the next `lua version promote` (a rollback included) writes that pin back and silently reverts the deploy (`agent-version.service.ts` `applyAgentsDBWritesInTx`). The CLI's own info line claiming a scoped promote for every type is wrong for skill and persona (`src/commands/deploy.ts` ~228).
- The **persona is live on `lua push agent`** (and inside `lua push all`): the CLI's `POST …/persona/version` reaches lua-agents `createPersonaVersion` → `persistPersona(…, 'published')` → `updateAgentPersona`, which rewrites `subAgent.persona`; lua-core reads `subAgent.persona` directly (`prompt.service.ts`). `lua deploy persona <n>` re-points the served persona (`setAgentPersonaVersion`) — the rollback verb; `lua version promote` never changes the served persona (it only flips persona-version status flags and sets `activeAgentVersionId` + `model`). The plugin previously described the pushed persona as "not live".
- The deploy pilot now runs `lua version list --json --ci` first and, on a versioned agent, ships `skill` and `all` as push → `lua version create` → `lua version promote`; on an unversioned agent `lua deploy <type>` goes live directly; target `persona` is push-only, with `lua deploy persona --set-version <previous>` as its rollback.
- `lua workflows activate <name> -v <ver>` deploys that version (`src/commands/workflows.ts` ~343). `lua push all` never includes workflows (stage-all handler list, `push.ts` ~1196-1206).
- `--auto-deploy` is ignored by `lua push` and `lua push all` (`push.ts` ~543-554 clears the flag before stage-all — MCP servers included, despite the CLI's usage text); it goes live only on a **single-primitive** push (`mcp` activates, `agent` deploys the persona, every versioned type publishes the version). That is why the plugin keeps denying it in every form.

### `--ci` behaviour and exit codes (`cli-reference.md` §1, §4; `commands/lua-test.md`, `commands/lua-version.md`, `agents/lua-skill-builder.md`, `agents/lua-debug.md`)

- `lua devices test`, `lua governance`, `lua skills production`, `lua persona sandbox` use `safePrompt` and exit 1 with the standard refusal under `--ci` — they do not hang (`src/utils/prompt-handler.ts`; `devices.ts`, `governance.ts`, `skills.ts`, `persona.ts`).
- `lua version create` / `lua version delete` skip their prompts under `--ci`; `delete` proceeds unconfirmed even without `--force` (`version.ts` ~58-61, ~439-450).
- Raw `inquirer.prompt` call sites (bare `lua env`, `lua pull` without `--force`, `lua auth logout|key` without `--force`, `lua chat` without `-m`/`-e`, `lua test skill` without `--name`) bypass `--ci`: they block on a TTY and, with no TTY, print the menu and exit 0 having done nothing (`src/utils/cli.ts`). `lua test skill --ci` without `--name` compiles and resolves a credential, then exits 0 having tested nothing (`test.ts` ~334-363) — always pass `--name` and `--input`.
- `lua test --name x` without a type exits 2 (`CliError.usage`); `lua push --name x` without a type exits 1 (plain `Error`, `push.ts` ~562).

### Logs (`cli-reference.md` §4, `commands/lua-logs.md`, `agents/lua-qa.md`)

- `lua logs --type` accepts exactly `all skill job webhook preprocessor postprocessor mcp device device-trigger user_message agent_response agent_error runtime rag calls`; other platform sources (`trigger`, `model-resolver`, `workflow-step`, `workflow-script`, `workflow`) exit 2 and are reachable only through the `tail_logs` MCP tool (`src/utils/aliases.ts`, `src/commands/logs.ts`).
- Log metadata has no `environment` field (`shared-types` `vm-execution-log.types.ts`); `metadata.channel === 'dev'` marks CLI-sent turns in both environments (`src/api/chat.api.service.ts` posts `?channel=dev`); a throwing tool lands under `logSource: 'skill'` (lua-core `execute-function.service.ts`); `agent_error` is written only by the chat pipeline (`chat.service.ts`).

### Credentials (`cli-reference.md` §2, `commands/lua-auth.md`)

- Dropped "server-enforced `minimumCliVersion`": the only `minimumCliVersion` in the platform is advisory text in the unconditional `410 LEGACY_API_KEY_ISSUANCE_RETIRED` body of the retired legacy API-key issuance route (lua-auth `profile.controller.ts`); nothing compares CLI versions.

### Model fallback (`primitives.md` §2)

- Replaced "no automatic provider fallback" with the real chain: an unapproved model code is silently swapped for the platform default at resolve time (lua-core `models.ts` `modelFromString`), and an operator-side, off-by-default cross-model fallback chain exists for provider transients (`fallback-chain.ts` `planLegs`, `execute.model-resolver.service.ts`). The persona `base/voice/text` "no cross-fallback" and "first voice is the fallback" statements were re-verified (`shared-types` `persona-text.type.ts`, lua-core `livekit-bridge.service.ts` `pickVoiceForChannel`).

### Sandbox environment (`cli-reference.md` §4, `primitives.md` §12, `commands/lua-env.md`, `commands/lua-chat.md`)

- `lua env sandbox` writes `.env` only (no env API call); `lua chat -e sandbox` compiles locally and uploads `loadEnvironmentVariables()` — the whole `process.env` merged with `.env`, `.env` winning — as the env of every sandbox skill version it pushes (`src/services/sandbox.service.ts` ~232-238, `src/utils/sandbox.ts` ~154-172); `.env` is what `lua test` reads.

### Runtime lag between typings and the deployed runtime (`primitives.md` §3, §8, §12, §14)

- `Data.create` **and** `Data.update` with an options object → `400 searchText must be a string` in production (`sandbox-runtime` `custom.data.api.service.ts`); `Data.collections()` is not injected deployed; `Voice.createSession` is not injected deployed nor under `lua test`.
- `LuaMCPServerConfig` has no `description`; `lua compile` does not warn (it consumes the field), `tsc` rejects the object literal.
- `Workflows.raiseBudget` fails in both runtimes (`WORKFLOWS_API_UNAVAILABLE` locally, 501 `not_implemented` deployed) — use `lua workflows raise-budget`.
- `Integrations.passthrough` takes `data` (not `body`), returns `data`, has no `connectionId`; `IntegrationPassthroughError` is not exported — duck-type on `name`/`code`.
- `user.send(messages)` delivers to the last-interaction channel; it returns `true` or throws under `lua test` but **always `true`** when deployed (delivery failures are swallowed in `platform-http.ts` / `user.instance.ts`) — use `Channels.send` for a delivery result. The last-interaction dispatch (lua-whatsapp `channel.service.ts` `sendToLastInteraction`) reaches WhatsApp, Instagram, Messenger, Teams personal chats, MessageBird, SMS and email windows only; Slack, Front, iMessage, RCS and web/`pop` are a 400 the deployed code never sees.
- `Channels.send` returns `status: 'accepted'` or `'queued'` on the immediate result — `'sent'` is typed but never produced (lua-api `channel-send.service.ts`). `Channels.email.send` needs an email channel (the agent's, the user's email window, or the platform's global one) and a `text` / `html` / `richBody` body.
- `AI.generate` `output` is JSON-parsed, never schema-validated (lua-core `ai-generation.service.ts`); the typings' conformance promise is false.
- `Agents.invoke` under `lua test` drops `userId`, `model`, `timeoutMs` and returns blocked turns as `{ text, finishReason }`; deployed it forwards them all and throws `AgentInvocationError`.
- `Templates.whatsapp.send` `results[i]` is Meta's raw per-recipient body passed through, but only successes land in `results` (failures go to `errors`), so there is no index correspondence with `phoneNumbers`.
- `Lua.request.channel` is `'pop'` for the website widget (lua-web `lua-pop/src/api/chat.ts` sends `channel=pop`; the platform keeps it distinct from `web`; the `Channel` typing still spells `web`) — compare against both.

### Jobs (`primitives.md` §6)

- Two retry algorithms behind a server-side intake mode (lua-core `job.service.ts`): in-process exponential backoff with ≤ 25 % jitter and a 900 s cap, bounded by `maxAttempts`; queued fixed `backoffSeconds` with `min(maxAttempts, 10)` attempts (no finite `maxAttempts` ⇒ no app-level retries) and `job.execution` set only there (`lua-sandbox-runner` `executor-entry.ts`).

### Devices and triggers (`primitives.md` §5, §9; `cli-reference.md` §4)

- A group command addresses every registered device in the group; offline members fail with 404 and count as `failed` (lua-core `device-tool.service.ts`, lua-api `device.service.ts`). `trigger_result` is never emitted (only `trigger_ack`). The `defineDeviceTrigger` execute context is `{ device: { name }, trigger: { name, triggerId } }` at runtime while the type declares `{ agent, device }` — `trigger` is untyped and `agent` is never passed (`sandbox-runtime` `wrapper-templates.ts`, `src/types/skill.ts`). The platform trigger URL host is a server-side setting (lua-api `developer.trigger.service.ts`); device-triggers have no URL.

### Integrations (`integrations.md`, `commands/lua-integrations.md`, `scripts/lint-cli-flags.mjs`)

- The post-connect hint `lua triggers create --connection <id>` printed by `lua integrations connect` (`integrations.ts` ~1459) is a tombstone — `lua triggers` prints a redirect and creates nothing (`triggers.ts` ~76-86). The documented follow-up is `lua integrations webhooks create --connection <id> --object <o> --event <e> --hook-url <url>`; `--hook-url` is required for a non-interactive run (no default; the "wake my agent" value is `<LUA_API_URL>/webhook/unifiedto/data`, `integrations.ts` ~50, ~2959-2984). A `lint-cli-flags` denylist entry now guards the tombstone spelling.

### Examples (`workflows.md` §1, `agents/lua-skill-builder.md`, `commands/lua-init.md`)

- `lua init --with-examples` examples do not compile: `tsc --strict` (TypeScript 5.9.3) against the installed 3.33.0 typings reports 23 errors in 10 files (`Channels.email.send` `body`→`text`, passthrough `body`→`data`, a non-existent `Payments`, `Orders.list`, `job.jobId`, unchecked `User.get()` nulls, broken relative imports). Builder agents mirror their layout only.

### Confirmed already correct

- `/lua-template`: the "Source agent has no active version" refusal is exit 10 (`http_400`), as the slash already stated (`src/errors/cli.error.ts` maps 4xx other than 401/403/404 to `CLI_EXIT.FORBIDDEN`).

## 1.2.0 — 2026-09-12

Verified against lua-cli 3.33.0 source; hook-based production gate (`confirm-deploy.mjs` on every Bash call, env-prefix aware permission template); plugin-scoped MCP tool names; six new slash commands (`/lua-env`, `/lua-integrations`, `/lua-status`, `/lua-version`, `/lua-workflow`, `/lua-template`); `cli-reference.md` and `workflows.md` knowledge files; live five-agent E2E. See the `v1.2.0` release.

## 1.1.0

Typed CLI auth (PRO-1042): `X-Lua-Client` identification of plugin API calls, credential-class reporting. See the `v1.1.0` release.

# Mechanics: flow tests, tool tests, stress and log scan

lua-cli is a TypeScript agent framework, not the Lua programming language. "Mechanics" are the checks that do not need a conversation: offline workflow flow tests, direct tool tests, a stress test and a log scan. The planner (cartographer, phase `plan`) writes the plans. The mechanics agent runs them through `node <pluginRoot>/lib/qa/cli.mjs`. Every command needs gate `plan` stamped.

## What each QA tier runs

| | smoke | medium | production-ready |
|---|---|---|---|
| tool tests | one valid input per tool | valid, boundary, invalid per tool | valid, boundary, invalid per tool |
| flow tests | the happy path, one test per workflow (more is refused) | every path | every path |
| stress | none (`stress.json` must not exist) | burst in sandbox | concurrent on a staged version; without one, a sandbox burst, and the report notes it |
| log scan | yes | yes | yes |

**Time estimate** (`validate --what plan` prints it as `estimate`, and refuses a plan over the tier's budget: smoke 30 min, a hard cap; medium 120; production-ready 300). The estimate adds up these parts:

- **Conversations:** about 2.5 minutes for every pair of runs, because sandbox chats are serialized, two runs per batch. Elsewhere eight runs go per batch.
- **Tests:** 0.25 minutes for each tool or flow test (each compiles).
- **Stress:** 2 minutes for a burst, 4 for concurrent.
- **Log scan:** 1 minute.
- **Fixed:** 8 minutes for discovery, planning, analysis and the report.

The mechanics take the sandbox lock with the players, so their time adds to the conversations rather than running alongside them.

**The smoke cap.** The 30 minutes count from the plan approval (gate 4, `clockStartedAt` in `state.json`), not from `init-run`, so discovery and the user's answers at the gates never eat into it. `start-run` starts no new conversation after minute 25 (exit 3, `TIME_BUDGET`), so a late run can still finish. After minute 30, `record` sends no further turn and closes the run as inconclusive, and `tool-test` and `flow-test` run nothing more (exit 3, `TIME_BUDGET`; each batch is also clamped to the minutes left). The tests not run are listed as not run, and the cards not played as "not played: the 30-minute cap was reached", never as agent failures. Grading the last runs, the log scan, the analysis and the report come after the cap and take a few minutes more; the report's "Time taken" runs from the plan approval to the last conversation or check.

## Flow tests (`plan/flow-tests.json`, schema `lua-qa/flow-tests@1`)

One test per entry in `flow-model.workflows[].paths[]` of every graph-form workflow. A script-form workflow has no graph: write one happy-path test and note in the description that branches are not covered.

For each path:
- `input`: valid for the workflow's `inputSchema`. Use fake data only.
- `stepOutputs`: one entry per agent step the path crosses, because the offline driver runs with fake agents. Key by the step id (or label), value a plausible JSON output that makes the path's branch conditions true. Read the path's `predicate` texts to choose values.
- `approve` / `deny`: the approval ids the path needs (`paths[].needs.approve`, `needs.deny`). An approval path and its denial path are two tests.
- `signals`: the signal names the path waits for (`needs.signals`), each with a JSON payload.
- `expect`: `exitCode` (0 for a path that completes), `reachNodes` (step ids that must run), `notReachNodes` (steps on other branches), `outputIncludes` (substrings of the output).

The CLI runs `lua test workflow` with the fake-agents and fast-retries options and the `--step-output`, `--approve`, `--deny` and `--signal` arguments built from the test. It never calls the platform.

Coverage: every conditional arm, every approval (approve and deny), every signal wait, every foreach with zero and with several items where the shape allows. The metric `workflow-branch-coverage` is covered paths divided by all paths. The validator lists every path without a test as a coverage gap.

An agent with no workflows still gets the file, with `"tests": []` and `"notApplicable": "the agent has no workflows"`: an empty list without that reason is refused, and so is the reason when the agent does have workflows. `flow-test --all` then has nothing to run, and the report shows workflow coverage as n/a. A workflow a user cannot start from chat (webhook or trigger only) is listed in `notChatStartable`, so the coverage checklist does not ask for a persona to start it.

If the output does not list step ids, `reachNodes` is skipped and the reason is recorded. That is not a failure.

Flow tests are resumable. Run `flow-test --all` repeatedly until the output says `remaining: 0`.

## Tool tests (`plan/tool-tests.json`, schema `lua-qa/tool-tests@1`)

For every tool in the flow model, three tests:
1. one valid input (`expect: "ok"`), built from the input schema's required fields and realistic fake values;
2. one boundary input (`expect: "ok"`): minimum and maximum lengths, empty optional fields, the largest allowed number;
3. one invalid input (`expect: "error"`): a wrong type or a missing required field.

Skip or soften tests for tools whose `sideEffect` is `likely` or `unknown` and which would act on a real system: use only inputs that the tool will reject, or note the risk in `rationale` and mark the ledger. Never use real ids or addresses. Emails end in `@example.com`.

**`lua test` exits 0 when a tool throws.** The exit code is not a verdict. The CLI treats a tool as having thrown when the parsed `--json` output is the error envelope (`success: false`) or has a top-level `status` equal to `error`, when output that is not JSON at all contains a `"status":"error"` pair, or when the output has a stack trace. A successful result whose own records carry `status: "error"` is not a throw. A tool that throws on a valid input is a failure. A tool that accepts an invalid input is a failure. A missing `outputIncludes` substring is a failure.

Tool tests run the tool's code on this machine. API calls inside the tool are real, and the shell environment is passed through so tools can read their keys. The output never prints secrets: it is redacted. Right before each spawn the CLI re-checks the test input for real-looking emails and URLs (exit 3), and every test of a tool whose `sideEffect` is not `none` adds a ledger row (`source: tool-call`, `cleanup: manual`).

Tool tests are resumable. Run `tool-test --all` repeatedly until the output says `remaining: 0`.

`expectedLogs` (optional, in `tool-tests.json`): a tool's own deliberate `console.warn` lines, found by reading its code at plan time (a refused password reset, a P1 ticket notice). Each is `{ "tool": "<tool name>", "match": "<a literal piece of the logged text, at least 6 characters>", "why": "<why the tool warns>" }`. They are warnings only (an error is never expected), and they are sealed with the plan.

## Stress (`plan/stress.json`, schema `lua-qa/stress-plan@1`)

Defaults:
- staged or production: `mode: "concurrent"`, 10 threads, 2 turns per thread, concurrency 5, `maxWallSeconds` 100. Real concurrency needs a staged version through the test-session API, or production with consent.
- sandbox: `mode: "burst"`, one burst of 4 messages, 100 ms apart, in one thread. A burst plan needs `messages`, `burst`, `maxWallSeconds` and `targets`; `threads`, `turnsPerThread` and `concurrency` are only required for `concurrent`. Sandbox chats are serialized because every sandbox chat compiles and pushes; concurrent sandbox stress is refused (exit 3).

Messages: short, realistic, fake data, covering the agent's most common request. Targets default to p90 15000 ms, p99 30000 ms, error rate 0.01 (from the agreed metrics).

Percentiles are nearest rank. Stress is resumable: when the output says `complete: false`, call `stress --resume` again, at most 8 calls. A burst result counts replies, batch-handled messages and batch aborts.

## Log scan

Runs last, after every conversation and test has finished. The window starts shortly before the first run started and ends now, so errors from before the test do not count. Use the log environment from `run.json` (`logEnvironment`). The scan reads up to 100 rows per request and splits a window in half when a request returns 100 rows. Only entries whose `subType` is `error` or `warn` matter. Group by `logSource` and `primitiveName`. Any error is a finding. A warning is noted, except a warning the plan expects (`tool-tests.json` `expectedLogs`, matched on the tool and the literal text): it is counted under `expectedWarns`, shown in the report as expected, and is not a finding. The expectations apply only while the plan is the sealed one. A truncated window is reported honestly. Messages are redacted and cut to 500 characters.

## Tool calls from the logs

The thread-history route does not return tool calls in sandbox, so `prechecks` fills them from the skill logs: one `lua logs --type skill` query per run (up to 200 rows, split in half when full, retried with backoff on a 429; the logs allow 120 calls a minute). Rows are kept only for this agent and the run's log environment and grouped by `executionId` into calls with the tool, skill, input, result, warnings and errors. Each call goes to the turn whose chat window holds it (the chat process inside the sandbox lock, or the whole turn for runs recorded before that was stored), and every run in the run folder is indexed so a neighbour's call is not taken. Such turns get `toolCallSource: "logs-window"`. Only sandbox runs are filled (the lock is what makes the window unique). A failed, truncated or unreadable query leaves the turns `unavailable`, never "zero calls". A logged call to a tool with a side effect adds a ledger row once (`source: tool-call`).

For runs recorded before this existed: `backfill-tools --run-dir <runDir> [--card <id> --run <k> [--attempt <n>]] [--refresh] [--no-prechecks]` fills the calls and re-runs those runs' prechecks. Without `--card/--run` it does every finished run.

## Order and limits

Every mechanics command checks that the plan files are the ones the user approved: the plan gate stores a hash of the cards and the three test plans, and an edit after the stamp is refused (exit 3, `PLAN_CHANGED`) until the plan is shown and stamped again.

Mechanics may run next to the conversations, except the log scan, which runs after them. In a sandbox run, `flow-test` and `tool-test` take the same sandbox lock as the players' chats, because `lua test` compiles into the folder a sandbox chat pushes from. When a player holds the lock for too long the command stops with `sandboxBusy: true` and writes no result for the tests it could not start: run it again. Burst stress has no staged path and is refused for a staged environment; use concurrent stress there. Each CLI call stays under 110 seconds; the tools stop starting new work near the limit and say what remains. Never wait more than 120 seconds in one command. To bound a call harder, pass `--timeout <seconds>` (5 to 115) to `flow-test`, `tool-test`, `stress`, `log-scan`, `prechecks` or `backfill-tools`: it stops the call, the `lua` processes it started and any sandbox lock it held, and the next call carries on. `record` and the other stateful subcommands refuse it. Never wrap the helper in `timeout` or `gtimeout`: macOS has neither, and the wrapper breaks the permission rule.

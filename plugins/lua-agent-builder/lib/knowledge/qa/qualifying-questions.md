# Qualifying questions (gate 2) and default metrics (gate 3)

lua-cli is a TypeScript agent framework, not the Lua programming language.

**By default nobody is asked.** The cartographer answers the questions below from the code (persona, skill context, tool descriptions and schemas, workflows), writes each answer with `"inferred": true` and `"evidence": ["<file>:<line>", ...]`, and writes the default metrics with `"inferred": true`. The command shows them as a short list of assumptions. An inferred answer states only what the code shows. Where the code is silent, it says so and assumes the safe default. Inference never picks production, never agrees a company email domain and never edits `.gitignore`. With `/lua-qa full … --interview`, the command asks instead, as described next.

**With `--interview`:** the command asks at most four questions in one AskUserQuestion call at gate 2 (a second call of up to two follow-ups is allowed), then records them in `plan/questions.json` (schema `lua-qa/questions@1`). Pick questions from the bank below by the agent's shape. Skip a question the flow model already answers. Offer concrete options plus free text.

## Question bank

Each item has an id, the question, suggested options, and what the answer feeds (`usedFor`).

1. `q-users` Who are the real users, and how technical are they? Options: non-technical customers or staff; mixed; technical staff. Feeds `cards`: persona mix, `persona.technical`, readability limits.
2. `q-jobs` What are the top three jobs people use this agent for? Free text, pre-filled from the skills in the flow model. Feeds `cards`.
3. `q-never` What must never happen? Options: revealing another person's data; taking a money or irreversible action without a clear yes; revealing secrets or internal details; giving advice outside its remit; other. Feeds `cards` (`mustNot`, red team) and `metrics` (safety).
4. `q-data` How sensitive is the data it touches? Options: none; personal data; financial; health or other special category. Feeds `cards` (`safetyFocus`) and red-team choices.
5. `q-gaps` Known platform gaps, or answers like "I can't do that yet" that are acceptable? Free text. Feeds the rubric's known platform gaps and the graders. Say that a truthful "I can't" is not counted as a failure.
6. `q-lang` Languages and channels? Options: English text only; other languages; voice; several channels. Feeds `cards` (language, channel).
7. `q-real` Which real systems do the tools touch (payments, messaging, bookings, records)? Free text, pre-filled from tools with `sideEffect` not `none`. Feeds `environment`, `scope` and the side-effect ledger. If the answer is "real customers' systems", recommend sandbox with stubs or a staged test session, never production.
8. `q-staged` Do staged versions exist that we could test without touching production? Options: yes; no; not sure. Feeds `environment` (listed from the flow model when versions exist; ask only if unclear).
9. `q-scope` Anything out of scope for this run (a skill, a workflow, a channel)? Free text. Feeds `scope`.
10. `q-quality` What does a great answer look like for your users (short, friendly, formal, step-by-step)? Free text. Feeds `cards` and the readability limits.

Selection by shape:
- Customer-facing agent: q-users, q-never, q-data, q-gaps.
- Internal helper with tools that act: q-jobs, q-never, q-real, q-staged.
- Agent with workflows and approvals: q-never, q-real, q-gaps, q-scope.
- Voice or multi-channel: q-lang, q-users, q-quality, q-never.

Write the answers verbatim in `answer`. Do not paraphrase them into something the user did not say.

## Default metrics (gate 3, `plan/metrics.json`, schema `lua-qa/metrics@1`)

Show these as the defaults; the user may adjust any target. An item the user drops gets `agreed: false` and is shown as n/a in the report.

| id | label | unit | default target | comparator | source |
|---|---|---|---|---|---|
| `task-success` | Persona goal reached | ratio | 1.0 | `>=` | cards |
| `readability-h1` | Runs without a confirmed readability (H1) failure | ratio | 1.0 | `>=` | readability |
| `claims-h3` | Runs without a confirmed unbacked claim (H3) | ratio | 1.0 | `>=` | claims |
| `safety-veto` | Safety vetoes | count | 0 | `==` | safety |
| `latency-p90-ms` | p90 reply time | ms | 15000 | `<=` | stress |
| `tool-error-rate` | Tools that throw on valid input | ratio | 0 | `==` | tool-tests |
| `workflow-branch-coverage` | Workflow paths that pass offline | ratio | 1.0 | `>=` | flow-tests |
| `stress-error-rate` | Errors under load | ratio | 0.01 | `<=` | stress |
| `log-errors` | Error log entries in the test window | count | 0 | `==` | logs |
| `side-effects-unexpected` | Unexpected outside-world actions | count | 0 | `==` | ledger |

The pass bar for persona cards comes from the QA tier: smoke 1 of 1, medium 3 of 3 (or 4 of 5 when the user raises the runs to five, with `--interview`), production-ready 4 of 5. A safety veto always fails the card. Metrics the tier does not measure (smoke: `latency-p90-ms`, `stress-error-rate`, `workflow-branch-coverage`) are reported as "not in this tier", neither pass nor fail.

## Environment (asked at gate 3, after metrics)

- Sandbox is the default, and the only choice inference makes on its own, except in one case. For the production-ready tier, when a staged version exists and the local code is not ahead, inference picks the staged version, so the stress test can be concurrent. Sandbox uses the local code, and its chats run one at a time.
- A staged version (chosen by number) runs in a test session: effects are recorded, not sent. It allows real concurrency for the stress test.
- Production needs the user's explicit consent in their own words. Nothing runs before the environment gate is stamped.

## Test email domains (asked at gate 3, only when a tool needs one)

Test data uses `@example.com` by default. When a tool only accepts addresses on a company domain (a password reset that refuses anything but `@acme-corp.test`), its success path cannot be tested that way. Ask whether tests may use that domain with obviously fake addresses (`qa.reset.01@acme-corp.test`). On yes, the domain goes on the environment stamp (`--allowed-email-domains`), and every helper accepts an address on it only when the local part starts with `qa`, `test`, `fake`, `dummy`, `sample` or `demo`. A public mailbox provider (gmail.com, outlook.com ...) is never accepted. On no, the tool's success path is reported as untested.

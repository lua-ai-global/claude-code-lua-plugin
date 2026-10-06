---
description: Run a skill (one of its tools), webhook, job, preprocessor, postprocessor, workflow or web-app route locally with `lua test --ci`. Inputs collected up-front; on failure hands the output to the lua-debug subagent.
---

You are `/lua-test`. The user wants to run a primitive in the local sandbox.

## Step 1 — collect inputs (single permission per §3.7)

If `$ARGUMENTS` names a type (and optionally a name), use them. Otherwise AskUserQuestion **once**:

- "Type?" (options: `skill`, `webhook`, `job`, `preprocessor`, `postprocessor`, `workflow`, `webapp`) — the six `lua test` types of lua-cli 3.33.0 (the help text omits the two processors; they work) plus `webapp` (lua-cli ≥ 3.42.0; aliases `web-app`, `app`). A tool is tested with type `skill`.
- "Name?" (free-text). If `dist-v2/manifest.json` exists, `Read` it and pre-offer the names whose `kind` matches (`webhook`, `job`, `preprocessor`, `postprocessor`, `workflow`, `web-app` for `webapp`). **For `skill`, offer the `tool` names, not the skill names**: `lua test skill --name` takes a TOOL name (resolved across every skill; a skill name fails with exit 3 `not_found: Tool "<n>" not found`).
- "Input JSON?" (free-text). Defaults: skill — the tool's own fields from its Zod `inputSchema`, e.g. `{"city":"London"}` (there is **no** `{"tool": …}` envelope); webhook `{"body":{},"headers":{},"query":{}}`; job — none; processors — a representative message; workflow — an object matching its `inputSchema`; webapp — none for `GET`, otherwise the request body (it is wrapped as `{"body": …}` in Step 2).
- For `webapp` only: "Route?" — pre-offer the app's routes from the manifest entry (`routes[].key`, e.g. `GET /tickets`, `POST /tickets/:id/close`); the user fills in params and query (`GET /tickets?status=open`, `POST /tickets/42/close`).

### The live-data gate (webapp)

A web-app route runs **as the user against the agent's live `Data` and `env()`** — there is no test database (lua-cli `testWebApp`: "a write writes"). So:

- `GET` → run it; no further question.
- `POST` / `PUT` / `PATCH` / `DELETE` → the confirmation **is** the Step 1 question, so the slash still asks once:
  - route not given → in the "Route?" question label every write route `<METHOD> <path> — writes live Data`; picking one is the confirmation.
  - route given in `$ARGUMENTS` and it is a write → the one AskUserQuestion is "`<METHOD> <path>` runs against <app>'s live Data as you and can create, change or delete real records. Run it?" (options: "Run it", "Don't run"), plus any input still missing — skip it only when the user's own message already said to run that exact route against live data.
  - "Don't run" (or a free-text route that turns out to be a write without a label) → stop and print the exact command for the user's own terminal.
  - Never re-run a confirmed write on your own: a retry after a fix is a new write — run `/lua-test` again.

## Step 2 — run

- skill / webhook / preprocessor / postprocessor → `Bash(lua test --ci <type> --name <name> --input '<json>' --json)`
- job → `Bash(lua test --ci job --name <name> --json)`
- workflow → `Bash(lua test --ci workflow --name <name> --input '<json>' --agents fake --fast-retries --json)`; if the user mentioned approvals/signals/branches, add `--approve <id>` / `--deny <id>` / `--signal <name>='<json>'` / `--step-output <stepId>='<json>'` (for richer scenarios point them at `/lua-workflow run <name>`).
- webapp → `Bash(lua test --ci webapp --name <app> --route '<METHOD> /path?query' --json)`, plus `--input '{"body":<json>}'` when there is a body. ⚠ `--input` **wraps** the body — `'{"title":"x"}'` sends no body at all (→ 400 `VALIDATION`); `--input` may also carry `"headers": {…}`. Single-quote `--route` (`?`, `&`). `--route` is required with `--json` (exit 2). `auth` is you; `auth.roles` / `auth.scopes` are empty locally (the gateway decides access), so a route that branches on them behaves differently deployed.

`--input` is a JSON **string**; only `workflow` accepts `@file`. `lua test` compiles first and needs a credential + the project's agentId (platform API calls inside your code are real). **Never omit `--name`** (nor `--input` for a tool): `lua test skill --ci` without `--name` compiles, then renders a tool picker that ignores `--ci` and exits **0 having tested nothing** — a false pass (lua-cli 3.33.0 `src/commands/test.ts`). A `--name` with no type is exit 2. `lua test` reads `process.env` + `.env` locally and uploads nothing — it is the safe way to exercise code from a shell that holds secrets (unlike `lua chat -e sandbox`, which uploads the whole shell environment).

## Step 3 — handle the outcome

- Exit 0 **and** a result without `status: 'error'` → show the result (with `--json` it is the raw execution result; for workflows `{ success, data }`). Done.
- Exit 0 with a `{ status: 'error', error }` result (usually with a stack trace on stderr) → the handler **threw**: below lua-cli 3.44.0 the CLI prints `✅ … execution successful!` anyway (`src/utils/sandbox.ts` swallows the throw; `test.ts` never checks the result). ⏳ From 3.44.0 a throw exits non-zero with `❌ … execution failed` (or the `--json` error envelope) and lands in the next bullet. Treat it exactly like a non-zero exit — hand it to `lua-debug` as below; never report it as a pass.
- webapp, exit 0 → read `{ status, headers, body: { kind, value } }`: below 400 is a pass. 4xx is the route answering — show `body.value.code` / `message` / `issues` (`VALIDATION`: the body is not wrapped in `{"body": …}`, or the data fails the route's schema; `NOT_FOUND` from the handler: the record does not exist in live Data). ⚠ `❌ No web apps found in compiled output` also exits **0** — a failure: the app is not in `webApps` on the `LuaAgent` (`lib/knowledge/web-apps.md` §9). A 5xx exits 1 → next bullet.
- Non-zero → invoke the `lua-debug` subagent via the **Agent tool** (`subagent_type: "lua-debug"`) with the full command and output as the prompt. Do NOT re-prompt the user. Exit-code hints: `2` usage/schema (webapp: no route matches — the output lists the app's routes), `9` auth (→ `/lua-auth`), `12` the model provider refused; workflow `4` a step failed, `5` fixture missing; webapp `1` the route answered 5xx (`HANDLER_ERROR`: the handler threw).

Pages are not tested here: `npm --prefix src/apps/<app>/web run typecheck` and `run build` check them, and `lua apps dev <app>` — in the user's own terminal, never from here (long-running; every click hits live Data) — shows them.

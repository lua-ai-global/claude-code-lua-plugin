# Changelog

All notable changes to the `lua-agent-builder` plugin. Versions follow the tag `release-prod.yml` cuts from `package.json` (`v<version>`). lua-cli is a TypeScript SDK/CLI; it is unrelated to the Lua programming language.

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

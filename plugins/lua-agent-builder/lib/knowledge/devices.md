# Devices — connecting hardware and local machines to an agent (lua-cli 3.44.0 · ⏳ 3.45.0)

Read from lua-cli `src/commands/devices.ts`, `src/cli/command-definitions.ts`, `src/utils/aliases.ts` (`devices.action`) and `src/primitives/device*.handler.ts` at **3.44.0** (the npm `latest` on 2026-10-05) and at **3.45.0** (the `stefan/devices-cli-fixes` release, in review). Platform facts from docs.heylua.ai `/devices/*`, re-checked against production on 2026-10-05. Entries marked **⏳ 3.45.0** need lua-cli 3.45.0 or later; each one names its 3.44 fallback. The plugin's own pin stays 3.38.0 — check `lua --version` before choosing a path.

lua-cli is a TypeScript SDK/CLI; it has nothing to do with the Lua programming language. Device clients are Node, Python or MicroPython programs — none of them is Lua either.

---

## 1. The model in one paragraph

A **device** is a client process (a Pi, a laptop, a Pico W, a PLC gateway) that holds one authenticated connection to the platform — Socket.IO to `https://api.heylua.ai` (Node default) or MQTT 3.1.1 over WebSocket+TLS at `wss://mqtt.heylua.ai/mqtt` (Node `transport: 'mqtt'`, Python, MicroPython). The agent calls the device through **commands** (each becomes a model tool) and the device calls the agent through **triggers** (each runs a handler on the platform). Nothing about a device is part of an **agent version**: promoting or rolling back a version never changes a device, a device-trigger, or the handlers they run.

| Direction | Mechanism | What the model / platform sees |
|---|---|---|
| agent → device | command | tool `device__<device>__<command>` (hyphens in the device name become `_`) plus `device__<device>__is_online`; a group of `defineDevice` devices also gets `device__<group>__<command>__all` |
| device → agent | trigger | `{ triggerName, payload }` queued, `trigger_ack { triggerId, received: true }` back (= queued, **not** handled); the matching `execute` runs with `(payload, { device: { name }, trigger: { name, triggerId } })` |
| platform → agent | system triggers | `device_connected { deviceName, connectedAt, metadata }`, `device_disconnected { deviceName, disconnectedAt }` — handle with a `defineDeviceTrigger` of that name; a heartbeat-sweep timeout fires neither |

## 2. Self-describing device vs `defineDevice` — choose first

| | **Self-describing** (commands declared by the client) | **`defineDevice`** (commands declared in the agent project) |
|---|---|---|
| Where commands live | the client's `commands: [...]` / `@device.command` — sent at connect, nothing pushed | `src/devices/<name>.ts`, registered on `LuaAgent.devices`, `lua push device` |
| Change a command | edit the client, restart it | edit the project, `lua push device` (live on the agent's next turn) |
| Tools while offline | **gone** on the next turn; `is_online` answers `{ status: 'offline' }` | **kept**; a call returns `DEVICE_OFFLINE` |
| Timeouts / retries | per command in the client list | `timeoutMs`, `retry: { maxAttempts, backoffMs }` under version control |
| Group fan-out (`__all`) | no | yes — same `group` on every declaration **and** passed by each client |
| 24 h command expiry | **yes** — the stored list expires 24 h after connect; heartbeats don't extend it | no (the declaration is the list) |
| Inline triggers | no (use standalone `defineDeviceTrigger`) | `triggers: { name: { execute } }` on the declaration |
| Best for | a quick prototype, a board whose firmware owns its capabilities, MicroPython | a fleet, anything you want reviewed in a PR, groups, stable tools while a device reboots |

If a device connects **with** its own list **and** a `defineDevice` of the same name is pushed, the device's list wins and the declaration's commands are ignored for that device. A `defineDevice` client connects with the same `name` and **no** command list (e.g. `lua-device connect` from `npm i -g @lua-ai-global/device-client`).

Names: device `^[a-z][a-z0-9-]*$` for a `defineDevice` (compile warning otherwise; 1–200 chars, no whitespace, `/`, `+`, `#` on the wire); command `^[a-z][a-z0-9_]{0,63}$` (others **silently dropped**); device-trigger `^[a-z][a-z0-9_-]*$`. Trigger names match by exact string — `temperature_alert` ≠ `temperature-alert`.

## 3. Credentials

| Credential | Connects? | How it is issued |
|---|---|---|
| **Device credential** (`api_<uuid>.<43 chars>`, bound to one agent + one device name + operations) | yes — the only kind for new devices | ⏳ 3.45.0 `lua devices credential` (below) |
| Legacy API key (`api_` + 32 hex) | yes, while its owner may manage the agent | no longer issued; only one you already hold |
| **Scoped personal API key** (`api_<uuid>.<43 chars>` too — looks identical) | **no** — `AUTH_FAILED: Typed API keys require an explicitly scoped gateway policy` (Socket.IO) / broker `Not authorized`, MicroPython `MQTT CONNACK error: rc=5` | — |

Operations (`DEVICE_OPERATIONS` in `@lua/shared-types`): `commands` (declare, receive, respond), `triggers` (send, receive acks), `assets.upload` (the client's `cdn.upload`; Node and Python only). Grant only what the device does; operations **cannot be added** to an existing credential — issue a new one.

### ⏳ 3.45.0 `lua devices credential`

```
lua devices credential --ci --device-name <name> [--operations commands,triggers,assets.upload] --out .env.device [--force]
```

- Needs a project directory (agent from `lua.skill.yaml`) and an **email sign-in** (a first-party session). An API-key sign-in is refused before any request: `usage: Issuing a device credential needs an email sign-in; an API key cannot issue one.` → the user runs `lua auth configure` **in their own terminal** and chooses Email (`/lua-auth`); the plugin never runs it.
- `--operations` defaults to `commands,triggers`; an unknown operation is exit 2 naming the valid list.
- `--out <file>` writes exactly three lines — `LUA_AGENT_ID=…`, `LUA_DEVICE_NAME=…`, `LUA_DEVICE_CREDENTIAL=…` (bare when the value is `[A-Za-z0-9_.:@-]*`, otherwise JSON-double-quoted) — with mode **600** (re-applied on overwrite), and prints only `saved to <file> (id <credentialId>)`. An existing file is exit 2 (`<file> already exists.`) unless `--force`.
- **Without `--out` the secret is printed once to stdout.** In Claude Code that is the conversation transcript, so the plugin **always** passes `--out` — the `block-device-secret` hook blocks the command otherwise — and never `cat`s, `source`s, `grep`s, `head`s or echoes the file. Never pass `--force` unless the user asked to replace the file.
- Before issuing, make sure the out file is git-ignored (the `lua init` template ignores `.env` but **not** `.env.device`): append the exact name to `.gitignore` if missing. Copy the file to a device out-of-band (`scp`, `mpremote cp`), never through the chat.
- Aliases: `credentials`, `key` → `credential`. All three sit in the plugin's `ask` tier.
- Rotate / suspend / revoke: no CLI verb. They are `POST /admin/users/me/credentials/<id>/rotate|suspend|reactivate` and `DELETE …/<id>` with a session token — the user does that from their own tooling; to replace a lost or leaked secret, issue a new credential with `--out --force` and restart the device. Revocation closes Socket.IO connections at once (`AUTH_FAILED`), MQTT at the next publish/subscribe; a ~60 s re-check is the fallback.

**3.44 fallback**: `credential` is not a `devices` action (`validateOrSuggest` → exit 2). There is no self-service path — the `/admin/users/me/credentials/device` route needs a first-party session token that no CLI command prints and the dashboard does not expose. On 3.44 a device connects only with a **legacy `api_` + 32 hex key the user already holds**; the user puts it into the device's env file themselves. Otherwise: `npm i -g lua-cli@3.45.0` once it is published (`/lua-update`).

## 4. `lua devices` — every action, 3.44 vs ⏳ 3.45

`lua devices [action] [--device-name n] [--group g] [--command c] [--trigger t] [--payload json] [--timeout ms] [--operations list] [--out file] [--force]`. Always pass `--ci` and `--device-name` — without a name every action prompts a picker (exit 1 under `--ci`). Aliases (`devices.action`): `ls`/`l` → list · `info`/`show` → status · `on`/`activate` → enable · `off`/`deactivate` → disable · `rm`/`delete`/`del` → remove · `run`/`exec` → test · `test_trigger` → test-trigger · ⏳ `credentials`/`key` → credential. None of them is a production verb in `lib/tokenizer.mjs`.

| Action | 3.44.0 | ⏳ 3.45.0 | Plugin tier |
|---|---|---|---|
| `list [--group g]` | lists **declared (`defineDevice`) devices only** — a self-describing device never appears (`📡 name` / `⛔`). Use `status --device-name` instead | declared **and** connected devices merged, each `🟢 online` / `⚪ offline` / `⛔ disabled`, `declared` tag, `Last seen …` | allow |
| `status --device-name n` | `🟢/🔴/⛔ Device 'n' is <online\|offline\|registered\|disabled>` | same, plus `has never connected to this agent` and the `enable` hint for a disabled device | allow |
| `test --device-name n --command c --payload '{…}' [--timeout ms]` | **no `--command` option**: always prompts for the command → exit 1 under `--ci`. Fallback: `/lua-chat` asking the agent to call `device__<n>__<c>` | sends one command, prints `Response received (<ms>ms):` + the JSON reply; errors name `offline` / `disabled` / `No reply within <ms>ms` / 429 | ask |
| `test-trigger --device-name n --trigger t --payload '{…}'` | always prompts for the name (exit 1 under `--ci`) and **never ran a handler** — it relayed a `__test_trigger__<t>` command to the device. Fallback: fire the trigger from the client | fires the trigger as device `n` and **runs the live handler**: `Trigger 't' queued (id <triggerId>)`; read the run with `lua logs --type device-trigger`; a 404 means the environment lacks the test route | ask |
| `enable --device-name n` | `Device 'n' enabled` | same + the reminder that the device stays **offline until its client reconnects** | ask |
| `disable --device-name n` | `Device 'n' disabled` | `disabled. It is disconnected and refused until you enable it.` (the platform kicks the connection) | ask |
| `remove --device-name n --force` | deletes the **declaration** only (a self-describing device's record stays); no unknown-name check | refuses an unknown name (`No device named 'n' on this agent.`, exit 3); deletes the declaration and/or the connected record; warns that a still-connected device reappears on reconnect — **disable** it to keep it out | ask (`lua * remove*`) |
| `credential …` | does not exist (exit 2) | §3 | ask |

Without `--force`, `remove` prompts (exit 1 under `--ci`). `--group` only filters `list`; `lua devices test` addresses one device and cannot call an `__all` group tool — exercise fan-out through `/lua-chat`.

## 5. Going live — not an agent version

| What | Push | Live when | Plugin path |
|---|---|---|---|
| Self-describing device | nothing | the client connects | — |
| `defineDevice` | `lua push device --ci --force --name <n>` | **on the agent's next turn, published or not** (`--auto-deploy` only records the active version) | `/lua-devices push` — the `ask`-tier prompt on `lua push device *` is the confirmation |
| `defineDevice` inline `triggers.*` | same push | same | same |
| Standalone `defineDeviceTrigger` | `lua push device-trigger --ci --force --name <n>` creates a version **that does not run** | only after that version is **published** — `lua push device-trigger --name <n> --auto-deploy` or the interactive push prompt | the plugin denies `--auto-deploy` everywhere, so it prints that line for the user's **own terminal** and never runs it |

- `lua deploy` takes no device type and lua-cli has no device-triggers management command; `lua version create` → `lua version promote` does **not** publish either (devices are not in agent versions). `/lua-deploy` therefore does not offer them.
- ⚠ `lua push all` (stage-all, also run by `/lua-deploy` for `all` / `agent-version`) pushes every registered `defineDevice` too — that is a device go-live.
- A trigger with no live handler is **logged as skipped and dropped**; the device still gets `received: true`.
- The **WhatsApp** (and every other channel) link talks to the agent's **live** version: anything a device flow needs from a skill, persona or workflow must be pushed **and** promoted (`/lua-deploy`) before testing over WhatsApp. A device-trigger handler's return value goes nowhere on its own — to message a user it must send it (`Channels`, `Agents.invoke`, or a returned `{ startWorkflow }`).

## 6. Handlers — `defineDeviceTrigger`

```ts
import { Agents, defineDeviceTrigger } from 'lua-cli';
import { z } from 'zod';

const AGENT_ID = '<agent.agentId from lua.skill.yaml>';   // env() is EMPTY inside device-trigger handlers

export const doorOpened = defineDeviceTrigger({
  name: 'door_opened',
  description: 'A door sensor reports that its door opened',
  payloadSchema: z.object({ door: z.string(), openedAt: z.string() }),
  async execute(payload, { device, trigger }) {       // runtime context; `agent` is typed but never passed
    await Agents.invoke(AGENT_ID, `Device ${device.name} reports door ${payload.door} opened at ${payload.openedAt}.`);
    // or: return { startWorkflow: { name: 'door-incident', input: payload, idempotencyKey: trigger.triggerId } };
  },
});
```

Register on `LuaAgent.deviceTriggers` (inline device triggers go on the declaration). Up to **10 min** per run; delivered **at least once** — a throw or timeout is retried 3× 60 s apart with the **same `trigger.triggerId`**, so key every side effect on it. Any return other than `{ startWorkflow }` is only logged. Scaffold with `/lua-new device-trigger <name>` (and `/lua-new device <name>` for a declaration).

## 7. Clients

All three read **no** env vars themselves; the scaffolds below load the `--out` file. Never inline the secret in source.

| | Node `@lua-ai-global/device-client` (1.1.0, Node ≥ 18) | Python `lua-device-client` (1.3.0, Python ≥ 3.8) | MicroPython (Pico W) |
|---|---|---|---|
| Install | `npm i @lua-ai-global/device-client` (+ `dotenv` to load the file) | `pip install lua-device-client` | `pip install lua-device-client mpremote`, then copy `lua_device/micropython.py` to the board as `lua_device.py` |
| Credential field | `deviceCredential` (`apiKey` = legacy, deprecated) | `api_key` (1.3.0 has no `device_credential`) | `api_key` |
| Transport | `transport: 'socketio'` (default) \| `'mqtt'` | MQTT/WSS | MQTT/WSS (TLS cert **not** verified in WS mode) |
| Commands | `commands: [{ name, description, inputSchema?, timeoutMs?, retry? }]` + `onCommand(name, async (payload) => result)` | `commands=[DeviceCommandDefinition(...)]` + `on_command(name, async fn)` | `@device.command("name", description=..., inputSchema=...)` (sync; a slow handler delays heartbeats) |
| Triggers | `await device.trigger(name, payload)` → ack or reject after 10 s | `await client.trigger(...)` → `TimeoutError` after 10 s | `device.trigger(name, payload)` returns at once, no ack wait |
| CDN | `device.cdn.upload(...)` — needs `assets.upload` | `cdn` — needs `assets.upload` | **none** |
| Reconnect | Socket.IO 1→30 s jittered, **stops for good on `AUTH_FAILED`/`MISSING_AUTH`**; a server close (`AGENT_FORBIDDEN`, `DEVICE_DISABLED`) is retried every 1 s forever — handle `error`; MQTT every 5 s | 1→120 s | 2→30 s, **board reset after 10 failures**; `run()` reconnects only after an error |

Scaffold layout the plugin writes (with the Write tool — never a heredoc or `node -e`/`python -c`, see §10): `device/` at the project root, git-ignored env file next to it. The Pico gets `main.py` that parses the copied `device.env` (strip optional `"…"`) and a `wifi.py` the **user** fills in on their machine; the plugin never asks for or writes the Wi-Fi password.

## 8. Testing and logs

| Goal | ⏳ 3.45.0 | 3.44.0 fallback |
|---|---|---|
| Is it connected? | `lua devices status --ci --device-name n` (or `list`) | `status` (never `list` for a self-describing device) |
| Does a command work? | `lua devices test --ci --device-name n --command c --payload '{…}' --timeout 20000` | `/lua-chat` → "Call device__n__c with {…} and show me the raw result" (in production the agent's live version answers) |
| Does a handler run? | `lua devices test-trigger --ci --device-name n --trigger t --payload '{…}'`, then logs | fire it from the client (`device.trigger(...)`), then logs |
| Read the handler run | `lua logs --ci --json --type device-trigger --limit 20` (⏳ 3.38.0 `--since 10m`, `--follow`) | same |
| Read command traffic | `lua logs --ci --json --type device --limit 20` | same |
| Tools the model has | `/lua-chat` → "Which device tools do you have?" | same |

## 9. Limits

Command timeout `timeoutMs` (30 000 ms default) **+ 2 s**, then `TIMEOUT` · **100** commands in flight per agent (`TOO_MANY_REQUESTS`) · **10** triggers/s per agent (`RATE_LIMITED` on `trigger_error`, surfaced by the Node Socket.IO client only; MQTT clients just time out) · **1 MB** command payload, response `data` and trigger payload · response `error` 4 KB · 128 commands per device, 128 device tools per agent (counting `is_online`), 4 KB per `inputSchema`, descriptions cut at 500 chars · heartbeat 30 s; offline at once on close, else within 5–10 min (sweep) · **command list expires 24 h after connect** (self-describing only) · 5 failed handshakes / 60 s → 10 min lock-out (`RATE_LIMITED`, `retryAfterMs`) · CDN 100 MB per file.

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `AUTH_FAILED` … `Typed API keys require an explicitly scoped gateway policy` | a **scoped personal API key** used as the device secret | issue a device credential (⏳ `lua devices credential --ci --device-name <n> --out .env.device`); on 3.44 use a legacy `api_`+32 hex key. Restart the client — the Node client never retries after `AUTH_FAILED` |
| `AUTH_FAILED` (other) | credential revoked / suspended / rotated / expired, or a typo | issue a new one (`--out <file> --force` when replacing), restart |
| `MQTT CONNACK error: rc=5` (MicroPython) / `Not authorized` (Node MQTT, Python) | broker refused: wrong secret, scoped key, **or** `agentId`/`deviceName` ≠ the credential's binding | compare the board's `LUA_AGENT_ID` / `LUA_DEVICE_NAME` with the file the credential was written to, character for character; re-copy the env file |
| `AGENT_FORBIDDEN` on connect, reconnecting every second | agent ID or device name differs from the binding | fix the client config; stop the loop by handling `error` |
| `OPERATION_FORBIDDEN` | credential lacks `commands` / `triggers` / `assets.upload` | new credential with the operation (cannot be added) |
| Offline after `disable` → `enable` | `disable` kicks the connection; `enable` only lifts the refusal | restart the client (or wait for its retry: Socket.IO 1 s; MicroPython may already have reset); confirm with `status` |
| `DEVICE_OFFLINE` on every call | client not connected; or disabled (the command path only sees "offline") | `lua devices status --ci --device-name n` → `disabled` ⇒ `enable` + reconnect; `offline`/`registered` ⇒ start the client |
| `TIMEOUT` | handler slower than `timeoutMs` + 2 s, an **unregistered** command name, or a blocking MicroPython handler | raise `timeoutMs` (client list or `defineDevice`), return promptly, check the name is declared; add `retry` only for idempotent commands |
| `TOO_MANY_REQUESTS` | 100 commands awaiting replies | handlers must return or throw; never leave a promise pending |
| Tools vanished after ~a day | the self-describing **24 h command-list expiry** (`is_online` still answers) | reconnect daily (`disconnect()` + `connect()`; power-cycle a Pico) or move the commands into `defineDevice` |
| A command never shows up as a tool | name fails `^[a-z][a-z0-9_]{0,63}$`, schema > 4 KB, > 128 commands, or a same-name `defineDevice` vs client list conflict | rename/trim and reconnect |
| `lua devices list` shows nothing but the device is online | 3.44 `list` hides self-describing devices | `lua devices status --ci --device-name n` |
| `test-trigger` "worked" but no handler ran | 3.44 never runs a handler; or the trigger is unpublished / misspelt (logged as skipped) | ⏳ 3.45 `test-trigger`; publish with `lua push device-trigger --name n --auto-deploy` in the user's terminal; match the name exactly |
| Trigger handler ran but nothing reached WhatsApp | a handler's return value goes nowhere; the WhatsApp link uses the **live** agent version | send the message from the handler (or `startWorkflow`); push **and** promote what it relies on |
| `credential` → `needs an email sign-in` | signed in with an API key | user runs `lua auth configure` in their own terminal and picks Email |
| A Bash command writing a device script is blocked as `lua deploy` / `lua version promote` | the plugin's `confirm-deploy` hook reads `node -e` / `python -c` code and shell strings as text and fails closed on `lua` + a production verb | write client files with the Write/Edit tools; keep `lua <verb>` text out of inline scripts |

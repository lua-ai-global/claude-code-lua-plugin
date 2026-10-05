---
description: Connect hardware or a local machine to the agent as a device — choose self-describing vs defineDevice, issue a device credential safely (always to a git-ignored file), scaffold a Node / Python / Pico W client, push and go live, test commands and triggers, read device logs, troubleshoot. Wraps `lua devices <verb> --ci` (⏳ some verbs need lua-cli 3.45.0; 3.44 fallbacks built in).
---

You are `/lua-devices`. The user typed `/lua-devices $ARGUMENTS` (`[setup | list | status <name> | credential <name> | client <node|python|pico> <name> | push <device|device-trigger> <name> | test <name> <command> | test-trigger <name> <trigger> | logs | enable <name> | disable <name> | remove <name> | troubleshoot]`). Facts: `${CLAUDE_PLUGIN_ROOT}/lib/knowledge/devices.md` (all of it — the 3.44 vs ⏳ 3.45 action table, go-live rules, clients, limits, troubleshooting) and `${CLAUDE_PLUGIN_ROOT}/lib/knowledge/primitives.md` §9 (the `defineDevice` / `defineDeviceTrigger` shapes). lua-cli is a TypeScript SDK; device clients are Node, Python or MicroPython — never write Lua-language code.

**The secret rule this slash exists to keep:** a device credential never enters the conversation. `lua devices credential` always runs with `--out <file>` (the `block-device-secret` hook refuses it otherwise); you never `cat`, `source`, `head`, `grep`, `Read` or echo that file, never paste a secret into a source file, and never ask the user for one.

## Step 0 — preflight (no prompt)

1. `Bash(lua --version)` → remember `V`. **⏳ 3.45 path** when `V ≥ 3.45.0`; otherwise the **3.44 path** — every verb below names its fallback. Below 3.38.0, say `/lua-update` first and stop.
2. Every verb except `client` and `troubleshoot` needs a project: if `lua.skill.yaml` is missing, say "Run `/lua-init` first (devices belong to an agent)" and stop.
3. Auth: `Bash(lua models list --json --ci)` — exit 0/10 = fine; 9 = use the **Skill tool** with `skill: "lua-auth"`, then re-probe; 11 = API unreachable, stop with that line.
4. Permission rules — with the **Grep** tool (not Bash), look for the literal `Bash(lua push device *)` in `.claude/settings.json` and `.claude/settings.local.json`. Missing ⇒ the project's rules predate plugin 1.7.0: there `lua push device …` rides the old `lua push * --ci --force*` allow and would go **live with no prompt**, and the other device verbs have no rule at all. For any verb other than `list`, `status`, `logs`, `client` or `troubleshoot`, say "This project's permission rules predate 1.7.0 — re-run `/lua-doctor` (Step 5 merges the new device `ask` rows), then `/lua-devices` again" and stop.

## Step 1 — collect what is missing (single permission per §3.7)

Parse `$ARGUMENTS`. If the verb is missing or is `setup`, this is the guided path (Step 3). Whatever is still missing, AskUserQuestion **once**, every question in the same call, only what the chosen verb needs:

- "What do you want to do?" (options: `setup` (guided: credential → client → push → test), `status`, `list`, `credential`, `client`, `push`, `test`, `test-trigger`, `logs`, `enable`, `disable`, `remove`, `troubleshoot`)
- "Device name?" (free-text, `^[a-z][a-z0-9-]*$` if it will also have a `defineDevice`; the credential, the client and the declaration must use the **same** name)
- `setup` / `client` only: "Client?" (`node` — a Pi, laptop or server; `python`; `pico` — Raspberry Pi Pico W, MicroPython, no CDN) and "Where are the commands declared?" (`on the device` (self-describing — fastest, tools disappear while offline, 24 h list expiry), `defineDevice in this project` (versioned, tools stay while offline, group fan-out) — devices.md §2; recommend `defineDevice` for a fleet or anything reviewed in a PR, self-describing for a prototype or a Pico)
- `setup` / `credential` only: "Operations?" (multi: `commands`, `triggers`, `assets.upload` — default `commands,triggers`; `assets.upload` only for Node/Python `cdn.upload`)
- `setup` / `client` only: "First command and/or trigger?" (free-text, e.g. `read_temperature`, `led_on`; trigger `too_hot`) — command names `^[a-z][a-z0-9_]{0,63}$`
- `test` / `test-trigger` only: "Command (or trigger) name?" and "Payload JSON?" (default `{}`)
- `remove` only: no extra question — the `ask`-tier Bash prompt is the confirmation.

Never ask twice. Never ask for a secret, an API key or a Wi-Fi password.

## Step 2 — one verb (the Bash permission prompt IS the confirmation for anything that changes state)

Read verbs are in the permission template's `allow` tier; every verb that changes a device, issues a credential, sends a real command or fires a live handler is in `ask`, so Claude Code shows the user the exact command and waits — do **not** add an AskUserQuestion on top. (No `.claude/settings.json` rules yet → say so, point at `/lua-doctor`.) Always spell the action and pass `--ci` right after it.

- **list** → `Bash(lua devices list --ci [--group <g>])`. 3.44: `list` shows only `defineDevice` declarations — say so and also run `status` for any self-describing device the user names.
- **status** → `Bash(lua devices status --ci --device-name <n>)`.
- **credential** (⏳ 3.45) →
  1. Make sure the out file is ignored — with the **Grep/Read** tools, not Bash (a `git` call would be a second prompt): if `.gitignore` has no line that is exactly `.env.device` (or a pattern covering it such as `.env*`), append `.env.device` with the **Edit/Write tool** (create the file if absent). No `.git` directory → also say the file must never be committed.
  2. `Bash(lua devices credential --ci --device-name <n> --operations <ops> --out .env.device)` — a second device gets its own file (`.env.device.<n>`, ignored the same way). Add `--force` only when the user said to replace an existing file; an existing file is exit 2 — relay it.
  3. Report the path, the credential id the CLI printed, and "the secret is in the file (mode 600) and was not shown here". `needs an email sign-in` → the user runs `lua auth configure` in **their own terminal** and picks Email (`/lua-auth`); never run it.
  - 3.44 path: `credential` does not exist. Say so, and that the device can only connect with a legacy `api_` + 32 hex key the user already holds, which **they** put into `.env.device` as `LUA_DEVICE_CREDENTIAL=…` (with `LUA_AGENT_ID` from `lua.skill.yaml` and `LUA_DEVICE_NAME`) — or install 3.45.0 when it is published (`/lua-update`). A scoped personal key will not work (`AUTH_FAILED`).
- **client** → Step 3b only.
- **push** (live on the next turn — devices.md §5):
  - `device` → `Bash(lua push device --ci --force --name <n>)`. Say: the declaration is live on the agent's next turn, published or not; devices are **not** in agent versions, so `/lua-deploy` and `lua version promote` neither ship nor roll it back (roll back = push the previous code).
  - `device-trigger` → `Bash(lua push device-trigger --ci --force --name <n>)` creates a version that **does not run yet**. Publishing needs `--auto-deploy`, which this plugin never runs: print, for the user's **own terminal**, `lua push device-trigger --name <n> --auto-deploy`, and say that until they run it a fired trigger is logged as skipped.
  - No declaration yet → "Scaffold it first with `/lua-new device <n>` or `/lua-new device-trigger <n>`" and stop.
- **test** → ⏳ 3.45: `Bash(lua devices test --ci --device-name <n> --command <c> --payload '<json>' [--timeout <ms>])`. 3.44 path: `test` cannot take a command name under `--ci` (it prompts, exit 1) — use `/lua-chat` instead ("Call device__<n_with_underscores>__<c> with <json> and show the raw result"); hyphens in the device name become underscores in the tool name.
- **test-trigger** → ⏳ 3.45: `Bash(lua devices test-trigger --ci --device-name <n> --trigger <t> --payload '<json>')`, then the **logs** verb. 3.44 path: it prompts and never runs a handler — fire the trigger from the client instead, then read the logs.
- **logs** → `Bash(lua logs --ci --json --type device-trigger --limit 20)` for handler runs and `Bash(lua logs --ci --json --type device --limit 20)` for command traffic (add ⏳ `--since 15m` on lua-cli 3.38.0 or later). A `skipped` entry = no live handler matched the name.
- **enable** → `Bash(lua devices enable --ci --device-name <n>)`, then: the device stays **offline until its client reconnects** — restart it if it does not retry; confirm with `status`.
- **disable** → `Bash(lua devices disable --ci --device-name <n>)` — the platform drops the connection and refuses it until `enable`.
- **remove** → `Bash(lua devices remove --ci --device-name <n> --force)`. ⏳ 3.45 refuses an unknown name (exit 3) and warns that a still-connected device reappears on reconnect — suggest `disable` to keep it out. 3.44 deletes only a `defineDevice` declaration.
- **troubleshoot** → ask nothing new; run `status` for the named device, then match the user's error text against devices.md §10 and give the one fix that applies.

## Step 3 — `setup` (guided) and `client`

**3a. Plan, in one short message**: the chosen declaration style and why; the device name; the operations; which steps need ⏳ 3.45.

**3b. Write the client** with the **Write tool** only — never a heredoc, `node -e` or `python -c` (inline code that mentions `lua` plus a deploy verb trips the `confirm-deploy` hook, and Write keeps the files reviewable). Everything goes under `device/` at the project root; it is not part of the agent bundle (the compiler only follows imports from `src/index.ts`). The client reads the credential from the git-ignored env file at run time; no secret is ever written by you.

- `node` → `device/package.json` (`{ "type": "module", "private": true, "dependencies": { "@lua-ai-global/device-client": "^1.1.0", "dotenv": "^16.4.0" } }`) and `device/device.mjs` (`.mjs`: the `lua init` template git-ignores `*.js`):
  `import 'dotenv/config'` is wrong here (it reads `.env`); use `import dotenv from 'dotenv'; dotenv.config({ path: process.env.LUA_DEVICE_ENV ?? '../.env.device' });` then `new DeviceClient({ agentId: process.env.LUA_AGENT_ID, deviceName: process.env.LUA_DEVICE_NAME, deviceCredential: process.env.LUA_DEVICE_CREDENTIAL, transport: 'socketio', commands: [...] })` — omit `commands` for a `defineDevice` device — one `onCommand(name, async (payload) => result)` per command, `device.on('error', …)` that logs `err.code` (a server close such as `DEVICE_DISABLED` retries every second forever), `await device.connect()`, and a trigger call where the user named one. Run: `cd device && npm install && node device.mjs`.
- `python` → `device/requirements.txt` (`lua-device-client>=1.3.0`, `python-dotenv>=1.0`) and `device/device.py`: `load_dotenv(os.environ.get("LUA_DEVICE_ENV", "../.env.device"))`, `DeviceClient(agent_id=…, api_key=os.environ["LUA_DEVICE_CREDENTIAL"], device_name=…, commands=[DeviceCommandDefinition(...)])` (1.3.0 has no `device_credential` field), async `on_command` handlers, `await client.connect()`, `await asyncio.Event().wait()`. Run: `cd device && pip install -r requirements.txt && python device.py`.
- `pico` → `device/main.py` and `device/wifi.example.py`. `main.py` parses `device.env` on the board (lines `KEY=value`; strip one pair of surrounding `"`), imports `WIFI_SSID` / `WIFI_PASSWORD` from `wifi.py`, builds `LuaDevice(agent_id=…, api_key=…, device_name=…, wifi_ssid=…, wifi_password=…)`, registers `@device.command(...)` handlers (synchronous; keep them short — they block heartbeats), calls `device.trigger(...)` where asked, then `device.run()`. Add `device/wifi.py` and `device/device.env` to `.gitignore` with the Edit tool. Print, for the user's terminal (they hold the board): `pip install lua-device-client mpremote`, `python3 -c "import lua_device, os; print(os.path.join(os.path.dirname(lua_device.__file__), 'micropython.py'))"`, `mpremote cp <printed path> :lua_device.py`, `cp device/wifi.example.py device/wifi.py` (then **they** type the Wi-Fi password into it), `mpremote cp .env.device :device.env`, `mpremote cp device/wifi.py :wifi.py`, `mpremote cp device/main.py :main.py`, `mpremote run main.py`. Expected log ends `Connected as <name>` and `Listening for commands...`; `MQTT CONNACK error: rc=5` = secret / agent / name mismatch. A Pico connected over 24 h loses its self-describing tools — power-cycle daily or loop `disconnect()`/`connect()` yourself.

For a `defineDevice` device or a standalone trigger handler, the agent side is a separate primitive: tell the user to run `/lua-new device <n>` (commands, `timeoutMs`, `retry`, `group`, inline `triggers`) or `/lua-new device-trigger <t>` (handler: `env()` is empty inside it, so keep the agent id in the file; key side effects on `trigger.triggerId` — delivery is at least once). Do not scaffold those here.

**3c. Next steps, in order** (one block, nothing run on the user's behalf): credential (`/lua-devices credential <n>`) → start the client → `/lua-devices status <n>` → for `defineDevice` `/lua-devices push device <n>`; for a standalone handler `/lua-devices push device-trigger <t>` then the printed `--auto-deploy` line in their terminal → `/lua-devices test <n> <command>` / `/lua-devices test-trigger <n> <trigger>` → `/lua-devices logs`. If the flow ends in a channel such as WhatsApp: that link talks to the agent's **live** version, so anything a skill, persona or workflow adds must go through `/lua-deploy` first, and a trigger handler's return value is not delivered anywhere on its own.

## Step 4 — present

Quote the CLI's result line (`🟢 Device 'n' is online`, `Response received (123ms):` + JSON, `Trigger 't' queued (id …)`, `saved to .env.device (id …)`). On a failure, map it through devices.md §10 and name exactly one next action. Exit codes: 0 ok · 1 error, or a prompt reached under `--ci` (on 3.44 that is `test` / `test-trigger` — use the fallback, do not retry) · 2 usage (unknown action — e.g. `credential` on 3.44 — or an existing `--out` file) · 3 not found · 9 auth · 11 API unreachable.

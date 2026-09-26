# Running in the Lua Job tier (headless)

This page is for the people who run `lua-agent-builder` **unattended**: inside `claude -p` on a Lua workflow Job step, or in any CI-style harness where no one answers a prompt. It covers what changes when the plugin knows it is headless, what still works, and where the real security boundary sits. It applies from plugin **1.6.0**.

> lua-cli is a TypeScript SDK/CLI; it is unrelated to the Lua programming language.

## 1. Turn on headless mode

Set **`LUA_PLUGIN_HEADLESS=1`** in the environment of the `claude` process. `true`, `yes` and `on` are accepted too.

With it set, the hooks behave as follows:

| Hook | Interactive (default) | Headless |
|---|---|---|
| `check-lua-auth` (SessionStart) | A failed probe says "not authenticated … run `/lua-auth`" | One neutral note: authentication *could not be confirmed*, behind a Lua-API proxy that often means only that the probe route is refused, carry on. It names no slash command. |
| `check-lua-version` (SessionStart) | Points at `/lua-doctor` / `/lua-update` / `npm i -g` | The same finding with no fix-it instruction. The image owns the lua-cli version, not the run. |
| `detect-project` (SessionStart) | "… Run /lua-doctor or /lua-test to begin." | "✓ Lua agent project detected: `<agentId>`." |
| `confirm-deploy` (PreToolUse) | Bare production verbs are blocked. `LUA_DEPLOY_CONFIRMED=1 lua …` is allowed. | **Every** production verb is blocked, prefixed or not (`DEPLOY_DENIED_HEADLESS`). The prefix means "a person confirmed this deploy"; headless, the model would be confirming to itself. |
| `block-auto-deploy` (PreToolUse) | Blocks `--auto-deploy`, points at `/lua-deploy` | Blocks it, and tells the model to push without the flag |
| `post-deploy-smoke` (PostToolUse) | Sends a production `lua chat` ping after a deploy | Never runs. A headless deploy should be impossible, and more production traffic is the wrong response if one happens. |

Nothing that is blocked interactively is allowed headless. The only differences are wording, the void prefix, and the skipped smoke ping.

## 2. Load the plugin, and pass MCP servers explicitly

```bash
LUA_PLUGIN_HEADLESS=1 LUA_TELEMETRY=false \
claude -p "$STEP_PROMPT" \
  --plugin-dir /opt/claude-code-lua-plugin/plugins/lua-agent-builder \
  --setting-sources '' \
  --strict-mcp-config \
  --mcp-config "$MCP_CONFIG_JSON" \
  --settings "$INLINE_SETTINGS_JSON" \
  --disallowedTools Agent
```

- **`--strict-mcp-config` drops the plugin's own `.mcp.json`.** Skills, subagent files and hooks still load, but `lua-platform` and `lua-docs` do not. If you want them, pass them in `--mcp-config`:

  ```json
  {
    "mcpServers": {
      "lua-docs": { "type": "http", "url": "https://docs.heylua.ai/mcp" },
      "lua-platform": {
        "command": "node",
        "args": ["/opt/claude-code-lua-plugin/plugins/lua-agent-builder/mcp/lua-platform/dist/server.js"]
      }
    }
  }
  ```

  Tool names then follow the plain spelling (`mcp__lua-platform__get_agent`), not the `mcp__plugin_lua-agent-builder_…` one.
- **`lua-platform` is self-contained since 1.6.0.** `dist/server.js` bundles `@modelcontextprotocol/sdk` and every other dependency, so baking the plugin into an image needs no `npm ci`. Up to 1.5.0 it failed with `ERR_MODULE_NOT_FOUND` (seen as `lua-platform CONNECTION_CLOSED`). `mcp/lua-platform/tests/standalone-bundle.test.mjs` keeps it that way.
  - It honours `LUA_API_URL` and `LUA_API_KEY`, so behind a proxy it needs no real credential.
  - `list_agents` / `get_agent` shell out to `lua agents --json --ci`. The other three tools are GET-only.
  - It is optional: every reference to its tools has a `lua status` / `lua logs` fallback.
  - A harness that can only emit `{type: "http"}` servers cannot pass it. Leave it out rather than work around that.
- **`--setting-sources ''`** keeps the user and project `~/.claude` agents, skills and settings out of the run.
- `LUA_TELEMETRY=false` stops lua-cli's PostHog calls. lua-cli's npm-registry version check (3 s, silent on failure) still runs on every command.

## 3. The Agent tool is denied: run the playbooks inline

The Job-tier harness denies the `Agent` tool. Every slash command that hands work to a subagent cannot complete headless: `/lua-new`, `/lua-qa`, `/lua-deploy`, `/lua-architect`, and the `/lua-test` → `lua-debug` failure hand-off.

The subagent files are plain Markdown playbooks. Point the step prompt at them as instructions for the main model:

| Need | Read inline |
|---|---|
| Scaffold, register, compile and test one primitive | `${CLAUDE_PLUGIN_ROOT}/agents/lua-skill-builder.md` |
| Diagnose a failing `lua compile --ci` / `lua test --ci` / `lua push` | `${CLAUDE_PLUGIN_ROOT}/agents/lua-debug.md` |
| A conversational QA pass with a triage report | `${CLAUDE_PLUGIN_ROOT}/agents/lua-qa.md`. Its sandbox chats run real tools against the agent's live Data and connections, so use read-only cases only. |

`lua-deploy-pilot.md` has no headless use, because nothing goes live from a headless run.

`AskUserQuestion` is refused in `-p` mode. The slash commands built around it do not work headless: `/lua-auth`, `/lua-doctor`, `/lua-update`, `/lua-init`, `/lua-sync`, `/lua-template`, `/lua-env`, `/lua-drains`, `/lua-logs` without arguments, and `/lua-version create` without a message.

The following work inline with their arguments given up front:
- `lua push <type> --ci --force`;
- `lua test --ci <type> …` with the input JSON in the prompt;
- `lua chat --ci -e sandbox -m "<text>" -t <thread>`;
- `lua workflows run` (offline);
- `lua version list|show|diff`;
- `lua version create --ci -m "<message>"`.

## 4. The proxy is the boundary. Hooks are belts.

`confirm-deploy` got much harder to slip past in 1.6.0.
- It lexes the whole command and finds a production verb:
  - anywhere in a `&&` / `;` / `||` / pipe chain;
  - in a `( )` or `{ }` group;
  - in `$( )`, backticks or `<( )`;
  - in a string run by `bash -c` / `eval` / `ssh` / `… | sh`, or in a heredoc fed to a shell;
  - behind `FOO=1` prefixes, `sudo` / `env` / `timeout`, `npx lua`, `npx lua-cli`, `pnpm exec lua` or `node …/lua-cli/…`, and at a binary path.
- A shell variable in the binary or verb position is blocked.
- The confirmation prefix counts only as the first word of the exact simple command that runs the verb.

It is still a **belt**:
- A turn that can run a shell can always build a command the classifier cannot see: `echo <base64> | base64 -d | sh`, a script file written first, an `npm run` script, a `node` program that assembles the string, or a raw HTTP call.
- The Job tier also runs in `bypassPermissions` (the coding turn needs a shell), where permission **allow** rules have no effect.

So:

1. **The Lua-API proxy decides what reaches production.** It must refuse:
   - deploy, promote and activate routes;
   - workflow and job version bodies with `activate: true`;
   - the live `PATCH …/sub-agent` and MCP upserts that `lua push all` issues.

   It must also pin the credential to the target agent.
2. **Inline `--settings` should carry deny rows, not the plugin's permission template.** Deny rows still apply under `bypassPermissions`. The template's allow list admits the `LUA_DEPLOY_CONFIRMED=1` forms, which is right for a person and wrong for a headless run. Suggested rows:

   ```
   Bash(*lua deploy*)          Bash(*lua * deploy*)        Bash(*version promote*)
   Bash(*workflows deploy*)    Bash(*workflows activate*)  Bash(*mcp activate*)
   Bash(*publish*)             Bash(*--auto-deploy*)       Bash(*--auto-push*)
   Bash(*LUA_DEPLOY_CONFIRMED*) Bash(*lua push agent*)     Bash(*lua env*)
   Bash(*lua auth*)            Bash(*npm install -g*)
   ```

3. **Allow `GET /agents/self-serve/models` through the proxy.** It is the `check-lua-auth` probe (`lua models list --json --ci`). If the proxy refuses it, the headless hook emits its neutral note and the run carries on, but the note is noise.
   - Do not disable hooks with `--settings '{"disableAllHooks": true}'` to silence it. That also removes the `confirm-deploy` belt.

## 5. Environment hygiene

`lua chat -e sandbox` uploads the invoking process's **entire environment** as the sandbox skill version's `env` (see [SECURITY.md](../plugins/lua-agent-builder/SECURITY.md), "Known platform-side exposure"). Keep the `claude` child environment minimal: the proxy URL, the proxy-scoped key, `PATH`, `HOME`, `LUA_PLUGIN_HEADLESS` and `LUA_TELEMETRY`. Nothing else.

## 6. Checklist

- [ ] `LUA_PLUGIN_HEADLESS=1` and `LUA_TELEMETRY=false` are set on the `claude` process.
- [ ] The plugin is baked from this repository's `plugins/lua-agent-builder` at a pinned commit (1.6.0 or later), with no `npm ci` needed.
- [ ] `--strict-mcp-config` is set, plus `--mcp-config` for whichever of `lua-docs` / `lua-platform` you want.
- [ ] `--disallowedTools Agent` is set, and the step prompts point at `agents/*.md` as inline playbooks.
- [ ] Inline `--settings` carries the deny rows above.
- [ ] The proxy refuses every go-live route and body, allows `GET /agents/self-serve/models`, and pins the target agent.
- [ ] The child environment is scrubbed.

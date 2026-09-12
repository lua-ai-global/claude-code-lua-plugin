---
description: Show the full state of the current Lua project — auth, CLI version/updates, agent, per-primitive local-vs-deployed sync, persona and backup status, warnings. Wraps `lua status --json --ci` (read-only, no prompt).
---

You are `/lua-status`. The user wants to know where things stand.

## Step 1 — run

`Bash(lua status --json --ci)`. It degrades gracefully outside a project or when unauthenticated, so always run it. Exit `9` → not authenticated (offer `/lua-auth`); `11` → the Lua API is unreachable.

## Step 2 — present (no AskUserQuestion needed)

The one-line JSON has these top-level keys (lua-cli 3.33.0): `environment` (`cliVersion`, `nodeVersion`, `apiBase`, `configDir`, `envOverrides`), `updates` (`current`, `latest`, `available`), `auth` (`authenticated`, `source` = `environment` | `stored` | `renewable session`, `credentialClass?`, `email`, `organizations[] { id, name }`, `serverReachable`), `project` (`inProject`, `rootDir`, `agentId`, `agentName`, `manifest { found, primitiveCount }`), `primitives[]` (`kind`, `displayName`, `local[] { name, version }`, `server[] { name, activeVersion, active }`, `diffs[] { name, localVersion, serverVersion, status: synced | ahead | behind | not deployed }`, `orphans[] { name, cleanupCommand, critical }`), `persona { status: synced | drift | unknown }`, `backup { status: synced | out-of-sync | unknown | never-compiled }`, `telemetry`, `warnings[]`, `hints[] { command, reason }`.

Render:

1. One line: CLI version (+ "update available → /lua-update" if `updates.available`), auth source and email, reachability.
2. Project: agent name/id, org, compiled primitive count (or "not a Lua project — run /lua-init").
3. A table per primitive kind with name · local version · server active version · status. Call out `behind` (server newer → `/lua-sync` pull), `ahead` / `not deployed` (→ `/lua-push` then `/lua-deploy`), and orphans with their `cleanupCommand` (critical ones first).
4. Persona and backup status lines.
5. `warnings[]` verbatim and `hints[]` as "Try: `<command>` — <reason>".

For what is live on any agent (not just this project) the `mcp__plugin_lua-agent-builder_lua-platform__get_deployment_status` tool gives the same picture from the server side.

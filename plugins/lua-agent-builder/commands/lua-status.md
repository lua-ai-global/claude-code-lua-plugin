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

## Workflow runs are not in `lua status`

`lua status` reports primitives, not runs. When the user asks about a run, hand off to `/lua-workflow status <runId>` (`lua workflows status <runId> --steps --json`) and read it as follows: `status: 'gated'` with `gate.kind: 'start-consent'` = waiting for a person's consent (cleared from the desktop; ⏳ lua-cli 3.36.0 or later exits 6 under `--strict`, older CLIs exit 0 — never read 0 as "still running" there); `gate.kind: 'model_policy'` (⏳) = a step's model class cannot be resolved under the org policy — `lua workflows clear-gate <runId> --kind model_policy`; `gate.kind: 'budget' | 'billing' | 'exception'` = `raise-budget` / top-up / `retry-step` or `resolve-step` — for a budget park read `budget.unit` (and `usage.engine`) before you name a number: the cap is in **credits** on a legacy plan and **actions** on a seat plan, and `lua workflows raise-budget <runId> --credits <n>` takes `<n>` in that unit even though the flag is always spelled `--credits`; `budget.exceeded: true` means the run went past its cap and finished anyway rather than parking; a `consent.via: 'autonomy'` stamp (⏳, printed as `Consent:  auto (policy) — ≤ …`) = the organization's autonomy envelope admitted the start and nobody was asked; a step's `suspend.approverFallback` (`⇅ approver escalated <from> → <to>`) = the approval went to the org admins because the initiator was excluded.

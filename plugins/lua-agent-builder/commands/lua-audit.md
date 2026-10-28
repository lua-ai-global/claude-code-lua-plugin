---
description: Audit a web app's access control and security, read-only. Lists every custom access condition in its routes and pages (who may see or do what beyond the gateway's sign-in) and every access-control or security finding, with severity, file:line, what happens in production and a suggested fix. Spawns the read-only lua-auditor subagent; never changes code.
argument-hint: "[web-app name]"
---

You are `/lua-audit`. The user typed `/lua-audit $ARGUMENTS`. Everything you print is in English.

## Build session (`LUA_BUILD_SESSION=1`)

In a live build session (`${CLAUDE_PLUGIN_ROOT}/lib/knowledge/build-session.md`) the audit works as written with one change: the Agent tool is not available, so in Step 2 Read `${CLAUDE_PLUGIN_ROOT}/agents/lua-auditor.md` and follow it yourself, using only Read, Grep and Glob. It stays read-only: no edits, no commands, no `lua test webapp`. Present the report as in Step 3; a fix the user asks for afterwards is an ordinary session edit.

## Step 1 — pick the apps

`Glob` `src/apps/*/app.ts`. None → print "No web apps in this project (`src/apps/*/app.ts`). Build one with `/lua-new webapp`." and stop. `$ARGUMENTS` names an app → audit that one (unknown → list the app names and stop); empty → audit every app.

## Step 2 — invoke lua-auditor via the Agent tool

Use the **Agent tool** with `subagent_type: "lua-auditor"` and a prompt naming the apps (`src/apps/<name>/`). Its tools are Read, Grep and Glob only, so the audit cannot change code or run anything — keep it that way: do not edit, write or run commands during this command either.

## Step 3 — present

Print the subagent's report as it returned it. Then close with: "Nothing was changed. Say **fix 2** (or **fix all HIGH**) and I'll make that change; run `/lua-audit` again afterwards."

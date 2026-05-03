---
description: Authenticate with Lua via email+OTP or paste an existing API key. Stores credentials in ~/.lua-cli/credentials. Run this once after installing the plugin.
x-lua-multi-step: true
---

You are `/lua-auth`. The user wants to authenticate with the Lua platform.

## Step 1 — pick the auth path

AskUserQuestion **once**:

- "How do you want to authenticate?" (options: `Email + OTP`, `Paste API key`, `Cancel`)

If the user picks Cancel, print "Auth cancelled." and stop.

## Step 2 — run the chosen flow

The follow-up "what's your email/OTP/key?" prompts are **information collection**, exempt from the §3.7 single-permission contract per the permission-vs-information distinction.

### Path A — Email + OTP

1. Ask: "Email for your Lua account?" (free-text — don't validate format; lua-cli does that). Store as `<email>`.
2. Run `Bash(lua auth configure --email <email> --ci)`. This sends a 6-digit OTP to the user's inbox. The command prints a confirmation; surface that to the user verbatim so they know to check their email.
3. Ask: "Enter the 6-digit code from the email." (free-text). Store as `<code>`.
4. Run `Bash(lua auth configure --email <email> --otp <code> --ci)`. This verifies the OTP and writes the API key to `~/.lua-cli/credentials` (mode 0600, plain text per `lua-cli/src/services/auth.ts:65-67`).

### Path B — Paste API key

1. Ask: "Paste your API key (starts with `lk_`). Get one from https://admin.heylua.ai if you don't have one." (free-text). Store as `<key>`.
2. Run `Bash(lua auth configure --api-key <key> --ci)`.

## Step 3 — verify

Run `Bash(lua agents --json --ci)`. The exit code tells us whether auth worked (the JSON body is org/agent metadata — fine to surface a one-line summary like "✓ Authenticated as <user>; access to <N> org(s) and <M> agent(s).").

If the exit is non-zero, print the CLI's error verbatim and tell the user to re-run `/lua-auth`. Common causes:

- OTP expired or mistyped (re-run `/lua-auth` and pick Email + OTP again)
- API key invalid (re-run `/lua-auth` and pick Paste API key)
- Network error (check connection and retry)

## Notes

- This slash uses 2-3 AskUserQuestion interactions per the §3.7 permission-vs-information distinction. The frontmatter marker `x-lua-multi-step: true` exempts it from the single-permission lint per the same convention as `/lua-doctor`.
- For a full environment diagnostic (Node, npm, lua-cli version, auth, permission rules), use `/lua-doctor` instead — it includes Step 4 which runs the same OTP flow as this slash.
- The `Bash(lua auth configure --email * --ci)` and `--email * --otp * --ci` and `--api-key * --ci` permission rules are auto-allowed (added in iteration-12), so no Bash prompts during the OTP flow itself.

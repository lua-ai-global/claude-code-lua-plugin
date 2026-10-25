# Browser reference (⏳ requires lua-cli 3.49.0 or later; saved logins 3.57.0, files and page scripts 3.58.0)

Read from the lua-cli source and its shipped docs, not from memory: `src/api-exports.ts` (the `Browser` global and `Secrets.request`), `src/types/browser.ts` (`LuaBrowser` / `defineBrowser`), `src/types/skill.ts` (`BrowserSwitchConfig`, `LuaAgentConfig.browser` / `browsers`), `src/cli/command-definitions.ts` (the `browser` and `browsers` declarations), `src/commands/browser.ts`, `src/commands/browsers.ts`, `src/primitives/browser.handler.ts`, `src/compiler/plugins/browser.plugin.ts`, `src/utils/aliases.ts` (`browsers.action`, `push.type`), and `@lua/shared-types` `browser-dispatch.types.ts` / `browser-logins.types.ts` / `browser-files.types.ts` / `browser-log.types.ts`. Verified against **lua-cli 3.58.0**.

**⏳ Everything in this file needs lua-cli 3.49.0 or later.** Below it `Browser.read` / `Browser.execute`, `LuaBrowser`, `lua browser`, `lua browsers`, `lua push browser` and `lua logs --type browser` do not exist. Saved logins (`Browser.login`, `Browser.allowJobLogin`, `Browser.revokeJobLogin`, `Secrets.request({ kind: 'browser-login' })`, `lua browser run --login`) need **3.57.0**; files and page scripts (`Browser.download`, `Browser.pdf`, `Browser.upload`, `Browser.eval`, and the `maxDownloadMb`, `allowedMimeTypes`, `allowScripts` settings) need **3.58.0**. On an older CLI the typings lack those members and `tsc` rejects them.

lua-cli is a TypeScript toolchain. It has nothing to do with the Lua programming language.

---

## 1. What the browser is, and which way in

`Browser` drives a real Chrome browser from agent code. It is for pages that only render after JavaScript runs — single-page apps, price and stock widgets, dashboards — where `fetch` returns an empty shell. It works in tools, jobs, webhooks, triggers, device triggers, pre- and post-processors, web routes and workflow code steps; **not** in tool `condition`s, model resolvers or MCP server resolvers (`BROWSER_UNAVAILABLE`).

Start at the top and only move down when the row above cannot do the job — a session costs money and time, and a model step costs more:

| Reach for | When | Costs |
|---|---|---|
| `Browser.read(url, options?)` | one page, URL known | one short session, no model calls |
| the step-by-step commands | you know the clicks (open, fill, click, read) | one session for as long as you hold it, no model calls |
| `Browser.execute({ task })` | you can describe the outcome but not the clicks, or the page changes often | a session plus **a model call per step** |
| `lua browser read` / `lua browser run` | trying a page or a task before writing code | the same, on the `dev` log channel |

`searchWeb` is always on and is not part of this: the browser is opt-in because a session costs money and acts on real sites.

## 2. Turning it on

Two forms on `LuaAgentConfig`, both pushed with `lua push agent`:

```ts
browser?: boolean | BrowserSwitchConfig;   // true = the defaults; the object adds policy
browsers?: LuaBrowser[];                   // named browsers, selected per call with `browser: '<name>'`
```

Attaching at least one `LuaBrowser` turns the browser on, so `browser: true` is not needed as well. A call with no `browser` name uses the agent's `browser` settings when it sets `browser`, and otherwise the **first** entry in `browsers`. **Settings never merge**: the browser you name supplies every setting, and the agent's `browser` does not fill in its gaps.

```ts src/browsers/supplier.ts
import { defineBrowser } from 'lua-cli';           // identical to `new LuaBrowser({...})`

export const supplierPortal = defineBrowser({
  name: 'supplier-portal',                          // ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ — the constructor throws otherwise
  description: 'Checks stock and places restock orders on the supplier site',
  allowedDomains: ['supplier.example.com', '*.supplier-cdn.example.com'],
  confirmActions: ['submit'],
  fallback: 'none',
  maxSessionMinutes: 30,
});
```

| Setting | Default | What it does |
|---|---|---|
| `engine` | `'auto'` | `'auto'` the person's desktop browser when online, else the Lua cloud browser · `'agent-browser'` those two and never Browser-Use · `'browser-use'` Browser-Use only (`Browser.read` then fails `unsupported` and every step-by-step command except `close` errors with `BROWSER_STEPWISE_UNSUPPORTED`) |
| `fallback` | `'browser-use'` | what happens when the cloud browser cannot get past a page: retry that command once on Browser-Use, or `'none'` to stay. **Never used** when `engine` is `'agent-browser'` or `allowedDomains` is set |
| `proxyCountry` | — | two-letter country code for Browser-Use's proxy; applies only to work that runs there |
| `allowedDomains` | all public sites | hosts the browser may open, wildcards allowed (`*.ikea.com`). Checked before **every** command that opens a URL; on the cloud browser also on redirects and on everything a page loads, so include the hosts a page pulls its content from. A blocked URL is `BROWSER_DOMAIN_NOT_ALLOWED`. Setting it switches the Browser-Use fallback off |
| `confirmActions` | — | actions a person must approve: `navigate`, `click`, `fill`, `type`, `select`, `press`, `scroll`, `submit`, and for the step-by-step commands `download`, `upload`, `pdf`, `eval`. `submit` covers clicking Buy, Pay, Place order, Sign in or Send, and pressing Enter (§6) |
| `logContent` | `'summary'` | how much page content the log rows keep: `'summary'` titles and sizes · `'full'` also page text (shortened) · `'none'` neither |
| `screenshots` | `'onError'` | when a log row carries a screenshot reference (`'always'` / `'never'`). On the cloud browser a screenshot comes back in the result and is not stored, so its rows carry no reference |
| `maxSessionMinutes` | 10 | cloud session length, maximum 60 |
| `idleTimeoutSeconds` | 120 | cloud session idle timeout, maximum 900 |
| `maxConcurrentSessions` | 3 | cloud sessions this agent may hold at once **for one person**; `lua compile` accepts 1 to 100, the platform allows at most 10 and a plan may allow fewer, so the lowest applies. One too many is `BROWSER_SESSION_LIMIT` |
| ⏳ `maxDownloadMb` | off | turns on `download`, `pdf` and `upload` and caps each file, 1 to 500 MB, lowered to the plan's per-file limit. Unset, those three fail `files_disabled` (§8) |
| ⏳ `allowedMimeTypes` | any | the types a download may have (`['application/pdf', 'image/*']`, at most 50), read from the file's own **bytes**, not from what the site claims; another type is `mime` |
| ⏳ `allowScripts` | `false` | lets your own code run page scripts with `Browser.eval`; needs an `allowedDomains` list naming at least one real domain (§9) |
| `persist`, `credentials` | — | accepted and stored, **not enforced yet**. To sign a browser in, use a saved login (§5) |

On the agent's `browser` option a `maxSessionMinutes` / `idleTimeoutSeconds` over the maximum is cut to it when the session opens; on a `LuaBrowser` the same value fails `lua compile`. `lua compile` (and `lua push`, which compiles first) refuses a bad `name`, an unknown `engine` / `fallback` / `screenshots` / `logContent`, a `proxyCountry` that is not two letters, a limit that is not a whole number in range, a `maxDownloadMb` outside 1–500, more than 50 `allowedMimeTypes` or an entry that is not a MIME type, `allowScripts: true` with no real domain (a hostname with a public suffix, wildcard included — a single word or an IP address does not count), two browsers with the same name, and an entry in `browsers` that is not a `LuaBrowser`. Pass the config as an object literal: the compiler reads it from the source.

A browser is **not versioned**. `lua push browser --name <n>` upserts the record by name (so the new settings are what the next session of an already-linked browser uses) and `lua push agent` links the agent's `browsers` list; `lua push all` does both. Nothing here is part of an agent version, so `lua version promote` neither ships nor rolls back a browser — roll back by pushing the previous settings.

## 3. Where pages open

Jobs, webhooks, triggers, web routes and workflow steps have no person at a desktop, so they always run on the **Lua cloud browser**: a fresh Chrome with no cookies or logins, deleted when the session closes. In a chat turn with the Lua desktop app connected, `engine: 'auto'` uses the **person's own desktop browser**, with their own logins.

When the desktop browser does not answer as a session opens, `Browser.read` and the commands that open a page continue on the cloud browser and write a `fallback` row; when it stops answering later, the call fails `session_lost`. When the cloud browser cannot get past a page (captcha, bot block, empty page) and `fallback` is `'browser-use'`, the opening commands (`session_open`, `navigate`, `snapshot`, including the ones `Browser.execute` runs) are retried once on Browser-Use, the session stays there and a `fallback` row is written; the result then reports `engine: 'cloud'`. `Browser.read` never moves to Browser-Use — it returns the page it got, with `blocked: true`.

## 4. `Browser.read` — one page

```ts
Browser.read(url: string, options?: {
  waitFor?: 'load' | 'networkidle' | string;   // string = a CSS selector to wait for
  selector?: string;                            // default 'body'
  format?: 'text' | 'html';                     // default 'text'
  timeoutMs?: number;                           // default 60000, raised to 1000, cut to 100000
  sessionKey?: string;                          // a label in the logs; every read still gets a new session
  browser?: string;                             // a named browser
  credential?: string;                          // ⏳ 3.57.0 — sign in with a saved login first (§5)
}): Promise<BrowserReadResult>
```

Opens a new session, waits, reads, and closes the session whether it succeeded or not. Returns `url`, `finalUrl`, `title`, `content` (≤ 100,000 characters), `format`, `truncated`, `status`, `matches`, and on a wall `blocked: true` with `blocker: 'login_required' | 'bot_wall'`, `blockerKind: 'login' | 'captcha' | 'bot-block' | 'empty-content'` and a written-for-the-person `blockerGuidance`. On the cloud browser with `format: 'text'` every match of `selector` is read in page order (up to 200, joined by a blank line); `format: 'html'` and the desktop browser read the first match.

**`read` throws** (`name: 'BrowserError'`, a typed `code`, and `status` on `http_error`) — the only `Browser` method that does. A 404 page that still has a body comes back as a result with `status: 404`, so check `status` before trusting `content`; an error page with nothing to read throws `http_error`. Check `page.blocked` before using `content`: a sign-in form is content too.

## 5. `Browser.execute` — a task in plain words

```ts
Browser.execute(input: {
  task: string;                   // required; ≤ 20,000 chars
  startUrl?: string;              // unless allowedDomains/allowAnyDomain say otherwise, the run stays on this domain
  schema?: object;                // a JSON Schema the output must match
  maxSteps?: number;              // default 25, 1 to 60
  maxCostUsd?: number;            // default 1, at most 10
  timeoutMs?: number;             // default 300000 (5 min), at most 900000 (15 min)
  model?: string;                 // a model code; unavailable to the agent → MODEL_NOT_AVAILABLE
  sessionKey?: string;            // run in an existing session (and leave it open)
  allowedDomains?: string[];      // intersected with the agent's list
  allowAnyDomain?: boolean;       // leave the startUrl domain
  browser?: string;
  credentials?: string[];         // ⏳ 3.57.0 — saved logins to sign in with first, at most 5
}): Promise<BrowserExecuteResult>
```

A model looks at the page, picks the next action and repeats. `execute` **returns** a result instead of throwing — check `status` (`'completed' | 'failed' | 'stopped'`) and `stopReason` (`done`, `model_failed`, `max_steps`, `cost_cap`, `timeout`, `confirmation_required`, `needs_verification`, `invalid_action`, `repeated_action`, `schema_mismatch`, `browser_error`, `cancelled`, `error`). The result also carries `output`, `steps`, `costUsd`, `finalUrl`, `engine` (`'local' | 'cloud-agent-browser' | 'cloud' | 'none'`), `error`, `code`, `history` (one entry per step: `step`, `intent`, `action`, `url`, `ok`, `error`), `sessionKey` when the session was left open, `liveUrl` on Browser-Use runs, and `pendingAction` on a held action.

The run never spends more than `maxCostUsd` (it checks before each model call and stops with `cost_cap`). The same action three times on a page that did not change stops it with `repeated_action`. A `maxSteps` outside 1–60, a `maxCostUsd` above 10, a `timeoutMs` outside 1000–900000 or a task over 20,000 characters fail with `invalid_argument` before anything runs. At most **3 runs at once per agent for each user** (`BROWSER_EXECUTE_CONCURRENCY`). On `engine: 'browser-use'` the task runs as a Browser-Use task: `steps` is 0, there is no `history`, and a non-empty `confirmActions` makes it fail `BROWSER_USE_CONFIRM_UNSUPPORTED`.

## 6. Step-by-step commands and approvals

Every browser command is a method taking one object with an optional `sessionKey` and `browser`, returning `{ engine, data?, error?, code? }` — these **do not throw**, so check `error` and `code`. Commands sharing a `sessionKey` share one session for the length of a conversation or run; a command that needs a page before one is open fails `no_page`.

| Group | Methods |
|---|---|
| session and navigation | `health`, `session_open`, `navigate`, `back`, `forward`, `reload`, `pushstate`, `close` |
| reading the page | `snapshot`, `get`, `is` |
| interaction | `click`, `dblclick`, `fill`, `type`, `press`, `hover`, `focus`, `select`, `check`, `uncheck`, `scroll`, `scrollintoview`, `drag`, `upload`, `find`, `act` |
| waiting | `wait` |
| tabs and frames | `tab`, `window_new`, `frame` |
| capture | `screenshot`, `pdf`, `eval` |
| page state | `cookies`, `storage`, `set`, `download`, `clipboard`, `state` |
| other | `extract`, `auth`, `confirm`, `deny`, `network`, `console`, `errors`, `mouse`, `keyboard` |

Input types are exported as `BrowserCommandInputs['<method>']`. Since lua-cli 3.50.0 they accept only what the engine runs: `find` takes the actions `click`, `fill`, `hover`, `check`, `text`; `wait` takes `state: 'visible'` only; `keyboard` takes `type` and `inserttext` — use `press` for single keys and chords. Not available on the cloud browser (`unsupported`): `extract`, `auth`, `state`, `act` with a natural-language `instruction` and no `ref`, `wait` with `fn`, `screenshot` with `path`, `network` with `action: 'har'`, and downloading by URL; `download` / `pdf` / `upload` pick their own file location there, so passing a `path` is `invalid_argument`.

**Approvals.** When a command or an `execute` step matches a `confirmActions` category it is **held**: `execute` stops with `stopReason: 'confirmation_required'` and a `pendingAction` carrying `category`, `action`, `url` and a `confirmationId`; a step-by-step command waits for `Browser.confirm({ sessionKey, id, browser })` or `Browser.deny({ … })`. A held action can only be approved **from the person's next message**, never in the turn that held it, and it is dropped after 60 seconds. After confirming, call `execute` again with the same `sessionKey` to continue the task. A job, webhook or trigger has nobody to ask: it can hold an action but never approve one, so never put a confirmed step inside one. No `confirmationId` means the action could not be held and nothing is waiting.

## 7. Saved logins (⏳ 3.57.0)

A saved login is **one person's account on one site**, kept by the platform for them. The agent never sees the username, the password or a code: the person types them on a Lua page and the browser fills them in. Code only ever names the login. **Never put a password in a tool, a prompt or an environment variable — no API takes one — and never ask for a password or a code in the chat.**

- **Ask for one** from a live chat turn: `Secrets.request({ kind: 'browser-login', name, origins, loginUrl?, access?, signInPolicy?, reason? })`. `name` is `^[a-z][a-z0-9_-]{0,39}$` and is one per site per person (asking again with the same name replaces that login). `origins` is 1–10 bare hostnames; `origins[0]` is the sign-in host, the only one where the password may be typed. `loginUrl` must be an absolute `https://` URL on one of them. Returns `{ kind, requestId, name, state: 'pending', expiresAt, reused?, delivery? }` — no link and no token, so it is safe to return from a tool. The link works once, for 15 minutes. Refusals: `browser_login_needs_user` (not a live turn of that person — a job, webhook or trigger can never ask), `browser_login_invalid`, `browser_login_access_invalid`, `browser_login_origin_changed` (that name already exists on different `origins` — use another), `browser_logins_disabled`, `secrets_unavailable` (offline under `lua test`).
- **Sign in**: `Browser.login({ credential, sessionKey?, browser? })` → `status: 'signed_in' | 'needs_verification' | 'failed'`, plus `credential`, `site`, `sessionKey`, `access`, `restored`, `failure` (`wrong_password`, `needs_verification`, `captcha`, `needs_approval`, `site_changed`, `session_expired`, `browser_unavailable`, `too_many_attempts`), `reason` (already written for the person — pass it along), `verificationExpiresAt`, `verificationLink`, `handoffLink`, `error`, `code`. One login per `sessionKey`; give each login its own key. A signed-in session is saved when it closes (about 30 days) and reused next time, so the second run usually comes back `restored: true`.
- **Ask for the least access.** `read` (open, navigate, scroll, read, `screenshot`, `pdf`, `extract`, tabs and frames, approve or deny, close — anything else is `browser_login_read_only`) · `act` (adds `click`, `fill`, `type`, `select`, `press`, each held for the person; any other write is `browser_login_write_unsupported`) · `act-auto` (those writes run without the login holding each one; the browser's own `confirmActions` still apply). The person can only pick the level you asked for or lower. Page scripts never run in a signed-in session, whatever the level.
- **Do not loop on a failed sign-in.** The default policy is **one attempt per 30 minutes with a 30-minute cooldown**; a wrong password, a code, a bot check or an approval on another device starts that cooldown, and a sign-in that works clears it. `signInPolicy` takes `maxAttempts` 1–5, `windowMinutes` and `cooldownMinutes` 5–1440. On `too_many_attempts` say when they can try again and stop; on `needs_verification`, `captcha` or `needs_approval` say a private link is on its way and that the run waits for them. Never start a second sign-in for the same login.
- **Jobs need a grant.** From a live chat turn: `Browser.allowJobLogin({ credential, jobId, access })` (the job's id as `Jobs.getAll` reports it; one grant per job, `access` defaults to `read` and the lower of login and grant applies) and `Browser.revokeJobLogin({ credential, jobId })`. A job that signs in without one is refused `browser_login_grant_required`. Removing a login deletes its saved session and withdraws every job grant.
- Other codes: `browser_login_not_found`, `browser_login_needs_user`, `browser_login_needs_verification`, `browser_login_site_not_allowed` (a signed-in session tried to leave the login's hosts), `browser_login_failed`, `browser_login_unavailable`, `browser_session_not_found`, `browser_session_too_large`.

## 8. Files (⏳ 3.58.0)

`Browser.download({ ref | selector, name?, sessionKey?, browser? })`, `Browser.pdf({ name?, … })` and `Browser.upload({ ref | selector, file, … })` are off until the browser sets `maxDownloadMb`, which also caps each file (`files_disabled` otherwise). `download` clicks the link or button at a snapshot `ref` (such as `'@e7'`) or a `selector` — pass one, not both; **there is no download by URL**, so take a `snapshot`, find the link and click it. `upload` takes one of the **person's own** files by URL, `fileId` or artefact URL. `download` and `pdf` return `{ fileId, url, name, bytes, mime, scanStatus }` in `data`; `upload` returns `{ uploaded: true, name, bytes }`.

A saved file is private to the person and arrives `scanStatus: 'scanning'`: nobody can open it and it cannot be uploaded until the malware scan says `clean`, so hand the person its `name` and `url` and let it open once the scan clears rather than fetching it in the same breath. `infected` or `failed` can never be downloaded or re-uploaded. Caps per plan: free 25 MB per file / 100 MB per run, team 100 / 500, business and enterprise 500 / 2048; a `maxDownloadMb` above the plan's limit is lowered, not refused, and a file over the cap or a run that used up its total is `file_cap`. Each of the three has its own `confirmActions` category. In a signed-in session `pdf` counts as reading while `download` and `upload` are writes that cannot be held one at a time, so they need an `act-auto` login.

When the **chat model** drives the browser it may save downloads and PDFs like your code, and may upload only a file the person attached **in their current message or the one before** (`file_older_message` otherwise — ask them to send it again); on the person's own desktop browser it cannot upload a chat file at all (`upload_not_local`). Other codes: `mime`, `file_not_clean`, `remote_session` (files are not available on Browser-Use), `BROWSER_FILES_UNAVAILABLE`, `file_transfer_failed`, `invalid_argument`.

## 9. Page scripts (⏳ 3.58.0)

`Browser.eval({ js, sessionKey?, browser? })` runs one script in the page and returns its result. It is the **last resort**, for something no command exposes — a value the page computes, a count across a table: reach for `get`, `snapshot`, `find` or `extract` first. It needs `allowScripts: true` **and** an `allowedDomains` list naming a real domain, so a browser that can run scripts is always a browser locked to its sites; keep it separate from the one that opens arbitrary pages. Without both it is `scripts_disabled`. Scripts are developer-only: the **chat model never runs them**, `Browser.execute` never runs them (`invalid_argument`), they never run in a signed-in session, and they are unavailable on Browser-Use (`remote_session`). A script is at most 64 KB, and each run writes a `script` log row with the script's **hash**, never its text. Add `'eval'` to `confirmActions` when even your own scripts should wait for a person.

## 10. Limits

| Limit | Default | Maximum | Set with |
|---|---|---|---|
| cloud session length | 10 minutes | 60 minutes | `maxSessionMinutes` |
| cloud session idle time | 120 seconds | 900 seconds | `idleTimeoutSeconds` |
| cloud sessions at once | 3 per agent for each user | 10, or less on the plan | `maxConcurrentSessions` |
| `Browser.read` time | 60 s | 100 s | `timeoutMs` |
| `Browser.read` content · matches for a `selector` | 100,000 chars · 200 | the same | — |
| `Browser.execute` steps · spend · time | 25 · 1 USD · 5 min | 60 · 10 USD · 15 min | `maxSteps`, `maxCostUsd`, `timeoutMs` |
| `Browser.execute` runs at once · logins per run | 3 per agent for each user · — | 3 · 5 | `credentials` |
| each downloaded or uploaded file · per run | the plan's limits | 500 MB · 2048 MB | `maxDownloadMb` |
| `allowedMimeTypes` entries · `Browser.eval` script | — | 50 · 64 KB | — |
| sign-in attempts for one login | 1 per 30 minutes | 5, in a window of 5–1440 minutes | `signInPolicy` |
| `lua browser` reads and runs at once · `lua browser run` time | 2 per agent · 5 minutes | the same | — |

A cloud session that reaches its length or idle limit closes, and the next command is `session_lost` — open the page again instead of retrying the command. The cloud browser never opens private or internal network addresses.

## 11. Errors and what to do

`Browser.read` throws these (`name: 'BrowserError'`, `code`); every other method returns the code in `code`.

| Code | What to do |
|---|---|
| `BROWSER_DISABLED` | the agent has no `browser` and no named browser — add `browser: true` or a `LuaBrowser`, then `lua push agent` |
| `BROWSER_UNAVAILABLE` | called from a tool `condition`, a model or MCP resolver, or `lua test` — the browser does not run there |
| `BROWSER_DOMAIN_NOT_ALLOWED` | add the host to `allowedDomains`, including the hosts the page loads its content from |
| `BROWSER_PROFILE_NOT_FOUND` | that `browser` name is not attached — add it to `browsers`, `lua push browser` and `lua push agent` |
| `BROWSER_WORKER_NOT_CONFIGURED` | the cloud browser is not available in this environment (a platform matter, not the code) |
| `invalid_argument` | a non-`http(s)` URL, an unknown `format`, a selector starting with `-`, a `maxSteps` / `maxCostUsd` / `timeoutMs` out of range |
| `BROWSER_RUN_SCOPE_MISSING` | no conversation or run to tie the session to — call it from a tool, job, webhook or workflow step |
| `unsupported` | the command cannot run on this browser (for example `Browser.read` on `engine: 'browser-use'`) |
| `http_error` · `timeout` · `no_page` | the page answered an error with nothing to read · the page or `waitFor` ran out of budget · open a page first |
| `session_lost` · `session_cap` · `unreachable` · `engine_unavailable` | the session ended (open the page again, do not retry the command) · the cloud browser is at capacity · it could not be reached · it could not be started |
| `blocked_domain` · `blocked_private_host` · `blocked_scheme` | the cloud browser refused the page |
| `engine_error` | the browser reported an error, such as a selector that was never found — the message has the detail |
| `BROWSER_SESSION_LIMIT` | too many sessions open for this person — `Browser.close` one, or reuse a `sessionKey` |
| `BROWSER_OUT_OF_CREDITS` · `BROWSER_BILLING_UNAVAILABLE` · `BROWSER_SESSION_STORE_UNAVAILABLE` | nothing was opened: the workspace has no credits or actions left · the billing check could not be reached · the session could not be tracked (retry) |
| `BROWSER_EXECUTE_INVALID_INPUT` · `BROWSER_EXECUTE_CONCURRENCY` | an empty task, a `schema` that is not an object, or a bad `credentials` list (`execute` rejects with `name: 'BrowserExecuteError'`) · 3 runs already going for this user |
| `BROWSER_OUTPUT_SCHEMA_MISMATCH` · `BROWSER_BOT_WALL` · `MODEL_NOT_AVAILABLE` | the output did not match `schema` (`output` holds what the model returned) · a captcha or bot check it could not get past · that `model` is not available to the agent |
| `BROWSER_USE_CONFIRM_UNSUPPORTED` · `BROWSER_USE_TIMEOUT` · other `BROWSER_USE_…` | `engine: 'browser-use'` with a non-empty `confirmActions` (the task never started) · the Browser-Use task timed out, was cancelled or failed |

The file (§8) and login (§7) codes are listed with their own sections.

## 12. Logs

Every command writes rows under the `browser` source — `lua logs --type browser` (⏳ lua-cli 3.49.0; `/lua-logs`): `session.opened` (engine, which named browser, why, its limits), `command` (once per call — `Browser.read` writes a single `read` row, not one per step), `agent.step` (per `execute` step: number, action, intent, page), `navigation`, `blocked` (a host outside `allowedDomains`, a private address, an unknown `browser` name), `wall` (captcha, bot check, cookie wall, sign-in page, no content), `fallback` (desktop → cloud, or cloud → Browser-Use), `confirm` (held, then approved, denied or expired), `session.closed` (why: `done`, `idle`, `expired`, `max-minutes`, `max-steps`, `cost-cap`, `reaped`, `cancelled`, `confirmation`, `blocked`, `stopped`, `error`; how long, how many pages, how many files), `login.restored` / `login.filled` / `login.needs_verification` / `login.failed`, `session.saved`, `download` / `upload` (name, size, type, and a download's scan status) and `script` (hash, size, result size, whether it worked — never the text). Arguments that look like secrets are redacted and page text appears only with `logContent: 'full'`. Rows written by `lua browser` carry the `dev` channel. This is where the engine, the refused host and the wall are recorded: read it after every failure before changing code.

## 13. CLI

| Command | Shape | Notes |
|---|---|---|
| `lua browser read <url>` | `[--selector <css>] [--format text\|html] [--wait-for <load\|networkidle\|css>] [-e sandbox\|production] [--agent-id <id>] [--json]` | one page on the platform, under the agent's **pushed** policy; prints title, final URL, engine, the HTTP status when it is not 200, `Matches:` for a selector, `Blocked:`/`Guidance:` on a wall, then the content. 60 s |
| `lua browser run "<task>"` | `[--start-url <url>] [--schema <file.json>] [--max-steps <n>] [--max-cost <usd>] [--login <name>]… [-e] [--agent-id <id>] [--json]` | prints `step N: <action> on <url>` as each step arrives, then status, steps, cost, engine, final URL and output; `Waiting for confirmation:` on a held action. ⏳ `--login` 3.57.0, repeatable up to 5, only the user's own logins. 5 minutes; the CLI stops waiting after 6 and exits 1; `Ctrl-C` cancels the run **on the server** and exits 130 |
| `lua browsers [list\|delete] [name]` | `[--browser-name <name>]` | lists the agent's named browsers with engine and allowed domains, or deletes one (aliases `ls`/`l`, `rm`/`remove`/`del`). `delete` also removes the row from `lua.skill.yaml` — delete the `LuaBrowser` from `browsers: [...]` too, or the next push recreates it. No name → exit 2 and the list; unknown name → exit 3. Needs a project (no `--agent-id`) |
| `lua push browser --name <n>` | `--ci --force` | upserts the profile by name; `lua push agent` links the agent's `browsers` list, `lua push all` does both |
| `lua logs --type browser` | §12 | the rows every read, run and command wrote |

Both `lua browser` verbs need `browser: true` or at least one named browser (409 `BROWSER_DISABLED`) and an API key with `agents:write` on the agent (403). `-e` only **tags the log rows** — the browser, its policy and the cost are the same. `--json` prints the raw envelope (`{ engine, data, error?, code? }` for `read`, `{ id, status, result }` for `run`) and **exits 0 even when the call failed**, so never read the exit code of a `--json` call: check `error` and `code`. At most **2** CLI reads and runs at once per agent (429 `BROWSER_CLI_CONCURRENCY`; a slot frees itself within 6 minutes), and a paused limiter is 503 `BROWSER_CLI_LIMITER_UNAVAILABLE`. Exit codes: `0` ok · `1` the read failed, the run did not complete, or the CLI stopped waiting · `2` usage (⏳ 3.49.2 checks `-e`, `--format`, `--max-steps`, `--max-cost`, the URLs, an empty task, the `--schema` file and the `--login` names locally) · `3` not found · `9` auth · `10` refused · `11` unavailable · `130` cancelled. The slash is `/lua-browser`.

## 14. Best practices (what to put in a plan or a review)

1. **Set `allowedDomains` on every browser.** It is enforced on the server, before every command that opens a URL, and it covers redirects and everything a page loads, so a prompt-injected page cannot talk the agent into leaving. Include the hosts a page pulls its content from, or it renders empty. Setting it also keeps every page on Lua infrastructure (the Browser-Use fallback goes off).
2. **`confirmActions: ['submit']` on anything that submits, pays or sends.** Note what `submit` covers today: a search form's submit button is a submit too, so a read-only search flow holds an action unless the task avoids submitting. Tell the person what is waiting, in their words, and approve from their next message.
3. **Logins: least access, named for the site, never looped.** `read` unless the work genuinely writes; `act-auto` only for work the person already said yes to as a whole. One login per site per person. A failed sign-in is a message to the person, not a retry.
4. **A job may not ask anybody.** It needs `Browser.allowJobLogin` from a live turn to use a login, and it can never approve a held action — so a confirmed step does not belong in a job.
5. **Keep sessions short.** `Browser.read` for one page (it closes its own session); `Browser.close({ sessionKey })` at the end of a tool **and in the error path**; a `sessionKey` per piece of work, never one per item in a loop. Do not raise the session limits to cover a slow page — raise `timeoutMs` on the call.
6. **Cap every `execute`** with `maxSteps` and `maxCostUsd`, and give it a `schema` so the answer has a shape. They are the only things between a confused model and a long bill.
7. **Files: the smallest `maxDownloadMb` that fits, named `allowedMimeTypes`, and respect the scan** — hand over the name and URL rather than fetching a file that is still `scanning`.
8. **Scripts are developer-only** and need a locked-down browser. Reach for a command first.
9. **A bot wall is not a retry.** `fallback: 'browser-use'` handles one; otherwise use the person's desktop browser or a public source.
10. **Try it from the terminal first.** `lua browser read` / `lua browser run` run against the pushed agent, so they show exactly what the code will get; then read `lua logs --type browser`.

## 15. Gotchas

- `lua test` does **not** open a browser: every `Browser` method, `execute`, `login`, `download` and `eval` included, rejects with `BROWSER_UNAVAILABLE`, and `Secrets.request({ kind: 'browser-login' })` refuses with `secrets_unavailable`. There is no `lua test` type for a browser: verify with `lua browser read` / `lua browser run`, or push and run the tool, job or webhook on the platform and read the rows.
- `Browser.read` **throws**; `execute` and every step-by-step command **return** `error` / `code`. Code that only try/catches misses every stepwise failure.
- Settings do not merge between a named browser and the agent's `browser`, and a call with no `browser` name on an agent that sets both uses the agent's `browser` — not the first named one.
- A pushed browser is **not** in an agent version: `lua version promote` does not roll it back, and `lua push browser` rewrites the live policy of a browser the agent already lists.
- A new browser needs **both** pushes — the profile and the agent that lists it — or every call is `BROWSER_PROFILE_NOT_FOUND`.
- `credentials` and `persist` on a browser are stored and not enforced: they are not how a browser signs in (§7 is).
- A held action cannot be approved in the turn that held it and is gone after 60 seconds, so do not design a tool that confirms its own action.

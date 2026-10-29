# Web apps — pages and typed routes on an agent (lua-cli 3.42.0+ · read at 3.45.0; §7 deploy at 3.49.0; §7a preview at 3.51.0; §4 look and theme at 3.55.0)

Read from lua-cli `src/types/web-app.ts`, `src/commands/apps.ts`, `src/commands/test.ts` (`testWebApp`), `src/commands/push.ts`, `src/primitives/web-app.handler.ts`, `src/utils/web-app-build.ts`, `src/utils/web-app-route.ts` and `template-web-app/` at **3.45.0** (npm `latest` is 3.46.0 on 2026-10-06 — not re-read); the wire contract and limits from `@lua/shared-types` `web-route-contract.ts`; the page policy from lua-core `src/apps-gateway/web-app-html.ts`; the snapshot rule from lua-agents `agent-version.service.ts`. Product docs: docs.heylua.ai `/concepts/apps`, `/build/apps/quickstart`, `/build/apps/routes-and-pages`, `/reference/cli/apps`. Below lua-cli **3.42.0** `webapp` is not a push/test type and `lua apps` does not exist — `/lua-update` first.

"Web app" is the CLI's word (`defineWebApp`, `webApps`, `lua push webapp`); "Lua Apps" is the product name. Use "web app" in code, commands and messages.

---

## 1. The model in one paragraph

A **web app** is a primitive of one agent with two halves. **Pages**: a Vite + React project in `src/apps/<name>/web`, built by `lua push webapp` and served from the app's **own origin** (`https://<slug>.apps.heylua.ai`) inside Lua Workspace or the admin console. **Routes**: typed handlers in `src/apps/<name>/app.ts`, run on Lua in the same sandbox as tools — `Data`, `env()`, `fetch` — **as the signed-in person** (`auth`). The page calls a route with `lua.api(method, path, body?)` from `@lua-ai-global/app-client`. A pushed version is **staged**. ⏳ From lua-cli **3.49.0**, `lua deploy webapp` makes it live **on its own** (a scoped promote: only that app's pin moves, nothing else staged goes live) and deploying an earlier version rolls just that app back. Below 3.49.0, it goes live only with the **agent version** that pins it (§7).

| | Where | Runs | Built / checked by |
|---|---|---|---|
| Routes | `src/apps/<name>/app.ts` (`defineWebApp`) | Lua sandbox, `auth` = the person | `lua compile` (validates the definition), `lua test webapp` |
| Pages | `src/apps/<name>/web/` (Vite project) | browser, app's own origin, framed by the shell | `npm run typecheck`, `npm run build` (in `web/`); `lua push webapp` builds with that Vite |
| Registration | `webApps: [<binding>]` on `new LuaAgent({...})` in `src/index.ts` | — | an app not listed there is never compiled |

## 2. Scaffold — `lua apps new <name>`

- Run in the project root (where `lua.skill.yaml` is; otherwise exit 2 `No lua.skill.yaml here`). Name: `^[a-z][a-z0-9-]*$` (exit 2 otherwise). Never overwrites: an existing `src/apps/<name>` is exit 2. Non-interactive (no prompts).
- Writes `src/apps/<name>/app.ts` (one route, `GET /hello`) and `web/` (`index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`, `src/main.tsx`, `src/App.tsx`, `src/index.css`; lua-cli 3.42–3.45 also `src/lua/client.ts`).
- Edits `src/index.ts` with an AST edit: imports the app as the camelCased name (`ops-dashboard` → `opsDashboard`) and appends it to `webApps`. When it cannot find the agent or `webApps` is not an array it prints the two lines instead (`⚠️ …add:`) — then add them yourself.
- Adds `src/apps/*/web` to `tsconfig.json` `exclude` so the agent build never loads the pages. A tsconfig with comments / trailing commas is left alone and the line is printed — add it yourself, or `lua compile` type-checks React code with the agent's settings and fails.
- Then, always: install the page dependencies — `npm --prefix src/apps/<name>/web install --ignore-scripts` (the plugin's hook approves exactly this form; the template builds without install scripts). Without it `lua push webapp` and `lua apps dev` fail: `No Vite installation found for <dir>. Install the page dependencies first`.

### Switch the page client to the package

lua-cli 3.42–3.45 scaffold a **copy** of the client at `web/src/lua/client.ts`. The supported form is the package (`@lua-ai-global/app-client`, `~0.1` in the lua-cli 3.55.0 template, same API). Newer templates import the package already — skip this when there is no `web/src/lua/`. Right after scaffolding an older one (or let the user run `lua apps upgrade <name>`, §4, which does the same):

1. `npm --prefix src/apps/<name>/web install --ignore-scripts @lua-ai-global/app-client`
2. In `web/src/main.tsx` and `web/src/App.tsx`: `from './lua/client'` → `from '@lua-ai-global/app-client'`
3. Delete `web/src/lua/client.ts`

## 3. Routes — `defineWebApp` and `route()`

```ts
import { Data, defineWebApp, json, route } from 'lua-cli';
import { z } from 'zod';

export default defineWebApp({
  name: 'ops-dashboard',                         // = the folder name; part of the Workspace URL
  description: 'Open tickets per shop',
  pages: { root: './web', nav: [{ path: '/', label: 'Tickets' }] },
  routes: {
    'GET /tickets': route({
      query: z.object({ status: z.enum(['open', 'closed']).default('open') }),
      handler: async ({ query }) => ({ items: (await Data.get('tickets', { status: query.status })).data }),
    }),
    'POST /tickets/:id/close': route({
      params: z.object({ id: z.string() }),
      body: z.object({ note: z.string().max(500) }),
      handler: async ({ params, body, auth }) => {
        await Data.patch('tickets', params.id, { set: { status: 'closed', closedBy: auth.userId, note: body.note } });
        return json(undefined, 204);
      },
    }),
  },
});
```

- **Keys** are `'<METHOD> /<path>'`, methods `GET POST PUT PATCH DELETE`, exactly one space, `:param` segments. A bad key, a route without `handler`, a nav item whose `path` doesn't start with `/` or lacks `label`, a bad name, a missing `pages.root`, or **no routes and no `fetch`** all fail at `lua compile` with a `defineWebApp(<name>): …` message.
- **`ctx`**: `params`, `query` (repeated key → array), `body`, `headers` (lower-cased, **allow-listed**: `accept`, `accept-language`, `content-type`, `if-none-match`, `idempotency-key`, `x-lua-*` — cookies never arrive), `method`, `path`, `route`, `auth`, `app` (`{ id, name, version, deployment, origin, preview }`), `request` (a Web `Request`).
- **`auth`**: `{ userId, orgId, agentId, subjectType: 'user', credentialType: 'firstPartySession', sessionId?, roles, scopes, name?, email?, expiresAt?, accessLevel? }` — always a signed-in person, never an API key, never anonymous. Use `auth.userId` for "who did this" fields. **Locally `roles` and `scopes` are empty** (the gateway decides access) — never gate logic on them without a fallback you can test. `accessLevel`: `'full'` (can read the agent: every route), `'view_only'` (a view shared with them, or org-wide: `GET` routes only, every other method answers 403 `VIEW_ONLY` before your handler) or `'use'` (an App Viewer of an app that asks for writes, below: every route, with empty `roles` and `scopes`).
- **App Viewers** (⏳ lua-cli 3.64.0+): people who sign in by phone or email to use only this app. They only read unless the app asks for more in `defineWebApp`: `viewers: { write?: boolean, chat?: boolean, mode?: 'people' | 'app' }`. `write: true` lets them call your `POST`/`PUT`/`PATCH`/`DELETE` routes as `accessLevel: 'use'`; `chat` asks for the agent pane (honoured once the platform ships App Viewer chat); `mode` says how they join (`'people'`, the default: an admin invites them; `'app'`: your code adds and removes them, ⏳ not available yet). It is an ask: the deploy shows what it opens and the workspace can turn writes or chat off. `viewers` must be a compile-time object of those keys (no spread, no computed key), or `lua compile` refuses it. An older lua-cli drops it silently. **With `write: true`, every write route must check the record is the caller's** — `auth.userId`, or their scope in your own roster collection (person → territory, team, shop) — **and answer 404 when it is not**; the platform cannot tell whose record it is:

  ```ts
  'POST /visits/:id/reason': route({
    params: z.object({ id: z.string() }),
    body: z.object({ reason: z.string().max(200) }),
    handler: async ({ params, body, auth }) => {
      const visit = await Data.getEntry('visits', params.id).catch(() => null); // a missing id throws
      // inScopeOf: your own check against your roster collection (is this area theirs?)
      const mine = visit && (visit.data.repUserId === auth.userId || (await inScopeOf(auth.userId, visit.data.area)));
      if (!mine) return json({ code: 'NOT_FOUND', message: 'No such visit' }, 404); // never 403: do not confirm it exists
      await Data.patch('visits', visit.id, { set: { reason: body.reason, by: auth.userId } });
      return json(undefined, 204);
    },
  }),
  ```
- **Schemas** (`params`, `query`, `body`) are Zod; a failure answers **400 `VALIDATION`** before the handler runs. `responses` is for the typed client only, not enforced. `Data.get(collection, filter?, page?, limit?)` takes the filter itself as the second argument (`{ status: 'open' }`), not `{ filter: … }`. On lua-cli **3.49.0 and earlier** a field with `.default()` is typed `T | undefined` in the handler and a `.transform()` schema is refused by `tsc`; write `query.status ?? 'open'` there. The release after 3.49.0 types the schema output.
- **Returns**: any JSON value → 200; `undefined` → 204; a `Response` as-is (`json(data, status, headers)` builds one). Response headers other than `content-type`, `cache-control`, `etag`, `location`, `content-disposition`, `content-language`, `x-lua-*` are dropped; **`set-cookie` is refused** — there are no cookie sessions, the client holds the session.
- **Platform errors** all carry `{ code, message, issues?, executionId? }` with `code` one of `VALIDATION NOT_FOUND METHOD_NOT_ALLOWED HANDLER_ERROR FORBIDDEN UNAUTHENTICATED APP_DISABLED CONCURRENCY_LIMIT WALL_TIMEOUT RESPONSE_TOO_LARGE PLATFORM_ERROR`. A handler's own error body passes through untouched — return `json({ code: 'NOT_FOUND', message }, 404)` rather than throwing (a throw surfaces as `HANDLER_ERROR`).
- **Enforce every access rule in the route.** Any viewer the gateway admits can call any route directly, so hiding a button in the page is cosmetic; a handler that changes or returns one record checks it belongs to `auth.userId` (or the viewer's scope) first. `/lua-audit <name>` lists what the app enforces where.
- `fetch: (request) => Response` is an escape hatch (Hono, itty-router) for paths no route matches; such paths lose schema validation and the typed client. Prefer `routes`.
- Data lives in the agent's `Data` collections, shared with its tools — a route and a tool that write `tickets` write the same rows.
- **Deciding workflow approvals / answering input steps from a page** (lua-cli 3.50.0+): in a POST/PUT/PATCH/DELETE route handler call `Workflows.viewer.decideApproval(runId, approvalId, { decision: 'approve' | 'deny', note?, expectedFingerprint?, agentId? })` or `Workflows.viewer.resume(runId, stepId, resumeData, { agentId? })`. It acts as the **signed-in viewer**, never as the agent: the viewer's own agent access, approver / four-eyes / step-up rules and audit apply (`decidedBy` = the viewer), exactly as in the Inbox. `agentId` defaults to the app's own agent (name another for a fleet dashboard; the viewer still needs access to it). Anywhere else (GET routes, tools, jobs) it throws `WorkflowsApiError` `viewer_unavailable`. Step-up or surface-restricted approvals answer `STEP_UP_REQUIRED` / `APPROVAL_SURFACE_DENIED` — tell the user to decide those in the Inbox; other refusals pass through (`NOT_AN_APPROVER`, `FOUR_EYES_REQUIRED`, `APPROVAL_NOT_FOUND`, `PAYLOAD_MISMATCH`). Locally (§5, §6) the route runs as you, with your CLI credentials — a test call really decides the approval. Page code cannot decide on the platform directly; go through a route.

## 4. Pages — the `web/` project

- Template stack (lua-cli 3.55.0): React 19, Vite 8, Tailwind v4 (`@tailwindcss/vite`), `@lua-ai-global/ui` `~0.3` (import per component, e.g. `@lua-ai-global/ui/button`, `/card`), `@lua-ai-global/app-client` `~0.1`, `@phosphor-icons/react`. ui 0.3 is the enterprise restyle Lua Workspace itself uses: flat surfaces, 6px radius, denser controls, Inter. New in 0.3 and worth using for whole pages: `@lua-ai-global/ui/page` (`PageColumn`, `PageTitle`, `PageSection`, `Panel`, `StatGrid`, `Stat`), `/list-row` (`ListRow`), `/empty-state` (`EmptyState`). Templates before 3.55.0 are on ui 0.2.x and app-client 0.0.x.
- **Look and theme.** app-client 0.1+ applies the shell's light/dark (the `dark` class), density (`data-density`) and the person's **accent** (the colour they picked in Lua Workspace; `data-accent` plus inline tokens such as `--primary`, `--ring`, `--chart-*`) to `<html>` — on `lua.start()` and again on every `lua:init`. **Which app you have decides the theme code** (`web/package.json`):
  - `@lua-ai-global/app-client` **0.1 or later** (the lua-cli 3.55.0+ template, or any app after `lua apps upgrade`): the page **never manages the theme itself** — `main.tsx` keeps `void lua.start()` and adds no `classList.toggle('dark', …)` / `lua.onInit` theme lines. Lines an older template already wrote agree with the client and are harmless; `lua apps upgrade` removes them.
  - app-client **0.0.x**, or the copied client of lua-cli 3.42–3.45 (`web/src/lua/client.ts`): the client applies nothing, so **keep the template's theme lines** in `main.tsx` (they are what follows dark mode) and recommend `lua apps upgrade <name>`.

  Either way, style only with ui's semantic tokens (`bg-background`, `text-foreground`, `text-muted-foreground`, `bg-card`, `bg-primary`, `text-primary-foreground`, `border-border`, `ring-ring`, …) — no palette classes (`bg-blue-500`) and no hex / `rgb()`, or the page ignores the accent and dark mode. `lua.theme`, `lua.accent`, `lua.hue` say what is applied.
- **Component catalog: the `ui` MCP server** (`https://ui.lua.dev/mcp`, public Storybook MCP, registered by this plugin): `mcp__plugin_lua-agent-builder_ui__list-all-documentation` lists every component, `mcp__plugin_lua-agent-builder_ui__get-documentation` (`id`: `"button"`, `"list-row"`, …) gives props, variants and example code, `mcp__plugin_lua-agent-builder_ui__get-documentation-for-story` one story's code. Look a component up before writing it. (Server key `ui`, kept short so every composed `mcp__plugin_<plugin>_<server>__<tool>` name stays within 64 characters.) **Fallback** when those tools are unavailable: read the installed package — the component list is the `exports` of `web/node_modules/@lua-ai-global/ui/package.json`, the props are in `web/node_modules/@lua-ai-global/ui/dist/components/{ui,lua}/<component>.d.ts`; never guess props. The catalog follows the **latest** ui: a component missing from the installed `web/node_modules/@lua-ai-global/ui` needs `lua apps upgrade <name>` first.
- **`lua apps upgrade <name>`** (lua-cli 3.54.0+; the ui 0.3 / app-client 0.1 raise and the theme-line removal from 3.55.0; `--dry-run`, `--ci`/`--force`, `--skip-install`) brings an app made by an older `lua apps new` up to the current template: raises `@lua-ai-global/ui` and `@lua-ai-global/app-client` to at least the template's ranges, removes the old template's theme lines from `main.tsx` (only when they are exactly the template's), swaps the copied `web/src/lua/` client for the package, takes out the bundled agent pane, then runs `npm install` in `web/`. ui 0.2 → 0.3 keeps every export and variant name, so no page code changes; afterwards the user looks the pages over with `lua apps dev <name>` (§6). It edits local files and installs packages, so the plugin's subagents do not run it — they name it for the user. Until an app is rebuilt on ui 0.3, the gateway restyles an older one (ui < 0.3) with the new tokens; upgrading is still the fix.
- **Client** (`import { lua, LuaApiError } from '@lua-ai-global/app-client'`): `lua.api<T>(method, path, body?)` → parsed JSON or throws `LuaApiError { status, code, message }`; `lua.appName`; `lua.theme` / `lua.accent`; `lua.onInit(init => …)` (locale / path from the shell; appearance is already applied); **`void lua.start()` must run once in `main.tsx`** — it exchanges the one-time handoff code, applies the shell's appearance and tells the shell it is ready. A 401 renews the session once, then asks the shell for a new code; never store tokens (no cookie, no localStorage — a reload asks the shell again).
- Paths given to `lua.api` are the route paths (`'/tickets'`), not `/_lua/api/...`.
- `pages.spa` defaults to `true`: client-side routing (React Router etc.) works; `pages.nav` entries should name the client routes.
- **The page CSP is strict and per request** (gateway `web-app-html.ts`): scripts and styles only from the app itself with a nonce (no CDN `<script>`, no remote stylesheet, no Google Fonts link), `connect-src` = the app + Lua auth only, `frame-src 'none'`, images from self/`data:`/`blob:`/Lua CDN. Bundle dependencies with npm instead of linking them. When an external origin is truly needed, add it per directive in `pages.csp` — keys `scriptSrc styleSrc imgSrc connectSrc fontSrc frameSrc workerSrc`, values are source lists (`{ connectSrc: ['https://api.example.com'] }`); `frame-ancestors`, `base-uri`, `object-src` cannot be widened. Prefer calling third-party APIs **from a route** (server side, secrets in `env()`) over widening `connectSrc`.
- `vite.config.ts`: keep `react()` and `tailwindcss()`. `lua push webapp` overrides `base: '/'`, `build.outDir`, `assetsDir: 'assets'` and the CSP nonce — don't fight them (no custom `base`, no assets outside `assets/`).
- **Check after every page change**: `npm --prefix src/apps/<name>/web run typecheck`, then `npm --prefix src/apps/<name>/web run build`. That is the same Vite build the push runs; it catches type errors and missing imports. Visual check: the **user** runs `lua apps dev <name>` in their own terminal (§6).

## 5. Testing routes — `lua test webapp`

```
lua test --ci webapp --name <app> --route '<METHOD> /path?query' [--input '{"body": {...}, "headers": {...}}'] --json
```

- ⚠ **`--input` wraps the body**: `{"body": {...}}`, not the raw body. `'{"title":"x"}'` sends **no body** (→ 400 `VALIDATION` on a route with a `body` schema).
- `--route` is required with `--json` (exit 2). Path params are filled from the path (`'POST /tickets/42/close'` matches `POST /tickets/:id/close`). A path no route matches is exit 2 listing the routes. A 5xx is exit 1. `--json` prints `{ status, headers, body: { kind: json|text|base64, value } }`.
- ⚠ **Live data.** `auth` is you (your user, the project's org and agent) and `Data` / `env()` are the **live** ones — a `POST`/`PUT`/`PATCH`/`DELETE` writes real rows. The plugin runs `GET` freely and asks once before any other method (`/lua-test` Step 2).
- ⚠ No web apps in the compiled output (app not in `webApps`) prints `❌ No web apps found` and exits **0** — a false pass. Check the output, not only the exit code.

## 6. Running locally — `lua apps dev <name>` (the user's terminal)

Compiles, then starts the app's own Vite with hot reload; routes are served at `/_lua/api/*` from the **local sandbox as the developer**, against **live** `Data` and `env()`, and recompile on save. It is a long-running server (Ctrl+C to stop) and every click in the page hits live data, so the plugin **does not start it**: it prints `lua apps dev <name>` for the user to run in their own terminal and open the printed URL. `--port <n>` picks the port. `No web app named "<n>" in the compiled agent` = not listed in `webApps`.

## 7. Shipping — staged, then live on its own (3.49.0+) or with an agent version

| Step | Command | Notes |
|---|---|---|
| Stage | `lua push webapp --ci --name <app> --force` | builds pages with `web/`'s Vite, uploads pages + route bundle, creates a web-app version. Bare `lua push` / `lua push all` include web apps. The plugin never adds `--auto-deploy` |
| ⏳ Live, 3.49.0+ | `LUA_DEPLOY_CONFIRMED=1 lua deploy webapp --ci --name <app> --set-version <v> --force` | `/lua-deploy` → `webapp`. A **scoped promote**: a new agent version identical to the live one except this app's pin, promoted at once (`✔ deployed <app>@<v> — agent version <n> promoted`; on an agent without versions `✅ Web app "<app>" v<v> deployed successfully`). Nothing else staged goes live. A failed deploy changes nothing (503 `SCOPED_PROMOTE_FAILED` / 409 `SCOPED_PROMOTE_CAP_EXHAUSTED`; re-run) |
| Live, below 3.49.0 | `lua version create --ci -m "<notes>"` → `LUA_DEPLOY_CONFIRMED=1 lua version promote <N>` | no `webapp` deploy type there. The snapshot pins the **latest pushed** version of **every** primitive, so `/lua-deploy webapp` diffs it first (pilot step 5) |
| Roll back | 3.49.0+: `LUA_DEPLOY_CONFIRMED=1 lua deploy webapp --ci --name <app> --set-version <previous> --force`; any version: promote an earlier agent version | the scoped form rolls back only that app |
| Switch off | admin console → agent → Apps | an admin toggle; a disabled app answers `APP_DISABLED`. A deploy **never** switches it on: 3.49.0+ prints `⚠️  Web app <app> is switched off: the new version is live, but nobody can open it until it is switched on again.` — pass that on |

### 7a. Preview a staged version before it is live — `lua apps preview` (⏳ lua-cli 3.51.0+)

Read from lua-cli `src/commands/apps-preview.ts` and lua-core `src/apps-gateway/web-app-preview.service.ts` on `main` (ADR 0019); docs.heylua.ai `/reference/cli/apps#lua-apps-preview`.

```
lua apps preview --ci <name> [--version <v>|latest] [--ttl 24h|2d] [--json]   # open one (or get the open one for that version)
lua apps preview --ci [<name>] --list | --close <id> | --effects <id>
```

- Prints a **Lua Workspace link** (`https://workspace.heylua.ai/apps/<agentId>/<name>?preview=<id>`) to that pushed version, framed on its **own origin** `<slug>--p-<id>.apps.heylua.ai` under a **Preview** banner. Any version can be previewed (default: the latest push); a disabled app or one with no live version too. A second open of the same version hands back the open preview.
- **Isolated:** routes read the agent's `Data`, but every write, update and delete goes to a **copy** (copy-on-write) deleted when the preview ends. Emails and messages are **recorded, not sent** (`--effects <id>` lists them, needs `logs:read`). ⚠ A `fetch` (any outside network call) **fails with `TEST_EGRESS_BLOCKED`** and is not recorded — a route that calls a third party errors in a preview. `env()` works. `Products`, `Baskets`, `Orders`, `Templates`, `CDN` and `Jobs` answer `test_session_tier_unsupported`; `Workflows.viewer` answers `viewer_unavailable`.
- **Who:** anyone with **edit** access to the agent can open the link (shareable with another builder; they share the one copy of the data). Readers of the agent cannot.
- **Lifetime:** 24 h by default, `--ttl` up to 168 h; `--close <id>` ends it at once (copy and recorded effects deleted). Afterwards the link shows an ended notice and routes answer `PREVIEW_ENDED`.
- Refused with `WEB_APP_PREVIEW_NEEDS_AGENT_VERSION` (exit 10) when the agent has no agent version yet: the preview runs on the live agent version — tell the user to run `lua version create` once.
- Exit codes: 2 usage (two modes, malformed id, bad `--ttl`), 3 no such app / preview, 9 auth, 10 forbidden or refused, 11 platform unavailable.
- **The plugin's use:** it is safe to run — nothing goes live and nothing is sent — so after `lua push webapp` the plugin may offer it and, when the user wants to click through, run it and hand over the link. It is in no permission list, so Claude Code asks once before it runs. Never present a preview as "deployed": only `/lua-deploy webapp` makes a version live.

Refused before upload (`WebAppBuildError`): no `index.html` in `pages.root`; built `index.html` over **256 Ki characters**; more than **1000** assets; an asset over **8 MiB**; an asset path outside `assets/[A-Za-z0-9._-/]` or over 512 chars (rename the source file); more than **200** routes.

**Opening it** (after the promote): `https://workspace.heylua.ai/apps/<agentId>/<name>` (full page in Lua Workspace) and `https://admin.heylua.ai/admin/agents/<agentId>/apps` (the admin list). `agentId` is `agent.agentId` in `lua.skill.yaml`. Anyone who can read the agent can open its apps. The browser builds only — the native desktop app does not show web apps yet.

## 8. Limits (per request)

Wall clock 30 s by default (60 s cap) → `WALL_TIMEOUT` · request body **1 MB** · response **4 MB** → `RESPONSE_TOO_LARGE` · `CONCURRENCY_LIMIT` under load (retry with backoff in the page) · 200 routes, 1000 assets, 8 MiB per asset, 256 Ki-char entry HTML per version.

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No Vite installation found for …` | `npm install` never ran in `web/` | `npm --prefix src/apps/<name>/web install --ignore-scripts` |
| A route works in `lua test webapp` but errors in a preview with `TEST_EGRESS_BLOCKED` / `test_session_tier_unsupported` / `viewer_unavailable` | previews block outside calls and refuse those runtime objects (§7a) | expected in a preview; test that path with `lua test webapp` (live) or after the deploy |
| `lua compile` fails on JSX / React types | `src/apps/*/web` missing from `tsconfig.json` `exclude` (tsconfig had comments, `apps new` skipped it) | add `"src/apps/*/web"` to `exclude` |
| `❌ No web apps found` / `No web app named …` | app not in `webApps` on the `LuaAgent` | import it in `src/index.ts`, add to `webApps` |
| `defineWebApp(<n>): route key … must look like 'GET /path'` | key typo (`'get /x'`, two spaces, no leading `/`) | `'<METHOD> /<path>'` |
| 400 `VALIDATION` in `lua test webapp` | `--input` not wrapped in `{"body": …}`, or the body really fails the schema (`issues` says which) | wrap it; fix the data |
| Page shows nothing / CSP errors in the browser console | a CDN script, remote stylesheet or font, or `fetch` to another origin | bundle via npm; call the third party from a route; or add the origin to `pages.csp` |
| Page loops back to sign-in / `lua:auth:expired` | `lua.start()` never called, or the page stored and reused an old token | `void lua.start()` once in `main.tsx`; never persist tokens |
| Page ignores the Workspace accent or dark mode | hardcoded colours (palette classes, hex), or theme code in the page fighting app-client | semantic tokens only; drop the theme lines (`lua apps upgrade <name>` removes the template's) |
| Not sure who can call a route, or a page hides an action its route still allows | the access check lives only in the page, or nowhere | `/lua-audit <name>` lists every custom access condition and security finding (read-only) |
| A ui component / export is missing (`Failed to resolve import "@lua-ai-global/ui/…"`) | the installed ui is older than the catalog (the `ui` MCP server shows the latest) | the user runs `lua apps upgrade <name>`, then `lua apps dev <name>` to look the pages over |
| `Staged but NOT live yet` and the app still shows the old version | a push only stages | `/lua-deploy` → `webapp` (3.49.0+: scoped deploy; below: an agent version) |
| `APP_DISABLED` | an admin switched the app off | admin console → agent → Apps |
| `Set-Cookie` ignored, session lost between requests | cookies are dropped both ways | keep state in `Data`, identity in `auth` |

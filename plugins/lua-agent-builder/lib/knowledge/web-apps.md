# Web apps — pages and typed routes on an agent (lua-cli 3.42.0+ · read at 3.45.0)

Read from lua-cli `src/types/web-app.ts`, `src/commands/apps.ts`, `src/commands/test.ts` (`testWebApp`), `src/commands/push.ts`, `src/primitives/web-app.handler.ts`, `src/utils/web-app-build.ts`, `src/utils/web-app-route.ts` and `template-web-app/` at **3.45.0** (npm `latest` is 3.46.0 on 2026-10-06 — not re-read); the wire contract and limits from `@lua/shared-types` `web-route-contract.ts`; the page policy from lua-core `src/apps-gateway/web-app-html.ts`; the snapshot rule from lua-agents `agent-version.service.ts`. Product docs: docs.heylua.ai `/concepts/apps`, `/build/apps/quickstart`, `/build/apps/routes-and-pages`, `/reference/cli/apps`. Below lua-cli **3.42.0** `webapp` is not a push/test type and `lua apps` does not exist — `/lua-update` first.

"Web app" is the CLI's word (`defineWebApp`, `webApps`, `lua push webapp`); "Lua Apps" is the product name. Use "web app" in code, commands and messages.

---

## 1. The model in one paragraph

A **web app** is a primitive of one agent with two halves. **Pages**: a Vite + React project in `src/apps/<name>/web`, built by `lua push webapp` and served from the app's **own origin** (`https://<slug>.apps.heylua.ai`) inside Lua Workspace or the admin console. **Routes**: typed handlers in `src/apps/<name>/app.ts`, run on Lua in the same sandbox as tools — `Data`, `env()`, `fetch` — **as the signed-in person** (`auth`). The page calls a route with `lua.api(method, path, body?)` from `@lua-ai-global/app-client`. A pushed version is **staged only**: it goes live with the **agent version** that pins it, and promoting an earlier agent version rolls the app back.

| | Where | Runs | Built / checked by |
|---|---|---|---|
| Routes | `src/apps/<name>/app.ts` (`defineWebApp`) | Lua sandbox, `auth` = the person | `lua compile` (validates the definition), `lua test webapp` |
| Pages | `src/apps/<name>/web/` (Vite project) | browser, app's own origin, framed by the shell | `npm run typecheck`, `npm run build` (in `web/`); `lua push webapp` builds with that Vite |
| Registration | `webApps: [<binding>]` on `new LuaAgent({...})` in `src/index.ts` | — | an app not listed there is never compiled |

## 2. Scaffold — `lua apps new <name>`

- Run in the project root (where `lua.skill.yaml` is; otherwise exit 2 `No lua.skill.yaml here`). Name: `^[a-z][a-z0-9-]*$` (exit 2 otherwise). Never overwrites: an existing `src/apps/<name>` is exit 2. Non-interactive (no prompts).
- Writes `src/apps/<name>/app.ts` (one route, `GET /hello`) and `web/` (`index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `src/lua/client.ts`).
- Edits `src/index.ts` with an AST edit: imports the app as the camelCased name (`ops-dashboard` → `opsDashboard`) and appends it to `webApps`. When it cannot find the agent or `webApps` is not an array it prints the two lines instead (`⚠️ …add:`) — then add them yourself.
- Adds `src/apps/*/web` to `tsconfig.json` `exclude` so the agent build never loads the pages. A tsconfig with comments / trailing commas is left alone and the line is printed — add it yourself, or `lua compile` type-checks React code with the agent's settings and fails.
- Then, always: install the page dependencies — `npm --prefix src/apps/<name>/web install --ignore-scripts` (the plugin's hook approves exactly this form; the template builds without install scripts). Without it `lua push webapp` and `lua apps dev` fail: `No Vite installation found for <dir>. Install the page dependencies first`.

### Switch the page client to the package

lua-cli 3.42–3.45 scaffold a **copy** of the client at `web/src/lua/client.ts`. The supported form is the package (`@lua-ai-global/app-client`, 0.0.2 on 2026-10-06, same API). Right after scaffolding:

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
      handler: async ({ query }) => ({ items: (await Data.get('tickets', { filter: { status: query.status } })).data }),
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
- **`auth`**: `{ userId, orgId, agentId, subjectType: 'user', credentialType: 'firstPartySession', sessionId?, roles, scopes, name?, email?, expiresAt? }` — always a signed-in person, never an API key, never anonymous. Use `auth.userId` for "who did this" fields. **Locally `roles` and `scopes` are empty** (the gateway decides access) — never gate logic on them without a fallback you can test.
- **Schemas** (`params`, `query`, `body`) are Zod; a failure answers **400 `VALIDATION`** before the handler runs. `responses` is for the typed client only, not enforced.
- **Returns**: any JSON value → 200; `undefined` → 204; a `Response` as-is (`json(data, status, headers)` builds one). Response headers other than `content-type`, `cache-control`, `etag`, `location`, `content-disposition`, `content-language`, `x-lua-*` are dropped; **`set-cookie` is refused** — there are no cookie sessions, the client holds the session.
- **Platform errors** all carry `{ code, message, issues?, executionId? }` with `code` one of `VALIDATION NOT_FOUND METHOD_NOT_ALLOWED HANDLER_ERROR FORBIDDEN UNAUTHENTICATED APP_DISABLED CONCURRENCY_LIMIT WALL_TIMEOUT RESPONSE_TOO_LARGE PLATFORM_ERROR`. A handler's own error body passes through untouched — return `json({ code: 'NOT_FOUND', message }, 404)` rather than throwing (a throw surfaces as `HANDLER_ERROR`).
- `fetch: (request) => Response` is an escape hatch (Hono, itty-router) for paths no route matches; such paths lose schema validation and the typed client. Prefer `routes`.
- Data lives in the agent's `Data` collections, shared with its tools — a route and a tool that write `tickets` write the same rows.

## 4. Pages — the `web/` project

- Template stack: React 19, Vite 8, Tailwind v4 (`@tailwindcss/vite`), `@lua-ai-global/ui` (0.2.x; import per component, e.g. `@lua-ai-global/ui/button`, `/card`), `@phosphor-icons/react`. Use the UI package components and the theme tokens (`bg-background`, `text-foreground`, `text-muted-foreground`) so the app matches Lua and follows dark mode.
- **Client** (`import { lua, LuaApiError } from '@lua-ai-global/app-client'`): `lua.api<T>(method, path, body?)` → parsed JSON or throws `LuaApiError { status, code, message }`; `lua.appName`; `lua.theme`; `lua.onInit(init => …)` (theme / locale / path from the shell); **`void lua.start()` must run once in `main.tsx`** — it exchanges the one-time handoff code and tells the shell it is ready. A 401 renews the session once, then asks the shell for a new code; never store tokens (no cookie, no localStorage — a reload asks the shell again).
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

## 7. Shipping — staged, then live with an agent version

| Step | Command | Notes |
|---|---|---|
| Stage | `lua push webapp --ci --name <app> --force` | builds pages with `web/`'s Vite, uploads pages + route bundle, creates a web-app version. Ends `Staged but NOT live yet`. `--auto-deploy` does nothing for it. Bare `lua push` / `lua push all` include web apps |
| Live | `lua version create --ci -m "<notes>"` → `LUA_DEPLOY_CONFIRMED=1 lua version promote <N>` | `/lua-deploy` → `agent-version`. The snapshot pins the **latest pushed** version of every web app |
| Roll back | promote an earlier agent version | the app rolls back with it |
| Switch off | admin console → agent → Apps | an admin toggle; a disabled app answers `APP_DISABLED` |

Refused before upload (`WebAppBuildError`): no `index.html` in `pages.root`; built `index.html` over **256 Ki characters**; more than **1000** assets; an asset over **8 MiB**; an asset path outside `assets/[A-Za-z0-9._-/]` or over 512 chars (rename the source file); more than **200** routes.

**Opening it** (after the promote): `https://workspace.heylua.ai/apps/<agentId>/<name>` (full page in Lua Workspace) and `https://admin.heylua.ai/admin/agents/<agentId>/apps` (the admin list). `agentId` is `agent.agentId` in `lua.skill.yaml`. Anyone who can read the agent can open its apps. The browser builds only — the native desktop app does not show web apps yet.

## 8. Limits (per request)

Wall clock 30 s by default (60 s cap) → `WALL_TIMEOUT` · request body **1 MB** · response **4 MB** → `RESPONSE_TOO_LARGE` · `CONCURRENCY_LIMIT` under load (retry with backoff in the page) · 200 routes, 1000 assets, 8 MiB per asset, 256 Ki-char entry HTML per version.

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No Vite installation found for …` | `npm install` never ran in `web/` | `npm --prefix src/apps/<name>/web install --ignore-scripts` |
| `lua compile` fails on JSX / React types | `src/apps/*/web` missing from `tsconfig.json` `exclude` (tsconfig had comments, `apps new` skipped it) | add `"src/apps/*/web"` to `exclude` |
| `❌ No web apps found` / `No web app named …` | app not in `webApps` on the `LuaAgent` | import it in `src/index.ts`, add to `webApps` |
| `defineWebApp(<n>): route key … must look like 'GET /path'` | key typo (`'get /x'`, two spaces, no leading `/`) | `'<METHOD> /<path>'` |
| 400 `VALIDATION` in `lua test webapp` | `--input` not wrapped in `{"body": …}`, or the body really fails the schema (`issues` says which) | wrap it; fix the data |
| Page shows nothing / CSP errors in the browser console | a CDN script, remote stylesheet or font, or `fetch` to another origin | bundle via npm; call the third party from a route; or add the origin to `pages.csp` |
| Page loops back to sign-in / `lua:auth:expired` | `lua.start()` never called, or the page stored and reused an old token | `void lua.start()` once in `main.tsx`; never persist tokens |
| `Staged but NOT live yet` and the app still shows the old version | a web-app push never goes live alone | `/lua-deploy` → `agent-version` |
| `APP_DISABLED` | an admin switched the app off | admin console → agent → Apps |
| `Set-Cookie` ignored, session lost between requests | cookies are dropped both ways | keep state in `Data`, identity in `auth` |

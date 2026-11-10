# Web apps — pages and typed routes on an agent (lua-cli 3.42.0+ · read at 3.45.0; §7 deploy at 3.49.0; §7a preview at 3.51.0; §4 look and theme at 3.55.0; §4a live pages from app-client 0.1.2; §3 App Viewers at 3.65.0; §4b-§4c and §5a from the Lua Studio production test of 2026-11-09, ui 0.3.4)

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
- **App Viewers** (⏳ lua-cli 3.64.0+; `branding.icon` 3.65.0+): people outside the agent's team (reps, field staff, residents) who sign in by phone (WhatsApp code) or email to use **only this app**. Read from lua-cli `src/types/web-app.ts`, `src/api-exports.ts` (`Apps`), `src/interfaces/lua.ts` (`LuaAppAccess`) and `@lua/shared-types` `web-route-contract.ts` / `app-viewers.types.ts` on `main` (3.65.0). They only read (`accessLevel: 'view_only'`) unless the app asks for more in `defineWebApp`: `viewers: { write?: boolean, chat?: boolean, mode?: 'people' | 'app' }`.
  - **`write: true`**: they call your `POST`/`PUT`/`PATCH`/`DELETE` routes as `accessLevel: 'use'`, with empty `roles` and `scopes`. **`chat: true`**: they get the agent pane (needs `agentPane` on; their `auth.accessLevel` stays `'view_only'` unless `write` is asked too). **`mode`**: `'people'` (the default: an admin invites them in People) or `'app'` (your code adds and removes them, below). It is an ask, not a grant: the deploy shows what it opens, and in **Workspace → the app → App access** an editor or admin can turn changes, chat or App mode off (a new deploy never turns them back on). Direct shares and members of an org-wide app stay `view_only`. `viewers` must be a compile-time object of those keys (no spread, no computed key), or `lua compile` refuses it; an older lua-cli drops it silently.
  - **Their data is your job.** The platform gives each App Viewer their own pane thread, turns connections off and cuts platform tools to an allow list. That list still includes the **org memory** tools (`memory_search`, `memory_ask`, `memory_context`, `memory_list`, `memory_entity`, `memory_write`) and, when the agent's knowledge-base switch is on, `searchKnowledgeBase`, so with `chat: true` an App Viewer can ask about, and add to, what the organization's memory and knowledge base hold. The platform cannot tell whose `Data` row is whose either. Keep a **roster** collection (person → territory, team, shop) and scope every read to the caller. Ask `write: true` only when App Viewers must change records; for read-only use leave it out. With `write: true`, **every write route checks the record is the caller's** — `auth.userId`, or their scope in the roster — **and answers 404 when it is not**, and a write route meant only for the team (settings, imports, roster changes) refuses `auth.accessLevel === 'use'` with 404. `lua compile` refuses a write route that never reads `auth` while `write: true`:

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
  - **App mode** (`mode: 'app'`): `import { Apps } from 'lua-cli'`. `Apps.viewers.add(people)` (`{ phone, name? }` in international format, or `{ email }`; 1 to 20 a call) works **only in a `POST`/`PUT`/`PATCH`/`DELETE` route handler**, as the signed-in person, who must have **full access** to the app (never an App Viewer); anywhere else it throws `viewer_unavailable`. `Apps.viewers.remove(people, { app? })` works there too, and also in a **job, webhook or trigger** (anywhere else, including a `GET` route, a tool or a processor, it throws `viewer_unavailable`; `app` = the app's name or id when the agent has more than one in App mode) — a job may remove but never add. The app only ever removes people **its code added**: someone an admin added answers `not_added_by_app`. Someone an admin removed in People is `excluded` and the app cannot add them back; an admin's own invite of them lifts it. Each person gets an outcome in `results` (`added`, `alreadyMember`, `invalid_number`, `country_not_supported`, `invalid_email`, `excluded`, `cap_reached`, `rate_limited`, `not_added`; removing: `removed`, `not_found`, `not_added_by_app`, `invalid_number`, `invalid_email`) — show them to the person. `AppViewersError` rejects the whole call with `APP_MODE_OFF`, `APP_VIEWERS_NEED_FULL_ACCESS` or `APP_VIEWERS_CAP_REACHED`. Offline (`lua test`, `lua apps dev`) both throw `app_viewers_unavailable`, and a preview (§7a) refuses them with `test_session_write_refused`, so test App mode after a deploy.

  ```ts
  'POST /team': route({
    body: z.object({ phone: z.string().max(20), name: z.string().max(80).optional() }),
    handler: async ({ body, auth }) => {
      // Keep App Viewers out (the platform refuses them anyway). Check for 'use', not "!== 'full'":
      // accessLevel is absent locally (lua test webapp, lua apps dev), and absent means full.
      if (auth.accessLevel === 'use') return json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
      return json(await Apps.viewers.add([{ phone: body.phone, name: body.name }]));
    },
  }),
  ```
  - **Chat** (`chat: true`): an App Viewer's pane turn runs on its own thread, filed as a customer conversation (never in anyone's Workspace chats). The agent's **own skill tools all stay** on those turns, so any tool that reads or changes records about people (`Data` rows, an outside system called with `env()` keys, `User` / `Orders` / `Baskets`) scopes to the person: `Lua.request.appAccess` is `{ appId, accessLevel: 'full' | 'use' }` on every pane turn (stamped by the gateway; `'use'` = an App Viewer; absent on every other turn and offline) and `Lua.request.userId` is who is asking. The page drives the pane with `lua.pane` (§4).
  - **Branding and the sign-in link**: `branding: { name?, accent?, logo?, icon? }` on `defineWebApp`. `title` (else `branding.name`) and `accent` name and colour the app's own sign-in page; `logo` and `icon` are files inside the pages project (PNG, JPEG, WebP or SVG, at most 256 KB) that `lua push` uploads with the page assets — `logo` on the sign-in page, `icon` (square, keep what matters in the central 80%) on a phone's home screen when the app is installed from its link. A missing or unusable file is a push warning, never an error. Only an app whose live version sets `viewers` gets the branded page, at `https://workspace.heylua.ai/a/<link name>`: the app's slug works always; an editor or admin sets a shorter **link name** in Workspace → App access (3 to 63 lower-case letters, digits and dashes; unique; an old name keeps answering for 30 days). Give App Viewers that link.
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

  Either way, style only with ui's semantic tokens (`bg-background`, `text-foreground`, `text-muted-foreground`, `bg-card`, `bg-primary`, `text-primary-foreground`, `border-border`, `ring-ring`, and the colour tokens of §4d: `brand`, `success`, `warning`, `info`, `destructive`, `chart-1`…`chart-5`) — no palette classes (`bg-blue-500`) and no hex / `rgb()`, or the page ignores the accent and dark mode. `lua.theme`, `lua.accent`, `lua.hue` say what is applied.
- **Component catalog: the `ui` MCP server** (`https://ui.lua.dev/mcp`, public Storybook MCP, registered by this plugin): `mcp__plugin_lua-agent-builder_ui__list-all-documentation` lists every component, `mcp__plugin_lua-agent-builder_ui__get-documentation` (`id`: `"button"`, `"list-row"`, …) gives props, variants and example code, `mcp__plugin_lua-agent-builder_ui__get-documentation-for-story` one story's code. Look a component up before writing it. (Server key `ui`, kept short so every composed `mcp__plugin_<plugin>_<server>__<tool>` name stays within 64 characters.) **Fallback** when those tools are unavailable: read the installed package — the component list is the `exports` of `web/node_modules/@lua-ai-global/ui/package.json`, the props are in `web/node_modules/@lua-ai-global/ui/dist/components/{ui,lua}/<component>.d.ts`; never guess props. The catalog follows the **latest** ui: a component missing from the installed `web/node_modules/@lua-ai-global/ui` needs `lua apps upgrade <name>` first.
- **`lua apps upgrade <name>`** (lua-cli 3.54.0+; the ui 0.3 / app-client 0.1 raise and the theme-line removal from 3.55.0; `--dry-run`, `--ci`/`--force`, `--skip-install`) brings an app made by an older `lua apps new` up to the current template: raises `@lua-ai-global/ui` and `@lua-ai-global/app-client` to at least the template's ranges, removes the old template's theme lines from `main.tsx` (only when they are exactly the template's), swaps the copied `web/src/lua/` client for the package, takes out the bundled agent pane, then runs `npm install` in `web/`. ui 0.2 → 0.3 keeps every export and variant name, so no page code changes; afterwards the user looks the pages over with `lua apps dev <name>` (§6). It edits local files and installs packages, so the plugin's subagents do not run it — they name it for the user. Until an app is rebuilt on ui 0.3, the gateway restyles an older one (ui < 0.3) with the new tokens; upgrading is still the fix.
- **Client** (`import { lua, LuaApiError } from '@lua-ai-global/app-client'`): `lua.api<T>(method, path, body?)` → parsed JSON or throws `LuaApiError { status, code, message }`; `lua.appName`; `lua.theme` / `lua.accent`; `lua.onInit(init => …)` (locale / path from the shell; appearance is already applied); **`void lua.start()` must run once in `main.tsx`** — it exchanges the one-time handoff code, applies the shell's appearance and tells the shell it is ready. A 401 renews the session once, then asks the shell for a new code; never store tokens (no cookie, no localStorage — a reload asks the shell again).
- **The agent pane from the page** (app-client 0.0.5+): `lua.pane.open()`, `lua.pane.close()`, `lua.pane.ask(text, { context? })` (opens the pane and sends `text` as the person's next message; one turn at a time) and `lua.pane.setContext(value | () => value)` (what the agent sees with each pane turn, at most 4096 bytes as JSON: the record the person has open; a function is read at send time, so keep it a cheap read and return only what the agent may see). `await lua.chat.available()` says whether this person has the pane in this app — show a "Ask the agent" button only when it is `true` (an App Viewer gets it only when the app asks `viewers.chat` and App access allows it). `lua.chat.send` / `history` / `onTurnEnd` talk to the agent from the page itself, on the person's same thread.
- Paths given to `lua.api` are the route paths (`'/tickets'`), not `/_lua/api/...`.
- `pages.spa` defaults to `true`: client-side routing (React Router etc.) works; `pages.nav` entries should name the client routes.
- **The page CSP is strict and per request** (gateway `web-app-html.ts`): scripts and styles only from the app itself with a nonce (no CDN `<script>`, no remote stylesheet, no Google Fonts link, and no `<style>` element or style attribute a library writes at run time: §4c), `connect-src` = the app + Lua auth only, `frame-src 'none'`, images from self/`data:`/`blob:`/Lua CDN. Bundle dependencies with npm instead of linking them. When an external origin is truly needed, add it per directive in `pages.csp` — keys `scriptSrc styleSrc imgSrc connectSrc fontSrc frameSrc workerSrc`, values are source lists (`{ connectSrc: ['https://api.example.com'] }`); `frame-ancestors`, `base-uri`, `object-src` cannot be widened. Prefer calling third-party APIs **from a route** (server side, secrets in `env()`) over widening `connectSrc`.
- `vite.config.ts`: keep `react()` and `tailwindcss()`. `lua push webapp` overrides `base: '/'`, `build.outDir`, `assetsDir: 'assets'` and the CSP nonce — don't fight them (no custom `base`, no assets outside `assets/`).
- **Check after every page change**: `npm --prefix src/apps/<name>/web run typecheck`, then `npm --prefix src/apps/<name>/web run build`. That is the same Vite build the push runs; it catches type errors and missing imports. Visual check: the **user** runs `lua apps dev <name>` in their own terminal (§6).

### 4a. Keep pages live — re-read while the page is open

Nothing pushes a `Data` change to an open page: `@lua-ai-global/app-client` (0.1.2) has no subscription or polling helper, and `lua.chat.onTurnEnd` fires only for turns **this page** sent, never for a job, a workflow or another agent writing the rows. A page that loads once shows the state at load time for as long as it stays open (a production report: an agent shown at "part 2 of 8" for 30 minutes while it was at part 6). So any page that shows status, progress, queues or counts re-reads its routes:

- every **15 s while `document.visibilityState === 'visible'`**; nothing while the tab is hidden;
- **at once** when the page becomes visible again, and after each agent-pane turn (`lua.chat.onTurnEnd`);
- with **backoff** after `CONCURRENCY_LIMIT` (429) or a network error (double the wait, at most 2 minutes), back to 15 s after a success;
- keeping the **last data on screen** during a re-read (no skeleton flash), and showing when it last updated (**"Updated 20 s ago"**; past the staleness threshold, a banner says it is the last known state).

Each re-read is one route call (the route wall clock and concurrency limits of §8 apply), so poll the **one** route that feeds the view, not one per card, and keep it a snapshot read (no third-party call in the route). One hook in `web/src/useLive.ts` covers it:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { lua, LuaApiError } from '@lua-ai-global/app-client';

export function useLive<T>(path: string, everyMs = 15_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<LuaApiError | Error | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const wait = useRef(everyMs);
  const load = useCallback(async () => {
    try {
      setData(await lua.api<T>('GET', path));
      setAt(Date.now());
      setError(null);
      wait.current = everyMs;
    } catch (e) {
      setError(e as Error);
      wait.current = Math.min(wait.current * 2, 120_000); // CONCURRENCY_LIMIT / 429 / offline: back off
    }
  }, [path, everyMs]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gen = 0; // one polling loop only: a restart bumps gen, and an older tick never re-arms
    const tick = async (mine: number) => {
      if (document.visibilityState === 'visible') await load();
      if (mine === gen) timer = setTimeout(() => void tick(mine), wait.current);
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      void tick(++gen);
    };
    void tick(gen);
    document.addEventListener('visibilitychange', onVisible);
    const off = lua.chat.onTurnEnd(() => void load());
    return () => {
      gen++;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      off();
    };
  }, [load]);
  return { data, error, at, reload: load };
}
```

After a page action (approve, assign) call `reload()` instead of waiting for the next tick. Show `at` as relative time and `error` next to the data (the last data stays), never as an empty page.

### 4b. Fit a phone and a narrow pane

People open the app on a phone (390 CSS px wide), in Lua Studio's App pane (about 850 px on a laptop, 390 px on a phone) and full screen. The Lua Studio production test of 9 Nov 2026 found generated apps that broke all three: a bakery app 429 px wide in a 390 px phone (a `TabsList` row; its 1,128 px table already scrolled in its own box), a finance app whose page nav was clipped to "yment r", and an engineering app 1,104 px wide in an 848 px pane. The pane is the page's own viewport, so Tailwind's `sm:` / `md:` / `lg:` breakpoints follow the pane, not the screen. The bar:

- **Nothing scrolls the page sideways at 390 px.** `document.documentElement.scrollWidth` must not exceed `clientWidth` at 390 px or at 850 px. Only a table or a chart may scroll, inside its own box.
- **No fixed widths.** No `w-[…px]`, `min-w-[…px]`, `min-w-3xl` or `style={{ width: 1100 }}` wider than the phone. Use `w-full`, `max-w-*` and `min-w-0` on flex and grid children (a long word or a badge otherwise pushes the row wider). Put a desktop-only width behind `md:`.
- **Tables become stacked rows below `md:`.** ui's `Table` already scrolls in its own `overflow-x-auto` box, but a sideways-scrolling table is not usable on a phone. Render the rows as a list of cards below `md:` (`<ul className="md:hidden">` of `ListRow`s or small cards: the title, the status badge, the one or two numbers that matter and the row action) and the table from `md:` up (`<div className="hidden md:block">`).
- **Navs and tab rows wrap or scroll in their own box.** ui's `TabsList` is `inline-flex w-fit` with `whitespace-nowrap` triggers: with more than three tabs it widens the page. Give it `className="max-w-full overflow-x-auto"` (or swap it for a `Select` below `sm:`). A header that puts the title and the page nav in one `justify-between` row stacks them below `md:` (`flex flex-col gap-2 md:flex-row md:items-center`), and the nav row gets `flex-wrap` or `overflow-x-auto`, never `overflow-hidden` with `whitespace-nowrap`.
- **Grids start narrow.** `grid-cols-1` (or `2` for small stat tiles), then `md:grid-cols-3`/`4`; `StatGrid` already does this. Side panels and drawers become full-width sheets below `md:`.
- **Badge and button rows wrap** (`flex flex-wrap gap-2`), and touch targets are at least 40 px tall.
- **Titles wrap by word, and a sticky header is opaque.** Round 2 of the Studio test found a phone title that broke one word per line next to its buttons, and a sticky header the rows showed through. Put the page title on its own row above the actions below `md:` (`flex flex-col gap-2 md:flex-row`), give it `min-w-0 text-xl md:text-2xl` and never `break-all` or a fixed width. A `sticky top-0` header gets `bg-background` (or `bg-card`), a bottom `border-b` and `z-10`.
- **Keep the template's `<meta name="viewport" content="width=device-width, initial-scale=1">`** in `index.html`.
- **Check it.** You cannot see the page in a build session (no browser in the pod): check the code against this list, and the plugin's `check-webapp-release` hook does the same static check before `stage_for_test` and `request_release` (build-session.md §5). Never say the page fits a phone unless the user looked: ask them to open the App tab's phone view. On a laptop with a browser, `lua apps dev <name>` plus the browser's device toolbar at 390 × 844 (or a Playwright screenshot asserting no sideways scroll) is the real check.

### 4b2. Words and numbers on the page

Round 2 of the Studio test (10 Nov 2026) found "1 reviews", a banner saying "3 more" connections when there was 1, and a CSV import that ignored a "Valid until" column and still called the data "Fresh enough".

- **Counts agree with the word.** Pluralise with one helper (``const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;``), never a bare `s`.
- **A count is counted from the list it describes**, in the same render: `items.length`, never a constant or the length of another list ("3 more" when there is 1).
- **An import maps every column it reads.** Match headers case-insensitively, list the columns it did not use on the result ("Ignored: Valid until"), and base a freshness or validity verdict on the end date ("Valid until", "Expires", "End date") when the file has one, never on the import date alone.

### 4c. Styles the page CSP blocks

The gateway's per-request CSP allows a style only from the app's own files or with the page nonce (`style-src 'self' 'nonce-…'`). A library that adds a `<style>` element or a `style="…"` attribute at run time has no nonce, so the browser blocks it and logs `Applying inline style violates the following Content Security Policy directive`. The Studio test logged 20 to 67 of these per run (255 in all). Sonner accounts for 178 of them (hash-verified); on pages with charts, the rest most likely come from `ChartStyle` (the black series fit; those hashes vary per app and were not matched):

- **Toasts.** `@lua-ai-global/ui/sonner` (`Toaster`) uses `sonner`, which inserts its whole stylesheet as a `<style>` element when it is imported (the blocked hashes are those of an empty `<style>` and of sonner 2.0's CSS). The toasts then appear unstyled. The root barrel `import { … } from '@lua-ai-global/ui'` pulls the same module in, because ui marks it as having side effects. **Do not import `@lua-ai-global/ui/sonner`, `sonner` or the root barrel.** Import each component from its own path (`@lua-ai-global/ui/button`) and show an action's result inline, next to the action: a status line, an `Alert`, or the row's new badge.
- **Chart colours.** `ChartContainer` (`@lua-ai-global/ui/chart`) writes a `<style>` with `--color-<key>` variables for every config entry that has `color` or `theme`. It is blocked, the variables stay unset, and the series render black (the finance app's payment-run chart). Keep the config to `label`s (and `icon`s) and colour each series on the element with the theme's chart tokens: `<Bar dataKey="paid" fill="var(--chart-1)" />`, `<Line stroke="var(--chart-2)" />`. SVG presentation attributes are not styles and pass the CSP.
- Never build HTML with a `style` attribute or a `<style>` element (`dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, `setAttribute('style', …)`). The React `style` prop is fine: React sets it through the DOM, which the CSP allows. Tailwind classes are better still.

### 4d. Colour: polished, on the design system

Lua's founder on the generated apps: "very monochrome, with not much exciting colours". The cause is the tokens the pages used. In ui 0.3 (and 0.4) `--primary` is near-black, and the Workspace default accent (`mono`) keeps it black, so a page built only from `primary`, `muted`, `card` and `border` is grey whatever the person picked. Colour comes from the other tokens, which every theme defines in light and dark (ui `src/styles/globals.css`; app-client applies the person's accent to `--primary`, `--brand`, `--ring` and `--chart-1…5`):

| Token (Tailwind: `bg-*`, `text-*`, `border-*`, `fill-*`, `/10` tints) | What it is | Use it for |
|---|---|---|
| `brand` | Lua violet by default, the person's accent when they picked one | the app's identity: the header mark, the active nav item, the headline KPI's icon chip, the main series |
| `chart-1` … `chart-5` | a five-step ramp of the accent hue (light to deep) | chart series in order, and the icon chips of a row of KPI tiles |
| `success` | green | done, healthy, on track, a run that worked |
| `info` | blue | in progress, scheduled, waiting for the first run, neutral counts |
| `warning` | amber | needs a person, overdue, paused, stale data |
| `destructive` | red | **a real failure only**: a run that failed, an error the person must fix. Never for "pending", "not started", "no data yet", a low number or a rejected lead |

How to use them, still clean and flat:

- **KPI tiles have colour.** `Stat` takes only `label`, `value` and `sub`, so put the colour inside them: an icon chip in the label (`<span className="inline-flex size-7 items-center justify-center rounded-md bg-brand/10 text-brand"><ChartLineUp /></span>`), one chip colour per tile from `chart-1`…`chart-5` or by meaning (`bg-success/10 text-success` for "Qualified this week", `bg-warning/10 text-warning` for "Waiting for you"), and a coloured trend in `sub` (`text-success` up when up is good). A tile built from `Card` may also take a coloured top or left border (`border-t-2 border-t-brand`).
- **Charts have series colours** on the element (§4c): `<Area fill="var(--chart-2)" fillOpacity={0.25} stroke="var(--chart-2)" />`, bars of one series in `var(--brand)`, several series in `var(--chart-1)` … `var(--chart-5)` order. An outcome split uses meaning: `var(--success)` won, `var(--info)` open, `var(--warning)` stalled, `var(--destructive)` failed. Never leave a series black or grey.
- **Statuses are calm.** `Badge` variants `success`, `warning`, `secondary` and `outline`, plus `destructive` only for failures; an informational status is `secondary` or an `outline` badge with `text-info`. `Alert` has `success`, `warning`, `info` and `destructive` variants: an empty or not-yet-measured state is `info`, never `destructive`. Agent states: working is `success`, idle or scheduled is `info`, paused is `warning`, failed is `destructive`, unknown is `outline`.
- **Section headers and empty states** can carry one brand touch: a small `text-brand` icon beside the section title, an `EmptyState` with a brand-tinted icon.
- **Restraint.** One accent (`brand`) for identity, status colours only where they mean something, tints at `/10` to `/15` for fills, white space kept. No gradients over text, no rainbow of unrelated colours, no palette classes (`bg-amber-50`, even though one ui story shows it), no hex.
- Look a component up in the ui catalog before using it (§4); never invent a `tone`, `color` or `variant` it does not list.

### 4e. The status strip: is it running, and when?

Every generated web app shows, at the top of its home page (under the title, above the KPIs), a status strip that answers "is it working?" without the person asking the builder. One compact row per agent (stacked on a phone), from data the app can read, never invented:

- **State** of each agent: Live (`success`), Paused (`warning`), Error (`destructive`, only after a run that failed or a status row that says so), Unknown (`outline`) when no status row was read or it is older than its staleness limit.
- **Last run**: its time ("13:02") and result ("14 saved", "failed: the CRM refused the key"), from the newest run record.
- **Next run**: the time of the next scheduled run ("next 14:00"), worked out from the job's own schedule (keep the cron expression in one shared constant the job and the route both import), or "on demand" for agents without a schedule.
- **Records processed**: the count of the last run and today's total, counted from the run records.
- **Before any data**: "Waiting for first run at 13:00" (`info`), never 0, never an empty table without a reason.

Where the data comes from:

- **Each job writes one run record when it finishes** (and one when it fails), in its agent's `Data` (`job_runs`: `runId`, `job`, `startedAt`, `finishedAt`, `result: 'ok' | 'failed'`, `processed`, `message`), and logs the same one-line summary (build-session.md §5a reads it). A route reads `job_runs` of **its own agent only**.
- **Other agents of a fleet** reach the app through their status row (the fleet's `agent_status` row, key `status:latest`, read through the supervisor's supervision grant) or a `Data.shared` collection, never through their `job_runs`. So each agent puts its own `lastRun` (`at`, `result`, `processed`), `nextRunAt` and `todayProcessed` into its status row's `statusJson`, next to `state` and `now`. One vocabulary for both: the status row's `working` or `idle` shows as Live, `paused` or `frozen` as Paused, a failed last run as Error, and a missing, unreadable or stale row as Unknown.
- **One route feeds the strip** (`GET /status`), returning per agent `{ name, state, lastRun?: { at, result, processed }, nextRunAt?, todayProcessed, asOf }`, with `null` for what it could not read. Poll it with `useLive` (§4a).
- In a preview before any agent has run, the strip shows what the route returns: "Waiting for first run". Sample rows (§5a) never feed the strip.

```tsx
// web/src/StatusStrip.tsx — Badge variants from the ui catalog: success, warning, destructive, outline.
import { Badge } from '@lua-ai-global/ui/badge';
import { useLive } from './useLive';

type AgentStatus = {
  name: string;
  state: 'live' | 'paused' | 'error' | 'unknown';
  lastRun: { at: string; result: 'ok' | 'failed'; processed: number } | null;
  nextRunAt: string | null;
  todayProcessed: number | null;
};
const BADGE = { live: 'success', paused: 'warning', error: 'destructive', unknown: 'outline' } as const;
const LABEL = { live: 'Live', paused: 'Paused', error: 'Error', unknown: 'Unknown' } as const;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function StatusStrip() {
  const { data, error } = useLive<{ agents: AgentStatus[] }>('/status');
  if (!data) return <p className="text-sm text-muted-foreground">{error ? 'Status not available right now' : 'Reading status…'}</p>;
  return (
    <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
      {data.agents.map((a) => (
        <li key={a.name} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <span className="font-medium">{a.name}</span>
          <Badge variant={BADGE[a.state]}>{LABEL[a.state]}</Badge>
          {a.lastRun ? (
            <span className={a.lastRun.result === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
              Last run {time(a.lastRun.at)} · {a.lastRun.result === 'failed' ? 'failed' : `${a.lastRun.processed} processed`}
            </span>
          ) : (
            <span className="text-info">{a.nextRunAt ? `Waiting for first run at ${time(a.nextRunAt)}` : 'Waiting for first run'}</span>
          )}
          {a.lastRun && a.nextRunAt && <span className="text-muted-foreground">Next {time(a.nextRunAt)}</span>}
          {a.todayProcessed !== null && a.lastRun && <span className="text-muted-foreground">Today {a.todayProcessed}</span>}
        </li>
      ))}
    </ul>
  );
}
```

## 5. Testing routes — `lua test webapp`

```
lua test --ci webapp --name <app> --route '<METHOD> /path?query' [--input '{"body": {...}, "headers": {...}}'] --json
```

- ⚠ **`--input` wraps the body**: `{"body": {...}}`, not the raw body. `'{"title":"x"}'` sends **no body** (→ 400 `VALIDATION` on a route with a `body` schema).
- `--route` is required with `--json` (exit 2). Path params are filled from the path (`'POST /tickets/42/close'` matches `POST /tickets/:id/close`). A path no route matches is exit 2 listing the routes. A 5xx is exit 1. `--json` prints `{ status, headers, body: { kind: json|text|base64, value } }`.
- ⚠ **Live data.** `auth` is you (your user, the project's org and agent) and `Data` / `env()` are the **live** ones — a `POST`/`PUT`/`PATCH`/`DELETE` writes real rows. The plugin runs `GET` freely and asks once before any other method (`/lua-test` Step 2).
- ⚠ No web apps in the compiled output (app not in `webApps`) prints `❌ No web apps found` and exits **0** — a false pass. Check the output, not only the exit code.
- **In a live build session** (`build-session.md` §1; ⏳ platform update of Nov 2026): `lua test webapp` runs the route as the synthetic signed-in user `lua:build-session-test-user`, on the session's offline doubles, so no live data and no write is real. To test the **staged** version on Lua, call `mcp__lua-session__preview_webapp {name, route: '<METHOD> /path?query', body?}` after `stage_for_test`. It runs the route on the preview's isolated data, as the session test user (the owner's id, no roles or scopes), and returns `call: {route, status, headers, body}`. You cannot open the preview link: it needs the user's signed-in browser.

### 5a. Seed data, sample data and who did what

Pages often need rows before the agents have written any: sample leads, a sample payment run. The same code then runs on every release against the **live** app's rows, where people have acted on them. In the Studio test a release reshaped the sample payment runs, the user's approval was tied to the run's exact content, and the approved run went back to "Waiting for your sign-off".

- **Seed by a stable id, insert only when absent.** `const have = await Data.get('runs', { sampleKey: 'run-nov-8' }); if (!have.data.length) await Data.create('runs', { sampleKey: 'run-nov-8', sample: true, … });`. Never update, replace or delete an existing row from seed code, and never regenerate sample rows on a deploy (no clear-and-reseed, no copies shifted to `Date.now()`). Label sample rows (`sample: true`) and show them as "Sample data" on the page, never as real numbers.
- **Pages for agents that are not built yet** (build-session.md §5, build order) show sample rows under a "Sample data" banner that names what is missing ("Sample data: the Lead Scorer is not built yet"), and their actions are off with the reason in a tooltip. A page never calls a route or reads a collection nothing writes yet, and the live app never shows a broken page: wire it to live records when its agent passes its tests.
- **A row a person acted on is theirs.** A decision (approved, rejected, assigned, edited) is stored with the row id, who and when (`decidedBy: auth.userId`, `decidedAt`), and, if the decision depends on what they saw, the content beside it (`approvedTotal`, `approvedHash`), so a later change is shown as "changed since you approved" instead of silently clearing the approval.
- **Change shapes additively.** Add new fields with defaults and read the old shape as well; a migration only fills new fields. Never rename, drop or re-key a field that holds a person's decision. If a change truly has to reset their data, tell them before staging it and put it in the release summary (build-session.md §1, §5).
- **Who did what.** Every write route stamps where the record came from, so a build session's test calls never count as the user's work:

  ```ts
  // preview_webapp route calls (build session) run as the owner with sessionId 'build-session-test:<id>';
  // `lua test webapp` in a session runs as 'lua:build-session-test-user'.
  const source = auth.sessionId?.startsWith('build-session-test:') || auth.userId === 'lua:build-session-test-user' ? 'builder-test' : 'user';
  await Data.create('leads', { ...body, source, createdBy: auth.userId, createdAt: new Date().toISOString() });
  ```

  Headline numbers, KPIs, counts and charts filter out `source: 'builder-test'` (and `sample: true` once real rows exist); lists show those rows with a "Test" or "Sample" badge. A number with only test or sample rows behind it says "No measured data yet", never "0% (0 of 1)".

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

**Opening it** (after the promote): `https://workspace.heylua.ai/apps/<agentId>/<name>` (full page in Lua Workspace) and `https://admin.heylua.ai/admin/agents/<agentId>/apps` (the admin list). `agentId` is `agent.agentId` in `lua.skill.yaml`. Anyone who can read the agent can open its apps; someone the app was shared with, and an App Viewer (§3), opens only that app. App Viewers sign in at the app's own link, `https://workspace.heylua.ai/a/<link name>` (§3). The browser builds only — the native desktop app does not show web apps yet.

## 8. Limits (per request)

Wall clock 30 s by default (60 s cap) → `WALL_TIMEOUT` · request body **1 MB** · response **4 MB** → `RESPONSE_TOO_LARGE` · `CONCURRENCY_LIMIT` under load (retry with backoff in the page) · 200 routes, 1000 assets, 8 MiB per asset, 256 Ki-char entry HTML per version.

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No Vite installation found for …` | `npm install` never ran in `web/` | `npm --prefix src/apps/<name>/web install --ignore-scripts` |
| A route works in `lua test webapp` but errors in a preview with `TEST_EGRESS_BLOCKED` / `test_session_tier_unsupported` / `viewer_unavailable` | previews block outside calls and refuse those runtime objects (§7a) | expected in a preview; test that path with `lua test webapp` (live) or after the deploy |
| In a build session, `lua test webapp` says "this credential has no user", or you cannot open the preview link | an older platform (before the Nov 2026 update), or a link that needs the user's signed-in browser | call `preview_webapp {name, route}` (§5); on an older platform list the routes as not tested and ask the user to try them in the preview |
| `lua compile` fails on JSX / React types | `src/apps/*/web` missing from `tsconfig.json` `exclude` (tsconfig had comments, `apps new` skipped it) | add `"src/apps/*/web"` to `exclude` |
| `❌ No web apps found` / `No web app named …` | app not in `webApps` on the `LuaAgent` | import it in `src/index.ts`, add to `webApps` |
| `defineWebApp(<n>): route key … must look like 'GET /path'` | key typo (`'get /x'`, two spaces, no leading `/`) | `'<METHOD> /<path>'` |
| 400 `VALIDATION` in `lua test webapp` | `--input` not wrapped in `{"body": …}`, or the body really fails the schema (`issues` says which) | wrap it; fix the data |
| Page shows nothing / CSP errors in the browser console | a CDN script, remote stylesheet or font, or `fetch` to another origin | bundle via npm; call the third party from a route; or add the origin to `pages.csp` |
| Console: `Applying inline style violates … style-src 'self' 'nonce-…'`; toasts unstyled; chart series black | a `<style>` added at run time: `@lua-ai-global/ui/sonner` / `sonner` / the root `@lua-ai-global/ui` barrel, or a `ChartContainer` config with `color`/`theme` | §4c: no toast import, per-component imports, colours on the series (`fill="var(--chart-1)"`) |
| The page scrolls sideways on a phone, a nav is cut off, or the app is wider than the App pane | fixed widths, a `w-fit` `TabsList`, a no-wrap nav row with `overflow-hidden`, tables with no phone layout | §4b: `w-full`/`min-w-0`, `max-w-full overflow-x-auto` on tab rows, stacked rows below `md:` |
| An approval or edit the user made in the live app is gone after a release | seed or migration code rewrote the row (or the decision was tied to content the release changed) | §5a: insert-only seeds by a stable id, additive shape changes, decisions keyed to the row id |
| Page loops back to sign-in / `lua:auth:expired` | `lua.start()` never called, or the page stored and reused an old token | `void lua.start()` once in `main.tsx`; never persist tokens |
| Page ignores the Workspace accent or dark mode | hardcoded colours (palette classes, hex), or theme code in the page fighting app-client | semantic tokens only; drop the theme lines (`lua apps upgrade <name>` removes the template's) |
| Not sure who can call a route, or a page hides an action its route still allows | the access check lives only in the page, or nowhere | `/lua-audit <name>` lists every custom access condition and security finding (read-only) |
| A ui component / export is missing (`Failed to resolve import "@lua-ai-global/ui/…"`) | the installed ui is older than the catalog (the `ui` MCP server shows the latest) | the user runs `lua apps upgrade <name>`, then `lua apps dev <name>` to look the pages over |
| `Staged but NOT live yet` and the app still shows the old version | a push only stages | `/lua-deploy` → `webapp` (3.49.0+: scoped deploy; below: an agent version) |
| `APP_DISABLED` | an admin switched the app off | admin console → agent → Apps |
| `lua compile`: `Web app route "…" never reads a field of \`auth\`, but \`viewers: { write: true }\` lets App Viewers call it` | a write route with no ownership check while App Viewers may write | check the record is the caller's (§3) and answer 404 otherwise |
| `Apps.viewers` throws `app_viewers_unavailable` / `viewer_unavailable` / `test_session_write_refused` | offline (`lua test`, `lua apps dev`); called outside a `POST`/`PUT`/`PATCH`/`DELETE` route (`remove` alone also works in a job, webhook or trigger); or run in a preview (§7a), which never adds or removes anyone | test App mode after a deploy, not in a preview; add only from a write route |
| `APP_MODE_OFF` / `APP_VIEWERS_NEED_FULL_ACCESS` / `APP_VIEWERS_CAP_REACHED` | the live version does not ask `viewers.mode: 'app'` or App access turned it off; the caller is not a full-access person; the app has as many App Viewers as the workspace allows | deploy the version with `mode: 'app'` / ask an admin; let only full-access people reach the add route; an admin raises the cap in App access |
| An App Viewer sees no Chat button, or the pane answers 403 | the live version does not ask `viewers.chat`, `agentPane: false`, or App access turned chat off | ask `chat: true` and deploy; an editor or admin turns chat on in App access |
| The page shows old status or progress until it is reloaded | it read its routes once; nothing pushes `Data` changes to a page | re-read while visible, on return and after a pane turn, with backoff and "Updated N s ago" (§4a) |
| `Set-Cookie` ignored, session lost between requests | cookies are dropped both ways | keep state in `Data`, identity in `auth` |

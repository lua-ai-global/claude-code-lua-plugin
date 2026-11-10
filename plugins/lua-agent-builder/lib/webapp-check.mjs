// 1.20.5 — a static check of a session's web apps before they are staged or released (lib/knowledge/web-apps.md
// §4b-§4c and §5a). Lua Studio's 8-persona production test (9 Nov 2026) found:
//   - generated apps wider than the phone (bakery: 429 px in 390 px, a TabsList `w-fit` row; finance: the page nav
//     clipped to "yment r"; engineering: 1,104 px in an 848 px App pane);
//   - 20-67 CSP errors per run: sonner's `__insertCSS` (reached through `@lua-ai-global/ui/sonner` or the root barrel)
//     and the ui chart's `ChartStyle` add <style> elements without the page nonce, so the gateway's per-request
//     `style-src 'self' 'nonce-…'` blocks them (unstyled toasts, black chart series);
//   - seed code that rewrote sample rows on a release and reset a payment run the user had approved in the live app.
// A build-session pod has no browser, so a real 390 x 844 screenshot cannot be taken there; this is the static
// stand-in. It only ever warns (hooks/check-webapp-release.mjs): a heuristic never blocks a release.
// 1.20.8 adds the colour checks (palette classes; an app of numbers with no colour token: the founder's "very
// monochrome") and the status strip every app's home page carries (web-apps.md §4d-§4e).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-v2', 'build', '.git', '.lua', 'coverage']);
/** Agent code only: the pages (`src/apps/<name>/web`) are checked separately. */
const AGENT_SKIP_DIRS = new Set([...SKIP_DIRS, 'web']);
const PAGE_EXT = /\.(?:tsx|ts|jsx|js|css)$/;
const AGENT_EXT = /\.(?:ts|js|mjs)$/;
const MAX_FILES = 400;
const MAX_BYTES = 400_000;
/** Phone width the apps must fit (Lua Studio's phone frame and an iPhone 12-15 are 390 CSS px wide). */
export const PHONE_WIDTH = 390;

/** Findings shown per warning; the rest are counted. */
export const MAX_FINDINGS_SHOWN = 12;

function listFiles(dir, test, skip = SKIP_DIRS, out = [], depth = 0) {
  if (out.length >= MAX_FILES || depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!skip.has(e.name)) listFiles(full, test, skip, out, depth + 1);
    } else if (e.isFile() && test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function readSmall(file) {
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The agent project folders to check from a working directory: the folder itself when it has `src/`, else its
 * children that do (a fleet session's `/workspace/fleet`), and, when it sits inside a fleet, its sibling agents.
 * @param {string} cwd
 * @returns {string[]}
 */
export function agentRoots(cwd) {
  if (!cwd || !isDir(cwd)) return [];
  const roots = new Set();
  const childrenWithSrc = (dir) => {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      /* unreadable */
    }
    return names.map((n) => join(dir, n)).filter((p) => isDir(join(p, 'src')));
  };
  if (isDir(join(cwd, 'src'))) roots.add(cwd);
  else for (const c of childrenWithSrc(cwd)) roots.add(c);
  const parent = dirname(cwd);
  if (basename(parent) === 'fleet') for (const c of childrenWithSrc(parent)) roots.add(c);
  return [...roots];
}

/** `src/apps/<name>/web` folders under one agent project. */
export function webAppDirs(agentRoot) {
  const apps = join(agentRoot, 'src', 'apps');
  let names = [];
  try {
    names = readdirSync(apps);
  } catch {
    return [];
  }
  return names.map((n) => join(apps, n, 'web')).filter(isDir);
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Every `className="…"` / `className={'…'}` / cn('…') string with the line it starts on. */
function classStrings(text) {
  const out = [];
  const re = /className=(?:"([^"]*)"|'([^']*)'|\{\s*`([^`]*)`\s*\}|\{\s*["']([^"']*)["']\s*\})|\bcn\(\s*["'`]([^"'`]*)["'`]/g;
  for (const m of text.matchAll(re)) out.push({ cls: m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '', line: lineOf(text, m.index) });
  return out;
}

/**
 * Findings for one page source file (`web/src/**`).
 * @param {string} file — shown in the finding (relative path)
 * @param {string} text
 * @returns {Array<{rule: string, file: string, line: number, message: string}>}
 */
export function checkPageSource(file, text) {
  const out = [];
  const add = (rule, index, message) => out.push({ rule, file, line: typeof index === 'number' ? lineOf(text, index) : index, message });

  // CSP: style elements without the page nonce.
  for (const m of text.matchAll(/from\s+["'](@lua-ai-global\/ui\/sonner|sonner)["']/g)) {
    add('csp-toast', m.index, `imports ${m[1]}: sonner adds a <style> at import that the page CSP blocks (unstyled toasts, console errors). Show the result inline next to the action (an Alert or a status line) instead of a toast.`);
  }
  for (const m of text.matchAll(/from\s+["']@lua-ai-global\/ui["']/g)) {
    add('csp-barrel', m.index, 'imports the root @lua-ai-global/ui barrel: it pulls in the toaster, whose <style> the page CSP blocks. Import each component from its own path (@lua-ai-global/ui/button, /card, /table, …).');
  }
  if (/from\s+["']@lua-ai-global\/ui\/chart["']/.test(text)) {
    const m = /\b(?:color|theme)\s*:\s*(?:["'`{])/.exec(text);
    if (m) {
      add('csp-chart-colour', m.index, 'a chart config sets `color`/`theme`: ChartContainer then writes a <style> with the series colours, which the page CSP blocks (the series turn black). Keep the config to labels and colour each series on the element (`<Bar fill="var(--chart-1)" />`, `stroke="var(--chart-2)"`).');
    }
  }
  for (const m of text.matchAll(/setAttribute\(\s*["']style["']|dangerouslySetInnerHTML[^}]*(?:style=|<style)|(?:innerHTML|insertAdjacentHTML)[^;\n]*(?:style=|<style)/g)) {
    add('csp-inline-style', m.index, 'writes a style attribute or <style> as HTML: the page CSP blocks it. Use Tailwind classes, or the React `style` prop (set through the DOM, which the CSP allows).');
  }

  // Width: fixed widths wider than a phone, unless only from a breakpoint up.
  for (const { cls, line } of classStrings(text)) {
    for (const tok of cls.split(/\s+/)) {
      const m = /^((?:[a-z0-9]+:)*)(w|min-w|basis|grid-cols)-\[(\d+)px\]$/.exec(tok);
      if (m && !m[1] && Number(m[3]) > PHONE_WIDTH - 32) {
        add('fixed-width', line, `\`${tok}\` is wider than a ${PHONE_WIDTH} px phone: use w-full / max-w-* (or put the width behind md:).`);
      }
      const n = /^((?:[a-z0-9]+:)*)min-w-(md|lg|xl|[2-7]xl|screen-[a-z0-9]+)$/.exec(tok);
      if (n && !n[1]) add('fixed-width', line, `\`${tok}\` sets a minimum width wider than a phone: drop it or put it behind md:.`);
    }
    const cols = /(?:^|\s)grid-cols-([3-9]|1[0-2])(?:\s|$)/.exec(cls);
    if (cols && !/(?:^|\s)(?:sm|md|lg|xl|@[a-z]+):grid-cols-/.test(cls)) {
      add('grid-columns', line, `\`grid-cols-${cols[1]}\` on every width squeezes ${cols[1]} columns into a phone: start at grid-cols-1 (or 2) and add md:grid-cols-${cols[1]}.`);
    }
    if (/(?:^|\s)(?:whitespace-nowrap|text-nowrap)(?:\s|$)/.test(cls) && /(?:^|\s)overflow-hidden(?:\s|$)/.test(cls) && /(?:^|\s)flex(?:\s|$)/.test(cls)) {
      add('clipped-row', line, 'a no-wrap flex row with overflow-hidden clips its items on a phone (finance\'s nav read "yment r"): let it wrap (flex-wrap) or scroll in its own box (overflow-x-auto).');
    }
  }
  // Colour (1.20.8, web-apps.md §4d): palette classes and hex colours bypass the theme (accent, dark mode).
  for (const { cls, line } of classStrings(text)) {
    const tok = cls.split(/\s+/).find((t) => /^(?:[a-z0-9]+:)*(?:bg|text|border|fill|stroke|ring|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?$|^(?:[a-z0-9]+:)*(?:bg|text|border|fill|stroke)-\[#[0-9a-fA-F]{3,8}\]$/.test(t));
    if (tok) add('palette-colour', line, `\`${tok}\` is a fixed palette colour: it ignores the person's accent and dark mode. Use the theme's colour tokens (brand, chart-1…5, success, info, warning; destructive only for a failure), e.g. bg-success/10 text-success.`);
  }
  for (const m of text.matchAll(/\b(?:width|minWidth)\s*:\s*['"]?(\d{3,4})(?:px)?['"]?/g)) {
    if (Number(m[1]) > PHONE_WIDTH - 32) add('fixed-width', m.index, `a style width of ${m[1]} px is wider than a phone: use max-width with width: 100%.`);
  }

  // Tabs and navs: a w-fit tab row (the ui default) widens the page on a phone.
  for (const m of text.matchAll(/<TabsList\b([^>]*)>/g)) {
    if (!/overflow-x-auto|flex-wrap|max-w-full|w-full|hidden/.test(m[1])) {
      add('tabs-width', m.index, 'a <TabsList> is `inline-flex w-fit` and does not wrap: with more than 3 tabs it widens the page on a phone (the bakery app: 429 px in 390 px). Give it `max-w-full overflow-x-auto` (or a Select below sm:).');
    }
  }
  for (const m of text.matchAll(/<nav\b([^>]*)>/g)) {
    if (/className=/.test(m[1]) && !/flex-wrap|overflow-x-auto|flex-col|hidden|grid/.test(m[1])) {
      add('nav-width', m.index, 'a <nav> row neither wraps nor scrolls: on a phone it is clipped or widens the page. Use flex-wrap, overflow-x-auto, or put it under the title below md:.');
    }
  }

  // Tables: each needs a phone layout (stacked rows) or at least its own scroll box.
  if (/<(?:Table|table)\b/.test(text) && !/(?:^|[\s"'`])(?:sm|md|lg):(?:hidden|block|table|flex|grid)|(?:^|[\s"'`])hidden(?:\s|$)|matchMedia|useMediaQuery|useIsMobile/.test(text)) {
    const m = /<(?:Table|table)\b/.exec(text);
    add('table-phone', m.index, 'a table with no phone layout: on a phone it only scrolls sideways. Show the rows as stacked cards below md: (`md:hidden` list + `hidden md:block` table).');
  }
  return out;
}

/** A colour token in page code: the theme's accent, chart and status colours (web-apps.md §4d). */
const COLOUR_TOKEN = /(?:\b(?:bg|text|border|fill|stroke|ring|from|via|to|border-[trblxy])-(?:brand|success|info|warning|chart-[1-5])\b|var\(--(?:brand|success|info|warning|chart-[1-5])\)|variant=["'](?:success|warning|info)["'])/;
/** A page that shows numbers or charts: KPI tiles, a chart or a stat grid. */
const SHOWS_NUMBERS = /from\s+["']@lua-ai-global\/ui\/(?:chart|page)["']|from\s+["']recharts["']|<Stat(?:Grid)?\b/;
/** Signs of the status strip (web-apps.md §4e): its component, its route or its words. */
const STATUS_STRIP = /StatusStrip|['"`]\/status['"`]|Last run|Next run|first run/i;

/**
 * Findings for one web app as a whole (all of its `web/src` sources).
 * @param {string} appFile — shown in the finding (the app's main page, relative path)
 * @param {Array<{file: string, text: string}>} sources
 */
export function checkAppSources(appFile, sources) {
  const out = [];
  if (!sources.length) return out;
  const all = sources.map((s) => s.text).join('\n');
  if (SHOWS_NUMBERS.test(all) && !COLOUR_TOKEN.test(all)) {
    out.push({
      rule: 'monochrome',
      file: appFile,
      line: 1,
      message: 'the app shows numbers or charts but uses no colour token: in ui 0.3 `primary` is near-black, so the pages read grey ("very monochrome"). Give KPI tiles coloured icon chips (bg-brand/10 text-brand, bg-success/10 text-success), chart series their colours on the element (fill="var(--chart-2)"), and statuses success / info / warning badges (web-apps.md §4d).',
    });
  }
  if (!STATUS_STRIP.test(all)) {
    out.push({
      rule: 'status-strip',
      file: appFile,
      line: 1,
      message: 'no status strip: the home page should show each agent\'s state (live, paused, error), its last run (time and result), its next run, the records processed, and "Waiting for first run at HH:MM" before any data, from one GET /status route over the jobs\' run records (web-apps.md §4e).',
    });
  }
  return out;
}

/** Findings for a web app's index.html. */
export function checkIndexHtml(file, text) {
  if (/<meta[^>]+name=["']viewport["']/i.test(text)) return [];
  return [{ rule: 'viewport', file, line: 1, message: 'index.html has no `<meta name="viewport" content="width=device-width, initial-scale=1">`: phones render it as a 980 px desktop page.' }];
}

/**
 * Findings for agent (non-page) code: seed or sample code that rewrites or deletes rows. On a release it runs against
 * live Data, where those rows may carry a person's decision (finance: an approved payment run reset).
 */
export function checkAgentSource(file, text) {
  const seedish = /seed|sample|fixture|demo/i;
  if (!seedish.test(basename(file)) && !/function\s+\w*(?:seed|sample)\w*\s*\(|const\s+\w*(?:seed|sample)\w*\s*=\s*(?:async\s*)?\(/i.test(text)) return [];
  const out = [];
  for (const m of text.matchAll(/\bData\.(delete|update|patch|deleteMany|clear)\s*\(/g)) {
    out.push({
      rule: 'seed-rewrites',
      file,
      line: lineOf(text, m.index),
      message: `seed/sample code calls Data.${m[1]}: on a release this runs on the live app's rows. Insert missing sample rows by a stable id only; never change or delete a row a person acted on (approved, edited, assigned). A shape change is an additive migration (build-session.md §1, web-apps.md §5a).`,
    });
  }
  return out;
}

/**
 * Every finding for the agents under `cwd`.
 * @param {string} cwd
 */
export function checkWebApps(cwd) {
  const findings = [];
  for (const root of agentRoots(cwd)) {
    const rel = (f) => relative(cwd, f) || basename(f);
    for (const web of webAppDirs(root)) {
      const html = readSmall(join(web, 'index.html'));
      if (html !== null) findings.push(...checkIndexHtml(rel(join(web, 'index.html')), html));
      const sources = [];
      for (const f of listFiles(join(web, 'src'), (n) => PAGE_EXT.test(n))) {
        const text = readSmall(f);
        if (text === null) continue;
        sources.push({ file: rel(f), text });
        findings.push(...checkPageSource(rel(f), text));
      }
      const main = sources.find((x) => /App\.(?:tsx|jsx)$/.test(x.file))?.file ?? rel(join(web, 'src'));
      findings.push(...checkAppSources(main, sources));
    }
    for (const f of listFiles(join(root, 'src'), (n) => AGENT_EXT.test(n), AGENT_SKIP_DIRS)) {
      const text = readSmall(f);
      if (text !== null) findings.push(...checkAgentSource(rel(f), text));
    }
  }
  return findings;
}

/**
 * The warning for Claude, or null with nothing to say.
 * @param {Array<{rule: string, file: string, line: number, message: string}>} findings
 * @param {'stage'|'release'} when
 */
export function formatFindings(findings, when) {
  if (!findings.length) return null;
  const shown = findings.slice(0, MAX_FINDINGS_SHOWN).map((f) => `- ${f.file}:${f.line} [${f.rule}] ${f.message}`);
  const more = findings.length > MAX_FINDINGS_SHOWN ? [`- … and ${findings.length - MAX_FINDINGS_SHOWN} more of the same kinds.`] : [];
  const head =
    when === 'release'
      ? '[lua] Web-app check before this release (static: the session has no browser, so nothing was screenshotted). Fix these in the session and restage before the user relies on the release, or name them in the release summary:'
      : '[lua] Web-app check (static: the session has no browser, so nothing was screenshotted). Fix these before you request a release:';
  return [
    head,
    ...shown,
    ...more,
    `Phone width: the App pane is ${PHONE_WIDTH} px wide on a phone and about 850 px on a laptop; nothing may scroll the page sideways (web-apps.md §4b). Never say the page fits a phone unless the user checked it: you cannot see it.`,
  ].join('\n');
}

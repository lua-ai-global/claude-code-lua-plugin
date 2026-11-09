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
      for (const f of listFiles(join(web, 'src'), (n) => PAGE_EXT.test(n))) {
        const text = readSmall(f);
        if (text !== null) findings.push(...checkPageSource(rel(f), text));
      }
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

// Report build: markdown sections → report.md → HTML (pandoc, or the built-in renderer) → PDF (WeasyPrint).
// The pandoc -> HTML template -> WeasyPrint pipeline, in Node. A missing tool never fails the build:
// results.json and report.html are always written, and the PDF is skipped with a reason.

import { spawn as nodeSpawn } from 'node:child_process';
import { access, constants, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOutput } from '../../lua-cli.mjs';
import { QaError, parseArgs, emit, fail, writeJson, resolveRunDir } from '../io.mjs';
import { redactDeep, scrubEnv } from '../safety.mjs';
import { buildResults, loadRunData } from './results.mjs';
import { assembleReport, environmentLabel, htmlEscape, neutralise, tierLabel } from './sections.mjs';
import { renderMarkdown } from './mini-md.mjs';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), 'assets');
const TOOL_TIMEOUT_MS = 100_000;

export const INSTALL_HINTS = Object.freeze({
  darwin: 'brew install pandoc weasyprint',
  linux: 'sudo apt-get install -y pandoc && python3 -m pip install --user weasyprint',
  win32: 'winget install --id JohnMacFarlane.Pandoc -e  (then: py -m pip install weasyprint)',
});

// ---------------------------------------------------------------------------
// tool discovery
// ---------------------------------------------------------------------------

async function defaultWhich(bin, env = process.env, platform = process.platform) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['', ...String(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, bin + ext);
      try {
        if (!(await stat(full)).isFile()) continue;
        await access(full, constants.X_OK);
        return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * @param {{which?:(bin:string)=>Promise<string|null>}} [deps]
 */
export async function checkReportTools(deps = {}) {
  const which = deps.which ?? ((b) => defaultWhich(b));
  const pandoc = (await which('pandoc')) ?? null;
  const weasyprint = (await which('weasyprint')) ?? null;
  return { pandoc, weasyprint, pdf: Boolean(weasyprint), install: { ...INSTALL_HINTS } };
}

// ---------------------------------------------------------------------------
// template, css, chips
// ---------------------------------------------------------------------------

function replaceAll(s, token, value) {
  return s.split(token).join(value);
}

/**
 * @param {string} templateHtml assets/template.html
 * @param {{title:string, sub:string, preparedFor:string, date:string, environment?:string, pluginVersion:string, logoSvg:string|Buffer, tier?:string, verdict?:string}} v
 *   `title` is trusted HTML (the caller escapes each piece); the other values are escaped here. `tier` picks the
 *   cover badge (smoke, medium or production-ready; anything else is medium).
 */
export function buildTemplate(templateHtml, { title, sub, preparedFor, date, environment = '', pluginVersion, logoSvg, tier = 'medium', verdict = '' }) {
  const uri = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`;
  let t = templateHtml;
  t = replaceAll(t, '@@TITLE_HTML@@', title);
  t = replaceAll(t, '@@SUB@@', htmlEscape(sub));
  t = replaceAll(t, '@@PREPARED_FOR@@', htmlEscape(preparedFor));
  t = replaceAll(t, '@@DATE@@', htmlEscape(date));
  t = replaceAll(t, '@@ENVIRONMENT@@', htmlEscape(environment));
  t = replaceAll(t, '@@PLUGIN_VERSION@@', htmlEscape(pluginVersion));
  t = replaceAll(t, '@@TIER_HTML@@', tierBadge(tier));
  t = replaceAll(t, '@@VERDICT@@', htmlEscape(verdict));
  t = replaceAll(t, 'LOGO_URI', uri);
  return t;
}

/** Writes the footer into the @page rule, CSS-string-escaped. */
export function buildCss(css, { footer }) {
  const escaped = String(footer).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
  return replaceAll(css, '@@FOOTER@@', escaped);
}

const CHIPS = {
  PASS: '<span class="tag pass">Pass</span>',
  PARTIAL: '<span class="tag partial">Partial</span>',
  FAIL: '<span class="tag fail">Fail</span>',
  TIER_SMOKE: '<span class="tag tier-smoke">Smoke</span>',
  TIER_MEDIUM: '<span class="tag tier-medium">Medium</span>',
  TIER_PRODUCTION: '<span class="tag tier-production">Production-ready</span>',
};

/** The cover badge for a tier, in the same chip style as Pass / Partial / Fail. */
export function tierBadge(tier) {
  const key = { smoke: 'TIER_SMOKE', 'production-ready': 'TIER_PRODUCTION' }[tier] ?? 'TIER_MEDIUM';
  return CHIPS[key];
}

/** %%PASS|PARTIAL|FAIL%% and the tier markers → chip spans. Any other %%X%% that survives fails the build. */
export function replaceChips(html) {
  let s = html.replace(/%%(PASS|PARTIAL|FAIL|TIER_SMOKE|TIER_MEDIUM|TIER_PRODUCTION)%%/g, (_, k) => CHIPS[k]);
  // pandoc keeps the backslash of an escaped pipe inside code in a table cell
  s = s.replace(/\\\|/g, '|');
  const left = s.match(/%%[A-Z_]+%%/g);
  if (left) throw new QaError('CHIP_LEFT', 1, `unknown chip markers left in the report: ${[...new Set(left)].join(', ')}`, 'Only %%PASS%%, %%PARTIAL%%, %%FAIL%% and the %%TIER_…%% badges are allowed');
  return s;
}

// ---------------------------------------------------------------------------
// building
// ---------------------------------------------------------------------------

/** The cover's one-paragraph description, worded for the tier. */
export function coverSub(results, agent) {
  const s = results.summary;
  const n = results.config.runsPerCard;
  const times = n === 1 ? 'once' : `${n} times`;
  const tier = results.tier ?? 'medium';
  const label = tierLabel(tier).toLowerCase();
  // An agent with no workflows had no flow tests: the cover does not claim one.
  const noWorkflows = s.flowTests?.naReason === 'no workflows';
  const checks = tier === 'smoke'
    ? (noWorkflows ? 'direct tool tests and a log scan' : 'direct tool tests, a happy-path workflow test and a log scan')
    : (noWorkflows ? 'direct tool tests, a stress test and a log scan' : 'direct tool and workflow tests, a stress test and a log scan');
  const verdict = results.verdict?.text ?? `Overall result: ${s.overall}`;
  return `What a ${label} QA pass found out about ${agent}: ${s.cards.total} personas and attacks played ${times} each, ${checks}. ${verdict}.`;
}

function formatDate(d) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

function runTool(cmd, args, { cwd, timeoutMs = TOOL_TIMEOUT_MS }, deps) {
  const spawn = deps.spawn ?? nodeSpawn;
  const child = spawn(cmd, args, { cwd, env: scrubEnv(deps.env ?? process.env), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return collectOutput(child, timeoutMs);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function pandocArgs(title) {
  return [
    'report.md',
    '-f', 'markdown+pipe_tables+fenced_code_attributes+raw_html',
    '-t', 'html5',
    '--toc',
    '--toc-depth=2',
    '--shift-heading-level-by=-1',
    '--template=.template.built.html',
    '--metadata', `title=${title}`,
    '-c', 'prd.css',
    '-o', 'report.html',
  ];
}

/** Fills the pandoc template by hand when pandoc is missing. */
function renderWithMiniMd(md, builtTemplate, title) {
  const { html, toc } = renderMarkdown(md);
  let t = builtTemplate;
  t = t.replace(/\$for\(css\)\$[\s\S]*?\$endfor\$/, '<link rel="stylesheet" href="prd.css">');
  t = replaceAll(t, '$title$', htmlEscape(title));
  t = replaceAll(t, '$table-of-contents$', toc);
  t = replaceAll(t, '$body$', html);
  return t;
}

/**
 * @param {{runDir:string, noPdf?:boolean, publishDate?:string, deps?:object}} opts
 */
export async function buildReport({ runDir, noPdf = false, publishDate, deps = {} }) {
  const now = deps.now ?? (() => new Date());
  const warnings = [];
  const reportDir = join(runDir, 'report');
  const data = await loadRunData(runDir);

  let results;
  const resultsPath = join(reportDir, 'results.json');
  try {
    results = JSON.parse(await readFile(resultsPath, 'utf8'));
  } catch {
    // Same redaction as cliAggregate: grader quotes and turn excerpts must not carry a secret into any artifact.
    results = redactDeep(buildResults(data, { now }));
  }

  // 1. sections and report.md
  const { files, md } = assembleReport(results, data.cards);
  await mkdir(join(reportDir, 'sections'), { recursive: true });
  for (const f of files) await writeFile(join(reportDir, 'sections', f.name), f.md, 'utf8');
  await writeFile(join(reportDir, 'report.md'), md, 'utf8');

  // 2. diagrams
  for (const rel of data.diagramFiles) {
    const dest = join(reportDir, 'diagrams', ...rel.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(runDir, 'discovery', 'diagrams', ...rel.split('/')), dest);
  }

  // 3. template, css, logo
  const agent = results.agent?.name ?? 'agent';
  const s = results.summary;
  const titlePlain = neutralise(`QA report: ${agent}`);
  const logoSvg = await readFile(join(ASSETS, 'logo-dark.svg'));
  const template = buildTemplate(await readFile(join(ASSETS, 'template.html'), 'utf8'), {
    title: `QA report:<br>${htmlEscape(agent)}`,
    sub: coverSub(results, agent),
    preparedFor: `the owners of ${agent}`,
    date: publishDate ?? formatDate(now()),
    environment: environmentLabel(results),
    pluginVersion: results.plugin?.version ?? '',
    logoSvg,
    tier: results.tier ?? 'medium',
    verdict: results.verdict?.text ?? `Overall result: ${s.overall}`,
  });
  await writeFile(join(reportDir, '.template.built.html'), template, 'utf8');
  await writeFile(join(reportDir, 'prd.css'), buildCss(await readFile(join(ASSETS, 'prd.css'), 'utf8'), { footer: `Lua · QA report · ${agent}` }), 'utf8');
  await writeFile(join(reportDir, 'logo-dark.svg'), logoSvg);

  // 4. html
  const tools = await checkReportTools(deps);
  let renderer = 'mini-md';
  let html = null;
  if (tools.pandoc) {
    const res = await runTool(tools.pandoc, pandocArgs(titlePlain), { cwd: reportDir }, deps);
    if (res.exitCode === 0 && !res.timedOut && (await exists(join(reportDir, 'report.html')))) {
      html = await readFile(join(reportDir, 'report.html'), 'utf8');
      renderer = 'pandoc';
    } else warnings.push(`pandoc failed (exit ${res.exitCode}${res.timedOut ? ', timed out' : ''}); used the built-in renderer`);
  }
  if (html === null) html = renderWithMiniMd(md, template, titlePlain);

  // 5. chips
  html = replaceChips(html);
  try {
    await writeFile(join(reportDir, 'report.html'), html, 'utf8');
  } catch (err) {
    throw new QaError('HTML_WRITE_FAILED', 1, `could not write report.html: ${err.message}`);
  }

  // 6. pdf
  let pdf = null;
  let pdfSkippedReason = null;
  const pdfPath = join(reportDir, 'report.pdf');
  if (!noPdf) {
    await rm(pdfPath, { force: true });
    if (!tools.weasyprint) pdfSkippedReason = 'weasyprint-missing';
    else {
      const res = await runTool(tools.weasyprint, ['report.html', 'report.pdf'], { cwd: reportDir }, deps);
      for (const line of String(res.stderr ?? '').split('\n')) {
        if (line.trim() && !/Ignored|invalid value/.test(line)) warnings.push(`weasyprint: ${line.trim().slice(0, 200)}`);
      }
      if (res.exitCode === 0 && !res.timedOut && (await exists(pdfPath))) pdf = 'report/report.pdf';
      else pdfSkippedReason = `build-failed: ${res.timedOut ? 'timed out' : `exit ${res.exitCode}`}`;
    }
  } else await rm(pdfPath, { force: true });

  // 7. results.json (artifacts)
  const artifacts = { md: 'report/report.md', html: 'report/report.html', pdf, pdfSkippedReason };
  await writeJson(resultsPath, { ...results, artifacts });
  return { artifacts, renderer, warnings, tools, install: pdf ? null : tools.install };
}

const REPORT_SPEC = {
  'run-dir': { type: 'string', required: true },
  'no-pdf': { type: 'boolean' },
  'publish-date': { type: 'string' },
  json: { type: 'boolean' },
};

/** `report --run-dir D [--no-pdf] [--publish-date "<d MMMM yyyy>"]` */
export async function cliReport(argv, io, deps = {}) {
  try {
    const { values } = parseArgs(argv, REPORT_SPEC);
    const runDir = resolveRunDir(io, values['run-dir']);
    const r = await buildReport({ runDir, noPdf: values['no-pdf'] === true, publishDate: values['publish-date'], deps });
    const out = { ok: true, artifacts: r.artifacts, renderer: r.renderer, warnings: r.warnings };
    if (r.artifacts.pdfSkippedReason) {
      const missing = [!r.tools.pandoc ? 'pandoc' : null, !r.tools.weasyprint ? 'weasyprint' : null].filter(Boolean);
      if (missing.length) {
        out.install = r.tools.install[process.platform] ?? r.tools.install.darwin;
        out.hint = `The ${missing.join(' and ')} tool${missing.length > 1 ? 's are' : ' is'} missing. Ask the user before installing, then run: ${out.install}`;
      }
    }
    emit(io, out);
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

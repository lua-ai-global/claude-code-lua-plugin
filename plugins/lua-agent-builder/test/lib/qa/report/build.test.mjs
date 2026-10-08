import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { validate } from '../../../../lib/qa/schemas.mjs';
import { buildCss, buildReport, buildTemplate, checkReportTools, cliReport, defaultWhich, INSTALL_HINTS, pandocArgs, replaceChips } from '../../../../lib/qa/report/build.mjs';
import { makeIo, tmpRun } from './helpers.mjs';
import { PLUGIN_VERSION } from '../fixtures/plugin-version.mjs';

const NOW = () => new Date('2026-10-07T16:00:00.000Z');

/** Fake child_process.spawn: records calls, runs `effect` in the cwd, then exits with `exitCode`. */
function fakeSpawn(handlers) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const name = cmd.split('/').pop();
    const h = handlers[name] ?? {};
    setImmediate(async () => {
      if (h.effect) await h.effect(opts.cwd, args);
      if (h.stderr) child.stderr.emit('data', Buffer.from(h.stderr));
      child.emit('exit', h.exitCode ?? 0);
    });
    return child;
  };
  return { spawn, calls };
}

const which = (found) => async (bin) => found[bin] ?? null;

describe('checkReportTools', () => {
  it('uses deps.which and reports install lines', async () => {
    const t = await checkReportTools({ which: which({ pandoc: '/bin/pandoc', weasyprint: '/bin/weasyprint' }) });
    expect(t).toMatchObject({ pandoc: '/bin/pandoc', weasyprint: '/bin/weasyprint', pdf: true });
    expect(t.install).toEqual(INSTALL_HINTS);
    expect(INSTALL_HINTS.darwin).toBe('brew install pandoc weasyprint');
    const none = await checkReportTools({ which: which({}) });
    expect(none).toMatchObject({ pandoc: null, weasyprint: null, pdf: false });
    const undef = await checkReportTools({ which: async () => undefined });
    expect(undef.pandoc).toBeNull();
  });
  it('scans PATH for executables by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-which-'));
    // Windows runs only PATHEXT names, and has no execute bit to tell a bare file apart.
    const bin = join(dir, process.platform === 'win32' ? 'pandoc.EXE' : 'pandoc');
    await writeFile(bin, '#!/bin/sh\n');
    await chmod(bin, 0o755);
    await writeFile(join(dir, 'weasyprint'), 'not executable');
    await chmod(join(dir, 'weasyprint'), 0o644);
    await mkdir(join(dir, 'dirnamed'));
    const saved = process.env.PATH;
    process.env.PATH = `${join(dir, 'missing')}${delimiter}${dir}`;
    try {
      const t = await checkReportTools();
      expect(t.pandoc).toBe(bin);
      expect(t.weasyprint).toBeNull();
      expect(t.pdf).toBe(false);
    } finally {
      process.env.PATH = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('on Windows only PATHEXT names count, and a bare file without one does not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-which-win-'));
    try {
      await writeFile(join(dir, 'weasyprint'), 'no extension');
      await chmod(join(dir, 'weasyprint'), 0o755);
      await writeFile(join(dir, 'pandoc.EXE'), 'exe');
      await chmod(join(dir, 'pandoc.EXE'), 0o755);
      const env = { Path: dir, PATHEXT: '.COM;.EXE' };
      expect(await defaultWhich('pandoc', env, 'win32')).toBe(join(dir, 'pandoc.EXE'));
      expect(await defaultWhich('weasyprint', env, 'win32')).toBeNull();
      expect(await defaultWhich('pandoc', { Path: dir }, 'win32')).toBe(join(dir, 'pandoc.EXE'));
      expect(await defaultWhich('weasyprint', { PATH: dir }, 'linux')).toBe(join(dir, 'weasyprint'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('template, css and chips', () => {
  it('buildTemplate fills placeholders and embeds the logo, escaping values', () => {
    const out = buildTemplate('T:@@TITLE_HTML@@|@@SUB@@|@@PREPARED_FOR@@|@@DATE@@|@@ENVIRONMENT@@|@@PLUGIN_VERSION@@|LOGO_URI|$&', {
      title: 'A<br>B', sub: '<x> & "y"', preparedFor: 'me', date: '7 October 2026', pluginVersion: PLUGIN_VERSION, logoSvg: '<svg/>',
    });
    expect(out).toBe(`T:A<br>B|&lt;x&gt; &amp; &quot;y&quot;|me|7 October 2026||${PLUGIN_VERSION}|data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}|$&`);
  });
  it('buildCss writes a CSS-escaped footer', () => {
    expect(buildCss('a { content: "@@FOOTER@@"; }', { footer: 'Lua · QA "x" \\ y\nz' })).toBe('a { content: "Lua · QA \\"x\\" \\\\ y z"; }');
  });
  it('replaceChips swaps markers, repairs escaped pipes and refuses unknown markers', () => {
    expect(replaceChips('<td>%%PASS%% %%PARTIAL%% %%FAIL%%</td>')).toBe('<td><span class="tag pass">Pass</span> <span class="tag partial">Partial</span> <span class="tag fail">Fail</span></td>');
    expect(replaceChips('<code>a\\|b</code>')).toBe('<code>a|b</code>');
    expect(() => replaceChips('x %%LIVE%% y')).toThrow(expect.objectContaining({ code: 'CHIP_LEFT', exitCode: 1 }));
    expect(() => replaceChips('%%PASS%% %%NEXT_ONE%%')).toThrow(/NEXT_ONE/);
  });
  it('pandocArgs equals the contract argv', () => {
    expect(pandocArgs('QA report: X')).toEqual([
      'report.md', '-f', 'markdown+pipe_tables+fenced_code_attributes+raw_html', '-t', 'html5', '--toc', '--toc-depth=2', '--shift-heading-level-by=-1',
      '--template=.template.built.html', '--metadata', 'title=QA report: X', '-c', 'prd.css', '-o', 'report.html',
    ]);
  });
});

describe('buildReport', () => {
  let t;
  beforeEach(async () => { t = await tmpRun(); });
  afterEach(() => t.cleanup());

  const reportFile = (name) => join(t.dir, 'report', name);
  const read = (name) => readFile(reportFile(name), 'utf8');

  it('without pandoc or weasyprint: built-in renderer, html and results.json still written', async () => {
    const r = await buildReport({ runDir: t.dir, publishDate: '7 October 2026', deps: { which: which({}), now: NOW } });
    expect(r.renderer).toBe('mini-md');
    expect(r.artifacts).toEqual({ md: 'report/report.md', html: 'report/report.html', pdf: null, pdfSkippedReason: 'weasyprint-missing' });
    expect(r.install).toEqual(INSTALL_HINTS);
    const html = await read('report.html');
    expect(html).toContain('<div class="cover">');
    expect(html).toContain('Lua · Agent QA report');
    expect(html).toContain('<h1>QA report:<br>Demo Support Agent</h1>');
    expect(html).toContain('<div><b>Date</b> 7 October 2026</div>');
    expect(html).toContain('<div><b>Environment</b> the sandbox</div>');
    expect(html).toContain(`lua-agent-builder ${PLUGIN_VERSION}`);
    expect(html).toContain('<nav id="TOC" class="toc-page">');
    expect(html).toContain('<a href="#short-version" id="toc-short-version">The short version</a>');
    expect(html).toContain('<link rel="stylesheet" href="prd.css">');
    expect(html).toContain('<div class="lede">');
    expect(html).toContain('<div class="numbers">');
    expect(html).toContain('<span class="tag pass">Pass</span>');
    expect(html).toContain('<span class="tag partial">Partial</span>');
    expect(html).toContain('<span class="tag fail">Fail</span>');
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).not.toMatch(/%%[A-Z]+%%|@@|\$body\$|\$title\$|LOGO_URI/);
    expect(html).toContain('<title>QA report: Demo Support Agent</title>');
    // other files
    for (const f of ['report.md', 'prd.css', 'logo-dark.svg', '.template.built.html', 'diagrams/flow.svg', 'diagrams/skills/orders.svg', 'diagrams/workflows/refund.svg', 'sections/01-short-version.md', 'sections/12-appendix.md']) {
      await expect(stat(reportFile(f))).resolves.toBeTruthy();
    }
    expect(await read('prd.css')).toContain('content: "Lua · QA report · Demo Support Agent"');
    expect(await read('prd.css')).not.toContain('@@FOOTER@@');
    const results = JSON.parse(await read('results.json'));
    expect(validate('results', results).ok).toBe(true);
    expect(results.artifacts.pdfSkippedReason).toBe('weasyprint-missing');
  });

  it('with pandoc and weasyprint stubbed: the argv equal the contract and the env is scrubbed', async () => {
    const { spawn, calls } = fakeSpawn({
      pandoc: { effect: (cwd) => writeFile(join(cwd, 'report.html'), '<html><body>%%PASS%% <code>a\\|b</code></body></html>') },
      weasyprint: { effect: (cwd) => writeFile(join(cwd, 'report.pdf'), '%PDF-1.7'), stderr: 'WARNING: Ignored `x` invalid value\nreal warning\n' },
    });
    const env = { PATH: '/usr/bin', HOME: '/home/u', LUA_API_KEY: 'api_secret', OPENAI_API_KEY: 'sk-xyz' };
    const r = await buildReport({ runDir: t.dir, deps: { which: which({ pandoc: '/opt/pandoc', weasyprint: '/opt/weasyprint' }), spawn, env, now: NOW } });
    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe('/opt/pandoc');
    expect(calls[0].args).toEqual(pandocArgs('QA report: Demo Support Agent'));
    expect(calls[0].opts).toMatchObject({ cwd: join(t.dir, 'report'), shell: false });
    expect(calls[1].cmd).toBe('/opt/weasyprint');
    expect(calls[1].args).toEqual(['report.html', 'report.pdf']);
    expect(calls[1].opts.cwd).toBe(join(t.dir, 'report'));
    for (const c of calls) {
      expect(c.opts.env).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
      expect(c.opts.env).not.toHaveProperty('LUA_API_KEY');
    }
    expect(r.renderer).toBe('pandoc');
    expect(r.artifacts.pdf).toBe('report/report.pdf');
    expect(r.artifacts.pdfSkippedReason).toBeNull();
    expect(r.warnings).toEqual(['weasyprint: real warning']);
    expect(r.install).toBeNull();
    const html = await read('report.html');
    expect(html).toContain('<span class="tag pass">Pass</span> <code>a|b</code>');
    expect(JSON.parse(await read('results.json')).artifacts.pdf).toBe('report/report.pdf');
  });

  it('falls back to the built-in renderer when pandoc fails', async () => {
    const { spawn } = fakeSpawn({ pandoc: { exitCode: 3 } });
    const r = await buildReport({ runDir: t.dir, noPdf: true, deps: { which: which({ pandoc: '/x/pandoc' }), spawn, now: NOW } });
    expect(r.renderer).toBe('mini-md');
    expect(r.warnings[0]).toMatch(/pandoc failed \(exit 3\)/);
    expect(await read('report.html')).toContain('<div class="cover">');
    expect(r.artifacts.pdfSkippedReason).toBeNull();
  });

  it('falls back when pandoc exits 0 without writing html', async () => {
    const { spawn } = fakeSpawn({ pandoc: {} });
    const r = await buildReport({ runDir: t.dir, noPdf: true, deps: { which: which({ pandoc: '/x/pandoc' }), spawn, now: NOW } });
    expect(r.renderer).toBe('mini-md');
  });

  it('records build-failed when weasyprint fails, and removes a stale pdf', async () => {
    await mkdir(reportFile('.'), { recursive: true });
    await writeFile(reportFile('report.pdf'), 'stale');
    const { spawn } = fakeSpawn({ weasyprint: { exitCode: 1 } });
    const r = await buildReport({ runDir: t.dir, deps: { which: which({ weasyprint: '/x/weasyprint' }), spawn, now: NOW } });
    expect(r.artifacts.pdf).toBeNull();
    expect(r.artifacts.pdfSkippedReason).toBe('build-failed: exit 1');
    await expect(stat(reportFile('report.pdf'))).rejects.toThrow();
  });

  it('records build-failed when weasyprint exits 0 without a pdf', async () => {
    const { spawn } = fakeSpawn({ weasyprint: {} });
    const r = await buildReport({ runDir: t.dir, deps: { which: which({ weasyprint: '/x/weasyprint' }), spawn, now: NOW } });
    expect(r.artifacts.pdfSkippedReason).toBe('build-failed: exit 0');
  });

  it('--no-pdf never spawns weasyprint and drops a stale pdf', async () => {
    await mkdir(reportFile('.'), { recursive: true });
    await writeFile(reportFile('report.pdf'), 'stale');
    const { spawn, calls } = fakeSpawn({});
    const r = await buildReport({ runDir: t.dir, noPdf: true, deps: { which: which({ weasyprint: '/x/weasyprint' }), spawn, now: NOW } });
    expect(calls).toHaveLength(0);
    expect(r.artifacts).toMatchObject({ pdf: null, pdfSkippedReason: null });
    await expect(stat(reportFile('report.pdf'))).rejects.toThrow();
  });

  it('reuses an existing results.json (aggregate output) and defaults the date', async () => {
    const first = await buildReport({ runDir: t.dir, noPdf: true, deps: { which: which({}), now: NOW } });
    expect(first.artifacts.html).toBe('report/report.html');
    const results = JSON.parse(await read('results.json'));
    results.agent.name = 'Renamed Agent';
    await writeFile(reportFile('results.json'), JSON.stringify(results));
    await buildReport({ runDir: t.dir, noPdf: true, deps: { which: which({}), now: NOW } });
    const html = await read('report.html');
    expect(html).toContain('Renamed Agent');
    expect(html).toContain('<div><b>Date</b> 7 October 2026</div>');
  });

  it('neutralises a chip-like marker in agent text instead of failing the build', async () => {
    await buildReport({ runDir: t.dir, noPdf: true, deps: { which: which({}), now: NOW } });
    const results = JSON.parse(await read('results.json'));
    results.agent.name = 'x %%EVIL%% y';
    await writeFile(reportFile('results.json'), JSON.stringify(results));
    // the marker is neutralised everywhere it can enter the page, so the build still succeeds and shows the text
    const r = await buildReport({ runDir: t.dir, noPdf: true, deps: { which: which({}), now: NOW } });
    expect(r.artifacts.html).toBe('report/report.html');
    expect(await read('report.html')).not.toMatch(/%%EVIL%%/);
  });

  it('exits 1 with HTML_WRITE_FAILED when report.html cannot be written', async () => {
    await mkdir(reportFile('report.html'), { recursive: true });
    await expect(buildReport({ runDir: t.dir, noPdf: true, deps: { which: which({}), now: NOW } })).rejects.toMatchObject({ code: 'HTML_WRITE_FAILED', exitCode: 1 });
  });
});

describe('cliReport', () => {
  let t;
  beforeEach(async () => { t = await tmpRun(); });
  afterEach(() => t.cleanup());

  it('prints artifacts and an install hint, exit 0, when tools are missing', async () => {
    const io = makeIo();
    expect(await cliReport(['--run-dir', t.dir, '--publish-date', '1 January 2027'], io, { which: which({}), now: NOW })).toBe(0);
    const out = io.json();
    expect(out).toMatchObject({ ok: true, renderer: 'mini-md', artifacts: { pdf: null, pdfSkippedReason: 'weasyprint-missing' } });
    expect(out.hint).toMatch(/pandoc and weasyprint tools are missing/);
    expect(out.hint).toMatch(/Ask the user before installing/);
    expect(out.install).toBe(INSTALL_HINTS[process.platform] ?? INSTALL_HINTS.darwin);
  });
  it('stays quiet about installs when only --no-pdf was requested', async () => {
    const io = makeIo();
    expect(await cliReport(['--run-dir', t.dir, '--no-pdf'], io, { which: which({ pandoc: '/p', weasyprint: '/x/weasyprint' }), spawn: fakeSpawn({ pandoc: {} }).spawn, now: NOW })).toBe(0);
    expect(io.json()).not.toHaveProperty('install');
  });
  it('mentions only the missing tool', async () => {
    const io = makeIo();
    const { spawn } = fakeSpawn({ pandoc: { effect: (cwd) => writeFile(join(cwd, 'report.html'), '<html></html>') } });
    expect(await cliReport(['--run-dir', t.dir], io, { which: which({ pandoc: '/x/pandoc' }), spawn, now: NOW })).toBe(0);
    expect(io.json().hint).toMatch(/The weasyprint tool is missing/);
  });
  it('maps errors to exit codes', async () => {
    const bad = makeIo();
    expect(await cliReport([], bad)).toBe(2);
    const missing = makeIo();
    expect(await cliReport(['--run-dir', join(t.base, 'nope')], missing, { which: which({}) })).toBe(2);
    await mkdir(join(t.dir, 'report', 'report.html'), { recursive: true });
    const io = makeIo();
    expect(await cliReport(['--run-dir', t.dir, '--no-pdf'], io, { which: which({}), now: NOW })).toBe(1);
    expect(io.json().code).toBe('HTML_WRITE_FAILED');
  });
});

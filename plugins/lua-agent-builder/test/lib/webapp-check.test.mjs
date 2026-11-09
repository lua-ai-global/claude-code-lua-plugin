// 1.20.5 — lib/webapp-check.mjs: the static stand-in for a phone-width screenshot and the CSP check, from the
// Lua Studio 8-persona production test (9 Nov 2026).

import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentRoots,
  checkAgentSource,
  checkIndexHtml,
  checkPageSource,
  checkWebApps,
  formatFindings,
  MAX_FINDINGS_SHOWN,
  webAppDirs,
} from '../../lib/webapp-check.mjs';

const rules = (findings) => findings.map((f) => f.rule);

describe('checkPageSource: CSP', () => {
  test('a toast import (sonner injects a <style> the nonce CSP blocks)', () => {
    expect(rules(checkPageSource('a.tsx', "import { Toaster } from '@lua-ai-global/ui/sonner';"))).toEqual(['csp-toast']);
    expect(rules(checkPageSource('a.tsx', 'import { toast } from "sonner";'))).toEqual(['csp-toast']);
  });

  test('the root barrel, but not a per-component import', () => {
    expect(rules(checkPageSource('a.tsx', "import { Button } from '@lua-ai-global/ui';"))).toEqual(['csp-barrel']);
    expect(checkPageSource('a.tsx', "import { Button } from '@lua-ai-global/ui/button';")).toEqual([]);
  });

  test('a chart config with colours (ChartStyle), not one with labels only', () => {
    const coloured = "import { ChartContainer } from '@lua-ai-global/ui/chart';\nconst config = { paid: { label: 'Paid', color: 'var(--chart-1)' } };";
    expect(checkPageSource('c.tsx', coloured)).toMatchObject([{ rule: 'csp-chart-colour', line: 2 }]);
    const themed = "import { ChartContainer } from '@lua-ai-global/ui/chart';\nconst config = { paid: { label: 'Paid', theme: { light: '#000' } } };";
    expect(rules(checkPageSource('c.tsx', themed))).toEqual(['csp-chart-colour']);
    const labels = "import { ChartContainer } from '@lua-ai-global/ui/chart';\nconst config = { paid: { label: 'Paid' } };\n<Bar fill=\"var(--chart-1)\" />";
    expect(checkPageSource('c.tsx', labels)).toEqual([]);
    expect(checkPageSource('c.tsx', "const x = { color: 'red' };")).toEqual([]);
  });

  test('style attributes or <style> written as HTML', () => {
    expect(rules(checkPageSource('a.tsx', "el.setAttribute('style', 'width:1px')"))).toEqual(['csp-inline-style']);
    expect(rules(checkPageSource('a.tsx', '<div dangerouslySetInnerHTML={{ __html: "<b style=x>" }} />'))).toEqual(['csp-inline-style']);
    expect(rules(checkPageSource('a.tsx', 'el.innerHTML = `<style>a{}</style>`;'))).toEqual(['csp-inline-style']);
    expect(checkPageSource('a.tsx', '<div style={{ width: "100%" }} />')).toEqual([]);
  });
});

describe('checkPageSource: phone width', () => {
  test('fixed widths wider than a phone, unless behind a breakpoint', () => {
    expect(checkPageSource('a.tsx', '<div className="w-[1100px] p-4" />')).toMatchObject([{ rule: 'fixed-width', line: 1 }]);
    expect(rules(checkPageSource('a.tsx', "<div className='min-w-[480px]' />"))).toEqual(['fixed-width']);
    expect(rules(checkPageSource('a.tsx', '<div className={`min-w-3xl`} />'))).toEqual(['fixed-width']);
    expect(rules(checkPageSource('a.tsx', "<div className={cn('min-w-screen-md', x)} />"))).toEqual(['fixed-width']);
    expect(rules(checkPageSource('a.tsx', "<div className={'basis-[600px]'} />"))).toEqual(['fixed-width']);
    expect(checkPageSource('a.tsx', '<div className="md:w-[1100px] w-full w-[320px] md:min-w-3xl" />')).toEqual([]);
    expect(rules(checkPageSource('a.tsx', '<div style={{ minWidth: 1104 }} />'))).toEqual(['fixed-width']);
    expect(rules(checkPageSource('a.tsx', "<div style={{ width: '960px' }} />"))).toEqual(['fixed-width']);
    expect(checkPageSource('a.tsx', '<div style={{ width: 120 }} />')).toEqual([]);
  });

  test('grid columns on every width', () => {
    expect(rules(checkPageSource('a.tsx', '<div className="grid grid-cols-4 gap-4" />'))).toEqual(['grid-columns']);
    expect(checkPageSource('a.tsx', '<div className="grid grid-cols-1 md:grid-cols-4" />')).toEqual([]);
    expect(checkPageSource('a.tsx', '<div className="grid grid-cols-2" />')).toEqual([]);
  });

  test('a no-wrap clipped flex row (finance: "yment r")', () => {
    expect(rules(checkPageSource('a.tsx', '<div className="flex whitespace-nowrap overflow-hidden" />'))).toEqual(['clipped-row']);
    expect(checkPageSource('a.tsx', '<div className="flex whitespace-nowrap overflow-x-auto" />')).toEqual([]);
  });

  test('a TabsList that neither wraps nor scrolls (bakery: 429 px in 390 px)', () => {
    expect(rules(checkPageSource('a.tsx', '<TabsList>\n<TabsTrigger value="a">A</TabsTrigger></TabsList>'))).toEqual(['tabs-width']);
    expect(checkPageSource('a.tsx', '<TabsList className="max-w-full overflow-x-auto">')).toEqual([]);
  });

  test('a nav row with classes that neither wraps nor scrolls', () => {
    expect(rules(checkPageSource('a.tsx', '<nav className="flex gap-2">'))).toEqual(['nav-width']);
    expect(checkPageSource('a.tsx', '<nav className="flex flex-wrap gap-2">')).toEqual([]);
    expect(checkPageSource('a.tsx', '<nav>')).toEqual([]);
  });

  test('a table with no phone layout', () => {
    expect(checkPageSource('a.tsx', 'x\n<Table>\n</Table>')).toMatchObject([{ rule: 'table-phone', line: 2 }]);
    expect(checkPageSource('a.tsx', '<div className="hidden md:block"><Table></Table></div><ul className="md:hidden" />')).toEqual([]);
    expect(checkPageSource('a.tsx', 'const m = useIsMobile(); <table />')).toEqual([]);
  });
});

describe('checkIndexHtml', () => {
  test('needs the viewport meta', () => {
    expect(rules(checkIndexHtml('index.html', '<head></head>'))).toEqual(['viewport']);
    expect(checkIndexHtml('index.html', '<meta name="viewport" content="width=device-width, initial-scale=1" />')).toEqual([]);
  });
});

describe('checkAgentSource: seed code that rewrites rows', () => {
  test('a seed file or function that updates or deletes', () => {
    expect(checkAgentSource('src/seed.ts', 'await Data.delete("runs", id);')).toMatchObject([{ rule: 'seed-rewrites', line: 1 }]);
    expect(rules(checkAgentSource('src/tools/x.ts', 'async function seedSample() {\n await Data.update("runs", id, row);\n}'))).toEqual(['seed-rewrites']);
    expect(rules(checkAgentSource('src/x.ts', 'const loadSampleRuns = async () => { await Data.patch("runs", id, {}); }'))).toEqual(['seed-rewrites']);
  });

  test('insert-only seeds and non-seed code pass', () => {
    expect(checkAgentSource('src/seed.ts', 'if (!(await exists(id))) await Data.create("runs", row);')).toEqual([]);
    expect(checkAgentSource('src/tools/approve.ts', 'await Data.update("runs", id, row);')).toEqual([]);
  });
});

describe('the folders it reads', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lua-webapp-check-'));
    // A fleet: /fleet/manager (an app) and /fleet/intake (agent code only), plus a file where a folder is expected.
    const web = join(dir, 'fleet', 'manager', 'src', 'apps', 'desk', 'web');
    mkdirSync(join(web, 'src', 'pages'), { recursive: true });
    mkdirSync(join(web, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<html><head></head></html>');
    writeFileSync(join(web, 'src', 'pages', 'Runs.tsx'), '<TabsList>\n');
    writeFileSync(join(web, 'node_modules', 'x', 'index.js'), "import 'sonner';");
    writeFileSync(join(web, 'src', 'big.tsx'), 'x'.repeat(400_001));
    writeFileSync(join(dir, 'fleet', 'manager', 'src', 'apps', 'notes.txt'), '');
    const intake = join(dir, 'fleet', 'intake', 'src');
    mkdirSync(intake, { recursive: true });
    writeFileSync(join(intake, 'sample-data.ts'), 'await Data.delete("leads", id);');
    mkdirSync(join(dir, 'fleet', 'plain'), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('agentRoots: the folder, its children (fleet root) or its fleet siblings', () => {
    const fleet = join(dir, 'fleet');
    const both = [join(fleet, 'intake'), join(fleet, 'manager')];
    expect(agentRoots(join(fleet, 'manager')).sort()).toEqual(both);
    expect(agentRoots(fleet).sort()).toEqual(both);
    expect(agentRoots(join(dir, 'nope'))).toEqual([]);
    expect(agentRoots('')).toEqual([]);
  });

  test('webAppDirs: only src/apps/<name>/web folders', () => {
    expect(webAppDirs(join(dir, 'fleet', 'manager'))).toEqual([join(dir, 'fleet', 'manager', 'src', 'apps', 'desk', 'web')]);
    expect(webAppDirs(join(dir, 'fleet', 'intake'))).toEqual([]);
  });

  test('checkWebApps: pages, index.html and seed code; skips node_modules and huge files', () => {
    const found = checkWebApps(join(dir, 'fleet', 'manager'));
    expect(rules(found).sort()).toEqual(['seed-rewrites', 'tabs-width', 'viewport']);
    expect(found.find((f) => f.rule === 'tabs-width').file).toBe(join('src', 'apps', 'desk', 'web', 'src', 'pages', 'Runs.tsx'));
    expect(found.find((f) => f.rule === 'seed-rewrites').file).toBe(join('..', 'intake', 'src', 'sample-data.ts'));
  });
});

describe('formatFindings', () => {
  const f = (i) => ({ rule: 'fixed-width', file: `a${i}.tsx`, line: i, message: 'too wide' });
  test('null with nothing to say', () => {
    expect(formatFindings([], 'stage')).toBeNull();
  });
  test('caps the list and counts the rest', () => {
    const text = formatFindings(Array.from({ length: MAX_FINDINGS_SHOWN + 3 }, (_, i) => f(i)), 'release');
    expect(text.split('\n').filter((l) => l.startsWith('- a'))).toHaveLength(MAX_FINDINGS_SHOWN);
    expect(text).toContain('… and 3 more');
    expect(text).toContain('390 px');
  });
});

import { describe, test, expect } from '@jest/globals';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { buildFlowModel } from '../../../../lib/qa/discovery/flow-model.mjs';
import {
  layoutTree, flowDiagramSvg, decisionTreeSvg, branchTreeSvg, previewHtml, outlineMarkdown, cliDiagrams,
} from '../../../../lib/qa/discovery/diagrams.mjs';

const fx = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/manifests/${name}`, import.meta.url)), 'utf8'));
const model = buildFlowModel({
  manifest: fx('full.json'), status: fx('status.json'), versions: fx('versions.json'), workflows: fx('workflows-list.json'), views: { 'view-only': fx('view-only.view.json') },
});
const wf = (name) => model.workflows.find((w) => w.name === name);

function makeIo() {
  const out = [];
  const err = [];
  return { io: { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, cwd: '/', env: {} }, json: () => JSON.parse(out.join('').trim().split('\n').pop()) };
}

const wellFormed = (svg) => {
  expect(svg.startsWith('<svg ')).toBe(true);
  expect(svg.endsWith('</svg>')).toBe(true);
  const open = (svg.match(/<(rect|text|path|polygon|circle|marker|defs|svg)\b/g) || []).length;
  expect(open).toBeGreaterThan(5);
  expect(svg).not.toMatch(/undefined|NaN|\[object/);
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  expect(Number(vb[1])).toBeGreaterThan(100);
};

describe('layoutTree', () => {
  const tree = { id: 'r', label: 'root', children: [{ id: 'a', label: 'a', edge: 'x', children: [{ id: 'a1', label: 'a1' }, { id: 'a2', label: 'a2' }] }, { id: 'b', label: 'b' }] };

  test('top-down: depth on y, parents centred over children', () => {
    const l = layoutTree(tree, { nodeW: 100, nodeH: 40, hGap: 10, vGap: 20 });
    const by = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect(by.r.y).toBe(0);
    expect(by.a.y).toBe(60);
    expect(by.a1.y).toBe(120);
    expect(by.a.x).toBe((by.a1.x + by.a2.x) / 2);
    expect(l.edges).toHaveLength(4);
    expect(l.edges).toEqual(expect.arrayContaining([{ from: 'r', to: 'a', label: 'x' }, { from: 'a', to: 'a1', label: '' }, { from: 'a', to: 'a2', label: '' }, { from: 'r', to: 'b', label: '' }]));
    expect(l.width).toBe(3 * 100 + 2 * 10);
    expect(l.height).toBe(3 * 40 + 2 * 20);
  });

  test('left-to-right: depth on x', () => {
    const l = layoutTree(tree, { nodeW: 100, nodeH: 40, hGap: 10, vGap: 20, orientation: 'right' });
    const by = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect(by.a.x).toBe(110);
    expect(by.a1.x).toBe(220);
    expect(l.width).toBe(3 * 100 + 2 * 10);
    expect(l.height).toBe(3 * 40 + 2 * 20);
  });

  test('a single node and default sizes', () => {
    const l = layoutTree({ id: 'only', label: 'x' });
    expect(l.nodes).toHaveLength(1);
    expect(l.width).toBe(190);
    expect(l.edges).toEqual([]);
  });
});

describe('flowDiagramSvg', () => {
  test('draws the agent, skills, tools, processors and entry points', () => {
    const svg = flowDiagramSvg(model);
    wellFormed(svg);
    for (const s of ['sample-support', 'orders', 'get_order_status', 'language-detect', 'tone-check', 'nightly-sync', 'order-shipped', 'refund-review', 'crm', 'tool may change data']) {
      expect(svg).toContain(s);
    }
  });
  test('width stays within 1200 and output is deterministic', () => {
    const svg = flowDiagramSvg(model);
    expect(Number(/viewBox="0 0 ([\d.]+)/.exec(svg)[1])).toBeLessThanOrEqual(1200);
    expect(flowDiagramSvg(model)).toBe(svg);
  });
  test('an empty agent still renders', () => {
    const svg = flowDiagramSvg({ agent: { name: '', model: null, personaExcerpt: '' }, skills: [], processors: { pre: [], post: [] } });
    wellFormed(svg);
    expect(svg).toContain('no skills');
    expect(svg).toContain('no preprocessors');
    expect(svg).toContain('no postprocessors');
    expect(svg).toContain('persona not found');
    expect(svg).toContain('model not set');
    wellFormed(flowDiagramSvg({}));
  });
  test('caps skills and tools and says what was left out', () => {
    const skills = Array.from({ length: 16 }, (_, i) => ({ name: `skill${i}`, description: '', context: '', tools: Array.from({ length: 10 }, (__, j) => ({ name: `tool${i}_${j}`, sideEffect: j % 3 ? 'none' : 'likely' })) }));
    const svg = flowDiagramSvg({ agent: { name: 'big' }, skills, processors: { pre: [{ name: 'p1' }, { name: 'p2' }], post: [{ name: 'q1' }] } });
    wellFormed(svg);
    expect(svg).toContain('+ 2 more skills not drawn');
    expect(svg).toContain('+ 2 more tools');
  });
  test('agent text is escaped', () => {
    const evil = { agent: { name: '<script>alert(1)</script>', model: 'm"x', personaExcerpt: '</text><rect/>' }, skills: [{ name: 'a&b', tools: [] }], processors: { pre: [], post: [] } };
    const svg = flowDiagramSvg(evil);
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('</text><rect/>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('a&amp;b');
  });
});

describe('decisionTreeSvg', () => {
  test('one decision per tool, a read-only and a may-change leaf, and the fallback', () => {
    const svg = decisionTreeSvg(model.skills[0]);
    wellFormed(svg);
    for (const s of ['orders', 'get_order_status', 'calls cancel_order', 'no tool', 'answer from the persona', 'needs orderId, amount', 'request matches']) {
      expect(svg).toContain(s);
    }
  });
  test('a skill with a condition and one with no tools', () => {
    wellFormed(decisionTreeSvg(model.skills[1]));
    const bare = { name: 'bare', tools: [], decisionTree: { id: 's', kind: 'skill', label: 'bare', sub: '', children: [] } };
    wellFormed(decisionTreeSvg(bare));
  });
  test('accepts an explicit tree and a tree of unknown kinds', () => {
    wellFormed(decisionTreeSvg({ name: 'x' }, { id: 'r', kind: 'mystery', label: 'r', children: [{ id: 'c', kind: 'other', label: 'c', children: [] }] }));
  });
  test('is deterministic', () => {
    expect(decisionTreeSvg(model.skills[0])).toBe(decisionTreeSvg(model.skills[0]));
  });
});

describe('branchTreeSvg', () => {
  test('draws every node type of the fixture workflow, with arm labels', () => {
    const svg = branchTreeSvg(wf('refund-review')).replaceAll('&#x27;', "'");
    wellFormed(svg);
    for (const s of ['start', 'done', 'Load the order', 'AI step classify', 'choose one branch', "classify.size == 'small'", 'else', 'deny: continue', 'timeout: continue', 'in parallel', 'all arms run', 'for each item', 'repeat until poll.done is truthy', 'wait 1.5 min', 'map shape', 'not drawn', '10 paths to test', 'runs on a schedule']) {
      expect(svg).toContain(s);
    }
    expect(Number(/viewBox="0 0 ([\d.]+)/.exec(svg)[1])).toBeGreaterThan(400);
  });

  test('a non-exclusive conditional gets a "nothing runs" arm', () => {
    const svg = branchTreeSvg(wf('non-exclusive'));
    wellFormed(svg);
    expect(svg).toContain('nothing runs');
    expect(svg).toContain('input.a exists');
    expect(svg).toContain('3 paths to test');
    expect(svg).toContain('approve / deny');
  });

  test('coverage colours nodes by id or step id and adds a legend', () => {
    const plain = branchTreeSvg(wf('refund-review'));
    const cov = branchTreeSvg(wf('refund-review'), { coverage: { n1: 'pass', classify: 'fail', n3: 'untested' } });
    expect(cov).not.toBe(plain);
    expect(cov).toContain('#dcfce7');
    expect(cov).toContain('#fee2e2');
    expect(cov).toContain('not tested');
    expect(plain).not.toContain('passed');
  });

  test('workflows with no steps or a missing entry still render', () => {
    const svg = branchTreeSvg({ name: 'empty', nodes: [], entry: null, paths: [] });
    wellFormed(svg);
    expect(svg).toContain('no steps to draw');
    expect(svg).toContain('0 paths to test');
    wellFormed(branchTreeSvg({ name: 'x' }));
  });

  test('labels from the workflow are escaped', () => {
    const w = { name: '<b>n</b>', nodes: [{ id: 'n1', type: 'step', label: '</text><script>x</script>', children: [], next: null, branchLabels: [] }], entry: 'n1', paths: [{ id: 'p1' }] };
    const svg = branchTreeSvg(w);
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('1 path to test');
  });

  test('a cyclic spine terminates', () => {
    const nodes = [
      { id: 'n1', type: 'step', label: 'a', children: [], next: 'n2', branchLabels: [] },
      { id: 'n2', type: 'step', label: 'b', children: [], next: 'n1', branchLabels: [] },
    ];
    wellFormed(branchTreeSvg({ name: 'loopy', nodes, entry: 'n1', paths: [] }));
  });

  test('is deterministic', () => {
    expect(branchTreeSvg(wf('refund-review'))).toBe(branchTreeSvg(wf('refund-review')));
  });

  test('snapshots of the three diagram kinds', () => {
    expect(flowDiagramSvg(model)).toMatchSnapshot('flow');
    expect(decisionTreeSvg(model.skills[0])).toMatchSnapshot('decision-tree');
    expect(branchTreeSvg(wf('refund-review'), { coverage: { n1: 'pass', n2: 'fail' } })).toMatchSnapshot('branch-tree');
  });
});

describe('previewHtml', () => {
  test('inlines every figure, groups them and escapes captions', () => {
    const html = previewHtml([
      { group: 'Flow', title: 'A <b>', svg: '<svg></svg>' },
      { group: 'Flow', title: 'B', svg: '<svg id="b"></svg>' },
      { group: 'Other', title: 'C', svg: '', note: 'a & b' },
    ], { title: 'T <x>', outline: 'line <1>' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<svg id="b"></svg>');
    expect(html).toContain('A &lt;b&gt;');
    expect(html).toContain('T &lt;x&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('line &lt;1&gt;');
    expect(html.match(/<section>/g)).toHaveLength(3);
    expect(html).not.toMatch(/<(script|link)\b/);
    expect(html).not.toMatch(/https?:\/\//);
  });
  test('works with defaults', () => {
    expect(previewHtml([])).toContain('Agent discovery');
  });
});

describe('outlineMarkdown', () => {
  test('describes flow, skills, entry points, workflows and notes', () => {
    const md = outlineMarkdown(model);
    for (const s of ['# Flow of sample-support', '[before: language-detect]', '[after: tone-check]', '## Skills and tools', 'cancel_order [may change data] needs orderId', '(only when its condition holds)', '## Other entry points', 'job nightly-sync (0 2 * * *)', 'MCP server crm', '### refund-review (graph, schedule 0 9 * * 1)', 'if classify.size == \'small\':', '  - else:', 'approval "Manager approves large refund" (on deny: continue)', 'paths to test: 10; approvals managerOk; denials managerOk; signals bank.reply', '(no graph to draw)', 'in parallel', 'arm 1:', 'repeat until poll.done is truthy:', '## Notes']) {
      expect(md).toContain(s);
    }
    expect(md.split('\n').length).toBeLessThanOrEqual(121);
  });
  test('truncates to 120 lines and says so', () => {
    const skills = Array.from({ length: 80 }, (_, i) => ({ name: `s${i}`, description: 'd', tools: [{ name: `t${i}`, description: '', inputSchema: {} }] }));
    const md = outlineMarkdown({ agent: { name: 'big' }, skills, processors: { pre: [], post: [] } });
    const lines = md.trimEnd().split('\n');
    expect(lines).toHaveLength(120);
    expect(lines.at(-1)).toMatch(/^\.\.\. \d+ more lines not shown/);
  });
  test('handles an empty model', () => {
    const md = outlineMarkdown({});
    expect(md).toContain('(no skills)');
    expect(md).toContain('# Flow of agent');
  });
  test('a graph workflow without nodes reads as no graph', () => {
    expect(outlineMarkdown({ workflows: [{ name: 'w', form: 'graph', nodes: [], paths: [] }] })).toContain('(no graph to draw)');
  });
  test('waiting nodes, tool-only branches and agent steps', () => {
    const md = outlineMarkdown({
      workflows: [{
        name: 'w', form: 'graph', entry: 'n1', paths: [],
        nodes: [
          { id: 'n1', type: 'waitForSignal', label: 'wait for signal x', next: 'n2', children: [], branchLabels: [] },
          { id: 'n2', type: 'agent', label: 'AI step a', detail: 'do things', next: 'n3', children: [], branchLabels: [] },
          { id: 'n3', type: 'approval', label: 'ok?', next: null, children: [], branchLabels: [] },
        ],
      }],
    });
    expect(md).toContain('wait for signal x');
    expect(md).toContain('AI step a: do things');
    expect(md).toContain('approval "ok?"');
  });
});

describe('cliDiagrams', () => {
  test('writes every file kind under discovery/diagrams', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-dg-'));
    await mkdir(join(dir, 'discovery'), { recursive: true });
    const m = JSON.parse(JSON.stringify(model));
    m.skills.push({ ...m.skills[0], name: '../orders' }, { ...m.skills[0], name: 'orders' });
    await writeFile(join(dir, 'discovery', 'flow-model.json'), JSON.stringify(m));
    const t = makeIo();
    expect(await cliDiagrams(['--run-dir', dir], t.io)).toBe(0);
    const res = t.json();
    expect(res.ok).toBe(true);
    expect(res.files).toEqual(expect.arrayContaining([
      join('discovery', 'diagrams', 'flow.svg'),
      join('discovery', 'diagrams', 'skills', 'orders.svg'),
      join('discovery', 'diagrams', 'skills', 'orders-2.svg'),
      join('discovery', 'diagrams', 'workflows', 'refund-review.svg'),
      join('discovery', 'diagrams', 'index.html'),
      join('discovery', 'diagrams', 'outline.md'),
    ]));
    const skills = await readdir(join(dir, 'discovery', 'diagrams', 'skills'));
    expect(skills.sort()).toEqual(['account.svg', 'faq.svg', 'orders-2.svg', 'orders-3.svg', 'orders.svg'].sort());
    const wfs = await readdir(join(dir, 'discovery', 'diagrams', 'workflows'));
    expect(wfs).not.toContain('weekly-digest.svg');
    const html = await readFile(join(dir, 'discovery', 'diagrams', 'index.html'), 'utf8');
    expect(html).toContain('Script-form workflow: no graph');
    expect(html).toContain('<svg');
    expect(await readFile(join(dir, 'discovery', 'diagrams', 'outline.md'), 'utf8')).toContain('# Flow of');
  });

  test('missing flow model and missing flag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-dg-'));
    const t = makeIo();
    expect(await cliDiagrams(['--run-dir', dir], t.io)).toBe(2);
    expect(t.json().code).toBe('NO_FLOW_MODEL');
    expect(await cliDiagrams([], makeIo().io)).toBe(2);
  });
});

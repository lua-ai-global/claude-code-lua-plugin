import { describe, test, expect } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  renderPredicate, predicateStepIds, graphToNodes, enumeratePaths, enumeratePathsDetailed, toolSideEffect,
  buildDecisionTree, buildVocabulary, buildFlowModel, cliFlowModel, safeName,
} from '../../../../lib/qa/discovery/flow-model.mjs';

const fx = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/manifests/${name}`, import.meta.url)), 'utf8'));
const loadAll = () => ({
  manifest: fx('full.json'),
  status: fx('status.json'),
  versions: fx('versions.json'),
  workflows: fx('workflows-list.json'),
  views: { 'view-only': fx('view-only.view.json') },
});
const eq = (path, literal) => ({ op: 'eq', left: { path }, right: { literal } });
const step = (id, extra = {}) => ({ type: 'step', step: { id, description: `step ${id}` }, ...extra });

function makeIo(cwd = '/') {
  const out = [];
  const err = [];
  return { io: { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, cwd, env: {} }, out, err, json: () => JSON.parse(out.join('').trim().split('\n').pop()) };
}

describe('renderPredicate', () => {
  test('comparisons strip stepResults and render literals', () => {
    expect(renderPredicate(eq('stepResults.classify.needsApproval', true))).toBe('classify.needsApproval == true');
    expect(renderPredicate({ op: 'ne', left: { path: 'initData.kind' }, right: { literal: 'x' } })).toBe("input.kind != 'x'");
    expect(renderPredicate({ op: 'gt', left: { path: 'state.n' }, right: { literal: 3 } })).toBe('state.n > 3');
    expect(renderPredicate({ op: 'lte', left: { path: 'initData' }, right: { literal: null } })).toBe('input <= null');
    expect(renderPredicate({ op: 'gte', left: { path: 'a' }, right: undefined })).toBe('a >= null');
    expect(renderPredicate({ op: 'lt', left: { literal: 1 }, right: 2 })).toBe('1 < 2');
  });
  test('negation, combinators and set tests', () => {
    expect(renderPredicate({ op: 'not', arg: eq('stepResults.watch.state', 'watching') })).toBe("not (watch.state == 'watching')");
    expect(renderPredicate({ op: 'and', args: [eq('a', 1), { op: 'or', args: [eq('b', 2), eq('c', 3)] }] })).toBe('a == 1 and (b == 2 or c == 3)');
    expect(renderPredicate({ op: 'in', value: { path: 'stepResults.s.k' }, set: ['x', 1] })).toBe("s.k in ['x', 1]");
    expect(renderPredicate({ op: 'notIn', value: { path: 'stepResults.s.k' }, set: [] })).toBe('s.k not in []');
    expect(renderPredicate({ op: 'and', args: [] })).toBe('always');
  });
  test('existence and truthiness', () => {
    expect(renderPredicate({ op: 'exists', path: 'initData.a' })).toBe('input.a exists');
    expect(renderPredicate({ op: 'notExists', path: 'initData.a' })).toBe('input.a is missing');
    expect(renderPredicate({ op: 'truthy', value: { path: 'state.k' } })).toBe('state.k is truthy');
    expect(renderPredicate({ op: 'falsy', value: { path: 'state.k' } })).toBe('state.k is falsy');
  });
  test('odd inputs never throw', () => {
    expect(renderPredicate(null)).toBe('always');
    expect(renderPredicate(undefined)).toBe('always');
    expect(renderPredicate('custom text')).toBe('custom text');
    expect(renderPredicate({ nonsense: true })).toBe('{"nonsense":true}');
    expect(renderPredicate({ op: 'weird' })).toBe('weird(...)');
    expect(renderPredicate(5)).toBe('5');
  });
  test('predicateStepIds collects referenced steps once', () => {
    const p = { op: 'and', args: [eq('stepResults.a.x', 1), eq('stepResults.b.y', 2), eq('stepResults.a.z', 3), eq('initData.q', 1)] };
    expect(predicateStepIds(p)).toEqual(['a', 'b']);
    expect(predicateStepIds(undefined)).toEqual([]);
  });
});

describe('graphToNodes', () => {
  test('covers every node type and the fallback', () => {
    const graph = fx('full.json').primitives.find((p) => p.name === 'refund-review').graph;
    const { nodes, entry } = graphToNodes(graph);
    expect(entry).toBe('n1');
    const types = new Set(nodes.map((n) => n.type));
    for (const t of ['step', 'mapping', 'foreach', 'loop', 'conditional', 'parallel', 'approval', 'waitForSignal', 'workflow', 'sleep', 'tool', 'agent', 'opaque']) {
      expect(types.has(t)).toBe(true);
    }
    const cond = nodes.find((n) => n.type === 'conditional');
    expect(cond.exclusive).toBe(true);
    expect(cond.children).toHaveLength(4);
    expect(cond.branchLabels.at(-1)).toBe('else');
    expect(cond.hasOtherwise).toBe(true);
    const appr = nodes.find((n) => n.type === 'approval');
    expect(appr.approvalId).toBe('managerOk');
    expect(appr.onDeny).toBe('continue');
    expect(appr.parent).toBe(cond.id);
    expect(nodes.find((n) => n.type === 'waitForSignal').signal).toBe('bank.reply');
    expect(nodes.find((n) => n.type === 'sleep').label).toBe('wait 1.5 min');
    expect(nodes.find((n) => n.type === 'opaque').label).toContain('exoticNode');
  });
  test('accepts the three wrapper shapes and garbage', () => {
    const e = [step('a')];
    expect(graphToNodes(e).nodes).toHaveLength(1);
    expect(graphToNodes({ graph: e }).nodes).toHaveLength(1);
    expect(graphToNodes({ definition: { graph: e } }).nodes).toHaveLength(1);
    expect(graphToNodes(null)).toEqual({ nodes: [], entry: null });
    expect(graphToNodes({ definition: 'x' }).nodes).toEqual([]);
    expect(graphToNodes([null, 5]).nodes.map((n) => n.type)).toEqual(['opaque', 'opaque']);
  });
  test('humanises sleep durations and handles odd containers', () => {
    const { nodes } = graphToNodes([
      { type: 'sleep', id: 's1', duration: 250 },
      { type: 'sleep', id: 's2', duration: 3000 },
      { type: 'sleep', id: 's3', duration: 7_200_000 },
      { type: 'sleep', id: 's4', duration: 'soon' },
      { type: 'foreach' },
      { type: 'loop', loopType: 'while' },
      { type: 'conditional', steps: [step('x')], predicates: [] },
      { type: 'approval', id: 'ap', title: 't', onTimeout: [{ after: 1 }] },
      { type: 'waitForSignal', id: 'w', signal: 'a.b', onTimeout: 'fail' },
    ]);
    expect(nodes[0].label).toBe('wait 250 ms');
    expect(nodes[1].label).toBe('wait 3 s');
    expect(nodes[2].label).toBe('wait 2 h');
    expect(nodes[3].label).toBe('wait a while');
    expect(nodes.find((n) => n.type === 'loop').label).toBe('repeat while');
    expect(nodes.find((n) => n.type === 'approval').onTimeout).toBe('escalate');
  });
});

describe('enumeratePaths', () => {
  const paths = (graph, opts) => {
    const { nodes, entry } = graphToNodes(graph);
    return { nodes, paths: enumeratePaths(nodes, entry, opts) };
  };

  test('conditional gives one path per arm plus else, and records step outputs', () => {
    const { paths: ps } = paths([
      { type: 'agent', id: 'cls', agentId: 'a' },
      { type: 'conditional', exclusive: true, steps: [step('x'), step('y')], predicates: [eq('stepResults.cls.k', 1), eq('stepResults.cls.k', 2)] },
    ]);
    expect(ps).toHaveLength(3);
    expect(ps.every((p) => p.needs.stepOutputs.includes('cls'))).toBe(true);
    expect(ps.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(ps[2].nodes).toHaveLength(2); // agent + conditional only: "no branch taken"
  });

  test('a catch-all arm replaces the empty else', () => {
    const { paths: ps } = paths([{ type: 'conditional', exclusive: true, steps: [step('x')], predicates: [eq('stepResults.s.a', 1)], otherwise: step('o') }]);
    expect(ps).toHaveLength(2);
    expect(ps[1].nodes).toHaveLength(2);
  });

  test('approval forks only when a denial continues', () => {
    const cont = paths([{ type: 'approval', id: 'ok', title: 'T', onDeny: 'continue' }]).paths;
    expect(cont).toHaveLength(2);
    expect(cont[0].needs.approve).toEqual(['ok']);
    expect(cont[1].needs.deny).toEqual(['ok']);
    expect(paths([{ type: 'approval', id: 'ok', title: 'T', onDeny: 'fail' }]).paths).toHaveLength(1);
    expect(paths([{ type: 'approval', id: 'ok', title: 'T' }]).paths).toHaveLength(1);
  });

  test('signals fork on a continuing timeout', () => {
    const ps = paths([{ type: 'waitForSignal', id: 'w', signal: 'a.b', onTimeout: 'continue' }]).paths;
    expect(ps).toHaveLength(2);
    expect(ps[0].needs.signals).toEqual(['a.b']);
    expect(ps[1].needs.timeouts).toEqual(['w']);
    const one = paths([{ type: 'waitForSignal', id: 'w', signal: 'a.b' }]).paths;
    expect(one).toHaveLength(1);
    expect(one[0].needs.timeouts).toBeUndefined();
  });

  test('parallel runs all arms, loop and foreach run once, nested containers expand', () => {
    const { paths: ps, nodes } = paths([
      { type: 'parallel', steps: [{ type: 'agent', id: 'p1', agentId: 'a' }, { type: 'approval', id: 'pa', title: 't', onDeny: 'continue' }] },
      { type: 'foreach', step: step('each') },
      { type: 'loop', loopType: 'until', step: { type: 'agent', id: 'lp', agentId: 'a' }, predicate: { op: 'truthy', value: { path: 'stepResults.lp.done' } } },
      { type: 'foreach' },
      { type: 'foreach', step: { type: 'conditional', steps: [step('i1')], predicates: [eq('stepResults.q.v', 1)] } },
    ]);
    expect(ps.length).toBe(4); // parallel approval fork (2) x nested conditional (arm + else) (2)
    expect(ps[0].needs.stepOutputs).toEqual(expect.arrayContaining(['p1', 'lp', 'q']));
    expect(nodes.length).toBeGreaterThan(8);
    expect(ps[0].nodes).toContain('n1');
  });

  test('truncates at maxPaths and says so', () => {
    const many = Array.from({ length: 8 }, () => ({ type: 'conditional', exclusive: true, steps: [step('a'), step('b')], predicates: [eq('stepResults.q.v', 1), eq('stepResults.q.v', 2)] }));
    const { nodes, entry } = graphToNodes(many);
    const d = enumeratePathsDetailed(nodes, entry, { maxPaths: 10 });
    expect(d.paths).toHaveLength(10);
    expect(d.truncated).toBe(true);
    expect(enumeratePathsDetailed(nodes, entry).truncated).toBe(true);
    expect(enumeratePaths(nodes, entry, { maxPaths: 10 })).toHaveLength(10);
  });

  test('empty or unknown entry gives no paths; a cyclic spine terminates', () => {
    expect(enumeratePaths([], null)).toEqual([]);
    expect(enumeratePaths([], 'n9')).toEqual([]);
    const nodes = [
      { id: 'n1', type: 'step', children: [], next: 'n2', stepId: 'a' },
      { id: 'n2', type: 'step', children: [], next: 'n1', stepId: 'b' },
    ];
    expect(enumeratePaths(nodes, 'n1')[0].nodes).toEqual(['n1', 'n2']);
  });

  test('missing child ids are skipped', () => {
    const nodes = [
      { id: 'n1', type: 'parallel', children: ['zz'], next: 'n2' },
      { id: 'n2', type: 'foreach', children: ['zz'], next: 'n3' },
      { id: 'n3', type: 'conditional', children: ['zz'], hasOtherwise: false, next: null },
    ];
    expect(enumeratePaths(nodes, 'n1').length).toBeGreaterThan(0);
  });
});

describe('toolSideEffect', () => {
  const cases = [
    ['createOrder', '', 'likely'],
    ['send_email', '', 'likely'],
    ['get_order_status', 'Get the status of an order', 'none'],
    ['list_schedule', '', 'none'],
    ['get_and_update_cart', '', 'likely'],
    ['lookup', 'Find a thing', 'none'],
    ['do_it', 'Will delete the record', 'likely'],
    ['do_it', 'Fetch records', 'none'],
    ['do_it', 'Something', 'unknown'],
    ['', '', 'unknown'],
  ];
  test.each(cases)('%s / %s -> %s', (name, description, expected) => {
    expect(toolSideEffect({ name, description })).toBe(expected);
  });
  test('tolerates a missing tool', () => {
    expect(toolSideEffect(undefined)).toBe('unknown');
  });
});

describe('buildDecisionTree', () => {
  test('skill -> tool -> call leaf, plus the fallback', () => {
    const tree = buildDecisionTree({
      name: 'orders', hasCondition: true, context: 'ctx',
      tools: [
        { name: 't1', description: 'Does one', inputSchema: { required: ['a', 'b'] }, sideEffect: 'likely', conditionHint: 'Use when x.' },
        { name: 't2', description: 'Does two', inputSchema: {}, sideEffect: 'none', conditionHint: null },
      ],
    });
    expect(tree.sub).toBe('has a run condition');
    expect(tree.children.map((c) => c.kind)).toEqual(['tool', 'tool', 'fallback']);
    expect(tree.children[0].sub).toBe('Use when x.');
    expect(tree.children[0].children[0].sub).toBe('needs a, b');
    expect(tree.children[0].children[0].edge).toBe('may change data');
    expect(tree.children[1].children[0].sub).toBe('needs no fields');
  });
  test('a skill with no tools still has the fallback', () => {
    const tree = buildDecisionTree({ name: 'x', context: 'only context' });
    expect(tree.sub).toBe('only context');
    expect(tree.children).toHaveLength(1);
    expect(buildDecisionTree(undefined).label).toBe('skill');
  });
});

describe('buildFlowModel', () => {
  const model = buildFlowModel(loadAll());

  test('agent, skills, processors and entry points', () => {
    expect(model.schema).toBe('lua-qa/flow-model@1');
    expect(model.agent.name).toBe('sample-support');
    expect(model.agent.model).toBe('sample-model-1');
    expect(model.agent.personaExcerpt.length).toBeLessThanOrEqual(600);
    expect(model.skills.map((s) => s.name)).toEqual(['orders', 'faq', 'account']);
    const orders = model.skills[0];
    expect(orders.tools.map((t) => t.sideEffect)).toEqual(['none', 'likely', 'likely']);
    expect(orders.tools[0].conditionHint).toMatch(/^Use when the customer asks/);
    expect(orders.tools[0].inputSchema.required).toEqual(['orderId']);
    expect(model.skills[1].hasCondition).toBe(true);
    expect(model.processors.pre[0].name).toBe('language-detect');
    expect(model.processors.post[0].name).toBe('tone-check');
    expect(model.jobs.map((j) => j.schedule)).toEqual(['0 2 * * *', 'every 60s', 'once']);
    expect(model.webhooks).toEqual([{ name: 'order-shipped' }]);
    expect(model.triggers).toEqual([{ name: 'new-message' }]);
    expect(model.mcpServers).toEqual([{ name: 'crm', transport: 'streamable-http' }]);
  });

  test('workflows: graph, script, view-only fallback, input schema, schedule', () => {
    const byName = Object.fromEntries(model.workflows.map((w) => [w.name, w]));
    expect(byName['refund-review'].form).toBe('graph');
    expect(byName['refund-review'].paths).toHaveLength(10);
    expect(byName['refund-review'].inputSchema.required).toEqual(['orderId']);
    expect(byName['refund-review'].schedule).toEqual({ expression: '0 9 * * 1', timezone: 'UTC' });
    expect(byName['refund-review'].connections).toEqual([{ key: 'payments', integrationType: 'unknown', required: true }]);
    expect(byName['weekly-digest']).toMatchObject({ form: 'script', nodes: [], paths: [], schedule: { expression: '0 8 * * *', timezone: null } });
    expect(byName['view-only'].nodes).toHaveLength(1);
    expect(byName['view-only'].schedule.expression).toBe('*/5 * * * *');
    expect(byName['non-exclusive'].paths).toHaveLength(3);
  });

  test('warnings name the real problems', () => {
    expect(model.warnings).toEqual(expect.arrayContaining([
      'script-form workflow weekly-digest: no graph, branch tree omitted',
      'skill account: tool ghost_tool is not in the compiled manifest',
      'tool unattached_helper is not attached to any skill (reachable only from workflows or MCP)',
      expect.stringContaining('not recognised'),
    ]));
  });

  test('versions and sync', () => {
    expect(model.versions.active).toBe(3);
    expect(model.versions.staged).toEqual([4]);
    expect(model.versions.all).toHaveLength(3);
    expect(model.versions.all[2].version).toBe(2);
    expect(model.sync.localAhead).toBe(true);
    expect(model.sync.primitives).toEqual(expect.arrayContaining([{ kind: 'skill', name: 'faq', status: 'ahead' }, { kind: 'persona', name: 'persona', status: 'synced' }]));
  });

  test('vocabulary holds tool, schema, workflow, step and env names', () => {
    for (const w of ['get_order_status', 'orderId', 'refund-review', 'managerOk', 'bank.reply', 'PAYMENTS_BASE_URL', 'orders']) {
      expect(model.vocabulary).toContain(w);
    }
    expect([...model.vocabulary].sort()).toEqual(model.vocabulary);
  });

  test('is deterministic', () => {
    expect(JSON.stringify(buildFlowModel(loadAll()))).toBe(JSON.stringify(model));
  });

  test('a bare manifest and missing snapshots still produce a model', () => {
    const m = buildFlowModel({ manifest: { primitives: [] } });
    expect(m.agent.name).toBe('agent');
    expect(m.agent.model).toBeNull();
    expect(m.skills).toEqual([]);
    expect(m.versions).toEqual({ active: null, staged: [], all: [] });
    expect(m.sync).toEqual({ known: false, localAhead: false, ahead: [], notDeployed: [], drift: [], primitives: [] });
    expect(m.warnings[0]).toMatch(/no agent primitive/);
    expect(buildFlowModel({ manifest: null }).skills).toEqual([]);
  });

  test('odd shapes: object model, array versions, connections as map and as list, graph-less workflow', () => {
    const m = buildFlowModel({
      manifest: {
        primitives: [
          { kind: 'agent', name: 'a', persona: 'p', model: { name: 'm-obj' } },
          { kind: 'agent', name: 'b' },
          { kind: 'workflow', name: 'w1', form: 'graph', connections: { gmail: { integrationType: 'gmail', required: false }, slack: 'slack' }, graph: { definition: { graph: [step('s', { requiredConnections: ['extra'] })] } } },
          { kind: 'workflow', name: 'w2', form: 'graph', connections: [{ key: 'k', type: 'crm' }, { nokey: 1 }] },
          { kind: 'workflow', name: 'w3', schedule: 5, graph: { definition: { graph: [step('s')] } } },
          { kind: 'workflow', name: 'w4', schedule: { cron: '* * * * *', timezone: 'Europe/London' }, graph: { definition: { graph: [step('s')] } } },
        ],
      },
      versions: [{ version: 1, status: 'active' }],
      status: { primitives: [{ kind: 'x', diffs: [{ id: 'i', status: 'behind' }] }], persona: { status: 'ahead' } },
      workflows: [{ name: 'w1' }],
    });
    expect(m.agent.model).toBe('m-obj');
    const w = Object.fromEntries(m.workflows.map((x) => [x.name, x]));
    expect(w.w1.connections).toEqual([
      { key: 'gmail', integrationType: 'gmail', required: false },
      { key: 'slack', integrationType: 'slack', required: true },
      { key: 'extra', integrationType: 'unknown', required: true },
    ]);
    expect(w.w2.connections).toEqual([{ key: 'k', integrationType: 'crm', required: true }]);
    expect(w.w2.nodes).toEqual([]);
    expect(m.warnings.some((x) => x.includes('workflow w2: no graph'))).toBe(true);
    expect(w.w3.schedule).toBeNull();
    expect(w.w4.schedule).toEqual({ expression: '* * * * *', timezone: 'Europe/London' });
    expect(m.versions.active).toBe(1);
    expect(m.sync.localAhead).toBe(true);
  });

  test('a long persona is cut at 600 characters and a path overflow warns', () => {
    const many = Array.from({ length: 8 }, () => ({ type: 'conditional', exclusive: true, steps: [step('a'), step('b')], predicates: [eq('stepResults.q.v', 1), eq('stepResults.q.v', 2)] }));
    const m = buildFlowModel({ manifest: { primitives: [{ kind: 'agent', name: 'a', persona: 'x'.repeat(2000) }, { kind: 'workflow', name: 'big', graph: { definition: { graph: many } } }] } });
    expect(m.agent.personaExcerpt).toHaveLength(600);
    expect(m.warnings.some((w) => w.includes('truncated at 64'))).toBe(true);
  });
});

describe('buildVocabulary', () => {
  test('walks nested schema properties to depth three only', () => {
    const deep = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: {} } } } } } }, list: { items: { properties: { it: {} } } } } };
    const v = buildVocabulary({ skills: [{ name: 's', tools: [{ name: 't', inputSchema: deep }] }], workflows: [] });
    expect(v).toEqual(expect.arrayContaining(['a', 'b', 'c', 'list', 'it', 't', 's']));
    expect(v).not.toContain('d');
    expect(buildVocabulary(undefined)).toEqual([]);
  });
});

describe('safeName', () => {
  test('keeps names file-safe', () => {
    expect(safeName('../etc/passwd')).toBe('etc_passwd');
    expect(safeName('ok-name_1')).toBe('ok-name_1');
    expect(safeName('')).toBe('unnamed');
    expect(safeName(undefined)).toBe('unnamed');
  });
});

describe('cliFlowModel', () => {
  test('reads discovery files and writes flow-model.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-fm-'));
    const d = join(dir, 'discovery');
    await mkdir(join(d, 'workflows'), { recursive: true });
    const all = loadAll();
    await writeFile(join(d, 'manifest.json'), JSON.stringify(all.manifest));
    await writeFile(join(d, 'status.json'), JSON.stringify(all.status));
    await writeFile(join(d, 'versions.json'), JSON.stringify(all.versions));
    await writeFile(join(d, 'workflows.json'), JSON.stringify(all.workflows));
    await writeFile(join(d, 'workflows', 'view-only.json'), JSON.stringify(all.views['view-only']));
    const t = makeIo();
    expect(await cliFlowModel(['--run-dir', dir], t.io)).toBe(0);
    const res = t.json();
    expect(res.ok).toBe(true);
    expect(res.counts).toMatchObject({ skills: 3, tools: 6, processors: 2, jobs: 3, webhooks: 1, workflows: 4 });
    const written = JSON.parse(await readFile(join(d, 'flow-model.json'), 'utf8'));
    expect(written.schema).toBe('lua-qa/flow-model@1');
  });

  test('missing manifest is a usage error, missing flag too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-fm-'));
    const t = makeIo();
    expect(await cliFlowModel(['--run-dir', dir], t.io)).toBe(2);
    expect(t.json().code).toBe('NO_MANIFEST');
    const t2 = makeIo();
    expect(await cliFlowModel([], t2.io)).toBe(2);
  });
});

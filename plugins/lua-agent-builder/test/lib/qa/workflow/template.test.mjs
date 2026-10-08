import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SRC = await readFile(join(ROOT, 'lib', 'qa', 'workflow', 'qa-full.workflow.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function split(src) {
  const m = src.match(/^export const meta = (\{[\s\S]*?\n\})\n/);
  if (!m) throw new Error('meta literal not found');
  return { metaText: m[1], body: src.slice(m[0].length) };
}

const baseArgs = (over = {}) => ({
  runDir: '/r', projectDir: '/p', pluginRoot: '/plug/lua-agent-builder', runId: 'rid',
  env: { kind: 'sandbox', agentVersion: null, testSession: null },
  productionConsentToken: null,
  bar: { runsPerCard: 3, passRequired: 3 }, maxVoidRetries: 1,
  runs: [
    { cardId: 'icp-01', kind: 'icp', k: 1, model: 'sonnet', technical: false },
    { cardId: 'rt-01', kind: 'redteam', k: 1, model: 'opus', technical: false },
  ],
  models: { grader: 'opus', analyst: 'opus', reporter: 'sonnet', mechanics: 'sonnet' },
  mechanics: { flowTests: true, toolTests: true, stress: true, logScan: true },
  agentTypes: { player: 'lua-qa-player', grader: 'lua-qa-grader', analyst: 'lua-qa-analyst', reporter: 'lua-qa-reporter', mechanics: 'lua-qa' },
  sandboxSerial: false, sandboxBatch: 2,
  ...over,
});

async function execute(args, respond) {
  const calls = [];
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts });
    return respond(prompt, opts);
  };
  const parallel = async (thunks) => Promise.all(thunks.map(async (t) => { try { return await t(); } catch { return null; } }));
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => {
    let prev = item;
    for (const s of stages) prev = await s(prev, item, i);
    return prev;
  }));
  const logs = [];
  const { body } = split(SRC);
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', body);
  const result = await fn(args, agent, parallel, pipeline, () => {}, (m) => logs.push(m));
  return { result, calls, logs };
}

// The folder start-run prints for a play label: play:icp-01:r1 -> runs/icp-01/r1, play:icp-01:r1:a2 -> runs/icp-01/r1-a2.
const folderOf = (label) => {
  const [, card, r, a] = label.split(':');
  return `runs/${card}/${r}${a ? `-${a}` : ''}`;
};
const run = (folder, over = {}) => ({ folder, turns: 5, precheckExit: 0, contamination: 'CLEAN', ...over });
const pass = { verdict: 'PASS', safety: false, majors: [], confirmedCandidates: 0 };
const failG = { verdict: 'FAIL', safety: false, majors: ['x'], confirmedCandidates: 0 };

function responder({ grader = () => pass, play = (o) => run(folderOf(o.label)) } = {}) {
  return (prompt, opts) => {
    const l = opts.label;
    if (l.startsWith('play:')) return play(opts, prompt);
    if (l.startsWith('gradeA:')) return grader('A', opts);
    if (l.startsWith('gradeB:')) return grader('B', opts);
    if (l === 'mechanics') return { flowTests: { total: 1, pass: 1, fail: 0 }, toolTests: { total: 1, pass: 1, fail: 0 }, stress: { status: 'pass' }, logScan: { status: 'pass' } };
    if (l === 'aggregate') return { aggregated: true };
    if (l === 'analyse') return { clusters: 0 };
    if (l === 'report') return { artifacts: {}, summary: 's' };
    return null;
  };
}

describe('qa-full.workflow.js', () => {
  test('meta is a pure literal with the five phases', () => {
    const { metaText } = split(SRC);
    expect(metaText).not.toMatch(/\$\{|`|\(|\.\.\./);
    const meta = new Function(`return ${metaText}`)();
    expect(meta.name).toBe('lua-qa-full');
    expect(meta.phases.map((p) => p.title)).toEqual(['Play', 'Grade', 'Mechanics', 'Analyse', 'Report']);
  });

  test('no clock or randomness in the source', () => {
    expect(SRC).not.toMatch(/Date\.now|Math\.random|new Date\(\s*\)/);
  });

  test('grader B is never called when A is failing, and runs once when A passes', async () => {
    const { calls, result } = await execute(baseArgs(), responder({ grader: (L, o) => (o.label.includes('icp-01') ? failG : pass) }));
    const labels = calls.map((c) => c.opts.label);
    expect(labels).toContain('gradeA:icp-01:r1');
    expect(labels).not.toContain('gradeB:icp-01:r1');
    expect(labels).toContain('gradeB:rt-01:r1');
    expect(result.runs.find((r) => r.cardId === 'icp-01').verdict).toBe('FAIL');
    expect(result.runs.find((r) => r.cardId === 'rt-01').verdict).toBe('PASS');
  });

  test('a failing grade by safety, majors or confirmed candidates skips B; B failing fails the run', async () => {
    for (const bad of [{ verdict: 'PASS', safety: true, majors: [], confirmedCandidates: 0 }, { verdict: 'PASS', safety: false, majors: [], confirmedCandidates: 2 }, null]) {
      const { calls } = await execute(baseArgs({ runs: [baseArgs().runs[0]] }), responder({ grader: () => bad }));
      expect(calls.some((c) => c.opts.label.startsWith('gradeB:'))).toBe(false);
    }
    const { result } = await execute(baseArgs({ runs: [baseArgs().runs[0]] }), responder({ grader: (L) => (L === 'B' ? failG : pass) }));
    expect(result.runs[0].verdict).toBe('FAIL');
    expect(result.runs[0].gradeB).toBe('FAIL');
  });

  test('precheckExit 3 triggers exactly one retry with attempt 2, then VOID', async () => {
    const { calls, result } = await execute(
      baseArgs({ runs: [baseArgs().runs[0]] }),
      responder({ play: (o) => run(folderOf(o.label), { precheckExit: 3, contamination: 'CONTAMINATED' }) }),
    );
    const plays = calls.filter((c) => c.opts.label.startsWith('play:'));
    expect(plays.map((c) => c.opts.label)).toEqual(['play:icp-01:r1', 'play:icp-01:r1:a2']);
    expect(plays[1].prompt).toContain('--attempt 2');
    expect(plays[0].prompt).not.toContain('--attempt');
    expect(result.runs[0].verdict).toBe('VOID');
    expect(calls.some((c) => c.opts.label.startsWith('grade'))).toBe(false);
  });

  test('retry that comes back clean is graded with the attempt number', async () => {
    let n = 0;
    const { calls, result } = await execute(
      baseArgs({ runs: [baseArgs().runs[0]] }),
      responder({ play: (o) => run(folderOf(o.label), { precheckExit: n++ === 0 ? 3 : 0 }) }),
    );
    expect(result.runs[0].verdict).toBe('PASS');
    expect(result.runs[0].attempt).toBe(2);
    expect(calls.find((c) => c.opts.label === 'gradeA:icp-01:r1').prompt).toContain('--attempt 2');
  });

  test('no retry when maxVoidRetries is 0; a dead player is not played, never graded', async () => {
    const { calls } = await execute(baseArgs({ maxVoidRetries: 0, runs: [baseArgs().runs[0]] }), responder({ play: (o) => run(folderOf(o.label), { precheckExit: 3 }) }));
    expect(calls.filter((c) => c.opts.label.startsWith('play:'))).toHaveLength(1);
    const dead = await execute(baseArgs({ runs: [baseArgs().runs[0]] }), responder({ play: () => null }));
    expect(dead.result.runs[0]).toMatchObject({ verdict: 'NOT_PLAYED', notPlayed: 'the player returned no result' });
    expect(dead.calls.some((c) => c.opts.label.startsWith('grade'))).toBe(false);
  });

  test('red team runs use opus and the right knowledge file', async () => {
    const { calls } = await execute(baseArgs(), responder());
    const rt = calls.find((c) => c.opts.label === 'play:rt-01:r1');
    const icp = calls.find((c) => c.opts.label === 'play:icp-01:r1');
    expect(rt.opts.model).toBe('opus');
    expect(icp.opts.model).toBe('sonnet');
    expect(rt.prompt).toContain('red-team.md');
    expect(icp.prompt).not.toContain('red-team.md');
    expect(rt.opts.agentType).toBe('lua-qa-player');
  });

  test('consent is threaded into prompts only when present', async () => {
    const without = await execute(baseArgs(), responder());
    expect(without.calls.every((c) => !c.prompt.includes('--production-consent'))).toBe(true);
    const withTok = await execute(baseArgs({ env: { kind: 'production' }, productionConsentToken: 'aabbccddeeff' }), responder());
    const play = withTok.calls.find((c) => c.opts.label === 'play:icp-01:r1');
    expect(play.prompt).toContain('record --run-dir /r');
    expect(play.prompt).toContain('--production-consent aabbccddeeff');
    expect(withTok.calls.find((c) => c.opts.label === 'mechanics').prompt).toContain('--production-consent aabbccddeeff');
    expect(withTok.calls.find((c) => c.opts.label === 'report').prompt).not.toContain('--apply');
  });

  test('sandbox runs go in sequential batches; mechanics respects flags', async () => {
    const runs = [1, 2, 3].map((k) => ({ cardId: 'icp-01', kind: 'icp', k, model: 'sonnet', technical: true }));
    const order = [];
    const { calls, logs } = await execute(
      baseArgs({ runs, sandboxSerial: true, sandboxBatch: 2, mechanics: { flowTests: false, toolTests: false, stress: false, logScan: false } }),
      (p, o) => { order.push(o.label); return responder()(p, o); },
    );
    expect(logs.filter((l) => l.startsWith('sandbox batch'))).toHaveLength(2);
    expect(order.indexOf('play:icp-01:r3')).toBeGreaterThan(order.indexOf('gradeB:icp-01:r2'));
    const mech = calls.find((c) => c.opts.label === 'mechanics').prompt;
    expect(mech).not.toContain('flow-test');
    expect(mech).not.toContain('log-scan');
    expect(calls.find((c) => c.opts.label === 'play:icp-01:r1').prompt).toContain('SANDBOX_BUSY');
    expect(calls.find((c) => c.opts.label === 'play:icp-01:r1').prompt).toContain('prechecks --run-dir /r --card icp-01 --run 1 --technical');
  });

  test('sandboxBatch missing falls back to one at a time', async () => {
    const { logs, calls } = await execute(baseArgs({ sandboxSerial: true, sandboxBatch: 0 }), responder());
    expect(logs.filter((l) => l.startsWith('sandbox batch'))).toHaveLength(2);
    const mech = calls.find((c) => c.opts.label === 'mechanics').prompt;
    expect(mech).toContain('flow-test --run-dir /r --all   (repeat until remaining is 0)');
    expect(mech).toContain('sandboxBusy');
  });

  test('analyse and report phases run after play, in order', async () => {
    const { calls } = await execute(baseArgs(), responder());
    const labels = calls.map((c) => c.opts.label);
    expect(labels.indexOf('aggregate')).toBeGreaterThan(labels.indexOf('gradeB:icp-01:r1'));
    expect(labels.indexOf('analyse')).toBeGreaterThan(labels.indexOf('aggregate'));
    expect(labels.indexOf('report')).toBeGreaterThan(labels.indexOf('analyse'));
    expect(calls.find((c) => c.opts.label === 'analyse').opts.agentType).toBe('lua-qa-analyst');
  });
});

describe('knowledge files', () => {
  test('free of Supervisor specifics', async () => {
    const dir = join(ROOT, 'lib', 'knowledge', 'qa');
    const names = await readdir(dir);
    expect(names.sort()).toEqual([
      'analyst.md', 'fix-locus.md', 'grader-a.md', 'grader-b.md', 'icp-cards.md', 'mechanics.md',
      'player.md', 'qualifying-questions.md', 'red-team.md', 'rubric.md',
    ].sort());
    for (const n of names) {
      const text = await readFile(join(dir, n), 'utf8');
      expect(text).not.toMatch(/sv_|baseAgent_|Supervisor|Bloom|Fern|Northwind|Riverside|Helix|OpenWeather|canary/);
    }
    expect(await readFile(join(dir, 'rubric.md'), 'utf8')).toMatch(/^RUBRIC \(FROZEN\) — lua-qa 1\.9\.0\. Do not edit during a run\./);
  });
});

describe('shipped plugin and repo docs', () => {
  // Built from pieces so this file never matches itself.
  const j = (...p) => p.join('');
  const FORBIDDEN = new RegExp([
    j('\\bsv', '_'), j('Super', 'visor'), j('North', 'wind'), j('River', 'side'), j('Open', 'Weather'), j('\\bBlo', 'om\\b'),
    j('\\bFe', 'rn\\b'), j('\\bHel', 'ix\\b'), j('can', 'ary'), j('check-', 'thread\\.py'), j('chat-', 'fast'), j('claims-', 'audit\\.py'),
    j('readability', '\\.py'), j('explainer-', 'cicd'), j('explainer-', 'agent'), j('lua-docs-', 'v2-plan'), j('agent-', 'supervisor'),
    j('RUNNER-', 'BRIEF'), j('RUBRIC-', 'FROZEN'), j('qa-', 'area'), j('docs-', 'internal'), j('QA-SUITE-', 'CONTRACT'),
  ].join('|'));
  const SKIP = new Set(['node_modules', 'coverage', 'test', 'tests', 'mcp', '.git']);
  async function walk(dir, out) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) await walk(p, out);
      else if (/\.(mjs|js|md|json|html|css)$/.test(ent.name) && ent.name !== 'package-lock.json') out.push(p);
    }
    return out;
  }
  test('carry no names from the private sources the suite was generalised from, and no internal contract', async () => {
    const files = await walk(ROOT, []);
    const repo = join(ROOT, '..', '..');
    for (const f of ['README.md', join('docs', 'USER_GUIDE.md')]) files.push(join(repo, f));
    expect(files.length).toBeGreaterThan(50);
    const hits = [];
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      const m = FORBIDDEN.exec(text);
      if (m) hits.push(`${f.slice(repo.length)}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});

describe('qa-full.workflow.js: tiers and agent briefs', () => {
  test('one grader (smoke): grader A decides and is told to run run-verdict; grader B is never called', async () => {
    const { calls, result } = await execute(baseArgs({ graders: ['A'] }), responder({ grader: (L, o) => (o.label.includes('icp-01') ? failG : pass) }));
    expect(calls.some((c) => c.opts.label.startsWith('gradeB:'))).toBe(false);
    expect(result.runs.find((r) => r.cardId === 'icp-01').verdict).toBe('FAIL');
    expect(result.runs.find((r) => r.cardId === 'rt-01')).toMatchObject({ verdict: 'PASS', gradeA: 'PASS', gradeB: null });
    expect(calls.find((c) => c.opts.label === 'gradeA:rt-01:r1').prompt).toContain('Always run run-verdict');
  });

  test('two graders by default: grader A is told not to run run-verdict on a pass', async () => {
    const { calls } = await execute(baseArgs({ graders: [] }), responder());
    expect(calls.find((c) => c.opts.label === 'gradeA:icp-01:r1').prompt).toContain('do not run it (grader B will)');
    expect(calls.some((c) => c.opts.label.startsWith('gradeB:'))).toBe(true);
  });

  test('general-purpose roles read their agent file first; plugin types get no brief', async () => {
    const briefs = { player: '/plug/agents/lua-qa-player.md', grader: '/plug/agents/lua-qa-grader.md', analyst: '/plug/agents/lua-qa-analyst.md', reporter: '/plug/agents/lua-qa-reporter.md', mechanics: '/plug/agents/lua-qa.md' };
    const gp = Object.fromEntries(Object.keys(briefs).map((k) => [k, 'general-purpose']));
    const { calls } = await execute(baseArgs({ agentTypes: gp, agentBriefs: briefs }), responder());
    const first = (label) => calls.find((c) => c.opts.label === label).prompt.split('\n')[0];
    expect(first('play:icp-01:r1')).toContain('First read /plug/agents/lua-qa-player.md');
    expect(first('gradeA:icp-01:r1')).toContain('/plug/agents/lua-qa-grader.md');
    expect(first('mechanics')).toContain('/plug/agents/lua-qa.md');
    expect(first('aggregate')).toContain('/plug/agents/lua-qa-reporter.md');
    expect(first('analyse')).toContain('/plug/agents/lua-qa-analyst.md');
    expect(first('report')).toContain('/plug/agents/lua-qa-reporter.md');
    expect(calls.every((c) => c.opts.agentType === 'general-purpose')).toBe(true);
    const plain = await execute(baseArgs(), responder());
    expect(plain.calls.every((c) => !c.prompt.includes('general-purpose agent'))).toBe(true);
  });
});

describe('qa-full.workflow.js: the smoke time cap', () => {
  test('a run refused by the cap is not graded, and later sandbox batches are not started', async () => {
    const runs = [1, 2, 3, 4].map((k) => ({ cardId: 'icp-01', kind: 'icp', k, model: 'sonnet', technical: false }));
    const { calls, result, logs } = await execute(
      baseArgs({ runs, graders: ['A'], sandboxSerial: true, sandboxBatch: 2 }),
      responder({ play: (o) => (o.label === 'play:icp-01:r2' ? run('', { stopped: 'TIME_BUDGET' }) : run(folderOf(o.label))) }),
    );
    const plays = calls.filter((c) => c.opts.label.startsWith('play:')).map((c) => c.opts.label);
    expect(plays).toEqual(['play:icp-01:r1', 'play:icp-01:r2']);
    expect(calls.some((c) => c.opts.label === 'gradeA:icp-01:r2')).toBe(false);
    expect(result.runs.map((r) => r.verdict)).toEqual(['PASS', 'NOT_PLAYED', 'NOT_PLAYED', 'NOT_PLAYED']);
    expect(logs.join('\n')).toMatch(/time budget reached: 2 run\(s\) not started/);
    expect(logs.join('\n')).toMatch(/3 not played/);
  });

  test('a player that returns no folder is not graded either', async () => {
    const { calls, result } = await execute(baseArgs({ runs: [baseArgs().runs[0]] }), responder({ play: () => run('') }));
    expect(calls.some((c) => c.opts.label.startsWith('grade'))).toBe(false);
    expect(result.runs[0]).toMatchObject({ verdict: 'NOT_PLAYED' });
  });

  test.each([
    ['a placeholder folder', () => run('not created')],
    ['another run\'s folder', () => run('runs/icp-02/r1')],
    ['no turn recorded', (o) => run(folderOf(o.label), { turns: 0 })],
    ['a contaminated-looking run with no turn', (o) => run(folderOf(o.label), { turns: 0, precheckExit: 3 })],
  ])('%s is not played: no grade, no retry, not a FAIL', async (_name, play) => {
    const { calls, result, logs } = await execute(baseArgs({ runs: [baseArgs().runs[1]] }), responder({ play }));
    expect(calls.filter((c) => c.opts.label.startsWith('play:'))).toHaveLength(1);
    expect(calls.some((c) => c.opts.label.startsWith('grade'))).toBe(false);
    expect(result.runs[0].verdict).toBe('NOT_PLAYED');
    expect(result.runs[0].notPlayed).toBeTruthy();
    expect(logs.join('\n')).toMatch(/0 fail, 0 void, 1 not played/);
  });

  test('an absolute folder that ends in the run\'s own folder is played', async () => {
    const { calls, result } = await execute(baseArgs({ runs: [baseArgs().runs[0]] }), responder({ play: () => run('/r/runs/icp-01/r1/') }));
    expect(calls.some((c) => c.opts.label === 'gradeA:icp-01:r1')).toBe(true);
    expect(result.runs[0].verdict).toBe('PASS');
  });
});

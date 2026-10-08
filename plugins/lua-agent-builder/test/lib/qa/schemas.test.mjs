import { join } from 'node:path';
import { SCHEMA_NAMES, cliValidate, validate, validatePlan } from '../../../lib/qa/schemas.mjs';
import { RUN_ID, cardJson, flowModel, mkio, runJson, scaffoldRun, stateJson, validPlan, wj, writeValidPlan } from './fixtures/runtime-helpers.mjs';

const stress = () => ({
  schema: 'lua-qa/stress-plan@1', mode: 'burst', threads: 10, turnsPerThread: 2, concurrency: 5, messages: ['hello there'],
  burst: { size: 4, delayMs: 100 }, maxWallSeconds: 100, targets: { p90Ms: 15000, p99Ms: 30000, errorRate: 0.01 },
});
const flowTests = () => ({ schema: 'lua-qa/flow-tests@1', tests: [{ id: 'ft-1', workflow: 'wf', pathId: 'p1', input: {}, expect: { exitCode: 0 } }] });
const toolTests = () => ({ schema: 'lua-qa/tool-tests@1', tests: [{ id: 'tt-1', tool: 'get_order', input: {}, expect: 'ok', rationale: 'valid input' }] });

describe('validate', () => {
  test('lists exactly the 24 contract schemas, all known', () => {
    expect(SCHEMA_NAMES).toHaveLength(24);
    for (const n of SCHEMA_NAMES) expect(validate(n, {}).ok).toBe(false);
  });
  test('unknown schema and non-object', () => {
    expect(validate('nope', {})).toEqual({ ok: false, errors: ['unknown schema "nope"'] });
    expect(validate('run', null).errors).toEqual(['value must be an object']);
    expect(validate('run', []).ok).toBe(false);
  });
  test('wrong schema id is reported', () => {
    expect(validate('run', { ...runJson('/p'), schema: 'lua-qa/run@2' }).errors[0]).toMatch(/schema must be "lua-qa\/run@1"/);
  });

  describe('run', () => {
    test('valid', () => expect(validate('run', runJson('/p'))).toEqual({ ok: true }));
    test('bar must be 3/3 or 5/4', () => {
      expect(validate('run', runJson('/p', { bar: { runsPerCard: 5, passRequired: 4 } })).ok).toBe(true);
      expect(validate('run', runJson('/p', { bar: { runsPerCard: 4, passRequired: 4 } })).errors.join()).toMatch(/3 of 3 or 4 of 5/);
    });
    test('staged needs an agent version', () => {
      const staged = (v) => runJson('/p', { environment: { kind: 'staged', agentVersion: v, testSession: true, logEnvironment: 'production' } });
      expect(validate('run', staged(3)).ok).toBe(true);
      expect(validate('run', staged(null)).errors.join()).toMatch(/agentVersion/);
    });
    test('bad enum', () => {
      expect(validate('run', runJson('/p', { mode: 'turbo' })).errors[0]).toMatch(/one of full,quick/);
    });
  });

  test('state requires all four gates (null when unstamped)', () => {
    expect(validate('state', stateJson()).ok).toBe(true);
    const bad = stateJson();
    delete bad.gates.plan;
    expect(validate('state', bad).errors.join()).toMatch(/gates.plan is required/);
    expect(validate('state', stateJson({ gates: { discovery: null, questions: null, environment: null, plan: { at: 1 } } })).ok).toBe(false);
  });

  test('flow-model', () => {
    expect(validate('flow-model', flowModel()).ok).toBe(true);
    expect(validate('flow-model', flowModel({ workflows: [{ name: 'w', form: 'weird', nodes: [], paths: [] }] })).ok).toBe(false);
  });

  test('questions and metrics need at least one item', () => {
    expect(validate('questions', { schema: 'lua-qa/questions@1', items: [] }).errors[0]).toMatch(/at least 1/);
    expect(validate('questions', { schema: 'lua-qa/questions@1', items: [{ id: 'q1', question: 'Q?', answer: 'A' }] }).ok).toBe(true);
    const m = { id: 'task-success', label: 'x', unit: 'ratio', target: 1, comparator: '>=', source: 'cards', agreed: true };
    expect(validate('metrics', { schema: 'lua-qa/metrics@1', items: [m] }).ok).toBe(true);
    expect(validate('metrics', { schema: 'lua-qa/metrics@1', items: [{ ...m, unit: 'furlongs' }] }).ok).toBe(false);
  });

  describe('card', () => {
    test('valid icp and redteam', () => {
      expect(validate('card', cardJson('icp-01')).ok).toBe(true);
      expect(validate('card', cardJson('rt-01')).ok).toBe(true);
    });
    test.each([
      ['id shape', { id: 'bob' }, /icp-03 or rt-02/],
      ['kind/id mismatch', { id: 'rt-01' }, /icp card id must start/],
      ['openers < 2', { openers: ['one'] }, /openers needs at least 2/],
      ['beats < 2', { beats: [{ id: 'b1', description: 'x' }] }, /beats needs at least 2/],
      ['criteria >= 1', { successCriteria: [] }, /successCriteria needs at least 1/],
      ['real email', { testData: { emails: ['dana@gmail.com'], phones: [], secrets: [] } }, /not an example/],
    ])('%s', (_n, over, re) => {
      expect(validate('card', cardJson('icp-01', over)).errors.join()).toMatch(re);
    });
    test('redteam needs redTeam; icp prefix check for rt', () => {
      expect(validate('card', cardJson('rt-01', { redTeam: null })).errors.join()).toMatch(/redTeam is required/);
      expect(validate('card', cardJson('rt-01', { redTeam: { attack: 'sorcery', target: 't', successMeansAgent: 'x' } })).ok).toBe(false);
      expect(validate('card', cardJson('rt-01', { kind: 'redteam', id: 'icp-01' })).errors.join()).toMatch(/redteam card id must start with rt-/);
    });
  });

  test('run-record, turn, results shapes reject missing fields', () => {
    expect(validate('run-record', { schema: 'lua-qa/run-record@1' }).ok).toBe(false);
    expect(validate('turn', { schema: 'lua-qa/turn@1' }).ok).toBe(false);
    expect(validate('results', { schema: 'lua-qa/results@1' }).ok).toBe(false);
  });

  test('flow-tests and tool-tests need unique ids', () => {
    expect(validate('flow-tests', flowTests()).ok).toBe(true);
    const dup = flowTests();
    dup.tests.push({ ...dup.tests[0] });
    expect(validate('flow-tests', dup).errors.join()).toMatch(/unique/);
    expect(validate('tool-tests', toolTests()).ok).toBe(true);
    const dup2 = toolTests();
    dup2.tests.push({ ...dup2.tests[0] });
    expect(validate('tool-tests', dup2).errors.join()).toMatch(/unique/);
  });

  test('stress-plan: burst needs burst, wall time is capped', () => {
    expect(validate('stress-plan', stress()).ok).toBe(true);
    expect(validate('stress-plan', { ...stress(), burst: null }).errors.join()).toMatch(/burst/);
    expect(validate('stress-plan', { ...stress(), maxWallSeconds: 200 }).errors.join()).toMatch(/<= 105/);
    expect(validate('stress-plan', { ...stress(), messages: [] }).errors.join()).toMatch(/at least 1/);
  });

  test('clusters need evidence and a valid fix locus', () => {
    const c = {
      id: 'C1', title: 't', rootCause: 'r', severity: 'major', rank: 1, count: 2, affected: {}, evidence: [{ ref: 'x', turn: 1, quote: 'q' }],
      fixLocus: 'code-guard', movesLogicOutOfPrompt: true, recommendation: 'do', fixPath: '/lua-new', effort: 'S',
    };
    expect(validate('clusters', { schema: 'lua-qa/clusters@1', clusters: [c] }).ok).toBe(true);
    expect(validate('clusters', { schema: 'lua-qa/clusters@1', clusters: [{ ...c, evidence: [] }] }).errors.join()).toMatch(/evidence needs at least 1/);
    expect(validate('clusters', { schema: 'lua-qa/clusters@1', clusters: [{ ...c, fixLocus: 'vibes' }] }).ok).toBe(false);
  });

  test('grade', () => {
    const g = {
      schema: 'lua-qa/grade@1', grader: 'A', runRef: 'runs/icp-01/r1', cardId: 'icp-01', verdict: 'PASS', safety: false, safetyNotes: [],
      criteria: [{ id: 'C1', status: 'met' }], candidates: [{ source: 'claims', turn: 1, item: 'x', decision: 'dismissed', why: 'echo' }], defects: [], best: [],
    };
    expect(validate('grade', g).ok).toBe(true);
    expect(validate('grade', { ...g, candidates: [{ ...g.candidates[0], decision: 'maybe' }] }).ok).toBe(false);
  });

  test('cleanup and ledger', () => {
    expect(validate('cleanup', { schema: 'lua-qa/cleanup@1', applied: false, actions: [{ kind: 'clear-thread', target: 't', status: 'planned', note: '' }] }).ok).toBe(true);
    expect(validate('cleanup', { schema: 'lua-qa/cleanup@1', applied: false, actions: [{ kind: 'x', target: 't', status: 'planned', note: '' }] }).ok).toBe(false);
  });
});

async function fullPlan(over = {}) {
  const { runDir, projectDir } = await scaffoldRun({ cards: [], ...over });
  await writeValidPlan(runDir);
  return { runDir, projectDir };
}

describe('validatePlan', () => {
  test('a complete plan is ok', async () => {
    const { runDir } = await fullPlan();
    expect(await validatePlan(runDir)).toEqual({ ok: true, errors: [], coverageGaps: [] });
  });
  test('missing run.json', async () => {
    expect((await validatePlan('/nonexistent/run')).errors).toEqual(['run.json is missing']);
  });
  test('too few cards, missing plan files and flow model', async () => {
    const { runDir } = await scaffoldRun({ withModel: false });
    const r = await validatePlan(runDir);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/need at least 10 ICP cards/);
    expect(r.errors.join('\n')).toMatch(/need at least 3 red-team cards/);
    expect(r.errors.join('\n')).toMatch(/flow-model.json is missing/);
    expect(r.errors.join('\n')).toMatch(/plan\/stress.json is missing/);
  });
  test('uncovered tools are listed as coverage gaps', async () => {
    const { runDir } = await fullPlan();
    for (const card of validPlan().cards.filter((c) => c.kind === 'icp')) {
      await wj(join(runDir, 'plan', 'cards', `${card.id}.json`), { ...card, coverage: { ...card.coverage, tools: ['get_order'] } });
    }
    const r = await validatePlan(runDir);
    expect(r.ok).toBe(false);
    expect(r.coverageGaps).toEqual(['tool cancel_order (skill orders) is not covered by any card']);
  });
  test('a real email in an opener, a bad json card, a misnamed card and concurrent sandbox stress', async () => {
    const { runDir } = await fullPlan();
    await wj(join(runDir, 'plan', 'cards', 'icp-01.json'), cardJson('icp-01', { openers: ['mail me at x@gmail.com', 'hello'], coverage: { skills: [], tools: ['get_order', 'cancel_order'], workflows: [] } }));
    await wj(join(runDir, 'plan', 'cards', 'icp-02.json'), cardJson('icp-09'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(runDir, 'plan', 'cards', 'icp-03.json'), '{nope', 'utf8');
    await wj(join(runDir, 'plan', 'stress.json'), { ...stress(), mode: 'concurrent' });
    await wj(join(runDir, 'plan', 'tool-tests.json'), { schema: 'lua-qa/tool-tests@1', tests: [{ id: 't', tool: 'x', input: { to: 'a@gmail.com' }, expect: 'ok', rationale: 'r' }] });
    const r = await validatePlan(runDir);
    const text = r.errors.join('\n');
    expect(text).toMatch(/icp-01.json: email "x@gmail.com"/);
    expect(text).toMatch(/icp-02.json: file name must be icp-09.json/);
    expect(text).toMatch(/icp-03.json: not valid JSON/);
    expect(text).toMatch(/concurrent stress needs a staged or production/);
    expect(text).toMatch(/tool-tests.json: email "a@gmail.com"/);
  });
  test('burst stress is refused for a staged environment', async () => {
    const { runDir } = await fullPlan();
    await wj(join(runDir, 'run.json'), runJson('/p', { environment: { kind: 'staged', agentVersion: 4, testSession: true, logEnvironment: 'production' } }));
    await wj(join(runDir, 'plan', 'stress.json'), { ...stress(), mode: 'burst', burst: { size: 2, delayMs: 10 } });
    expect((await validatePlan(runDir)).errors.join()).toMatch(/burst stress has no staged path/);
  });
  test('invalid run.json is reported', async () => {
    const { runDir } = await fullPlan();
    await wj(join(runDir, 'run.json'), { ...runJson('/p'), mode: 'turbo' });
    expect((await validatePlan(runDir)).errors.join()).toMatch(/run.json:/);
  });
});

describe('cliValidate', () => {
  test('plan: exit 0 when ok, 1 with errors', async () => {
    const { runDir } = await fullPlan();
    const t = mkio();
    expect(await cliValidate(['--run-dir', runDir, '--what', 'plan'], t.io)).toBe(0);
    expect(t.json().ok).toBe(true);
    const t2 = mkio();
    expect(await cliValidate(['--run-dir', join(runDir, '..', 'missing'), '--what', 'plan'], t2.io)).toBe(1);
  });
  test('cards', async () => {
    const { runDir } = await fullPlan();
    const t = mkio();
    expect(await cliValidate(['--run-dir', runDir, '--what', 'cards'], t.io)).toBe(0);
    const { runDir: empty } = await scaffoldRun({ cards: [] });
    const t2 = mkio();
    expect(await cliValidate(['--run-dir', empty, '--what', 'cards'], t2.io)).toBe(1);
    expect(t2.json().errors[0]).toMatch(/no cards/);
    await wj(join(runDir, 'plan', 'cards', 'icp-01.json'), { schema: 'lua-qa/card@1' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(runDir, 'plan', 'cards', 'icp-02.json'), 'x', 'utf8');
    const t3 = mkio();
    expect(await cliValidate(['--run-dir', runDir, '--what', 'cards'], t3.io)).toBe(1);
  });
  test.each([['run'], ['flow-tests'], ['tool-tests'], ['stress'], ['metrics'], ['questions']])('%s: missing file is exit 1', async (what) => {
    const { runDir } = await scaffoldRun({});
    const t = mkio();
    const code = await cliValidate(['--run-dir', runDir, '--what', what], t.io);
    expect(code).toBe(what === 'run' ? 0 : 1);
  });
  test('stress file validates', async () => {
    const { runDir } = await fullPlan();
    const t = mkio();
    expect(await cliValidate(['--run-dir', runDir, '--what', 'stress'], t.io)).toBe(0);
    await wj(join(runDir, 'plan', 'stress.json'), { schema: 'lua-qa/stress-plan@1' });
    expect(await cliValidate(['--run-dir', runDir, '--what', 'stress'], mkio().io)).toBe(1);
  });
  test('usage errors exit 2', async () => {
    const t = mkio();
    expect(await cliValidate(['--what', 'plan'], t.io)).toBe(2);
    expect(await cliValidate(['--run-dir', '/x', '--what', 'bogus'], mkio().io)).toBe(2);
  });
  test('RUN_ID constant is used by fixtures', () => expect(RUN_ID).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/));
});

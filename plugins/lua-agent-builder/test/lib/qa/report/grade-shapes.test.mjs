// Grade files as graders really wrote them in the 1.9.0 trial (Pageturner Books), and runs whose player stopped
// mid-conversation: aggregate must not crash, must count every confirmed candidate, and must not score an
// unfinished, ungraded run as a FAIL.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildResults, cliAggregate, cliRunVerdict, loadRunData, normalizeGrade, notPlayedReason } from '../../../../lib/qa/report/results.mjs';
import { makeIo, tmpRun } from './helpers.mjs';

const NOW = () => new Date('2026-10-07T16:00:00.000Z');
const jread = async (p) => JSON.parse(await readFile(p, 'utf8'));
const jwrite = (p, o) => writeFile(p, JSON.stringify(o), 'utf8');
const H1 = { turn: 4, item: '125 words > 120', decision: 'confirmed', quote: 'Here is what might help right now: …' };

describe('normalizeGrade', () => {
  test('candidates keyed check or kind, or given as a path, get a canonical source', () => {
    const g = normalizeGrade({
      verdict: 'FAIL',
      candidates: [{ check: 'readability', ...H1 }, { kind: 'claims', decision: 'dismissed' }, { source: 'checks/readability.json', decision: 'confirmed' }, { source: 'claims', decision: 'confirmed' }],
    });
    expect(g.candidates.map((c) => c.source)).toEqual(['readability', 'claims', 'readability', 'claims']);
  });

  test('candidates as an object keyed by check become one array, the key naming the source', () => {
    const g = normalizeGrade({ candidates: { readability: [H1], claims: [], contamination: [{ source: 'checks/contamination.json', decision: 'dismissed' }] } });
    expect(g.candidates).toEqual([{ ...H1, source: 'readability' }, { source: 'contamination', decision: 'dismissed' }]);
  });

  test('criteria and defects as objects (keyed by id, or grouped as common/specific) become arrays', () => {
    const g = normalizeGrade({
      criteria: { C1: { status: 'met', evidence: 'T1 searched first' }, C2: { status: 'partly' } },
      defects: { common: [{ severity: 'major', why: 'over the word limit' }], specific: [] },
    });
    expect(g.criteria).toEqual([{ id: 'C1', status: 'met', evidence: 'T1 searched first' }, { id: 'C2', status: 'partly' }]);
    expect(g.defects).toEqual([{ severity: 'major', why: 'over the word limit' }]);
    expect(normalizeGrade({ criteria: { common: [{ id: 'C1', status: 'met' }] } }).criteria).toEqual([{ id: 'C1', status: 'met' }]);
  });

  test('a well-formed grade is unchanged; missing lists become empty; non-objects pass through', () => {
    const ok = { verdict: 'PASS', safety: false, safetyNotes: ['n'], criteria: [{ id: 'C1', status: 'met' }], candidates: [{ source: 'claims', decision: 'dismissed' }], defects: [] };
    expect(normalizeGrade(ok)).toEqual(ok);
    expect(normalizeGrade({ verdict: 'PASS' })).toMatchObject({ candidates: [], criteria: [], defects: [], safetyNotes: [] });
    expect(normalizeGrade({ safetyNotes: 'one note' }).safetyNotes).toEqual(['one note']);
    expect(normalizeGrade(null)).toBeNull();
    expect(normalizeGrade(undefined)).toBeNull();
    expect(normalizeGrade({ candidates: [null, 'x', { source: 'claims' }] }).candidates).toEqual([{ source: 'claims' }]);
  });
});

describe('aggregate with grade files in the shapes graders wrote', () => {
  let t;
  beforeEach(async () => {
    t = await tmpRun();
  });
  afterEach(async () => t.cleanup());

  test('an object-shaped candidates list no longer crashes aggregate, and its confirmed candidate fails the run', async () => {
    // icp-02 r1 is a clean single-attempt PASS in the fixture (icp-01 r1 is superseded by its attempt 2).
    const p = join(t.dir, 'runs', 'icp-02', 'r1', 'grade-a.json');
    await jwrite(p, { ...(await jread(p)), candidates: { readability: [H1], claims: [] } });
    const io = makeIo();
    expect(await cliAggregate(['--run-dir', t.dir], io)).toBe(0);
    const results = await jread(join(t.dir, 'report', 'results.json'));
    const run = results.cards.find((c) => c.id === 'icp-02').runs.find((r) => r.k === 1);
    expect(run.verdict).toBe('FAIL');
    expect(run.majors.some((m) => /^readability: /.test(m))).toBe(true);
  });

  test('a confirmed readability candidate keyed `check` counts in readability-h1', async () => {
    const before = buildResults(await loadRunData(t.dir), { now: NOW });
    const metric = (r) => r.metrics.find((m) => m.id === 'readability-h1').actual;
    const p = join(t.dir, 'runs', 'icp-02', 'r1', 'grade-a.json');
    await jwrite(p, { ...(await jread(p)), candidates: [{ check: 'readability', ...H1 }] });
    const after = buildResults(await loadRunData(t.dir), { now: NOW });
    const valid = after.summary.runs.valid;
    expect(metric(after)).toBeCloseTo(metric(before) - 1 / valid, 10);
  });

  test('criteria written as an object do not crash aggregate', async () => {
    const p = join(t.dir, 'runs', 'icp-04', 'r1', 'grade-a.json');
    await jwrite(p, { ...(await jread(p)), criteria: { C1: { status: 'met' } }, defects: { common: [] } });
    expect(await cliAggregate(['--run-dir', t.dir], makeIo())).toBe(0);
  });
});

describe('a run whose player stopped mid-conversation', () => {
  let t;
  beforeEach(async () => {
    t = await tmpRun();
  });
  afterEach(async () => t.cleanup());

  test('notPlayedReason: still running with no grade A is not played; running with a grade, or done, is played', () => {
    expect(notPlayedReason({ record: { status: 'running', turns: 3 }, turnCount: 3 })).toMatch(/stopped mid-conversation/);
    expect(notPlayedReason({ record: { status: 'running', turns: 3 }, turnCount: 3, gradeA: { verdict: 'FAIL' } })).toBeNull();
    expect(notPlayedReason({ record: { status: 'done', turns: 3 }, turnCount: 3 })).toBeNull();
    expect(notPlayedReason({ record: { status: 'aborted', turns: 3 }, turnCount: 3 })).toBeNull();
  });

  test('is not played, not a FAIL, and the card becomes inconclusive instead of failing', async () => {
    const dir = join(t.dir, 'runs', 'icp-01', 'r2');
    const rec = await jread(join(dir, 'run-record.json'));
    await jwrite(join(dir, 'run-record.json'), { ...rec, status: 'running', endedAt: null, turns: 2 });
    await rm(join(dir, 'grade-a.json'));
    await rm(join(dir, 'grade-b.json'), { force: true });
    const r = buildResults(await loadRunData(t.dir), { now: NOW });
    const card = r.cards.find((c) => c.id === 'icp-01');
    expect(card.runs.find((x) => x.k === 2)).toMatchObject({ verdict: 'NOT_PLAYED', notPlayed: 'the player stopped mid-conversation (the run was never finished or graded)' });
    expect(card.runs.filter((x) => x.verdict === 'FAIL')).toHaveLength(0);
    expect(card.inconclusive).toBe(true);
  });

  test('run-verdict stores NOT_PLAYED for it too', async () => {
    const dir = join(t.dir, 'runs', 'icp-01', 'r2');
    const rec = await jread(join(dir, 'run-record.json'));
    await jwrite(join(dir, 'run-record.json'), { ...rec, status: 'running', turns: 2 });
    await rm(join(dir, 'grade-a.json'));
    const io = makeIo();
    expect(await cliRunVerdict(['--run-dir', t.dir, '--card', 'icp-01', '--run', '2'], io)).toBe(0);
    expect(io.json()).toMatchObject({ verdict: 'NOT_PLAYED', safety: false, majors: [] });
  });
});

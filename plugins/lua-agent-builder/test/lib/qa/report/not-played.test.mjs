// TRIAL-NOTES 17-20 in the report: n/a for zero denominators, "not played" runs, platform memory and the shared
// signed-in identity in the method, and harness-artefact clusters.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildResults, cliRunVerdict, isArtefactCluster, isMemoryCluster, loadRunData, memoryIsolation, notPlayedReason, scoreCard,
} from '../../../../lib/qa/report/results.mjs';
import { failureAnalysis, identityAndMemory, method, naText, personaResults, redTeam, shortVersion, workflowTests, appendix } from '../../../../lib/qa/report/sections.mjs';
import { tierVerdict, TIERS } from '../../../../lib/qa/tiers.mjs';
import { validate } from '../../../../lib/qa/schemas.mjs';
import { featuresDoc } from '../../../../lib/qa/memory.mjs';
import { makeIo, tmpRun } from './helpers.mjs';

const NOW = () => new Date('2026-10-07T16:00:00.000Z');
const jread = async (p) => JSON.parse(await readFile(p, 'utf8'));
const jwrite = (p, o) => writeFile(p, JSON.stringify(o), 'utf8');

describe('not played runs', () => {
  let t;
  beforeEach(async () => {
    t = await tmpRun();
  });
  afterEach(async () => t.cleanup());

  test('a planned run with no folder, a folder with no record, and a record with no turn are not played', async () => {
    await rm(join(t.dir, 'runs', 'rt-01', 'r2'), { recursive: true });
    await rm(join(t.dir, 'runs', 'rt-01', 'r3', 'run-record.json'));
    const rec = await jread(join(t.dir, 'runs', 'rt-02', 'r3', 'run-record.json'));
    await jwrite(join(t.dir, 'runs', 'rt-02', 'r3', 'run-record.json'), { ...rec, turns: 0 });
    const r = buildResults(await loadRunData(t.dir), { now: NOW });
    expect(validate('results', r)).toEqual({ ok: true });
    const rt1 = r.cards.find((c) => c.id === 'rt-01');
    expect(rt1.runs.map((x) => [x.k, x.verdict, x.folder])).toEqual([[1, 'PASS', 'runs/rt-01/r1'], [2, 'NOT_PLAYED', null], [3, 'NOT_PLAYED', 'runs/rt-01/r3']]);
    expect(rt1).toMatchObject({ chip: 'partial', inconclusive: true, bar: { valid: 1, passes: 1 }, notPlayed: 2 });
    expect(rt1.notPlayedReasons).toEqual(['no run folder was created (the player never started this run)', 'the run folder has no run record (start-run never completed)']);
    const rt2 = r.cards.find((c) => c.id === 'rt-02');
    // r3 had grades on disk, but nothing reached the agent: not a FAIL and not valid
    expect(rt2.runs[2]).toMatchObject({ verdict: 'NOT_PLAYED', notPlayed: 'the player started the run but recorded no turn', safety: false, majors: [] });
    expect(rt2.bar.valid).toBe(2);
    expect(r.summary.runs).toMatchObject({ total: 18, notPlayed: 3, void: 1, valid: 14 });
    expect(r.verdict.blockers).toContain('rt-01: inconclusive (1 valid of 3 needed; 2 not played)');

    const short = shortVersion(r);
    expect(short).toMatch(/14 of 18 runs were valid \(3 runs not played\)/);
    expect(short).toMatch(/Valid runs\. 1 voided by contamination, 3 not played/);
    const red = redTeam(r);
    expect(red).toMatch(/\| 2 \| 1 \| Not played \| n\/a \| n\/a \| n\/a \| not graded \| not graded \|/);
    expect(red).toMatch(/2 runs not played: no run folder was created/);
    expect(appendix(r, [])).toMatch(/`runs\/rt-01\/r2` \(not created\) \| n\/a \| Not played/);
    expect(method(r)).toMatch(/is not played: it is not a valid run and never a fail/);
  });

  test('a safety finding in a run that was never played does not veto; a played run still does', () => {
    const card = { id: 'rt-09', kind: 'redteam' };
    const bar = { runsPerCard: 3, passRequired: 3 };
    expect(scoreCard(card, [{ verdict: 'NOT_PLAYED', safety: true }, { verdict: 'PASS' }], bar)).toMatchObject({ safetyVeto: false, inconclusive: true, bar: { valid: 1 } });
    expect(scoreCard(card, [{ verdict: 'VOID', safety: true }], bar).safetyVeto).toBe(true);
  });

  test('notPlayedReason: an older record without a turn count is played', () => {
    expect(notPlayedReason({ record: null })).toMatch(/no run record/);
    expect(notPlayedReason({ record: { turns: 0 }, turnCount: 0 })).toMatch(/recorded no turn/);
    expect(notPlayedReason({ record: { turns: 0 }, turnCount: 3 })).toBeNull();
    expect(notPlayedReason({ record: {} })).toBeNull();
  });

  test('run-verdict stores NOT_PLAYED for a run with no turn, whatever the grades say', async () => {
    const dir = join(t.dir, 'runs', 'icp-03', 'r1');
    const rec = await jread(join(dir, 'run-record.json'));
    await jwrite(join(dir, 'run-record.json'), { ...rec, turns: 0 });
    const io = makeIo();
    expect(await cliRunVerdict(['--run-dir', t.dir, '--card', 'icp-03', '--run', '1'], io)).toBe(0);
    expect(io.json()).toMatchObject({ verdict: 'NOT_PLAYED', safety: false, majors: [] });
    const saved = await jread(join(dir, 'run-record.json'));
    expect(validate('run-record', saved)).toEqual({ ok: true });
  });

  test('the tier verdict still reads a cap-refused card as not played because of the cap', () => {
    const c = { id: 'icp-05', safetyVeto: false, inconclusive: true, chip: 'partial', bar: { runs: 1, required: 1, valid: 0, passes: 0 }, runs: [{ verdict: 'NOT_PLAYED' }], notPlayed: 1 };
    const summary = { flowTests: {}, toolTests: {}, logsPresent: true, logErrors: 0, sideEffects: { unexpected: 0 }, overall: 'partial' };
    expect(tierVerdict(TIERS.smoke, { summary, cards: [c], metrics: [], capReached: true }).blockers).toEqual(['icp-05: not played: the 30-minute cap was reached']);
    expect(tierVerdict(TIERS.smoke, { summary, cards: [c], metrics: [], capReached: false }).blockers).toEqual(['icp-05: inconclusive (0 valid of 1 needed; 1 not played)']);
  });
});

describe('zero denominators render as n/a with a reason', () => {
  test('no workflows: branch coverage tile, metric and section say n/a: no workflows', async () => {
    const t = await tmpRun();
    const data = await loadRunData(t.dir);
    Object.assign(data, { flowModel: { workflows: [] }, flowTestPlan: null, flowTests: [], toolTestPlan: null, toolTests: [], stress: null });
    const r = buildResults(data, { now: NOW });
    await t.cleanup();
    expect(r.summary.flowTests).toMatchObject({ branchCoverage: null, naReason: 'no workflows' });
    const cov = r.metrics.find((m) => m.id === 'workflow-branch-coverage');
    expect(cov).toMatchObject({ status: 'n/a', naReason: 'no workflows', actual: null });
    const short = shortVersion(r);
    expect(short).toMatch(/<b>n\/a<\/b><span>Workflow branch coverage \(n\/a: no workflows\)<\/span>/);
    expect(short).toMatch(/<b>n\/a<\/b><span>Direct tool tests \(n\/a: no tool tests\)<\/span>/);
    expect(short).toMatch(/<b>n\/a<\/b><span>Reply latency p90 under stress \(n\/a: no stress result\)<\/span>/);
    expect(short).not.toMatch(/100%/);
    const m = method(r);
    expect(m).toMatch(/\| Workflow branch coverage \| \\>= 100% \| n\/a \| n\/a: no workflows \|/);
    expect(m).toMatch(/A metric marked n\/a had nothing to measure/);
    expect(naText('')).toBe('n/a: not measured');
  });

  test('nothing played: every ratio tile is n/a and the result is never a pass', async () => {
    const t = await tmpRun();
    const data = await loadRunData(t.dir);
    Object.assign(data, { cards: [], runs: [], flowModel: { workflows: [] }, flowTestPlan: null, flowTests: [], toolTestPlan: null, toolTests: [], stress: null });
    const r = buildResults(data, { now: NOW });
    await t.cleanup();
    expect(r.summary.overall).toBe('partial');
    const short = shortVersion(r);
    expect(short).toMatch(/Cards that met the bar \(n\/a: no valid runs\)/);
    expect(short).toMatch(/Valid runs\. 0 voided by contamination \(n\/a: no runs were planned\)/);
    expect(short).toMatch(/Red-team attacks the agent held against in every required run \(n\/a: no red-team cards\)/);
    expect(r.metrics.find((x) => x.id === 'task-success')).toMatchObject({ status: 'n/a', naReason: 'no persona cards' });
    expect(r.metrics.find((x) => x.id === 'safety-veto')).toMatchObject({ status: 'n/a', naReason: 'no runs were played' });
  });

  test('happy-path tier with no flow tests, and a flow-test section with no known path', async () => {
    const t = await tmpRun();
    const r = buildResults(await loadRunData(t.dir), { now: NOW });
    await t.cleanup();
    const happy = { ...r, scope: { ...r.scope, flowMode: 'happy-path' }, summary: { ...r.summary, flowTests: { total: 0, pass: 0, fail: 0, branchCoverage: null, naReason: 'no workflows' } } };
    expect(shortVersion(happy)).toMatch(/Workflow happy-path tests passed \(other branches: not in this tier\) \(n\/a: no workflows\)/);
    const noPaths = { ...r, scope: { ...r.scope, flowMode: 'all' }, summary: { ...r.summary, flowTests: { ...r.summary.flowTests, branchCoverage: null, naReason: undefined } } };
    expect(workflowTests(noPaths)).toMatch(/Branch coverage is n\/a: no workflow paths\./);
    expect(shortVersion(noPaths)).toMatch(/Workflow branch coverage \(n\/a: no flow tests\)/);
  });
});

describe('shared identity, platform memory and harness artefacts', () => {
  const clusters = [
    { id: 'C1', title: 'Stored notes from other chats recited', rootCause: 'per-user memory', severity: 'critical', rank: 1, count: 10, affected: {}, evidence: [], fixLocus: 'persona-prompt', recommendation: 'r', fixPath: 'persona-edit', effort: 'S' },
    { id: 'C2', title: 'Harness artefact: cross-run memory', rootCause: 'one signed-in user', severity: 'critical', rank: 2, count: 4, affected: {}, evidence: [], fixLocus: 'test-artifact', harnessArtefact: true, recommendation: 'rerun with memory off', fixPath: 'operational', effort: 'S' },
    { id: 'C3', title: 'Long replies', rootCause: 'no length rule', severity: 'major', rank: 3, count: 8, affected: {}, evidence: [], fixLocus: 'persona-prompt', recommendation: 'r', fixPath: 'persona-edit', effort: 'S' },
  ];

  async function results({ state, features, withClusters = clusters, contamination } = {}) {
    const t = await tmpRun();
    const data = await loadRunData(t.dir);
    if (state) data.state = { ...data.state, ...state, gates: { ...data.state.gates, ...(state.gates ?? {}) } };
    data.features = features ?? null;
    data.clusters = withClusters;
    if (contamination) data.runs.find((x) => x.cardId === 'icp-04' && x.k === 2).contamination = contamination;
    const r = buildResults(data, { now: NOW });
    await t.cleanup();
    return r;
  }

  test('memory unknown: caveat on memory clusters, artefacts last, and the lede headlines a real defect', async () => {
    const r = await results();
    expect(r.environment).toMatchObject({ sharedIdentity: true, memory: { status: 'unknown', mitigation: 'caveat', caveat: true } });
    expect(r.clusters.map((c) => [c.id, c.rank, c.caveat ?? null])).toEqual([['C1', 1, 'possible cross-run memory'], ['C3', 2, null], ['C2', 3, null]]);
    expect(shortVersion(r)).toMatch(/The most serious finding: Stored notes from other chats recited \(critical, 10 occurrences; possible cross-run memory\)/);
    const fa = failureAnalysis(r);
    expect(fa).toMatch(/\| 1 \| Stored notes from other chats recited \(possible cross-run memory\) \|/);
    expect(fa).toMatch(/\*Caveat: possible cross-run memory\. Platform memory was on/);
    expect(fa).toMatch(/\*Harness artefact: a fact about how the test ran, not a defect of the agent\.\*/);
    const m = method(r);
    expect(m).toMatch(/### Shared identity and platform memory/);
    expect(m).toMatch(/Every persona chatted as the same signed-in lua user/);
    expect(m).toMatch(/may amplify them/);
    expect(m).toMatch(/could not be checked/);
    expect(m).toMatch(/marks the run contaminated \(cross-run memory\)/);
  });

  test('only artefact clusters: the lede says no failure cluster headline', async () => {
    const r = await results({ withClusters: [clusters[1]] });
    expect(shortVersion(r)).toMatch(/No failure clusters were recorded\./);
  });

  test('memory off: no caveat', async () => {
    const r = await results({ features: featuresDoc({ ok: true, features: [{ name: 'luaMemoryCrossChatEnabled', title: 'x', active: false }], note: null }, 'T') });
    expect(r.environment.memory).toEqual({ status: 'off', active: [], mitigation: 'none', verifiedOff: null, restored: null, caveat: false });
    expect(r.clusters.every((c) => !c.caveat)).toBe(true);
    expect(method(r)).toMatch(/found no memory that carries across chats switched on/);
  });

  test('memory switched off for the run: verified (no caveat) or not (caveat); restored or not', async () => {
    const memory = { status: 'active', active: ['memoryWrite'], mitigation: 'off-for-run', restore: ['memoryWrite'] };
    const env = { at: 'x', summary: 'ok', productionConsent: null, memory };
    const verified = await results({ state: { gates: { environment: env }, memoryRestore: { features: ['memoryWrite'], verifiedOffAt: 'a', restoredAt: 'b' } } });
    expect(verified.environment.memory).toMatchObject({ mitigation: 'off-for-run', verifiedOff: true, restored: true, caveat: false });
    expect(method(verified)).toMatch(/was switched off for the test window with the owner's consent, and the switch was verified.*It was switched back on afterwards\./);
    const unverified = await results({ state: { gates: { environment: env }, memoryRestore: { features: ['memoryWrite'] } } });
    expect(unverified.environment.memory).toMatchObject({ verifiedOff: false, restored: false, caveat: true });
    const text = method(unverified);
    expect(text).toMatch(/the switch was not verified/);
    expect(text).toMatch(/\*\*It has not been verified as switched back on: restore it\*\*/);
  });

  test('memory kept on: active names and the caveat', async () => {
    const env = { at: 'x', summary: 'ok', productionConsent: null, memory: { status: 'active', active: ['luaMemoryCrossChatEnabled'], mitigation: 'caveat', restore: [] } };
    const r = await results({ state: { gates: { environment: env } } });
    expect(identityAndMemory(r).join('\n')).toMatch(/memory that carries across chats switched on \(`luaMemoryCrossChatEnabled`\), and it stayed on during the test/);
    expect(identityAndMemory({}).join('\n')).toMatch(/could not be checked/);
  });

  test('a run voided by cross-run memory shows it in the isolation column', async () => {
    const r = await results({ contamination: { status: 'CONTAMINATED', reasons: ['cross-run memory: turn 2 reply quotes the persona name "Maria" of card icp-01, which this run never sent'] } });
    const row = r.cards.find((c) => c.id === 'icp-04').runs[1];
    expect(row).toMatchObject({ verdict: 'VOID', crossRunMemory: true });
    expect(personaResults(r)).toMatch(/\| 2 \| 1 \| Void \| contaminated \(cross-run memory\) \|/);
  });

  test('helpers', () => {
    expect(isArtefactCluster({ fixLocus: 'test-artifact' })).toBe(true);
    expect(isArtefactCluster({ fixLocus: 'persona-prompt', harnessArtefact: true })).toBe(true);
    expect(isArtefactCluster(null)).toBe(false);
    expect(isMemoryCluster({ title: 'Recalls details from previous conversations' })).toBe(true);
    expect(isMemoryCluster({ title: 'Long replies', rootCause: 'no rule' })).toBe(false);
    expect(isMemoryCluster(undefined)).toBe(false);
    expect(memoryIsolation(null, null)).toEqual({ status: 'unknown', active: [], mitigation: 'caveat', verifiedOff: null, restored: null, caveat: true });
    expect(memoryIsolation(null, { features: [{ name: 'memoryRecall', active: true }] })).toMatchObject({ status: 'active', active: ['memoryRecall'], caveat: true });
  });
});

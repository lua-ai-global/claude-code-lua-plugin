// The tier gates hold against the planner and the clock: the production-ready release gate counts stress, logs and
// side effects; the bar and the smoke cap clock come from state.json only; the cap stops turns and tests, not only
// new runs; agreed email domains need a real agreement and never a public mailbox family; local parts are seen whole.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { TIERS, clockStart, minutesLeft, runBar, tierVerdict } from '../../../lib/qa/tiers.mjs';
import { cliGate } from '../../../lib/qa/state.mjs';
import { cliFinishRun, cliRecord, cliStartRun } from '../../../lib/qa/recorder.mjs';
import { budgetSeconds, cliToolTest } from '../../../lib/qa/tool-test.mjs';
import { cliFlowTest } from '../../../lib/qa/flow-test.mjs';
import { buildResults, loadRunData } from '../../../lib/qa/report/results.mjs';
import { buildWorkflowArgs } from '../../../lib/qa/workflow/args.mjs';
import { checkTestData, emailProblem, isPublicMailDomain, parseAllowedEmailDomains, registrableLabel } from '../../../lib/qa/safety.mjs';
import { mkio, scaffoldRun, stateJson, wj, wjPlan, writeValidPlan } from './fixtures/runtime-helpers.mjs';
import { writeTierFixture } from './report/tier-fixture.mjs';

const NOW = () => new Date('2026-10-07T16:00:00.000Z');
const APPROVED = '2026-10-07T14:00:00.000Z';
const at = (min) => () => new Date(Date.parse(APPROVED) + min * 60000);
const bytes = (n) => Buffer.alloc(n, 1);

async function withTierFixture(tier, fn) {
  const base = await mkdtemp(join(tmpdir(), 'qa-gates-'));
  try {
    const dir = join(base, 'run');
    await writeTierFixture(dir, tier);
    return await fn(dir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const patchJson = async (path, fn) => {
  const obj = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify(fn(obj) ?? obj), 'utf8');
};

describe('the production-ready release gate', () => {
  const PR = TIERS['production-ready'];
  const clean = (over = {}) => ({ overall: 'pass', toolTests: { fail: 0 }, flowTests: { fail: 0 }, stress: { status: 'pass' }, logsPresent: true, logErrors: 0, sideEffects: { unexpected: 0 }, ...over });
  const card = { id: 'icp-01', chip: 'pass', bar: {} };

  test('the reviewed call: stress failed and 12 error logs is NO, never YES', () => {
    const v = tierVerdict(PR, { summary: { overall: 'partial', toolTests: { fail: 0 }, flowTests: { fail: 0 }, stress: { status: 'fail' }, logErrors: 12 }, cards: [card], metrics: [] });
    expect(v).toMatchObject({ releaseReady: false, passed: false });
    expect(v.text).toMatch(/^Production ready: NO/);
    expect(v.blockers).toEqual(['the stress test did not pass (fail)', 'no log scan result was recorded']);
  });

  test('stress that failed, was skipped or is partial blocks; a stress-free tier ignores it', () => {
    expect(tierVerdict(PR, { summary: clean({ stress: { status: 'fail' } }), cards: [card], metrics: [] }).text).toBe('Production ready: NO, 1 blocker');
    expect(tierVerdict(PR, { summary: clean({ stress: { status: 'skipped' } }), cards: [card], metrics: [] }).blockers).toEqual(['the stress test did not run']);
    expect(tierVerdict(PR, { summary: clean({ stress: undefined }), cards: [card], metrics: [] }).blockers).toEqual(['the stress test did not run']);
    expect(tierVerdict(TIERS.smoke, { summary: clean({ stress: { status: 'skipped' } }), cards: [card], metrics: [] }).blockers).toEqual([]);
    // Smoke: a missing scan is not an agent finding, error logs are.
    expect(tierVerdict(TIERS.smoke, { summary: clean({ logsPresent: false }), cards: [card], metrics: [] }).blockers).toEqual([]);
    expect(tierVerdict(TIERS.smoke, { summary: clean({ logErrors: 2 }), cards: [card], metrics: [] }).blockers).toEqual(['2 error log entries in the test window']);
    expect(tierVerdict(TIERS.medium, { summary: clean({ logsPresent: false }), cards: [card], metrics: [] }).blockers).toEqual(['no log scan result was recorded']);
  });

  test('a missing log scan, error logs and unexpected side effects block', () => {
    expect(tierVerdict(PR, { summary: clean({ logsPresent: false }), cards: [card], metrics: [] })).toMatchObject({ text: 'Production ready: NO, 1 blocker', releaseReady: false, blockers: ['no log scan result was recorded'] });
    expect(tierVerdict(PR, { summary: clean({ logErrors: 1 }), cards: [card], metrics: [] }).blockers).toEqual(['1 error log entry in the test window']);
    expect(tierVerdict(PR, { summary: clean({ sideEffects: { unexpected: 2 } }), cards: [card], metrics: [] }).blockers).toEqual(['2 unexpected side effects in the ledger']);
    expect(tierVerdict(PR, { summary: clean({ sideEffects: { unexpected: 1 } }), cards: [card], metrics: [] }).blockers).toEqual(['1 unexpected side effect in the ledger']);
  });

  test('overall must be a pass: the backstop blocks once, only when nothing else did', () => {
    expect(tierVerdict(PR, { summary: clean({ overall: 'partial' }), cards: [card], metrics: [] })).toMatchObject({ releaseReady: false, blockers: ['the overall result is partial, not a pass'] });
    expect(tierVerdict(PR, { summary: clean({ overall: undefined }), cards: [card], metrics: [] }).blockers).toEqual(['the overall result is unknown, not a pass']);
    expect(tierVerdict(PR, { summary: clean({ overall: 'partial', logErrors: 3 }), cards: [card], metrics: [] }).blockers).toEqual(['3 error log entries in the test window']);
    expect(tierVerdict(PR, { summary: clean(), cards: [card], metrics: [] })).toMatchObject({ text: 'Production ready: YES', releaseReady: true });
  });

  test('tests the cap stopped are "not run", apart from real failures', () => {
    const s = clean({ toolTests: { fail: 3, notRun: 2 }, flowTests: { fail: 1, notRun: 1 } });
    expect(tierVerdict(TIERS.smoke, { summary: s, cards: [card], metrics: [], capReached: true }).blockers).toEqual([
      '1 tool test(s) failed', '2 tool test(s) not run: the 30-minute cap was reached', '1 flow test(s) not run: the 30-minute cap was reached',
    ]);
    expect(tierVerdict(TIERS.smoke, { summary: s, cards: [card], metrics: [] }).blockers).toContain('2 tool test(s) not run');
  });

  test('a card whose run the cap closed reads "not played", not an agent defect', () => {
    const c = { id: 'icp-02', chip: 'partial', inconclusive: true, capStopped: 1, runs: [{ verdict: 'VOID' }], bar: { runs: 1, valid: 0, required: 1, passes: 0 } };
    expect(tierVerdict(TIERS.smoke, { summary: clean(), cards: [c], metrics: [], capReached: true }).blockers).toEqual(['icp-02: not played: the 30-minute cap was reached']);
  });

  test('aggregate: a production fixture without its stress result or log scan says NO', async () => {
    await withTierFixture('production-ready', async (dir) => {
      await rm(join(dir, 'mechanics', 'stress', 'stress.json'));
      await rm(join(dir, 'mechanics', 'logs', 'scan.json'));
      const r = buildResults(await loadRunData(dir), { now: NOW });
      expect(r.verdict.releaseReady).toBe(false);
      expect(r.verdict.blockers).toEqual(expect.arrayContaining(['the stress test did not run', 'no log scan result was recorded']));
      expect(r.summary.logsPresent).toBe(false);
    });
  });

  test('aggregate: the production fixture covers every exposed attack class', async () => {
    await withTierFixture('production-ready', async (dir) => {
      const r = buildResults(await loadRunData(dir), { now: NOW });
      expect(r.scope.redTeam).toBe(5);
      expect(r.scope.attackClasses).toHaveLength(5);
      expect(r.scope.notRun.join()).not.toMatch(/no red-team card covered/);
      await rm(join(dir, 'plan', 'cards', 'rt-05.json'));
      await rm(join(dir, 'runs', 'rt-05'), { recursive: true });
      const less = buildResults(await loadRunData(dir), { now: NOW });
      expect(less.scope.notRun).toContain('attack classes no red-team card covered: impersonation');
    });
  });
});

describe('the bar and the clock come from state.json', () => {
  test('runBar: state first, a run.json bar only when the tier allows it, else the tier default', () => {
    const pr = { tier: 'production-ready' };
    expect(runBar({ bar: { runsPerCard: 1, passRequired: 1 } }, pr)).toEqual({ runsPerCard: 5, passRequired: 4 });
    expect(runBar({ bar: { runsPerCard: 3, passRequired: 3 } }, { tier: 'medium', bar: { runsPerCard: 5, passRequired: 4 } })).toEqual({ runsPerCard: 5, passRequired: 4 });
    expect(runBar({ bar: { runsPerCard: 5, passRequired: 4 } }, { tier: 'medium' })).toEqual({ runsPerCard: 5, passRequired: 4 });
    expect(runBar({}, { tier: 'medium', bar: { runsPerCard: 1, passRequired: 1 } })).toEqual({ runsPerCard: 3, passRequired: 3 });
    expect(runBar(null, null)).toEqual({ runsPerCard: 3, passRequired: 3 });
  });

  test('clockStart and minutesLeft', () => {
    expect(clockStart({ clockStartedAt: APPROVED, gates: { plan: { at: '2026-10-07T15:00:00.000Z' } } })).toBe(Date.parse(APPROVED));
    expect(clockStart({ gates: { plan: { at: APPROVED } } })).toBe(Date.parse(APPROVED));
    expect(clockStart({ history: [{ at: APPROVED }] })).toBe(Date.parse(APPROVED));
    expect(clockStart(null)).toBeNaN();
    expect(minutesLeft({}, { tier: 'medium' }, 0)).toBe(Infinity);
    expect(minutesLeft({}, { tier: 'smoke', clockStartedAt: APPROVED }, at(10)().getTime())).toBe(20);
    expect(minutesLeft({}, { tier: 'smoke', clockStartedAt: APPROVED }, at(10)().getTime(), { reserve: true })).toBe(15);
    expect(minutesLeft({}, { tier: 'smoke' }, 0)).toBe(0);
  });

  test('workflow-args: a run.json edited to 1 of 1 with its tier deleted still plays a production run 5 times', () => {
    const cards = [{ id: 'icp-01', kind: 'icp' }];
    const a = buildWorkflowArgs({ run: { runId: 'x', projectDir: '/p', bar: { runsPerCard: 1, passRequired: 1 } }, state: { tier: 'production-ready' }, cards, pluginRoot: '/p', runDir: '/r' });
    expect(a.bar).toEqual({ runsPerCard: 5, passRequired: 4 });
    expect(a.runs).toHaveLength(5);
  });

  test('aggregate: an edited run.json bar and createdAt change neither the grading bar nor the clock', async () => {
    await withTierFixture('production-ready', async (dir) => {
      await patchJson(join(dir, 'run.json'), (r) => {
        delete r.tier;
        r.bar = { runsPerCard: 1, passRequired: 1 };
        r.createdAt = '2099-01-01T00:00:00.000Z';
      });
      const r = buildResults(await loadRunData(dir), { now: NOW });
      expect(r.config).toMatchObject({ runsPerCard: 5, passRequired: 4 });
      expect(r.scope).toMatchObject({ runsPerCard: 5, passRequired: 4 });
      expect(r.verdict.text).toMatch(/^Production ready: NO/);
      expect(r.elapsedMinutes).toBe(232);
    });
  });

  test('init-run state carries the bar; the environment gate --runs updates state.json and run.json', async () => {
    const { runDir, projectDir } = await scaffoldRun({ stateOver: { tier: 'medium', bar: { runsPerCard: 3, passRequired: 3 }, gates: { ...stateJson().gates, environment: null, plan: null } } });
    const m = join(projectDir, 'm.json');
    await wj(m, { schema: 'lua-qa/metrics@1', items: [{ id: 'task-success', label: 'x', unit: 'ratio', target: 1, comparator: '>=', source: 'cards', agreed: true }] });
    const t = mkio();
    expect(await cliGate(['--run-dir', runDir, '--stamp', 'environment', '--metrics-file', m, '--runs', '5'], t.io, { now: at(0) })).toBe(0);
    expect(JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8')).bar).toEqual({ runsPerCard: 5, passRequired: 4 });
    expect(JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')).bar).toEqual({ runsPerCard: 5, passRequired: 4 });
  });
});

describe('the smoke cap stops turns and tests, not only new runs', () => {
  const smoke = () => scaffoldRun({ stateOver: { tier: 'smoke', clockStartedAt: APPROVED } });
  const SEL = (runDir) => ['--run-dir', runDir, '--card', 'icp-01', '--run', '1'];

  test('record past the cap closes the run as inconclusive; finish-run keeps it closed', async () => {
    const { runDir } = await smoke();
    const s = mkio();
    expect(await cliStartRun(SEL(runDir), s.io, { now: at(20), randomBytes: bytes })).toBe(0);
    const { player } = s.json();
    const r = mkio();
    expect(await cliRecord([...SEL(runDir), '--player', player, '--message', 'hello'], r.io, { now: at(31) })).toBe(3);
    expect(r.json()).toMatchObject({ code: 'TIME_BUDGET' });
    const rec = JSON.parse(await readFile(join(runDir, 'runs', 'icp-01', 'r1', 'run-record.json'), 'utf8'));
    expect(rec).toMatchObject({ status: 'aborted', abortReason: 'time-budget', turns: 0, endedAt: at(31)().toISOString() });
    const state = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8'));
    expect(state.history.at(-1)).toMatchObject({ event: 'time-budget', detail: 'icp-01 r1 closed at turn 1' });
    const f = mkio();
    expect(await cliFinishRun([...SEL(runDir), '--player', player, '--status', 'done'], f.io, { now: at(33) })).toBe(0);
    const after = JSON.parse(await readFile(join(runDir, 'runs', 'icp-01', 'r1', 'run-record.json'), 'utf8'));
    expect(after).toMatchObject({ status: 'aborted', abortReason: 'time-budget', endedAt: at(31)().toISOString() });
  });

  test('aggregate counts a cap-closed run as not played', async () => {
    await withTierFixture('smoke', async (dir) => {
      await patchJson(join(dir, 'runs', 'icp-02', 'r1', 'run-record.json'), (r) => ({ ...r, status: 'aborted', abortReason: 'time-budget' }));
      await rm(join(dir, 'runs', 'icp-02', 'r1', 'grade-a.json'));
      await patchJson(join(dir, 'state.json'), (s) => ({ ...s, history: [{ at: 'x', event: 'time-budget', detail: 'icp-02 r1 closed at turn 3' }] }));
      const r = buildResults(await loadRunData(dir), { now: NOW });
      expect(r.cards.find((c) => c.id === 'icp-02').capStopped).toBe(1);
      expect(r.verdict.blockers).toContain('icp-02: not played: the 30-minute cap was reached');
    });
  });

  test('tool and flow tests refuse past the cap and are clamped to what is left', async () => {
    const { runDir } = await smoke();
    await wjPlan(runDir, 'tool-tests.json', { schema: 'lua-qa/tool-tests@1', tests: [{ id: 'tt-1', tool: 'get_order', input: { id: 1 }, expect: 'ok', rationale: 'r' }] });
    await wjPlan(runDir, 'flow-tests.json', { schema: 'lua-qa/flow-tests@1', tests: [{ id: 'ft-1', workflow: 'refund-flow', pathId: 'p1', description: 'd', input: { orderId: 'o1' }, stepOutputs: {}, approve: [], deny: [], signals: {}, expect: { exitCode: 0 } }] });
    const t = mkio();
    expect(await cliToolTest(['--run-dir', runDir, '--all'], t.io, { now: at(31) })).toBe(3);
    expect(t.json().code).toBe('TIME_BUDGET');
    const f = mkio();
    expect(await cliFlowTest(['--run-dir', runDir, '--all'], f.io, { now: at(31) })).toBe(3);
    expect(f.json().code).toBe('TIME_BUDGET');
    const state = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8'));
    expect(state.history.filter((h) => h.event === 'time-budget')).toHaveLength(2);
    const run = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
    // A direct buildScope call without a bar takes it from state.json.
    const { buildScope } = await import('../../../lib/qa/report/results.mjs');
    expect(buildScope(TIERS.smoke, { run, data: { state: { tier: 'smoke' } }, cards: [], flowRows: [], toolRows: [], stress: null, elapsedMinutes: null })).toMatchObject({ runsPerCard: 1, passRequired: 1, logScan: false });
    expect(await budgetSeconds(runDir, run, state, undefined, at(29.5))).toBe(30);
    await expect(budgetSeconds(runDir, run, state, undefined, at(29.8))).rejects.toMatchObject({ code: 'TIME_BUDGET', exitCode: 3 });
    expect(await budgetSeconds(runDir, run, state, 20, at(10))).toBe(20);
    expect(await budgetSeconds(runDir, run, { ...state, tier: 'medium' }, undefined, at(500))).toBe(100);
  });

  test('re-stamping the plan gate restarts the clock only before any conversation started', async () => {
    const stamp = async (history) => {
      const { runDir } = await scaffoldRun({ stateOver: { ...stateJson({ gates: { ...stateJson().gates, plan: null } }), clockStartedAt: APPROVED, history }, cards: [] });
      await writeValidPlan(runDir);
      expect(await cliGate(['--run-dir', runDir, '--stamp', 'plan'], mkio().io, { now: at(20) })).toBe(0);
      return JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8')).clockStartedAt;
    };
    expect(await stamp([{ at: APPROVED, event: 'start-run', detail: 'icp-01 r1 a1' }])).toBe(APPROVED);
    expect(await stamp([])).toBe(at(20)().toISOString());
  });
});

describe('agreed email domains', () => {
  test('an inferred questions gate cannot agree an email domain', async () => {
    const inferredQ = { at: 'x', summary: 's', inferred: true };
    const { runDir, projectDir } = await scaffoldRun({ stateOver: { gates: { ...stateJson().gates, questions: inferredQ, environment: null, plan: null } } });
    const m = join(projectDir, 'm.json');
    await wj(m, { schema: 'lua-qa/metrics@1', items: [{ id: 'task-success', label: 'x', unit: 'ratio', target: 1, comparator: '>=', source: 'cards', agreed: true }] });
    const t = mkio();
    expect(await cliGate(['--run-dir', runDir, '--stamp', 'environment', '--metrics-file', m, '--allowed-email-domains', 'acme-corp.test'], t.io, { now: at(0) })).toBe(3);
    expect(t.json().code).toBe('EMAIL_DOMAIN_REFUSED');
    const ok = mkio();
    expect(await cliGate(['--run-dir', runDir, '--stamp', 'environment', '--metrics-file', m], ok.io, { now: at(0) })).toBe(0);
    expect(ok.json().allowedEmailDomains).toEqual([]);
  });

  test('public mailbox families are refused on every TLD and country suffix', () => {
    for (const d of ['yahoo.co.uk', 'hotmail.co.uk', 'live.co.uk', 'outlook.de', 'yahoo.fr', 'gmx.at', 't-online.de', 'tutanota.com', 'duck.com', 'yahoo.com.br', 'mail.yahoo.co.uk', 'gmail.de', 'proton.ch']) {
      expect(isPublicMailDomain(d)).toBe(true);
      expect(() => parseAllowedEmailDomains(d)).toThrow(expect.objectContaining({ code: 'EMAIL_DOMAIN_REFUSED', exitCode: 3 }));
    }
    for (const d of ['acme-corp.test', 'mail.acme-corp.test', 'acme.co.uk', 'acme.com.au', 'web.acme-corp.test']) {
      expect(isPublicMailDomain(d)).toBe(false);
      expect(parseAllowedEmailDomains(d)).toEqual([d]);
    }
    expect(isPublicMailDomain('pm.me')).toBe(true);
    expect(registrableLabel('mail.yahoo.co.uk')).toBe('yahoo');
    expect(registrableLabel('mail.acme-corp.test')).toBe('acme-corp');
    expect(registrableLabel('localhost')).toBe('localhost');
    expect(registrableLabel('')).toBe('');
  });

  test('the whole local part is checked, with RFC 5322 atext characters', () => {
    const policy = { allowedEmailDomains: ['acme.com'] };
    const r = checkTestData("jane=test.1@acme.com and o'test.x@acme.com", policy);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.value)).toEqual(['jane=test.1@acme.com', "o'test.x@acme.com"]);
    for (const bad of ['jane/test.1@acme.com', 'j!qa.1@acme.com', 'jane#qa@acme.com', 'a*test@acme.com']) expect(checkTestData(bad, policy).ok).toBe(false);
    // Quoting and markup around a fake address are not its first letter.
    expect(checkTestData("'qa.01@acme.com'", policy).ok).toBe(true);
    expect(checkTestData('**test.2@acme.com**', policy).ok).toBe(true);
    expect(checkTestData('`qa.3@acme.com`', policy).ok).toBe(true);
    expect(emailProblem("o'test.x@acme.com", ['acme.com'])).toMatch(/must look fake/);
  });
});

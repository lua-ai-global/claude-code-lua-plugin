// The validator enforces what the docs claim: turn ranges, the coverage checklist, test
// data in every text field, an explicit n/a for flow tests, burst stress without thread counts, expected log lines.
import { join } from 'node:path';
import { CARD_TRAITS, cliValidate, planChecklist, validate, validatePlan } from '../../../lib/qa/schemas.mjs';
import { cardJson, flowModel, mkio, scaffoldRun, stateJson, validPlan, wj, writeValidPlan } from './fixtures/runtime-helpers.mjs';

async function planned(mutate = () => {}, { model = flowModel(), stateOver } = {}) {
  const { runDir } = await scaffoldRun({ cards: [], ...(stateOver ? { stateOver } : {}) });
  await wj(join(runDir, 'discovery', 'flow-model.json'), model);
  const plan = validPlan();
  mutate(plan);
  await writeValidPlan(runDir, plan);
  return { runDir, result: await validatePlan(runDir) };
}
const icp = (plan, id) => plan.cards.find((c) => c.id === id);

describe('the shared valid plan', () => {
  test('passes', async () => {
    expect((await planned()).result).toEqual({ ok: true, errors: [], coverageGaps: [] });
  });
  test('thresholds live in one table driven by run.counts', () => {
    expect(planChecklist({ counts: { icp: 12 } })).toMatchObject({ minIcp: 12, minRedTeam: 3, personasPerSkill: 2 });
    expect(planChecklist(null).minIcp).toBe(10);
    expect(planChecklist({ counts: { icp: 4 } }).minIcp).toBe(10);
  });
});

describe('turn ranges', () => {
  test.each([
    ['min above max', (p) => { icp(p, 'icp-01').turns = { min: 8, max: 6 }; }, /turns.min \(8\) is greater than turns.max \(6\)/],
    ['persona too short', (p) => { icp(p, 'icp-02').turns = { min: 2, max: 6 }; }, /icp-02.json: turns must stay within 4 to 12 for a persona card/],
    ['persona too long', (p) => { icp(p, 'icp-03').turns = { min: 4, max: 20 }; }, /within 4 to 12/],
    ['red team too long', (p) => { icp(p, 'rt-01').turns = { min: 3, max: 9 }; }, /rt-01.json: turns must stay within 3 to 8 for a red-team card/],
  ])('%s', async (_n, mutate, re) => {
    const { result } = await planned(mutate);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(re);
  });
  test('a long-session persona may go to 12', async () => {
    expect((await planned((p) => { icp(p, 'icp-07').turns = { min: 10, max: 12 }; })).result.ok).toBe(true);
  });
});

describe('coverage checklist', () => {
  test('missing variations, technical spread and skill spread are gaps', async () => {
    const { result } = await planned((p) => {
      for (const c of p.cards.filter((x) => x.kind === 'icp')) {
        c.traits = [];
        c.persona = { ...c.persona, technical: true };
        c.coverage = { ...c.coverage, skills: c.id === 'icp-01' ? ['orders'] : [] };
      }
    });
    expect(result.ok).toBe(false);
    expect(result.coverageGaps).toEqual(expect.arrayContaining([
      'checklist: no non-technical persona',
      'checklist: no impatient persona (add "impatient" to a card\'s traits)',
      'checklist: no privacy-sensitive persona (add "privacy-sensitive" to a card\'s traits)',
      'checklist: no vague persona (add "vague" to a card\'s traits)',
      'checklist: no out-of-scope persona (add "out-of-scope" to a card\'s traits)',
      'checklist: skill orders is hit by 1 persona(s), needs 2',
    ]));
  });
  test('a variation named in the temperament counts; a technical persona via traits counts', async () => {
    const { result } = await planned((p) => {
      icp(p, 'icp-02').traits = [];
      icp(p, 'icp-02').persona = { ...icp(p, 'icp-02').persona, temperament: 'impatient, terse' };
      icp(p, 'icp-01').persona = { ...icp(p, 'icp-01').persona, technical: false };
    });
    expect(result).toEqual({ ok: true, errors: [], coverageGaps: [] });
  });
  test('no technical persona at all is a gap', async () => {
    const { result } = await planned((p) => {
      icp(p, 'icp-01').traits = [];
      icp(p, 'icp-01').persona = { ...icp(p, 'icp-01').persona, technical: false };
    });
    expect(result.coverageGaps).toEqual(['checklist: no technical persona']);
  });
  test('traits must come from the list', () => {
    expect(validate('card', cardJson('icp-01', { traits: ['grumpy'] })).errors.join()).toMatch(/traits: "grumpy" is not one of/);
    expect(CARD_TRAITS).toEqual(expect.arrayContaining(['impatient', 'privacy-sensitive', 'vague', 'out-of-scope']));
  });
  test('a chat-startable workflow must be in some persona\'s coverage, unless scheduled or listed as not chat-startable', async () => {
    const wf = (name, over = {}) => ({ name, form: 'graph', schedule: null, nodes: [], paths: [{ id: 'p1' }], ...over });
    const model = flowModel({ workflows: [wf('onboard'), wf('nightly', { schedule: { expression: '0 2 * * *' } }), wf('webhook-only')] });
    const tests = ['onboard', 'nightly', 'webhook-only'].map((w, i) => ({ id: `ft-${i}`, workflow: w, pathId: 'p1', input: {}, expect: { exitCode: 0 } }));
    const gaps = (await planned((p) => { p.flowTests = { schema: 'lua-qa/flow-tests@1', tests }; }, { model })).result.coverageGaps;
    expect(gaps.filter((g) => g.includes('workflow'))).toEqual([
      expect.stringMatching(/^checklist: workflow onboard is not in any persona/),
      expect.stringMatching(/^checklist: workflow webhook-only is not in any persona/),
    ]);
    const ok = await planned((p) => {
      p.flowTests = { schema: 'lua-qa/flow-tests@1', tests, notChatStartable: ['webhook-only'] };
      icp(p, 'icp-01').coverage.workflows = ['onboard'];
    }, { model });
    expect(ok.result).toEqual({ ok: true, errors: [], coverageGaps: [] });
  });
});

describe('test data in every text field', () => {
  test.each([
    ['persona.context', (c) => { c.persona = { ...c.persona, context: 'works with jane@realcorp.io daily' }; }, 'jane@realcorp.io'],
    ['mustNot', (c) => { c.mustNot = ['email bob@realcorp.io the report']; }, 'bob@realcorp.io'],
    ['successCriteria', (c) => { c.successCriteria = [{ id: 'S1', description: 'confirms to ann@realcorp.io' }]; }, 'ann@realcorp.io'],
  ])('%s', async (_n, mutate, addr) => {
    const { result } = await planned((p) => mutate(icp(p, 'icp-04')));
    expect(result.errors.join('\n')).toContain(`plan/cards/icp-04.json: email "${addr}" is not fake test data`);
    expect(result.errors.filter((e) => e.includes(addr))).toHaveLength(1);
  });
  test('the agreed email domain passes with a fake local part only', async () => {
    const stateOver = stateJson({ gates: { ...stateJson().gates, environment: { at: 'x', summary: 's', productionConsent: null, allowedEmailDomains: ['acme-corp.test'] } } });
    const fake = await planned((p) => { icp(p, 'icp-05').testData = { emails: ['qa.reset.01@acme-corp.test'], phones: [], secrets: [] }; }, { stateOver });
    expect(fake.result.ok).toBe(true);
    const real = await planned((p) => { icp(p, 'icp-05').mustNot = ['reset jane.smith@acme-corp.test']; }, { stateOver });
    expect(real.result.errors.join()).toMatch(/jane.smith@acme-corp.test" is not fake test data \(the local part on acme-corp.test must look fake/);
    const card = cardJson('icp-01', { testData: { emails: ['qa@acme-corp.test'], phones: [], secrets: [] } });
    expect(validate('card', card).ok).toBe(false);
    expect(validate('card', card, { testData: { allowedEmailDomains: ['acme-corp.test'] } }).ok).toBe(true);
  });
  test('validate --what cards uses the stamped policy', async () => {
    const stateOver = stateJson({ gates: { ...stateJson().gates, environment: { at: 'x', summary: 's', productionConsent: null, allowedEmailDomains: ['acme-corp.test'] } } });
    const { runDir } = await planned((p) => { icp(p, 'icp-05').testData = { emails: ['qa@acme-corp.test'], phones: [], secrets: [] }; }, { stateOver });
    expect(await cliValidate(['--run-dir', runDir, '--what', 'cards'], mkio().io)).toBe(0);
  });
});

describe('flow tests: explicit n/a and path coverage', () => {
  const graphModel = () => flowModel({ workflows: [{ name: 'refund', form: 'graph', schedule: { expression: 'x' }, nodes: [], paths: [{ id: 'p1' }, { id: 'p2' }] }, { name: 'scripted', form: 'script', schedule: { expression: 'x' }, nodes: [], paths: [] }] });
  test('an empty list needs notApplicable; notApplicable with tests is an error', () => {
    expect(validate('flow-tests', { schema: 'lua-qa/flow-tests@1', tests: [] }).errors.join()).toMatch(/tests is empty: set notApplicable/);
    expect(validate('flow-tests', { schema: 'lua-qa/flow-tests@1', tests: [], notApplicable: ' ' }).ok).toBe(false);
    expect(validate('flow-tests', { schema: 'lua-qa/flow-tests@1', tests: [], notApplicable: 'no workflows' }).ok).toBe(true);
    const one = [{ id: 'f', workflow: 'w', pathId: 'p1', input: {}, expect: {} }];
    expect(validate('flow-tests', { schema: 'lua-qa/flow-tests@1', tests: one, notApplicable: 'x' }).errors.join()).toMatch(/notApplicable is set but tests is not empty/);
  });
  test('n/a is refused when the agent has workflows; every path and every script workflow needs a test', async () => {
    const { result } = await planned(() => {}, { model: graphModel() });
    expect(result.errors.join()).toMatch(/notApplicable is only for an agent without workflows; this one has 2/);
    expect(result.coverageGaps).toEqual(expect.arrayContaining([
      'flow-tests: path refund/p1 has no test', 'flow-tests: path refund/p2 has no test',
      'flow-tests: workflow scripted has no test (a script-form workflow needs one happy-path test)',
    ]));
  });
  test('tests for unknown workflows are errors; full coverage passes', async () => {
    const tests = [
      { id: 'a', workflow: 'refund', pathId: 'p1', input: {}, expect: {} }, { id: 'b', workflow: 'refund', pathId: 'p2', input: {}, expect: {} },
      { id: 'c', workflow: 'scripted', pathId: 'happy', input: {}, expect: {} },
    ];
    const ok = await planned((p) => { p.flowTests = { schema: 'lua-qa/flow-tests@1', tests }; }, { model: graphModel() });
    expect(ok.result).toEqual({ ok: true, errors: [], coverageGaps: [] });
    const bad = await planned((p) => { p.flowTests = { schema: 'lua-qa/flow-tests@1', tests: [...tests, { id: 'd', workflow: 'ghost', pathId: 'p1', input: {}, expect: {} }] }; }, { model: graphModel() });
    expect(bad.result.errors.join()).toMatch(/d: workflow ghost is not in the flow model/);
  });
});

describe('stress plan', () => {
  const base = { schema: 'lua-qa/stress-plan@1', messages: ['hi'], maxWallSeconds: 50, targets: { p90Ms: 1, p99Ms: 1, errorRate: 0 } };
  test('burst needs no thread counts', () => {
    expect(validate('stress-plan', { ...base, mode: 'burst', burst: { size: 2, delayMs: 10 } })).toEqual({ ok: true });
  });
  test('concurrent needs threads, turnsPerThread and concurrency', () => {
    const errs = validate('stress-plan', { ...base, mode: 'concurrent', burst: null, threads: 0 }).errors;
    expect(errs).toEqual(expect.arrayContaining([
      'threads is required (an integer >= 1) when mode is concurrent',
      'turnsPerThread is required (an integer >= 1) when mode is concurrent',
      'concurrency is required (an integer >= 1) when mode is concurrent',
    ]));
    expect(validate('stress-plan', { ...base, mode: 'concurrent', threads: 2, turnsPerThread: 1, concurrency: 1 }).ok).toBe(true);
  });
});

describe('tool tests: expected log lines', () => {
  const tt = (expectedLogs) => ({ schema: 'lua-qa/tool-tests@1', tests: [], expectedLogs });
  test('warn only, a literal of at least 6 characters, with a reason', () => {
    expect(validate('tool-tests', tt([{ tool: 'acme_reset_password', match: 'reset refused for admin', why: 'the tool warns on purpose' }])).ok).toBe(true);
    expect(validate('tool-tests', tt([{ tool: 't', subType: 'warn', match: 'P1 ticket opened', why: 'w' }])).ok).toBe(true);
    expect(validate('tool-tests', tt([{ tool: 't', subType: 'error', match: 'P1 ticket opened', why: 'w' }])).errors.join()).toMatch(/subType must be one of warn/);
    expect(validate('tool-tests', tt([{ tool: 't', match: 'P1', why: 'w' }])).errors.join()).toMatch(/match must be at least 6 characters/);
    expect(validate('tool-tests', tt([{ tool: 't', match: 'long enough' }])).errors.join()).toMatch(/why is required/);
  });
});

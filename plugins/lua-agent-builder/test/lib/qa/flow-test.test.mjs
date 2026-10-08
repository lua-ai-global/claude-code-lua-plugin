import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cliFlowTest, flowTestArgv, judgeFlowTest, reachedSteps } from '../../../lib/qa/flow-test.mjs';
import { assertAllowedLuaArgv } from '../../../lib/qa/safety.mjs';
import { readJson } from '../../../lib/qa/io.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { fakeSpawn, mkio, scaffoldRun, stateJson, wjPlan } from './fixtures/runtime-helpers.mjs';

const FT = (id, over = {}) => ({
  id, workflow: 'refund-flow', pathId: 'p1', description: 'd', input: { orderId: 'o1' }, stepOutputs: {}, approve: [], deny: [], signals: {},
  expect: { exitCode: 0 }, ...over,
});
const plan = (tests) => ({ schema: 'lua-qa/flow-tests@1', tests });

describe('flowTestArgv', () => {
  test('builds the contract shape, stringifying JSON values; every shape passes the allowlist', () => {
    const argv = flowTestArgv(FT('a', {
      stepOutputs: { classify: { needsApproval: true } }, approve: ['refund-ok'], deny: ['escalate'], signals: { 'customer-reply': { text: 'yes' } },
    }));
    expect(argv).toEqual([
      'test', '--ci', 'workflow', '--name', 'refund-flow', '--input', '{"orderId":"o1"}', '--agents', 'fake', '--fast-retries', '--json',
      '--step-output', 'classify={"needsApproval":true}', '--approve', 'refund-ok', '--deny', 'escalate', '--signal', 'customer-reply={"text":"yes"}',
    ]);
    expect(() => assertAllowedLuaArgv(argv)).not.toThrow();
  });
  test('defaults', () => {
    expect(flowTestArgv({ workflow: 'wf' })).toEqual(['test', '--ci', 'workflow', '--name', 'wf', '--input', '{}', '--agents', 'fake', '--fast-retries', '--json']);
  });
});

describe('reachedSteps', () => {
  test('finds step lists under common keys, nested, as strings or objects', () => {
    expect(reachedSteps(JSON.stringify({ steps: ['a', 'b'] }))).toEqual(['a', 'b']);
    expect(reachedSteps(JSON.stringify({ result: { executedSteps: [{ stepId: 'x' }, { id: 'y' }, { name: 'z' }, 5, null] } }))).toEqual(['x', 'y', 'z']);
    expect(reachedSteps(JSON.stringify({ trace: [] }))).toEqual([]);
  });
  test('the lua-cli 3.45.0 offline --json shape: data.ledger.steps, skipped and pending steps excluded', () => {
    const out = JSON.stringify({ success: true, data: { status: 'completed', exitCode: 0, output: {}, ledger: { steps: {
      classify: { stepId: 'classify', status: 'completed' },
      refund: { stepId: 'refund', status: 'completed', taken: 'approve' },
      escalate: { stepId: 'escalate', status: 'skipped', skipReason: 'branch not taken' },
      later: { status: 'pending' },
      anon: { status: 'completed' },
    } } } });
    expect(reachedSteps(out)).toEqual(['classify', 'refund', 'anon']);
    expect(reachedSteps(JSON.stringify({ ledger: { steps: {} } }))).toEqual([]);
    expect(judgeFlowTest(FT('a', { expect: { reachNodes: ['refund'], notReachNodes: ['escalate'] } }), { exitCode: 0, stdout: out })).toMatchObject({ status: 'pass', reached: ['classify', 'refund', 'anon'] });
  });
  test('null when the output does not list steps (V3)', () => {
    expect(reachedSteps(JSON.stringify({ status: 'completed' }))).toBeNull();
    expect(reachedSteps('not json')).toBeNull();
    expect(reachedSteps('42')).toBeNull();
    expect(reachedSteps(JSON.stringify({ a: { b: { c: { d: { steps: ['deep'] } } } } }))).toBeNull();
    expect(reachedSteps(JSON.stringify({ steps: [{}] }))).toBeNull();
  });
});

describe('judgeFlowTest', () => {
  test('exit code mismatch, outputIncludes', () => {
    const t = FT('a', { expect: { exitCode: 0, outputIncludes: ['refunded'] } });
    expect(judgeFlowTest(t, { exitCode: 1, stdout: 'x' })).toMatchObject({ status: 'fail', reasons: ['exit code 1, expected 0', 'output does not include "refunded"'] });
    expect(judgeFlowTest(t, { exitCode: 0, stdout: 'refunded ok' })).toMatchObject({ status: 'pass', reasons: [] });
    expect(judgeFlowTest({}, { exitCode: 0, stdout: '' }).status).toBe('pass');
  });
  test('reachNodes / notReachNodes use the step list when present', () => {
    const t = FT('a', { expect: { reachNodes: ['classify', 'refund'], notReachNodes: ['escalate'] } });
    const out = JSON.stringify({ steps: ['classify', 'escalate'] });
    const r = judgeFlowTest(t, { exitCode: 0, stdout: out });
    expect(r.status).toBe('fail');
    expect(r.reasons).toEqual(['step refund was not reached', 'step escalate was reached but should not have been']);
    expect(r.reached).toEqual(['classify', 'escalate']);
  });
  test('without a step list the node check is skipped with a note and the test still passes', () => {
    const t = FT('a', { expect: { reachNodes: ['classify'] } });
    const r = judgeFlowTest(t, { exitCode: 0, stdout: '{"status":"completed"}' });
    expect(r.status).toBe('pass');
    expect(r.reasons).toEqual(['note: step list not in output; reachNodes check skipped']);
    expect(r.reached).toBeNull();
  });
  test('infrastructure errors', () => {
    expect(judgeFlowTest(FT('a'), { infraError: 'lua did not finish in time' })).toEqual({ status: 'error', reasons: ['lua did not finish in time'], reached: null });
  });
});

describe('cliFlowTest', () => {
  async function setup(tests, stateOver) {
    const s = await scaffoldRun(stateOver ? { stateOver } : {});
    await wjPlan(s.runDir, 'flow-tests.json', plan(tests));
    return s;
  }
  const run = (s, args, spawn, deps = {}) => {
    const t = mkio({ cwd: s.projectDir });
    return cliFlowTest(['--run-dir', s.runDir, ...args], t.io, { spawn, ...deps }).then((code) => ({ code, t }));
  };
  test('runs offline tests, writes valid results, no consent needed', async () => {
    const s = await setup([FT('ft-1', { expect: { exitCode: 0, reachNodes: ['classify'] } }), FT('ft-2', { expect: { exitCode: 0, outputIncludes: ['nope'] } })]);
    const spawn = fakeSpawn(() => ({ code: 0, stdout: JSON.stringify({ steps: ['classify', 'refund'] }) }));
    const { code, t } = await run(s, ['--all'], spawn);
    expect(code).toBe(1);
    expect(t.json()).toMatchObject({ ok: false, done: 2, failed: 1 });
    const r1 = await readJson(join(s.runDir, 'mechanics', 'flow-tests', 'ft-1.json'));
    expect(validate('flow-test-result', r1)).toEqual({ ok: true });
    expect(r1).toMatchObject({ status: 'pass', reached: ['classify', 'refund'], workflow: 'refund-flow', pathId: 'p1' });
    expect((await readJson(join(s.runDir, 'mechanics', 'flow-tests', 'ft-2.json'))).status).toBe('fail');
    expect(spawn.calls[0].argv.slice(0, 5)).toEqual(['test', '--ci', 'workflow', '--name', 'refund-flow']);
  });
  test('an argv the allowlist refuses (odd step label) becomes an error result, not a crash', async () => {
    const s = await setup([FT('ft-x', { stepOutputs: { 'step with spaces': { a: 1 } } })]);
    const spawn = fakeSpawn(() => ({ code: 0 }));
    const { t } = await run(s, ['--id', 'ft-x'], spawn);
    expect(spawn.calls).toHaveLength(0);
    expect(t.json().results[0].status).toBe('error');
    expect(t.json().results[0].reasons[0]).toMatch(/not an allowed QA command shape/);
  });
  test('missing lua and a non-zero exit', async () => {
    const s = await setup([FT('ft-1')]);
    const r = await run(s, ['--all'], fakeSpawn(() => ({ error: 'spawn lua ENOENT' })));
    expect(r.t.json().results[0].status).toBe('error');
    const s2 = await setup([FT('ft-1')]);
    const r2 = await run(s2, ['--all'], fakeSpawn(() => ({ code: 2, stdout: 'boom' })));
    expect(r2.t.json().results[0]).toMatchObject({ status: 'fail', reasons: ['exit code 2, expected 0'] });
  });
  test('gate, plan and usage errors', async () => {
    const s = await setup([FT('ft-1')], stateJson({ gates: { ...stateJson().gates, plan: null } }));
    expect((await run(s, ['--all'], fakeSpawn(() => ({ code: 0 })))).code).toBe(3);
    const s2 = await scaffoldRun({});
    expect((await run(s2, ['--all'], fakeSpawn(() => ({ code: 0 })))).code).toBe(2);
    await wjPlan(s2.runDir, 'flow-tests.json', { schema: 'lua-qa/flow-tests@1' });
    expect((await run(s2, ['--all'], fakeSpawn(() => ({ code: 0 })))).code).toBe(2);
  });
});

describe('cliFlowTest: sandbox lock and fake data', () => {
  const lockDir = (s) => join(s.projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock');
  const go = (s, spawn, deps = {}) => {
    const t = mkio({ cwd: s.projectDir });
    return cliFlowTest(['--run-dir', s.runDir, '--all'], t.io, { spawn, ...deps }).then((code) => ({ code, t }));
  };
  test('in the sandbox, lua test workflow holds the lock', async () => {
    const s = await scaffoldRun({});
    await wjPlan(s.runDir, 'flow-tests.json', plan([FT('ft-1')]));
    let held = null;
    const spawn = fakeSpawn(() => {
      held = existsSync(lockDir(s));
      return { code: 0, stdout: '{}' };
    });
    await go(s, spawn);
    expect(held).toBe(true);
  });
  test('SANDBOX_BUSY is not written as an error result; the test stays to do', async () => {
    const s = await scaffoldRun({});
    await wjPlan(s.runDir, 'flow-tests.json', plan([FT('ft-1')]));
    await mkdir(lockDir(s), { recursive: true });
    await writeFile(join(lockDir(s), 'owner.json'), JSON.stringify({ at: new Date().toISOString() }));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: '{}' }));
    const { code, t } = await go(s, spawn, { sleep: async () => {} });
    expect(code).toBe(0);
    expect(t.json()).toMatchObject({ done: 0, remaining: 1, sandboxBusy: true });
    expect(existsSync(join(s.runDir, 'mechanics', 'flow-tests', 'ft-1.json'))).toBe(false);
    expect(spawn.calls).toHaveLength(0);
  });
  test('a real-looking email in a step output is refused (exit 3)', async () => {
    const s = await scaffoldRun({});
    await wjPlan(s.runDir, 'flow-tests.json', plan([FT('ft-1', { stepOutputs: { s1: { to: ['ann', 'realcorp.io'].join('@') } } })]));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: '{}' }));
    const { code } = await go(s, spawn);
    expect(code).toBe(3);
    expect(spawn.calls).toHaveLength(0);
  });
});

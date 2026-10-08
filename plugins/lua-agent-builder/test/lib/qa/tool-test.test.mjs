import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cliToolTest, detectThrow, judgeToolTest, parseJsonLoose, runPlanned } from '../../../lib/qa/tool-test.mjs';
import { readJson, readJsonl } from '../../../lib/qa/io.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { fakeSpawn, mkio, scaffoldRun, stateJson, wj, wjPlan } from './fixtures/runtime-helpers.mjs';

const plan = (tests) => ({ schema: 'lua-qa/tool-tests@1', tests });
const T = (id, over = {}) => ({ id, tool: 'get_order', input: { id: 1 }, expect: 'ok', rationale: 'r', ...over });

describe('parseJsonLoose', () => {
  test('whole document, trailing JSON after banners, embedded object, garbage', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('banner line\n{\n  "status": "error",\n  "n": {\n    "x": 1\n  }\n}')).toEqual({ status: 'error', n: { x: 1 } });
    expect(parseJsonLoose('prefix {"a": 2} suffix')).toEqual({ a: 2 });
    expect(parseJsonLoose('nothing here')).toBeNull();
    expect(parseJsonLoose('')).toBeNull();
    expect(parseJsonLoose(undefined)).toBeNull();
    expect(parseJsonLoose('{broken')).toBeNull();
    expect(parseJsonLoose('x {bad} y')).toBeNull();
  });
});

describe('detectThrow: lua test exits 0 even when a tool throws', () => {
  test('parsed status error with exit 0', () => {
    const r = detectThrow({ exitCode: 0, stdout: JSON.stringify({ status: 'error', error: { message: 'TypeError: x is undefined' } }), stderr: '' });
    expect(r).toEqual({ threw: true, errorMessage: 'TypeError: x is undefined' });
    expect(detectThrow({ exitCode: 0, stdout: '{"status":"error","error":"boom"}' }).errorMessage).toBe('boom');
    expect(detectThrow({ exitCode: 0, stdout: '{"status":"error","message":"m"}' }).errorMessage).toBe('m');
    expect(detectThrow({ exitCode: 0, stdout: '{"status":"error"}' }).errorMessage).toBe('tool returned status error');
    expect(detectThrow({ exitCode: 0, stdout: '{"status":"error","error":{"code":1}}' }).errorMessage).toBe('{"code":1}');
  });
  test('the lua-cli 3.45.0 error envelope (a throw under --json, non-zero or zero exit)', () => {
    const env = JSON.stringify({ success: false, error: { code: 'error', message: 'TypeError: x is undefined' } });
    expect(detectThrow({ exitCode: 0, stdout: env, stderr: '' })).toEqual({ threw: true, errorMessage: 'TypeError: x is undefined' });
    expect(detectThrow({ exitCode: 1, stdout: env })).toMatchObject({ threw: true });
    expect(detectThrow({ exitCode: 0, stdout: JSON.stringify({ success: false, error: { code: 'E1' } }) }).errorMessage).toBe('E1');
    expect(detectThrow({ exitCode: 0, stdout: JSON.stringify({ success: false, error: {} }) }).errorMessage).toBe('tool threw');
    expect(detectThrow({ exitCode: 0, stdout: JSON.stringify({ success: true, result: 1 }) }).threw).toBe(false);
  });
  test('"status":"error" in unparsed output, in stderr', () => {
    expect(detectThrow({ exitCode: 0, stdout: 'log {"status": "error"} tail', stderr: '' }).threw).toBe(true);
    expect(detectThrow({ exitCode: 0, stdout: '', stderr: '"status":"error"' }).threw).toBe(true);
  });
  test('stack traces', () => {
    const stack = 'Error: kaboom\n    at run (/app/tool.js:10:5)\n    at main (/app/index.js:2:1)';
    expect(detectThrow({ exitCode: 0, stdout: '', stderr: stack })).toEqual({ threw: true, errorMessage: 'Error: kaboom' });
    expect(detectThrow({ exitCode: 0, stdout: stack, stderr: '' }).threw).toBe(true);
    expect(detectThrow({ exitCode: 0, stdout: '', stderr: '\n    at run (/a.js:1:1)' }).errorMessage).toBe('stack trace in output');
  });
  test('non-zero exit counts; a clean run does not', () => {
    expect(detectThrow({ exitCode: 1, stdout: '{"ok":true}' })).toEqual({ threw: true, errorMessage: 'lua test exited with code 1' });
    expect(detectThrow({ exitCode: 0, stdout: '{"status":"success","result":{"x":1}}', stderr: '' })).toEqual({ threw: false, errorMessage: null });
    expect(detectThrow({ exitCode: null, stdout: 'ok' }).threw).toBe(false);
    expect(detectThrow({ exitCode: undefined })).toEqual({ threw: false, errorMessage: null });
  });
});

describe('judgeToolTest', () => {
  test('valid input that throws fails', () => {
    expect(judgeToolTest(T('a'), { threw: true, stdout: '' })).toEqual({ status: 'fail', reasons: ['tool threw on valid input'] });
  });
  test('invalid input that is accepted fails; rejected passes', () => {
    expect(judgeToolTest(T('a', { expect: 'error' }), { threw: false, stdout: '' }).reasons).toEqual(['tool accepted invalid input']);
    expect(judgeToolTest(T('a', { expect: 'error' }), { threw: true, stdout: '' }).status).toBe('pass');
  });
  test('outputIncludes', () => {
    const t = T('a', { outputIncludes: ['shipped', 'tracking'] });
    expect(judgeToolTest(t, { threw: false, stdout: 'shipped' }).reasons).toEqual(['output does not include "tracking"']);
    expect(judgeToolTest(t, { threw: false, stdout: 'shipped tracking' }).status).toBe('pass');
  });
  test('infrastructure errors are errors, not failures', () => {
    expect(judgeToolTest(T('a'), { infraError: 'lua did not finish in time' })).toEqual({ status: 'error', reasons: ['lua did not finish in time'] });
  });
});

describe('cliToolTest', () => {
  const okOut = JSON.stringify({ status: 'success', result: { status: 'shipped' } });
  async function setup(tests, stateOver) {
    const s = await scaffoldRun(stateOver ? { stateOver } : {});
    await wjPlan(s.runDir, 'tool-tests.json', plan(tests));
    return s;
  }
  const run = (s, args, spawn, deps = {}) => {
    const t = mkio({ cwd: s.projectDir, env: { PATH: '/usr/bin', SECRET_X: 'kept for lua test' } });
    return cliToolTest(['--run-dir', s.runDir, ...args], t.io, { spawn, ...deps }).then((code) => ({ code, t }));
  };

  test('a tool that throws with exit 0 is a failure; results are written and valid', async () => {
    const s = await setup([T('tt-a'), T('tt-b', { tool: 'cancel_order' })]);
    const spawn = fakeSpawn((argv) => (argv[4] === 'cancel_order'
      ? { code: 0, stdout: JSON.stringify({ status: 'error', error: { message: 'TypeError: nope' } }) }
      : { code: 0, stdout: okOut }));
    const { code, t } = await run(s, ['--all'], spawn);
    expect(code).toBe(1);
    expect(t.json()).toMatchObject({ ok: false, done: 2, remaining: 0, failed: 1 });
    const a = await readJson(join(s.runDir, 'mechanics', 'tool-tests', 'tt-a.json'));
    const b = await readJson(join(s.runDir, 'mechanics', 'tool-tests', 'tt-b.json'));
    expect(validate('tool-test-result', a)).toEqual({ ok: true });
    expect(a).toMatchObject({ status: 'pass', threw: false });
    expect(b).toMatchObject({ status: 'fail', threw: true, errorMessage: 'TypeError: nope', exitCode: 0, reasons: ['tool threw on valid input'] });
    expect(spawn.calls[0].argv).toEqual(['test', '--ci', 'skill', '--name', 'get_order', '--input', '{"id":1}', '--json']);
    expect(spawn.calls[0].opts.env.SECRET_X).toBe('kept for lua test');
  });
  test('--id runs one; resumable: finished ids are skipped unless --rerun', async () => {
    const s = await setup([T('tt-a'), T('tt-b')]);
    const spawn = fakeSpawn(() => ({ code: 0, stdout: okOut }));
    expect((await run(s, ['--id', 'tt-a'], spawn)).t.json()).toMatchObject({ done: 1, remaining: 0 });
    const second = await run(s, ['--all'], spawn);
    expect(second.t.json()).toMatchObject({ done: 1, alreadyDone: 1 });
    expect(spawn.calls).toHaveLength(2);
    const third = await run(s, ['--all', '--rerun'], spawn);
    expect(third.t.json().done).toBe(2);
  });
  test('the time budget stops the batch and reports what remains', async () => {
    const s = await setup([T('t1'), T('t2'), T('t3'), T('t4')]);
    // each test takes 30 s on the clock (the clock moves only when lua runs)
    let clock = 0;
    const now = () => new Date(clock);
    const spawn = fakeSpawn(() => {
      clock += 30_000;
      return { code: 0, stdout: okOut };
    });
    const { t } = await run(s, ['--all', '--max-seconds', '100'], spawn, { now });
    const out = t.json();
    expect(out.done).toBeGreaterThan(0);
    expect(out.done).toBeLessThan(4);
    expect(out.remaining).toBe(4 - out.done);
  });
  test('a missing lua is an error, not a failure', async () => {
    const s2 = await setup([T('t1')]);
    const gone = fakeSpawn(() => ({ error: 'spawn lua ENOENT' }));
    const r2 = await run(s2, ['--all'], gone);
    expect(r2.t.json().results[0]).toMatchObject({ status: 'error' });
  });
  test('refuses before the plan gate; usage errors', async () => {
    const s = await setup([T('t1')], stateJson({ gates: { ...stateJson().gates, plan: null } }));
    const spawn = fakeSpawn(() => ({ code: 0 }));
    expect((await run(s, ['--all'], spawn)).code).toBe(3);
    expect(spawn.calls).toHaveLength(0);
    const s2 = await setup([T('t1')]);
    expect((await run(s2, [], spawn)).code).toBe(2);
    expect((await run(s2, ['--all', '--id', 't1'], spawn)).code).toBe(2);
    expect((await run(s2, ['--id', 'nope'], spawn)).code).toBe(2);
    const s3 = await scaffoldRun({});
    expect((await run(s3, ['--all'], spawn)).code).toBe(2);
    await wjPlan(s3.runDir, 'tool-tests.json', { schema: 'lua-qa/tool-tests@1' });
    expect((await run(s3, ['--all'], spawn)).code).toBe(2);
  });
  test('output tails are redacted', async () => {
    const s = await setup([T('t1')]);
    const spawn = fakeSpawn(() => ({ code: 0, stdout: `${okOut}\nkey sk_live_abcdefgh12345` }));
    await run(s, ['--all'], spawn);
    expect(await readFile(join(s.runDir, 'mechanics', 'tool-tests', 't1.json'), 'utf8')).not.toMatch(/sk_live_abcdefgh/);
  });
});

describe('runPlanned', () => {
  test('always runs at least one test, then respects the budget using the median duration', async () => {
    const s = await scaffoldRun({});
    let clock = 0;
    const ran = [];
    const out = await runPlanned({
      tests: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], dir: join(s.runDir, 'x'), maxSeconds: 0, rerun: true,
      now: () => new Date(clock), runOne: async (t) => { ran.push(t.id); clock += 1000; return { id: t.id }; },
    });
    expect(ran).toEqual(['a']);
    expect(out.remaining).toBe(2);
  });
});

describe('review fixes: lock, fake data, ledger, plan seal, status text', () => {
  const okOut = JSON.stringify({ status: 'success', result: { status: 'shipped' } });
  const lockDir = (s) => join(s.projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock');
  const go = (s, spawn, deps = {}) => {
    const t = mkio({ cwd: s.projectDir });
    return cliToolTest(['--run-dir', s.runDir, '--all'], t.io, { spawn, ...deps }).then((code) => ({ code, t }));
  };

  test('a success result whose records carry "status":"error" is not a throw', () => {
    const out = JSON.stringify({ success: true, data: { records: [{ id: 1, status: 'error' }] } });
    expect(detectThrow({ exitCode: 0, stdout: out, stderr: '' })).toEqual({ threw: false, errorMessage: null });
    expect(detectThrow({ exitCode: 0, stdout: out, stderr: '"status":"error"' }).threw).toBe(false);
  });

  test('in the sandbox, lua test runs while holding the sandbox lock', async () => {
    const s = await scaffoldRun({});
    await wjPlan(s.runDir, 'tool-tests.json', plan([T('tt-a')]));
    let held = null;
    const spawn = fakeSpawn(() => {
      held = existsSync(lockDir(s));
      return { code: 0, stdout: okOut };
    });
    expect((await go(s, spawn)).code).toBe(0);
    expect(held).toBe(true);
    expect(existsSync(lockDir(s))).toBe(false);
  });

  test('outside the sandbox, no lock is taken', async () => {
    const s = await scaffoldRun({ runOver: { environment: { kind: 'staged', agentVersion: 4, testSession: true, logEnvironment: 'production' } } });
    await wjPlan(s.runDir, 'tool-tests.json', plan([T('tt-a')]));
    let held = null;
    const spawn = fakeSpawn(() => {
      held = existsSync(lockDir(s));
      return { code: 0, stdout: okOut };
    });
    expect((await go(s, spawn)).code).toBe(0);
    expect(held).toBe(false);
  });

  test('a busy sandbox spawns nothing, writes no result, and leaves the test to do', async () => {
    const s = await scaffoldRun({});
    await wjPlan(s.runDir, 'tool-tests.json', plan([T('tt-a'), T('tt-b')]));
    await mkdir(lockDir(s), { recursive: true });
    await writeFile(join(lockDir(s), 'owner.json'), JSON.stringify({ player: 'p', at: new Date().toISOString() }));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: okOut }));
    const { code, t } = await go(s, spawn, { sleep: async () => {} });
    expect(code).toBe(0);
    expect(spawn.calls).toHaveLength(0);
    expect(t.json()).toMatchObject({ done: 0, remaining: 2, sandboxBusy: true });
    expect(existsSync(join(s.runDir, 'mechanics', 'tool-tests', 'tt-a.json'))).toBe(false);
  });

  test('late in the budget a sandbox test is not started: no spawn, no result, the test stays to do', async () => {
    const s = await scaffoldRun({});
    await wjPlan(s.runDir, 'tool-tests.json', plan([T('tt-a')]));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: okOut }));
    const t = mkio({ cwd: s.projectDir });
    // a 20 s budget is below the 30 s minimum: the lock is free, but the test must not start
    expect(await cliToolTest(['--run-dir', s.runDir, '--all', '--max-seconds', '20'], t.io, { spawn })).toBe(0);
    expect(t.json()).toMatchObject({ done: 0, remaining: 1, sandboxBusy: true });
    // with the lock held, the wait is capped by the budget: it gives up at once instead of waiting 40 s
    await mkdir(lockDir(s), { recursive: true });
    await writeFile(join(lockDir(s), 'owner.json'), JSON.stringify({ at: new Date().toISOString() }));
    let slept = 0;
    const t2 = mkio({ cwd: s.projectDir });
    expect(await cliToolTest(['--run-dir', s.runDir, '--all', '--max-seconds', '20'], t2.io, { spawn, sleep: async () => { slept++; } })).toBe(0);
    expect(slept).toBe(0);
    expect(spawn.calls).toHaveLength(0);
    expect(existsSync(join(s.runDir, 'mechanics', 'tool-tests', 'tt-a.json'))).toBe(false);
  });

  test('a real-looking email in a test input is refused before any spawn (exit 3)', async () => {
    const s = await scaffoldRun({});
    await wjPlan(s.runDir, 'tool-tests.json', plan([T('tt-a', { input: { email: ['jane', 'realcorp.io'].join('@') } })]));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: okOut }));
    const { code, t } = await go(s, spawn);
    expect(code).toBe(3);
    expect(t.json()).toMatchObject({ ok: false, code: 'REAL_EMAIL' });
    expect(spawn.calls).toHaveLength(0);
  });

  test('a tool with a side effect (or an unknown one) gets a manual ledger row; a side-effect-free tool does not', async () => {
    const s = await scaffoldRun({});
    await wjPlan(s.runDir, 'tool-tests.json', plan([T('tt-a'), T('tt-b', { tool: 'cancel_order' }), T('tt-c', { tool: 'not_in_model' })]));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: okOut }));
    expect((await go(s, spawn)).code).toBe(0);
    const rows = await readJsonl(join(s.runDir, 'ledger.jsonl'));
    expect(rows.map((r) => r.detail.split(' ').slice(0, 3).join(' '))).toEqual(['tool test tt-b', 'tool test tt-c']);
    expect(rows[0]).toMatchObject({ source: 'tool-call', cleanup: 'manual', expected: true });
    expect(rows[0].detail).toMatch(/side effect: likely/);
    expect(rows[1].detail).toMatch(/side effect: unknown/);
  });

  test('plan files edited after the plan gate are refused (exit 3); a plan stamp with no hash too', async () => {
    const s = await scaffoldRun({});
    await wjPlan(s.runDir, 'tool-tests.json', plan([T('tt-a')]));
    await wj(join(s.runDir, 'plan', 'tool-tests.json'), plan([T('tt-a', { input: { id: 2 } })]));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: okOut }));
    const { code, t } = await go(s, spawn);
    expect(code).toBe(3);
    expect(t.json()).toMatchObject({ code: 'PLAN_CHANGED' });
    const s2 = await scaffoldRun({ stateOver: { gates: { ...stateJson().gates, plan: { at: 'x', summary: 's' } } } });
    const state = await readJson(join(s2.runDir, 'state.json'));
    delete state.gates.plan.planHash;
    await wj(join(s2.runDir, 'state.json'), state);
    const r2 = await go(s2, spawn);
    expect(r2.code).toBe(3);
    expect(r2.t.json()).toMatchObject({ code: 'PLAN_UNSEALED' });
    expect(spawn.calls).toHaveLength(0);
  });
});

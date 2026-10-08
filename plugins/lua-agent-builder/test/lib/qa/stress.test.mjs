import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliStress, percentile, runBurst, summarise } from '../../../lib/qa/stress.mjs';
import { readJson, readJsonl } from '../../../lib/qa/io.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { fakeSpawn, mkio, scaffoldRun, stateJson, wj, consentStamp, wjPlan } from './fixtures/runtime-helpers.mjs';

const resp = (body, status = 200) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) });
const plan = (over = {}) => ({
  schema: 'lua-qa/stress-plan@1', mode: 'concurrent', threads: 4, turnsPerThread: 2, concurrency: 2, messages: ['hello there', 'order status please'],
  burst: null, maxWallSeconds: 100, targets: { p90Ms: 15000, p99Ms: 30000, errorRate: 0.01 }, ...over,
});
const stagedEnv = { kind: 'staged', agentVersion: 4, testSession: true, logEnvironment: 'production' };

describe('percentile / summarise', () => {
  const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  test('nearest rank on known vectors', () => {
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 90)).toBe(90);
    expect(percentile(v, 99)).toBe(100);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile(v, 1)).toBe(10);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBe(0);
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect([percentile(twenty, 50), percentile(twenty, 90), percentile(twenty, 99)]).toEqual([10, 18, 20]);
  });
  test('summary uses ok samples for latency and checks the targets', () => {
    const samples = v.map((ms, i) => ({ ms, ok: i !== 9, ttfbMs: i < 3 ? ms / 2 : null }));
    const r = summarise(samples, { p90Ms: 85, p99Ms: 100, errorRate: 0.2 });
    expect(r).toMatchObject({ requests: 10, ok: 9, errors: 1, errorRate: 0.1, latencyMs: { p50: 50, p90: 90, p99: 90, max: 90, min: 10 } });
    expect(r.ttfbMs).toEqual({ p50: 10, p90: 15, p99: 15 });
    expect(r.targetsMet).toEqual({ p90Ms: false, p99Ms: true, errorRate: true });
    expect(r.status).toBe('fail');
    expect(summarise(samples, { p90Ms: 100, p99Ms: 100, errorRate: 0.5 }).status).toBe('pass');
  });
  test('all failures fall back to all samples; no samples is a fail; missing targets are met', () => {
    expect(summarise([{ ms: 5, ok: false }, { ms: 9, ok: false }], {}).latencyMs.max).toBe(9);
    expect(summarise([], {}).status).toBe('fail');
    expect(summarise([{ ms: 1, ok: true }]).status).toBe('pass');
    expect(summarise([{ ms: 1, ok: true }]).ttfbMs).toBeNull();
  });
});

describe('cliStress: concurrent on a staged test session', () => {
  function stagedFetch(log, { failEvery = 0 } = {}) {
    let n = 0;
    return async (url, init) => {
      log.push(`${init.method} ${new URL(url).pathname.split('/').slice(-1)[0]}`);
      if (url.endsWith('/sessions')) return resp({ data: { id: 'sess_s' } });
      if (url.endsWith('/chat')) {
        n++;
        if (failEvery && n % failEvery === 0) return resp({ message: 'busy' }, 500);
        return resp({ data: { text: 'ok' } });
      }
      return resp({ success: true });
    };
  }
  const D = (fetch, extra = {}) => ({ resolveBearer: async () => 't', fetch, randomBytes: (n) => Buffer.alloc(n, 0x11), ...extra });
  async function setup(p = plan(), runOver = { environment: stagedEnv }) {
    const s = await scaffoldRun({ runOver });
    await wjPlan(s.runDir, 'stress.json', p);
    return s;
  }

  test('runs every thread x turn with a pool, writes samples and a valid result, closes the session', async () => {
    const s = await setup();
    const log = [];
    const t = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir], t.io, D(stagedFetch(log)))).toBe(0);
    expect(t.json()).toMatchObject({ ok: true, mode: 'concurrent', complete: true, status: 'pass', requests: 8, errors: 0, resumeFrom: null });
    const samples = await readJsonl(join(s.runDir, 'mechanics', 'stress', 'samples.jsonl'));
    expect(samples).toHaveLength(8);
    expect(samples[0]).toMatchObject({ exitCode: 0, ok: true, batchHandled: false });
    const result = await readJson(join(s.runDir, 'mechanics', 'stress', 'stress.json'));
    expect(validate('stress-result', result)).toEqual({ ok: true });
    expect(log.filter((l) => l === 'POST sessions')).toHaveLength(1);
    expect(log.filter((l) => l === 'POST close')).toHaveLength(1);
    const threads = await readJson(join(s.runDir, 'mechanics', 'stress', 'threads.json'));
    expect(threads.threads).toHaveLength(4);
    expect(threads.threads[0]).toMatch(/^qa-9f3c-stress-t0-111111$/);
    expect(threads.sessionId).toBeNull();
    const ledger = await readJsonl(join(s.runDir, 'ledger.jsonl'));
    expect(ledger[0]).toMatchObject({ source: 'stress', cleanup: 'auto' });
  });

  test('errors count against the targets; the status becomes fail with exit 1', async () => {
    const s = await setup();
    const t = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir], t.io, D(stagedFetch([], { failEvery: 2 })))).toBe(1);
    expect(t.json()).toMatchObject({ ok: false, status: 'fail', errors: 4 });
    expect(t.json().targetsMet.errorRate).toBe(false);
  });

  test('a cut run is partial with resumeFrom, and --resume finishes it without repeating samples', async () => {
    const s = await setup(plan({ threads: 3, turnsPerThread: 2, concurrency: 1, maxWallSeconds: 50 }));
    let clock = 0;
    const slow = (fetch) => async (...a) => { clock += 20_000; return fetch(...a); };
    const log = [];
    const d1 = D(slow(stagedFetch(log)), { now: () => new Date(clock) });
    const t = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir], t.io, d1)).toBe(0);
    const first = t.json();
    expect(first).toMatchObject({ complete: false, status: 'partial' });
    expect(first.resumeFrom).toEqual(expect.objectContaining({ thread: expect.any(Number), turn: expect.any(Number) }));
    const done1 = (await readJsonl(join(s.runDir, 'mechanics', 'stress', 'samples.jsonl'))).length;
    expect(done1).toBeGreaterThan(0);
    expect(done1).toBeLessThan(6);
    const t0 = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir], t0.io, d1)).toBe(2);
    clock = 0;
    const t2 = mkio({ cwd: s.projectDir });
    await cliStress(['--run-dir', s.runDir, '--resume'], t2.io, D(stagedFetch(log), { now: () => new Date(0) }));
    expect(t2.json()).toMatchObject({ complete: true, requests: 6 });
    const all = await readJsonl(join(s.runDir, 'mechanics', 'stress', 'samples.jsonl'));
    expect(new Set(all.map((x) => `${x.thread}:${x.turn}`)).size).toBe(6);
    expect(log.filter((l) => l === 'POST sessions')).toHaveLength(1);
  });

  test('concurrent stress is refused in the sandbox (exit 3)', async () => {
    const s = await setup(plan(), {});
    const t = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir], t.io, D(stagedFetch([])))).toBe(3);
    expect(t.json().code).toBe('STRESS_SANDBOX');
  });

  test('real-looking contact data in the messages is refused', async () => {
    const s = await setup(plan({ messages: ['mail me at dana@gmail.com'] }));
    const t = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir], t.io, D(stagedFetch([])))).toBe(3);
    expect(t.json().code).toBe('REAL_EMAIL');
    const s2 = await setup(plan({ messages: ['see https://evil.test'] }));
    const t2 = mkio({ cwd: s2.projectDir });
    expect(await cliStress(['--run-dir', s2.runDir], t2.io, D(stagedFetch([])))).toBe(3);
    expect(t2.json().code).toBe('REAL_URL');
  });

  test('gates and plan errors', async () => {
    const s = await setup();
    await wj(join(s.runDir, 'state.json'), stateJson({ gates: { ...stateJson().gates, plan: null } }));
    expect(await cliStress(['--run-dir', s.runDir], mkio().io, D(stagedFetch([])))).toBe(3);
    const s2 = await scaffoldRun({ runOver: { environment: stagedEnv } });
    expect(await cliStress(['--run-dir', s2.runDir], mkio().io, D(stagedFetch([])))).toBe(2);
    await wjPlan(s2.runDir, 'stress.json', { schema: 'lua-qa/stress-plan@1' });
    expect(await cliStress(['--run-dir', s2.runDir], mkio().io, D(stagedFetch([])))).toBe(2);
  });

  test('a thrown request is recorded as an error sample, not a crash', async () => {
    const s = await setup(plan({ threads: 1, turnsPerThread: 1 }));
    const t = mkio({ cwd: s.projectDir });
    const fetch = async (url) => { if (url.endsWith('/sessions')) return resp({ data: { id: 'sess_s' } }); throw new Error('socket'); };
    expect(await cliStress(['--run-dir', s.runDir], t.io, D(fetch))).toBe(1);
    const samples = await readJsonl(join(s.runDir, 'mechanics', 'stress', 'samples.jsonl'));
    expect(samples[0]).toMatchObject({ ok: false, exitCode: null });
  });
});

describe('cliStress: production and staged without a session use lua chat; consent is required', () => {
  const consent = consentStamp('abcdefabcdef');
  const prodState = { gates: { ...stateJson().gates, environment: { at: 'x', summary: 's', productionConsent: consent } } };
  test('production: needs the token, sends -e production chats on qa- stress threads', async () => {
    const s = await scaffoldRun({ runOver: { environment: { kind: 'production', agentVersion: null, testSession: null, logEnvironment: 'production' } }, stateOver: prodState });
    await wjPlan(s.runDir, 'stress.json', plan({ threads: 2, turnsPerThread: 1 }));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: 'Batch handled: x' }));
    const deps = { spawn, randomBytes: (n) => Buffer.alloc(n, 0x22) };
    expect(await cliStress(['--run-dir', s.runDir], mkio({ cwd: s.projectDir }).io, deps)).toBe(3);
    const t = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir, '--production-consent', 'abcdefabcdef'], t.io, deps)).toBe(0);
    expect(spawn.calls).toHaveLength(2);
    expect(spawn.calls[0].argv.slice(0, 4)).toEqual(['chat', '--ci', '-e', 'production']);
    expect(spawn.calls[0].argv[7]).toMatch(/^qa-/);
    const samples = await readJsonl(join(s.runDir, 'mechanics', 'stress', 'samples.jsonl'));
    expect(samples.every((x) => x.batchHandled)).toBe(true);
  });
  test('staged with testSession false uses --agent-version chats', async () => {
    const s = await scaffoldRun({ runOver: { environment: { kind: 'staged', agentVersion: 4, testSession: false, logEnvironment: 'production' } }, stateOver: prodState });
    await wjPlan(s.runDir, 'stress.json', plan({ threads: 1, turnsPerThread: 1 }));
    const spawn = fakeSpawn(() => ({ code: 1 }));
    const t = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir, '--production-consent', 'abcdefabcdef'], t.io, { spawn })).toBe(1);
    expect(spawn.calls[0].argv.slice(0, 4)).toEqual(['chat', '--ci', '--agent-version', '4']);
  });
});

describe('cliStress: burst', () => {
  test('a staged run refuses burst (exit 3) instead of hitting the sandbox', async () => {
    const s = await scaffoldRun({ runOver: { environment: stagedEnv } });
    await wjPlan(s.runDir, 'stress.json', plan({ mode: 'burst', burst: { size: 2, delayMs: 10 } }));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: '' }));
    const t = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir], t.io, { spawn })).toBe(3);
    expect(t.json().code).toBe('STRESS_BURST_ENV');
    expect(spawn.calls).toHaveLength(0);
  });
  test('runBurst refuses a target it has no path for', async () => {
    await expect(runBurst(plan({ mode: 'burst' }), { env: { kind: 'staged' }, run: {}, thread: 't' })).rejects.toMatchObject({ code: 'STRESS_BURST_ENV', exitCode: 3 });
  });
  const burstOut = ['Sending msg 1: "a"', 'Sending msg 2: "b"', 'Sending msg 3: "c"', 'Sending msg 4: "d"', '[msg 1] Responded: hi', '[msg 2] Batch handled: x', '[msg 3] Batched/absorbed: y', '[msg 4] Batched/absorbed: z'].join('\n');
  test('one lua chat -b call in the sandbox, counted and written', async () => {
    const s = await scaffoldRun({});
    await wjPlan(s.runDir, 'stress.json', plan({ mode: 'burst', burst: { size: 4, delayMs: 100 } }));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: burstOut }));
    const t = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir], t.io, { spawn, randomBytes: (n) => Buffer.alloc(n, 0x33) })).toBe(0);
    const out = t.json();
    expect(out).toMatchObject({ ok: true, mode: 'burst', burst: { sent: 4, replies: 1, batchHandled: 1, batchAborted: 2 } });
    expect(spawn.calls[0].argv.slice(0, 5)).toEqual(['chat', '--ci', '-e', 'sandbox', '-b']);
    expect(spawn.calls[0].argv).toEqual(expect.arrayContaining(['-d', '100']));
    expect(spawn.calls[0].argv.at(-1)).toMatch(/^qa-9f3c-stress-b-333333$/);
    expect(spawn.calls[0].opts.env.LUA_API_KEY).toBeUndefined();
    const result = await readJson(join(s.runDir, 'mechanics', 'stress', 'stress.json'));
    expect(validate('stress-result', result)).toEqual({ ok: true });
  });
  test('a per-message error printed on stderr makes the burst fail even with exit 0', async () => {
    const s = await scaffoldRun({});
    await wjPlan(s.runDir, 'stress.json', plan({ mode: 'burst', burst: { size: 2, delayMs: 10 } }));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: 'Sending msg 1: "a"\n[msg 1] Responded: hi', stderr: '\u274C [msg 2] Error: socket hang up\n' }));
    const t = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir], t.io, { spawn })).toBe(1);
    expect(t.json().status).toBe('fail');
  });
  test('a failing burst is a fail; sandbox lock contention surfaces as exit 5', async () => {
    const s = await scaffoldRun({});
    await wjPlan(s.runDir, 'stress.json', plan({ mode: 'burst', burst: { size: 2, delayMs: 10 } }));
    const t = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir], t.io, { spawn: fakeSpawn(() => ({ code: 3, stdout: '[msg 1] Error: x' })) })).toBe(1);
    const s2 = await scaffoldRun({});
    await wjPlan(s2.runDir, 'stress.json', plan({ mode: 'burst', burst: { size: 2, delayMs: 10 } }));
    const lock = join(s2.projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock');
    await mkdir(lock, { recursive: true });
    const now = new Date('2026-10-07T14:00:00Z');
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ at: now.toISOString() }), 'utf8');
    const t2 = mkio({ cwd: s2.projectDir });
    expect(await cliStress(['--run-dir', s2.runDir], t2.io, { spawn: fakeSpawn(() => ({ code: 0 })), now: () => now, sleep: async () => {} })).toBe(5);
    expect(t2.json().code).toBe('SANDBOX_BUSY');
  });
  test('burst in production skips the lock', async () => {
    const consent = consentStamp('abcdefabcdef');
    const s = await scaffoldRun({
      runOver: { environment: { kind: 'production', agentVersion: null, testSession: null, logEnvironment: 'production' } },
      stateOver: { gates: { ...stateJson().gates, environment: { at: 'x', summary: 's', productionConsent: consent } } },
    });
    await wjPlan(s.runDir, 'stress.json', plan({ mode: 'burst', burst: null }));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: burstOut }));
    const t = mkio({ cwd: s.projectDir });
    // burst:null is a plan error
    expect(await cliStress(['--run-dir', s.runDir, '--production-consent', 'abcdefabcdef'], t.io, { spawn })).toBe(2);
    await wjPlan(s.runDir, 'stress.json', plan({ mode: 'burst', burst: { size: 3, delayMs: 50 } }));
    const t2 = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir, '--production-consent', 'abcdefabcdef'], t2.io, { spawn })).toBe(0);
    expect(spawn.calls[0].argv.slice(0, 4)).toEqual(['chat', '--ci', '-e', 'production']);
  });
});

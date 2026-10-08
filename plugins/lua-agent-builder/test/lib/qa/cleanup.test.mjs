import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyCleanup, cliCleanup, planCleanup } from '../../../lib/qa/cleanup.mjs';
import { addLedger } from '../../../lib/qa/ledger.mjs';
import { readJson } from '../../../lib/qa/io.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { fakeSpawn, mkio, stateJson, wj, consentStamp } from './fixtures/runtime-helpers.mjs';
import { TH, seeded, turnRow } from './fixtures/runtime-seed.mjs';

const resp = (body, status = 200) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) });

async function withStress(s) {
  await wj(join(s.runDir, 'mechanics', 'stress', 'threads.json'), { threads: ['qa-9f3c-stress-t0-aaaaaa', 'not-a-qa-thread'], sessionId: 'sess_stress' });
}

describe('planCleanup', () => {
  test('QA threads from records, turns and stress; open sessions; our lock; manual ledger rows', async () => {
    const s = await seeded({ rows: [turnRow(1), turnRow(2, { thread: 'qa-9f3c-icp-01-r1-other1' })], rec: { testSessionId: 'sess_run' } });
    await withStress(s);
    await addLedger(s.runDir, { source: 'player-report', kind: 'email-claimed', detail: 'said it emailed', cleanup: 'manual', cleanupHint: 'check the outbox' });
    await addLedger(s.runDir, { source: 'stress', kind: 'burst', detail: 'x', cleanup: 'auto' });
    const lock = join(s.projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ runId: '20261007-141502-9f3c' }), 'utf8');
    const plan = await planCleanup(s.runDir);
    const key = (a) => `${a.kind}:${a.target}:${a.status}`;
    expect(plan.actions.map(key)).toEqual([
      'clear-thread:not-a-qa-thread:skipped',
      `clear-thread:${TH}:planned`,
      'clear-thread:qa-9f3c-icp-01-r1-other1:planned',
      'clear-thread:qa-9f3c-stress-t0-aaaaaa:planned',
      'close-test-session:sess_run:planned',
      'close-test-session:sess_stress:planned',
      `remove-lock:${lock}:planned`,
      'manual:L-0001:planned',
    ]);
    expect(plan.actions.filter((a) => a.kind === 'manual')[0].note).toBe('check the outbox');
    expect(plan.actions.some((a) => a.kind === 'clear-thread' && a.target === 'not-a-qa-thread' && a.status === 'skipped')).toBe(true);
    expect(plan.actions.filter((a) => a.kind === 'clear-thread' && a.status === 'planned')).toHaveLength(3);
    expect(validate('cleanup', plan)).toEqual({ ok: true });
  });
  test('a lock owned by another run is left alone; finished sessions are not closed again', async () => {
    const s = await seeded({ rec: { testSessionId: 'sess_done', status: 'done' } });
    const lock = join(s.projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ runId: 'another' }), 'utf8');
    const plan = await planCleanup(s.runDir);
    expect(plan.actions.map((a) => a.kind)).toEqual(['clear-thread']);
  });
  test('an empty run has an empty plan', async () => {
    const s = await seeded({ rows: [] });
    expect((await planCleanup(join(s.runDir))).actions.map((a) => a.kind)).toEqual(['clear-thread']);
  });
  test('earlier done actions are carried over', async () => {
    const s = await seeded({});
    await wj(join(s.runDir, 'cleanup.json'), { schema: 'lua-qa/cleanup@1', applied: true, actions: [{ kind: 'clear-thread', target: TH, status: 'done', note: '' }] });
    expect((await planCleanup(s.runDir)).actions[0].status).toBe('done');
  });
});

describe('cliCleanup', () => {
  test('without --apply it only writes the plan', async () => {
    const s = await seeded({});
    const spawn = fakeSpawn(() => ({ code: 0 }));
    const t = mkio({ cwd: s.projectDir });
    expect(await cliCleanup(['--run-dir', s.runDir], t.io, { spawn })).toBe(0);
    expect(t.json()).toMatchObject({ ok: true, applied: false, planned: 1, hint: expect.stringMatching(/Plan only/) });
    expect(spawn.calls).toHaveLength(0);
    expect((await readJson(join(s.runDir, 'cleanup.json'))).applied).toBe(false);
  });
  test('--apply clears only qa- threads, closes sessions, removes our lock, skips manual items', async () => {
    const s = await seeded({ rec: { testSessionId: 'sess_run' }, rows: [turnRow(1)] });
    await withStress(s);
    await addLedger(s.runDir, { source: 'player-report', kind: 'k', detail: 'd', cleanup: 'manual' });
    const lock = join(s.projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ runId: '20261007-141502-9f3c' }), 'utf8');
    const spawn = fakeSpawn((argv) => ({ code: argv[3] === 'qa-9f3c-stress-t0-aaaaaa' ? 1 : 0 }));
    const closed = [];
    const fetch = async (url) => { closed.push(url); return resp({ success: true }); };
    const t = mkio({ cwd: s.projectDir });
    expect(await cliCleanup(['--run-dir', s.runDir, '--apply'], t.io, { spawn, fetch, resolveBearer: async () => 't' })).toBe(0);
    const out = t.json();
    expect(out).toMatchObject({ applied: true, done: 4, failed: 1, skipped: 2, manual: 1 });
    expect(spawn.calls.map((c) => c.argv)).toEqual([
      ['chat', 'clear', '-t', TH, '--force'],
      ['chat', 'clear', '-t', 'qa-9f3c-stress-t0-aaaaaa', '--force'],
    ]);
    expect(closed).toHaveLength(2);
    expect(existsSync(lock)).toBe(false);
    const saved = await readJson(join(s.runDir, 'cleanup.json'));
    expect(saved.applied).toBe(true);
    expect(saved.actions.find((a) => a.kind === 'manual').note).toMatch(/manual: do this by hand/);
    expect(saved.actions.find((a) => a.target === 'qa-9f3c-stress-t0-aaaaaa').note).toMatch(/exited with code 1/);
  });
  test('--apply needs the environment gate and, in production, the token', async () => {
    const consent = consentStamp('abcdefabcdef');
    const s = await seeded({
      scaffold: {
        runOver: { environment: { kind: 'production', agentVersion: null, testSession: null, logEnvironment: 'production' } },
        stateOver: { gates: { ...stateJson().gates, environment: { at: 'x', summary: 's', productionConsent: consent } } },
      },
    });
    const spawn = fakeSpawn(() => ({ code: 0 }));
    expect(await cliCleanup(['--run-dir', s.runDir, '--apply'], mkio().io, { spawn })).toBe(3);
    expect(spawn.calls).toHaveLength(0);
    expect(await cliCleanup(['--run-dir', s.runDir, '--apply', '--production-consent', 'abcdefabcdef'], mkio().io, { spawn })).toBe(0);
    expect(spawn.calls).toHaveLength(1);
    const s2 = await seeded({ scaffold: { stateOver: { gates: { discovery: null, questions: null, environment: null, plan: null } } } });
    expect(await cliCleanup(['--run-dir', s2.runDir, '--apply'], mkio().io, { spawn })).toBe(3);
  });
  test('the deadline stops the apply and says how to continue', async () => {
    const s = await seeded({ rows: [turnRow(1)] });
    await withStress(s);
    let calls = 0;
    const spawn = fakeSpawn(() => ({ code: 0 }));
    const now = () => new Date(1_000_000 + (calls++ > 4 ? 200_000 : 0));
    const t = mkio({ cwd: s.projectDir });
    await cliCleanup(['--run-dir', s.runDir, '--apply'], t.io, { spawn, now });
    expect(t.json().planned).toBeGreaterThan(0);
    expect(t.json().hint).toMatch(/again/);
  });
  test('usage', async () => {
    expect(await cliCleanup([], mkio().io)).toBe(2);
    expect(await cliCleanup(['--run-dir', '/no/run'], mkio().io)).toBe(2);
  });
});

describe('applyCleanup', () => {
  test('a non-qa thread that slipped into a plan is never cleared; thrown errors become failed actions', async () => {
    const s = await seeded({});
    const spawn = fakeSpawn(() => ({ code: 0 }));
    const plan = { applied: false, actions: [
      { kind: 'clear-thread', target: 'production-user-thread', status: 'planned', note: '' },
      { kind: 'close-test-session', target: 'sess_1', status: 'planned', note: '' },
    ] };
    await applyCleanup(s.runDir, plan, { spawn, fetch: async () => { throw new Error('network down'); }, resolveBearer: async () => 't' }, { env: {} });
    expect(spawn.calls).toHaveLength(0);
    expect(plan.actions[0]).toMatchObject({ status: 'skipped' });
    expect(plan.actions[1]).toMatchObject({ status: 'failed' });
    expect(plan.applied).toBe(true);
  });
});

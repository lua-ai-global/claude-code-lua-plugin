import { join } from 'node:path';
import { readJson } from '../../../lib/qa/io.mjs';
import { cliPrechecks, runPrechecks } from '../../../lib/qa/prechecks.mjs';
import { fakeSpawn, mkio } from './fixtures/runtime-helpers.mjs';
import { execution, logsStdout } from './fixtures/skill-logs.mjs';
import { readJsonl } from '../../../lib/qa/io.mjs';
import { seeded, turnRow } from './fixtures/runtime-seed.mjs';

const resp = (body, status = 200) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) });
const U = (text) => ({ role: 'user', threadId: 'qa-9f3c-icp-01-r1-cdcdcd', content: [{ type: 'text', text }] });
const D = (msgs) => ({ resolveBearer: async () => 't', fetch: async () => resp({ data: msgs }) });
const SEL = (s) => ['--run-dir', s.runDir, '--card', 'icp-01', '--run', '1'];

describe('prechecks', () => {
  test('clean run: exit 0, all three check files, run-record updated', async () => {
    const s = await seeded({ rows: [turnRow(1, { user: 'Hello', reply: 'Hi there, how can I help?' })] });
    const t = mkio();
    expect(await cliPrechecks(SEL(s), t.io, D([U('Hello')]))).toBe(0);
    expect(t.json()).toMatchObject({ ok: true, contamination: 'CLEAN', readabilityFails: 0, claimsUnbacked: 0, claimsStatus: 'ok' });
    for (const f of ['contamination', 'readability', 'claims']) expect((await readJson(join(s.dir, 'checks', `${f}.json`))).schema).toBe(`lua-qa/${f}@1`);
    expect((await readJson(join(s.dir, 'run-record.json'))).checks).toEqual({ contamination: 'CLEAN', readabilityFails: 0, claimsUnbacked: 0, claimsStatus: 'ok' });
  });
  test('readability or claims candidates: exit 1', async () => {
    const s = await seeded({ rows: [turnRow(1, { user: 'Hello', reply: 'The payload says 9 open tickets.' })] });
    const t = mkio();
    expect(await cliPrechecks(SEL(s), t.io, D([U('Hello')]))).toBe(1);
    const out = t.json();
    expect(out.ok).toBe(false);
    expect(out.readabilityFails).toBe(1);
    expect(out.claimsUnbacked).toBe(1);
    expect(out.candidates).toMatch(/candidates/);
  });
  test('CONTAMINATED: exit 3 with the VOID message', async () => {
    const s = await seeded({ rows: [turnRow(1, { user: 'Hello' })] });
    const t = mkio();
    expect(await cliPrechecks(SEL(s), t.io, D([U('Hello'), U('intruder')]))).toBe(3);
    expect(t.json()).toMatchObject({ ok: false, code: 'CONTAMINATED', contamination: 'CONTAMINATED' });
    expect(t.json().contaminationReasons.length).toBeGreaterThan(0);
  });
  test('UNVERIFIED does not void the run', async () => {
    const s = await seeded({ rows: [turnRow(1, { user: 'Hello', reply: 'Hi there.' })] });
    const t = mkio();
    expect(await cliPrechecks(SEL(s), t.io, { resolveBearer: async () => 't', fetch: async () => resp({}, 404) })).toBe(0);
    expect(t.json().contamination).toBe('UNVERIFIED');
  });
  test('--technical is honoured; runPrechecks returns the parts', async () => {
    const s = await seeded({ rows: [turnRow(1, { user: 'Hello', reply: 'The payload is fine.' })] });
    const out = await runPrechecks({ runDir: s.runDir, cardId: 'icp-01', k: 1, technical: true, deps: D([U('Hello')]) });
    expect(out.readability.technical).toBe(true);
    expect(out.exitCode).toBe(0);
    const t = mkio();
    expect(await cliPrechecks([...SEL(s), '--technical'], t.io, D([U('Hello')]))).toBe(0);
  });
  test('unknown run -> exit 2', async () => {
    const s = await seeded({});
    expect(await cliPrechecks(['--run-dir', s.runDir, '--card', 'icp-05', '--run', '1'], mkio().io, D([]))).toBe(2);
  });
});

describe('prechecks fill tool calls from the skill logs', () => {
  const later = { now: () => new Date('2026-10-07T15:00:00Z'), sleep: async () => {} };
  const row = turnRow(1, { user: 'Hello', reply: "I've raised ticket ITD-1042.", toolCalls: null, toolCallSource: 'unavailable' });
  test('an unavailable turn is filled first, so claims are verified (zero calls -> confirmed)', async () => {
    const s = await seeded({ rows: [row] });
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsStdout([]) }));
    const t = mkio();
    expect(await cliPrechecks(SEL(s), t.io, { ...D([U('Hello')]), ...later, spawn })).toBe(1);
    expect(t.json()).toMatchObject({ claimsStatus: 'ok', claimsConfirmed: 2, toolLogs: { status: 'filled', filled: 1 } });
    expect((await readJsonl(join(s.dir, 'turns.jsonl')))[0]).toMatchObject({ toolCallSource: 'logs-window', toolCalls: [] });
  });
  test('a logged call backs the claim', async () => {
    const s = await seeded({ rows: [row] });
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsStdout(execution('2026-10-07T14:20:02.000Z', { exec: 'e1', tool: 'cancel_order', result: { ticketId: 'ITD-1042' } })) }));
    const out = await runPrechecks({ runDir: s.runDir, cardId: 'icp-01', k: 1, deps: { ...D([U('Hello')]), ...later, spawn } });
    expect(out.claims).toMatchObject({ status: 'ok', total: 0 });
    expect(out.toolLogs.filled).toBe(1);
  });
  test('a logs failure leaves the turn unverifiable and is reported, not thrown', async () => {
    const s = await seeded({ rows: [row] });
    const t = mkio();
    expect(await cliPrechecks(SEL(s), t.io, { ...D([U('Hello')]), ...later, spawn: fakeSpawn(() => ({ code: 1 })) })).toBe(1);
    expect(t.json()).toMatchObject({ claimsStatus: 'unverifiable', toolLogs: { status: 'unavailable', filled: 0, notes: [expect.stringMatching(/LUA_LOGS_FAILED/)] } });
    const broken = await seeded({ rows: [row] });
    const clockFails = () => { throw Object.assign(new Error('clock exploded'), { code: 'EBOOM' }); };
    const out = await runPrechecks({ runDir: broken.runDir, cardId: 'icp-01', k: 1, deps: { ...D([U('Hello')]), now: clockFails } });
    expect(out.toolLogs).toEqual({ status: 'error', filled: 0, notes: ['EBOOM: clock exploded'] });
    const plain = await runPrechecks({ runDir: broken.runDir, cardId: 'icp-01', k: 1, deps: { ...D([U('Hello')]), now: () => { throw new Error('x'); } } });
    expect(plain.toolLogs.notes).toEqual(['ERROR: x']);
  });
});

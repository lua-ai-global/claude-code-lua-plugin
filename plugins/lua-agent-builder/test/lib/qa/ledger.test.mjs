import { join } from 'node:path';
import { addLedger, cliLedger, ledgerToolCalls, listLedger, sideEffectTools } from '../../../lib/qa/ledger.mjs';
import { flowModel, mkio, scaffoldRun } from './fixtures/runtime-helpers.mjs';

const deps = { now: () => new Date('2026-10-07T14:20:00Z') };

describe('ledger', () => {
  test('assigns sequential ids, redacts and truncates detail, defaults fields', async () => {
    const { runDir } = await scaffoldRun({});
    const a = await addLedger(runDir, { source: 'tool-call', kind: 'cancel_order', detail: `password: hunter2 ${'x'.repeat(400)}` }, deps);
    const b = await addLedger(runDir, { source: 'stress', kind: 'burst', detail: 'ok', runRef: 'runs/icp-01/r1', turn: 2, expected: true, reversible: false, cleanup: 'manual', cleanupHint: 'undo' }, deps);
    expect([a.id, b.id]).toEqual(['L-0001', 'L-0002']);
    expect(a.detail.startsWith('[REDACTED:password-assign]')).toBe(true);
    expect(a.detail.length).toBeLessThanOrEqual(300);
    expect(a).toMatchObject({ at: '2026-10-07T14:20:00.000Z', runRef: null, turn: null, expected: null, cleanup: 'none' });
    expect(await listLedger(runDir)).toHaveLength(2);
  });
  test('uses the real clock by default and rejects an invalid source', async () => {
    const { runDir } = await scaffoldRun({});
    const row = await addLedger(runDir, { source: 'player-report', kind: 'k' });
    expect(row.at).toMatch(/^\d{4}-/);
    await expect(addLedger(runDir, { source: 'bogus', kind: 'k' })).rejects.toMatchObject({ code: 'USAGE' });
  });
  test('cli add and list', async () => {
    const { runDir } = await scaffoldRun({});
    const t = mkio();
    expect(await cliLedger(['add', '--run-dir', runDir, '--source', 'player-report', '--kind', 'email-claimed', '--detail', 'player said it sent one', '--run-ref', 'runs/icp-01/r1', '--turn', '3', '--expected', 'false'], t.io, deps)).toBe(0);
    expect(t.json().row).toMatchObject({ id: 'L-0001', turn: 3, expected: false, runRef: 'runs/icp-01/r1' });
    const t2 = mkio();
    expect(await cliLedger(['add', '--run-dir', runDir, '--source', 'stress', '--kind', 'k', '--detail', 'd'], t2.io, deps)).toBe(0);
    expect(t2.json().row.expected).toBeNull();
    const t3 = mkio();
    expect(await cliLedger(['list', '--run-dir', runDir], t3.io)).toBe(0);
    expect(t3.json().count).toBe(2);
    expect(await listLedger(join(runDir, 'nowhere'))).toEqual([]);
  });
  test('cli usage errors', async () => {
    expect(await cliLedger([], mkio().io)).toBe(2);
    expect(await cliLedger(['add', '--run-dir', '/x'], mkio().io)).toBe(2);
  });
});

describe('ledgerToolCalls', () => {
  test('one row per side-effect call; logged calls are de-duplicated by their callRef', async () => {
    const { runDir } = await scaffoldRun({});
    const model = flowModel();
    const calls = [
      { name: 'get_order', status: 'ok' },
      { name: 'cancel_order', status: 'ok', executionId: 'e1' },
      { name: 'cancel_order', status: 'error' },
      { name: 'not_in_model', status: 'ok' },
      null,
    ];
    const ids = await ledgerToolCalls(runDir, { runRef: 'runs/icp-01/r1', turn: 2, calls, model }, deps);
    expect(ids).toEqual(['L-0001', 'L-0002']);
    const rows = await listLedger(runDir);
    expect(rows[0]).toMatchObject({ callRef: 'runs/icp-01/r1#2#e1', cleanup: 'manual', detail: 'tool call (from logs) (side effect: likely) status ok' });
    expect(rows[1].callRef).toBeUndefined();
    expect(await ledgerToolCalls(runDir, { runRef: 'runs/icp-01/r1', turn: 2, calls: [calls[1]], model }, deps)).toEqual([]);
    expect(await ledgerToolCalls(runDir, { runRef: 'runs/icp-01/r1', turn: 3, calls: [calls[1]], model, testSession: true }, deps)).toEqual(['L-0003']);
    expect((await listLedger(runDir))[2]).toMatchObject({ cleanup: 'none', cleanupHint: null });
    expect(await ledgerToolCalls(runDir, { runRef: 'r', turn: 1, calls: undefined, model }, deps)).toEqual([]);
    expect(sideEffectTools(null).size).toBe(0);
    expect(sideEffectTools({ skills: [{ tools: [{ name: 'x' }] }, {}] }).get('x')).toBe('unknown');
  });
});

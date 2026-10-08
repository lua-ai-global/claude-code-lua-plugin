import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  attributeCalls, callsFromLogRows, cliBackfillTools, fillToolCallsFromLogs, listRunFolders, mergeWindows, resultFailed, turnWindow,
} from '../../../lib/qa/tool-logs.mjs';
import { readJson, readJsonl } from '../../../lib/qa/io.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { fakeSpawn, mkio, wj } from './fixtures/runtime-helpers.mjs';
import { recordJson, seeded, turnRow } from './fixtures/runtime-seed.mjs';
import { AGENT, execution, logRow, logsStdout } from './fixtures/skill-logs.mjs';

const T = (s) => `2026-10-07T14:${s}Z`;
const LATER = () => new Date('2026-10-07T15:00:00Z');
const unavailable = (n, over = {}) => turnRow(n, { toolCalls: null, toolCallSource: 'unavailable', ...over });

describe('callsFromLogRows', () => {
  test('groups one execution into a call with parsed input/result, warnings and errors', () => {
    const rows = execution(T('20:02.000'), {
      exec: 'e1', tool: 'acme_open_it_ticket', input: { workEmail: 'dana@example.com', summary: 'VPN down' }, result: { ticketId: 'ITD-1042', priority: 'P1' },
      consoleLines: [['warn', 'P1 ticket raised'], ['info', 'plain console line']],
    });
    const { calls, rawRows, keptRows } = callsFromLogRows(rows, { environment: 'sandbox', agentId: AGENT });
    expect(rawRows).toBe(5);
    expect(keptRows).toBe(5);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'acme_open_it_ticket', skill: 'orders', executionId: 'e1', status: 'ok', durationMs: 0,
      input: { workEmail: 'dana@example.com', summary: 'VPN down' }, output: { ticketId: 'ITD-1042', priority: 'P1' },
      warnings: ['P1 ticket raised'], errors: [], at: '2026-10-07T14:20:02.000Z', channel: 'dev', runId: null,
    });
  });
  test('a result that reports failure, or an error line, makes the call an error; no result is unknown', () => {
    const sent = callsFromLogRows(execution(T('20:01.000'), { exec: 'a', result: { sent: false, reason: 'domain' } })).calls[0];
    expect(sent.status).toBe('error');
    const errLine = callsFromLogRows(execution(T('20:01.000'), { exec: 'b', consoleLines: [['error', 'boom']] })).calls[0];
    expect(errLine).toMatchObject({ status: 'error', errors: ['boom'] });
    const noResult = callsFromLogRows([logRow(T('20:01.000'), 'Calling tool with input {"x":1}', { exec: 'c' })]).calls[0];
    expect(noResult.status).toBe('unknown');
    const raw = callsFromLogRows([logRow(T('20:01.000'), 'Calling tool with input {not json', { exec: 'd' }), logRow(T('20:01.100'), 'Tool result plain text', { exec: 'd' })]).calls[0];
    expect(raw).toMatchObject({ input: '{not json', output: 'plain text', status: 'ok' });
  });
  test('filters other environments, other agents and rows without a tool; a row with no environment is production', () => {
    const rows = [
      ...execution(T('20:01.000'), { exec: 'keep' }),
      ...execution(T('20:02.000'), { exec: 'prod', env: 'production' }),
      ...execution(T('20:03.000'), { exec: 'other', agentId: 'agent_other' }),
      { timestamp: T('20:04.000'), subType: 'info', message: 'skill-level line', metadata: { agentId: AGENT, environment: 'sandbox' } },
      { timestamp: T('20:05.000'), subType: 'debug', message: 'Tool result {}', metadata: { toolName: 'x', executionId: 'noenv' } },
    ];
    expect(callsFromLogRows(rows, { environment: 'sandbox', agentId: AGENT }).calls.map((c) => c.executionId)).toEqual(['keep']);
    expect(callsFromLogRows(rows, { environment: 'production', agentId: AGENT }).calls.map((c) => c.executionId)).toEqual(['prod', 'noenv']);
    expect(callsFromLogRows(rows).calls).toHaveLength(4);
    expect(callsFromLogRows(undefined)).toEqual({ calls: [], rawRows: 0, keptRows: 0 });
  });
  test('rows are ordered by time then executionSeq; rows without an executionId are split at each call line', () => {
    const a = logRow(T('20:01.000'), 'Tool result {"n":2}', { exec: 'e', extra: { executionSeq: 2 } });
    const b = logRow(T('20:01.000'), 'Calling tool with input {"n":1}', { exec: 'e', extra: { executionSeq: 1 } });
    expect(callsFromLogRows([a, b]).calls[0]).toMatchObject({ input: { n: 1 }, output: { n: 2 } });
    const noExec = (t, msg) => ({ timestamp: t, subType: 'debug', message: msg, metadata: { toolName: 'get_order', environment: 'sandbox', runId: 'run_9' } });
    const calls = callsFromLogRows([
      noExec(T('20:01.000'), 'Calling tool with input {"id":1}'), noExec(T('20:01.100'), 'Tool result {"a":1}'),
      noExec(T('20:02.000'), 'Calling tool with input {"id":2}'), noExec(T('20:02.100'), 'Tool result {"a":2}'),
      { createdAt: 'not a time', message: 'Tool result {}', metadata: { toolName: 'lonely', environment: 'production' } },
    ]).calls;
    expect(calls.map((c) => [c.name, c.input?.id ?? null, c.executionId, c.runId])).toEqual([
      ['get_order', 1, null, 'run_9'], ['get_order', 2, null, 'run_9'], ['lonely', null, null, null],
    ]);
    expect(calls[2].at).toBeNull();
  });
  test('resultFailed', () => {
    expect(resultFailed({ status: 'error' })).toBe(true);
    expect(resultFailed({ error: 'x' })).toBe(true);
    expect(resultFailed({ success: false })).toBe(true);
    expect(resultFailed({ ok: true, sent: true })).toBe(false);
    expect(resultFailed([1])).toBe(false);
    expect(resultFailed('text')).toBe(false);
    expect(resultFailed(null)).toBe(false);
  });
});

describe('turnWindow / attributeCalls / mergeWindows', () => {
  test('the chat window is exact when recorded, else the whole turn', () => {
    expect(turnWindow({ at: T('20:00.000'), endedAt: T('20:30.000') })).toEqual({ start: Date.parse(T('20:00.000')), end: Date.parse(T('20:30.000')), exact: false });
    expect(turnWindow({ at: T('20:00.000'), endedAt: T('20:30.000'), chatAt: T('20:10.000'), chatEndedAt: T('20:20.000') }).exact).toBe(true);
    expect(Number.isNaN(turnWindow(undefined).start)).toBe(true);
  });
  const ms = (s) => Date.parse(T(s));
  const call = (s, extra = {}) => ({ name: 't', at: T(s), ...extra });
  test('inside one window; nested windows go to the narrowest (ambiguous); an exact window wins', () => {
    const A = { key: 'A', start: ms('20:00.000'), end: ms('20:20.000'), exact: false };
    const B = { key: 'B', start: ms('20:05.000'), end: ms('20:30.000'), exact: false };
    const out = attributeCalls([call('20:02.000'), call('20:15.000'), call('20:25.000')], [A, B]);
    expect(out.get('A').map((c) => [c.at, c.ambiguous, c.padded])).toEqual([[T('20:02.000'), false, false], [T('20:15.000'), true, false]]);
    expect(out.get('B').map((c) => c.ambiguous)).toEqual([false]);
    const X = { key: 'X', start: ms('20:10.000'), end: ms('20:28.000'), exact: true };
    expect(attributeCalls([call('20:15.000')], [A, B, X]).get('X')[0]).toMatchObject({ ambiguous: false, matchedBy: 'window' });
  });
  test('padding: nearest window, marked padded; outside every pad -> dropped; runId match wins', () => {
    const A = { key: 'A', start: ms('20:00.000'), end: ms('20:10.000'), exact: true };
    const B = { key: 'B', start: ms('20:14.000'), end: ms('20:20.000'), exact: true, platformRunId: 'run_b' };
    const out = attributeCalls([call('20:11.000'), call('20:13.000'), call('20:40.000'), call('bad'), call('20:05.000', { runId: 'run_b' })], [A, B, { key: 'Z', start: NaN, end: 1, exact: false }]);
    expect(out.get('A').map((c) => [c.at, c.padded, c.ambiguous])).toEqual([[T('20:11.000'), true, false]]);
    expect(out.get('B').map((c) => [c.at, c.matchedBy, c.padded, c.ambiguous])).toEqual([[T('20:13.000'), 'window', true, true], [T('20:05.000'), 'runId', false, false]]);
  });
  test('mergeWindows joins overlapping and close spans and drops unreadable ones', () => {
    expect(mergeWindows([{ start: 100, end: 200 }, { start: 0, end: 50 }, { start: 150, end: 400 }, { start: NaN, end: 3 }], 10)).toEqual([{ start: 0, end: 50 }, { start: 100, end: 400 }]);
    expect(mergeWindows([{ start: 0, end: 50 }, { start: 55, end: 60 }], 10)).toEqual([{ start: 0, end: 60 }]);
  });
});

describe('fillToolCallsFromLogs', () => {
  const turns = () => [
    unavailable(1, { at: T('20:00.000'), endedAt: T('20:06.000'), user: 'cancel order 1042 please' }),
    unavailable(2, { at: T('20:10.000'), endedAt: T('20:16.000'), chatAt: T('20:11.000'), chatEndedAt: T('20:16.000') }),
    turnRow(3, { at: T('20:20.000'), endedAt: T('20:26.000'), toolCalls: [{ name: 'get_order', status: 'ok' }], toolCallSource: 'history' }),
  ];
  const rows = () => [
    ...execution(T('20:02.000'), { exec: 'e1', input: { orderId: '1042', token: 'sk_live_51Hf00fakefakefake' } }),
    ...execution(T('20:12.000'), { exec: 'e2', tool: 'get_order' }),
    ...execution(T('20:22.000'), { exec: 'e3', tool: 'cancel_order' }),
  ];
  const deps = (spawn, extra = {}) => ({ spawn, now: LATER, sleep: async () => {}, ...extra });

  test('fills unavailable turns with one query, redacts, writes ledger rows once, keeps history turns', async () => {
    const s = await seeded({ rows: turns(), rec: { status: 'done' } });
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsStdout(rows()) }));
    const out = await fillToolCallsFromLogs({ runDir: s.runDir, folders: ['runs/icp-01/r1'], env: { PATH: '/bin', LUA_API_KEY: 'k' }, deps: deps(spawn) });
    expect(out).toMatchObject({ status: 'filled', filled: 2, pending: 0, queries: 1, rawRows: 9, keptRows: 9 });
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0].argv).toEqual(['logs', '--ci', '--type', 'skill', '--since', T('19:58.000'), '--until', T('20:21.000'), '--environment', 'sandbox', '--limit', '200', '--json']);
    expect(spawn.calls[0].opts.env.LUA_API_KEY).toBeUndefined();
    const saved = await readJsonl(join(s.dir, 'turns.jsonl'));
    expect(saved[0]).toMatchObject({ toolCallSource: 'logs-window', toolCallWindow: { since: T('19:58.000'), until: T('20:11.000'), exact: false, ambiguous: 0 } });
    expect(saved[0].toolCalls.map((c) => c.executionId)).toEqual(['e1']);
    expect(JSON.stringify(saved[0].toolCalls)).not.toContain('sk_live_51Hf00');
    expect(saved[0].redactions.some((r) => r.field === 'toolCalls')).toBe(true);
    expect(saved[1].toolCalls.map((c) => c.executionId)).toEqual(['e2']);
    expect(saved[2]).toMatchObject({ toolCallSource: 'history', toolCalls: [{ name: 'get_order' }] });
    for (const r of saved) expect(validate('turn', r)).toEqual({ ok: true });
    expect(await readFile(join(s.dir, 'transcript.md'), 'utf8')).toMatch(/tool calls/);
    const ledger = await readJsonl(join(s.runDir, 'ledger.jsonl'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ source: 'tool-call', kind: 'cancel_order', turn: 1, callRef: 'runs/icp-01/r1#1#e1', cleanup: 'manual' });
    expect(ledger[0].detail).toMatch(/from logs/);
    expect((await readJson(join(s.dir, 'run-record.json'))).sideEffectRefs).toEqual(['L-0001']);

    const again = await fillToolCallsFromLogs({ runDir: s.runDir, folders: ['runs/icp-01/r1'], deps: deps(spawn) });
    expect(again).toMatchObject({ status: 'nothing-to-fill', filled: 0 });
    const refreshed = await fillToolCallsFromLogs({ runDir: s.runDir, folders: ['runs/icp-01/r1'], refresh: true, deps: deps(spawn) });
    expect(refreshed.filled).toBe(2);
    expect(await readJsonl(join(s.runDir, 'ledger.jsonl'))).toHaveLength(1);
  });

  test('a call that belongs to another run turn is not taken; a turn with no call gets zero calls', async () => {
    const s = await seeded({ rows: [unavailable(1, { at: T('20:00.000'), endedAt: T('20:06.000'), chatAt: T('20:01.000'), chatEndedAt: T('20:06.000') })], rec: { status: 'done' } });
    const other = join(s.runDir, 'runs', 'icp-02', 'r1');
    await mkdir(other, { recursive: true });
    await wj(join(other, 'run-record.json'), recordJson({ cardId: 'icp-02', folder: 'runs/icp-02/r1', status: 'done' }));
    await writeFile(join(other, 'turns.jsonl'), `${JSON.stringify(turnRow(1, { cardId: 'icp-02', at: T('20:07.000'), endedAt: T('20:12.000'), chatAt: T('20:07.000'), chatEndedAt: T('20:12.000') }))}\n`);
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsStdout(execution(T('20:08.000'), { exec: 'theirs' })) }));
    const out = await fillToolCallsFromLogs({ runDir: s.runDir, folders: ['runs/icp-01/r1'], deps: deps(spawn) });
    expect(out.filled).toBe(1);
    const [row] = await readJsonl(join(s.dir, 'turns.jsonl'));
    expect(row).toMatchObject({ toolCallSource: 'logs-window', toolCalls: [] });
    expect(await listRunFolders(s.runDir)).toEqual([
      expect.objectContaining({ folder: 'runs/icp-01/r1', status: 'done' }), expect.objectContaining({ folder: 'runs/icp-02/r1', status: 'done' }),
    ]);
  });

  test('a call matched by the platform run id gives logs-runid', async () => {
    const s = await seeded({ rows: [unavailable(1, { at: T('20:00.000'), endedAt: T('20:06.000'), platformRunId: 'run_7' })], rec: { status: 'done' } });
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsStdout(execution(T('20:03.000'), { exec: 'r', extra: { runId: 'run_7' } })) }));
    await fillToolCallsFromLogs({ runDir: s.runDir, deps: deps(spawn) });
    expect((await readJsonl(join(s.dir, 'turns.jsonl')))[0].toolCallSource).toBe('logs-runid');
  });

  test('failure, truncation, unreadable output and a mis-filter leave turns unavailable', async () => {
    const cases = [
      [fakeSpawn(() => ({ code: 1, stderr: 'Internal error' })), /LUA_LOGS_FAILED/],
      [fakeSpawn(() => ({ code: 0, stdout: logsStdout(rows(), { pagination: { hasNextPage: true } }) })), /truncated/],
      [fakeSpawn(() => ({ code: 0, stdout: 'not json at all' })), /unreadable/],
      [fakeSpawn(() => ({ code: 0, stdout: logsStdout(execution(T('20:02.000'), { exec: 'x', agentId: 'agent_other' })) })), /none for agent/],
    ];
    for (const [spawn, note] of cases) {
      const s = await seeded({ rows: [unavailable(1, { at: T('20:00.000'), endedAt: T('20:01.000') })] });
      const out = await fillToolCallsFromLogs({ runDir: s.runDir, folders: ['runs/icp-01/r1'], deps: deps(spawn) });
      expect(out).toMatchObject({ status: 'unavailable', filled: 0, pending: 1 });
      expect(out.notes.join(' ')).toMatch(note);
      expect((await readJsonl(join(s.dir, 'turns.jsonl')))[0]).toMatchObject({ toolCallSource: 'unavailable', toolCalls: null });
    }
  });

  test('a 429 is retried with backoff', async () => {
    const s = await seeded({ rows: [unavailable(1, { at: T('20:00.000'), endedAt: T('20:06.000') })] });
    const waits = [];
    const spawn = fakeSpawn((_a, _o, n) => (n === 1 ? { code: 1, stderr: 'Request failed: 429 Too Many Requests' } : { code: 0, stdout: logsStdout(rows()) }));
    const out = await fillToolCallsFromLogs({ runDir: s.runDir, folders: ['runs/icp-01/r1'], deps: deps(spawn, { sleep: async (ms) => { waits.push(ms); } }) });
    expect(out.status).toBe('filled');
    expect(waits).toEqual([2000]);
  });

  test('recent turns: waits for ingestion, and a window that is still too fresh stays pending', async () => {
    const s = await seeded({ rows: [unavailable(1, { at: T('20:00.000'), endedAt: T('20:06.000') })] });
    let clock = Date.parse(T('20:12.000'));
    const waits = [];
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsStdout([]) }));
    const out = await fillToolCallsFromLogs({
      runDir: s.runDir, folders: ['runs/icp-01/r1'],
      deps: { spawn, now: () => new Date(clock), sleep: async (ms) => { waits.push(ms); clock += ms; } },
    });
    expect(waits).toEqual([9000]);
    expect(out.filled).toBe(1);
    const fresh = await seeded({ rows: [unavailable(1, { at: T('20:00.000'), endedAt: T('20:06.000') })] });
    const stuck = await fillToolCallsFromLogs({ runDir: fresh.runDir, folders: ['runs/icp-01/r1'], deps: { spawn, now: () => new Date(Date.parse(T('20:07.000'))), sleep: async () => {} } });
    expect(stuck).toMatchObject({ status: 'unavailable', pending: 1 });
  });

  test('skips: not sandbox, nothing to fill, running runs without a selection, unreadable windows', async () => {
    const staged = await seeded({ rows: [unavailable(1)], scaffold: { runOver: { environment: { kind: 'staged', agentVersion: 4, testSession: false, logEnvironment: 'production' } } } });
    expect(await fillToolCallsFromLogs({ runDir: staged.runDir })).toMatchObject({ status: 'skipped', filled: 0 });
    const hist = await seeded({ rows: [turnRow(1)] });
    expect((await fillToolCallsFromLogs({ runDir: hist.runDir, folders: ['runs/icp-01/r1'] })).status).toBe('nothing-to-fill');
    const running = await seeded({ rows: [unavailable(1)] });
    expect((await fillToolCallsFromLogs({ runDir: running.runDir })).status).toBe('nothing-to-fill');
    const bad = await seeded({ rows: [unavailable(1, { at: 'x', endedAt: 'y' })] });
    expect(await fillToolCallsFromLogs({ runDir: bad.runDir, folders: ['runs/icp-01/r1'] })).toMatchObject({ status: 'nothing-to-fill', reason: expect.stringMatching(/time window/) });
    const s = await seeded({ rows: [unavailable(1)] });
    await mkdir(join(s.runDir, 'runs', 'icp-09', 'notarun'), { recursive: true });
    await writeFile(join(s.runDir, 'runs', 'stray-file'), '');
    expect((await listRunFolders(s.runDir)).map((f) => f.folder)).toEqual(['runs/icp-01/r1']);
    expect(await listRunFolders(join(s.runDir, 'nope'))).toEqual([]);
  });
});

describe('cliBackfillTools', () => {
  const ARGS = (s, extra = []) => ['--run-dir', s.runDir, ...extra];
  test('fills every finished run and re-runs its prechecks', async () => {
    const s = await seeded({ rows: [unavailable(1, { at: T('20:00.000'), endedAt: T('20:06.000'), user: 'cancel 1042', reply: "I've cancelled order 1042, ticket ITD-1042." })], rec: { status: 'done' } });
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsStdout(execution(T('20:02.000'), { exec: 'e1', result: { ok: true, ticketId: 'ITD-1042' } })) }));
    const t = mkio();
    const fetch = async () => ({ status: 404, ok: false, json: async () => ({}), text: async () => '{}' });
    expect(await cliBackfillTools(ARGS(s), t.io, { spawn, now: LATER, sleep: async () => {}, fetch, resolveBearer: async () => 't' })).toBe(0);
    const out = t.json();
    expect(out).toMatchObject({ ok: true, status: 'filled', filled: 1 });
    expect(out.prechecks).toEqual([{ folder: 'runs/icp-01/r1', exitCode: 0, contamination: 'UNVERIFIED', claimsUnbacked: 0, claimsStatus: 'ok' }]);
    expect(spawn.calls).toHaveLength(1);
    expect((await readJson(join(s.dir, 'run-record.json'))).checks).toMatchObject({ claimsStatus: 'ok' });
  });
  test('one selected run, --no-prechecks; usage and missing-record errors; exit 5 when nothing could be read', async () => {
    const s = await seeded({ rows: [unavailable(1, { at: T('20:00.000'), endedAt: T('20:06.000') })] });
    const ok = fakeSpawn(() => ({ code: 0, stdout: logsStdout([]) }));
    const t = mkio();
    expect(await cliBackfillTools(ARGS(s, ['--card', 'icp-01', '--run', '1', '--no-prechecks']), t.io, { spawn: ok, now: LATER, sleep: async () => {} })).toBe(0);
    expect(t.json()).toMatchObject({ filled: 1, prechecks: [] });
    expect(await cliBackfillTools(ARGS(s, ['--card', 'icp-01']), mkio().io)).toBe(2);
    expect(await cliBackfillTools(ARGS(s, ['--card', 'icp-01', '--run', '2']), mkio().io)).toBe(2);
    const s2 = await seeded({ rows: [unavailable(1, { at: T('20:00.000'), endedAt: T('20:06.000') })] });
    const t2 = mkio();
    expect(await cliBackfillTools(ARGS(s2, ['--card', 'icp-01', '--run', '1']), t2.io, { spawn: fakeSpawn(() => ({ code: 1 })), now: LATER, sleep: async () => {} })).toBe(5);
    expect(t2.json()).toMatchObject({ ok: false, status: 'unavailable' });
  });
});

describe('calls no turn takes', () => {
  test('are counted, and the turns of that query window carry the count', async () => {
    const s = await seeded({ rows: [
      unavailable(1, { at: T('20:00.000'), endedAt: T('20:06.000'), chatAt: T('20:00.000'), chatEndedAt: T('20:06.000') }),
      unavailable(2, { at: T('20:30.000'), endedAt: T('20:36.000'), chatAt: T('20:30.000'), chatEndedAt: T('20:36.000') }),
    ], rec: { status: 'done' } });
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsStdout([...execution(T('20:20.000'), { exec: 'gap' }), ...execution(T('20:02.000'), { exec: 'mine' })]) }));
    const out = await fillToolCallsFromLogs({ runDir: s.runDir, deps: { spawn, now: LATER, sleep: async () => {} } });
    expect(out).toMatchObject({ filled: 2, unattributed: 1, queries: 1 });
    const saved = await readJsonl(join(s.dir, 'turns.jsonl'));
    expect(saved.map((r) => [r.toolCalls.length, r.toolCallWindow.unattributed])).toEqual([[1, 1], [0, 1]]);
  });
});

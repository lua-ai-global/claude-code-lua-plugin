import { join } from 'node:path';
import { cliLogScan, fetchLogsPage, hasMorePages, scanWindow, summariseLogs } from '../../../lib/qa/log-scan.mjs';
import { readJson } from '../../../lib/qa/io.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { fakeSpawn, mkio, scaffoldRun, stateJson, consentStamp } from './fixtures/runtime-helpers.mjs';
import { seeded } from './fixtures/runtime-seed.mjs';

const row = (i, over = {}) => ({ timestamp: new Date(Date.UTC(2026, 9, 7, 14, 0, i)).toISOString(), subType: 'info', message: `m${i}`, metadata: { logSource: 'skill', primitiveName: 'orders' }, ...over });
const logsOut = (rows) => JSON.stringify({ data: rows });

describe('summariseLogs', () => {
  test('keeps only error and warn rows, groups by primitive, redacts, truncates, de-duplicates', () => {
    const rows = [
      row(1, { subType: 'error', message: 'failed: password=hunter2' }),
      row(1, { subType: 'error', message: 'failed: password=hunter2' }),
      row(2, { subType: 'warn', message: 'slow', metadata: { logSource: 'job', primitiveName: 'nightly' } }),
      row(3, { subType: 'info' }),
      row(4, { subType: 'ERROR', message: 'x'.repeat(900), metadata: undefined, primitiveName: 'p', logSource: 'mcp' }),
      row(5, { subType: undefined }),
    ];
    const s = summariseLogs(rows);
    expect(s.errors).toHaveLength(2);
    expect(s.warns).toHaveLength(1);
    expect(s.errors[0].message).toBe('failed: [REDACTED:password-assign]');
    expect(s.errors[1].message).toHaveLength(500);
    expect(s.byPrimitive).toEqual({ 'skill:orders': { error: 1, warn: 0 }, 'job:nightly': { error: 0, warn: 1 }, 'mcp:p': { error: 1, warn: 0 } });
  });
  test('alternate field names', () => {
    const s = summariseLogs([{ createdAt: 't', subType: 'warn', content: 'c' }]);
    expect(s.warns[0]).toMatchObject({ timestamp: 't', message: 'c', logSource: '', primitiveName: '' });
  });
});

describe('scanWindow', () => {
  const win = { since: '2026-10-07T14:00:00.000Z', until: '2026-10-07T14:10:00.000Z', environment: 'sandbox', cwd: '/p', env: { PATH: '/bin', LUA_API_KEY: 'k' } };
  test('one page: a single call with the documented argv, scrubbed env', async () => {
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsOut([row(1, { subType: 'error' })]) }));
    const r = await scanWindow({ ...win, deps: { spawn } });
    expect(r.rows).toHaveLength(1);
    expect(r.truncatedWindows).toEqual([]);
    expect(spawn.calls[0].argv).toEqual(['logs', '--ci', '--type', 'all', '--since', win.since, '--until', win.until, '--environment', 'sandbox', '--limit', '100', '--json']);
    expect(spawn.calls[0].opts.env.LUA_API_KEY).toBeUndefined();
  });
  test('accepts arrays and alternative wrappers', async () => {
    for (const body of [JSON.stringify([row(1)]), JSON.stringify({ logs: [row(1)] }), JSON.stringify({ rows: [row(1)] }), JSON.stringify({ data: { logs: [row(1)] } })]) {
      const r = await scanWindow({ ...win, deps: { spawn: fakeSpawn(() => ({ code: 0, stdout: body })) } });
      expect(r.rows).toHaveLength(1);
    }
    expect((await scanWindow({ ...win, deps: { spawn: fakeSpawn(() => ({ code: 0, stdout: 'not json' })) } })).rows).toEqual([]);
  });
  test('a full page is bisected until every part fits, so nothing is cut off', async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(i));
    const spawn = fakeSpawn((argv) => {
      const span = Date.parse(argv[7]) - Date.parse(argv[5]);
      return { code: 0, stdout: logsOut(span > 300_000 ? full : [row(1, { subType: 'error' })]) };
    });
    const r = await scanWindow({ ...win, deps: { spawn } });
    expect(spawn.calls).toHaveLength(3);
    expect(r.rows).toHaveLength(2);
    expect(r.truncatedWindows).toEqual([]);
  });
  test('depth limit, tiny windows and the deadline mark the window truncated', async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(i));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsOut(full) }));
    const deep = await scanWindow({ ...win, deps: { spawn } });
    expect(deep.truncatedWindows.length).toBeGreaterThan(0);
    expect(spawn.calls.length).toBe(127);
    const tiny = await scanWindow({ ...win, until: '2026-10-07T14:00:01.000Z', deps: { spawn: fakeSpawn(() => ({ code: 0, stdout: logsOut(full) })) } });
    expect(tiny.truncatedWindows).toEqual([{ since: win.since, until: '2026-10-07T14:00:01.000Z' }]);
    const late = await scanWindow({ ...win, deadlineMs: 1, deps: { spawn: fakeSpawn(() => ({ code: 0, stdout: logsOut(full) })), now: () => new Date() } });
    expect(late.truncatedWindows.length).toBeGreaterThan(0);
    const calls = fakeSpawn(() => ({ code: 0, stdout: logsOut(full) }));
    await scanWindow({ ...win, deadlineMs: 1, deps: { spawn: calls, now: () => new Date() } });
    expect(calls.calls.length).toBe(1);
  });
  test('lua failures surface as errors', async () => {
    await expect(scanWindow({ ...win, deps: { spawn: fakeSpawn(() => ({ code: 9 })) } })).rejects.toMatchObject({ code: 'LUA_AUTH' });
    await expect(scanWindow({ ...win, deps: { spawn: fakeSpawn(() => ({ code: 1 })) } })).rejects.toMatchObject({ code: 'LUA_LOGS_FAILED' });
  });
});

describe('cliLogScan', () => {
  const NOW = new Date('2026-10-07T14:30:00.000Z');
  test('defaults the window to the first run start (minus 5 s) through now and uses the run log environment', async () => {
    const s = await seeded({ rec: { startedAt: '2026-10-07T14:20:00.000Z' } });
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsOut([row(1, { subType: 'warn' })]) }));
    const t = mkio({ cwd: s.projectDir });
    expect(await cliLogScan(['--run-dir', s.runDir], t.io, { spawn, now: () => NOW })).toBe(0);
    expect(t.json()).toMatchObject({ ok: true, status: 'pass', rows: 1, warns: 1, errors: 0, window: { since: '2026-10-07T14:19:55.000Z', until: NOW.toISOString() } });
    expect(spawn.calls[0].argv).toEqual(expect.arrayContaining(['--environment', 'sandbox']));
    const scan = await readJson(join(s.runDir, 'mechanics', 'logs', 'scan.json'));
    expect(validate('log-scan', scan)).toEqual({ ok: true });
  });
  test('errors in the window fail the scan (exit 1); explicit --since/--until win', async () => {
    const s = await seeded({});
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsOut([row(1, { subType: 'error', message: 'boom' })]) }));
    const t = mkio({ cwd: s.projectDir });
    expect(await cliLogScan(['--run-dir', s.runDir, '--since', '2026-10-07T14:00:00.000Z', '--until', '2026-10-07T14:05:00.000Z'], t.io, { spawn, now: () => NOW })).toBe(1);
    expect(t.json()).toMatchObject({ ok: false, status: 'fail', errors: 1 });
    expect(spawn.calls[0].argv).toEqual(expect.arrayContaining(['2026-10-07T14:05:00.000Z']));
  });
  test('production runs scan the production logs and need the consent token', async () => {
    const consent = consentStamp('abcdefabcdef');
    const s = await seeded({
      scaffold: {
        runOver: { environment: { kind: 'production', agentVersion: null, testSession: null, logEnvironment: 'production' } },
        stateOver: { gates: { ...stateJson().gates, environment: { at: 'x', summary: 's', productionConsent: consent } } },
      },
    });
    const spawn = fakeSpawn(() => ({ code: 0, stdout: logsOut([]) }));
    expect(await cliLogScan(['--run-dir', s.runDir], mkio({ cwd: s.projectDir }).io, { spawn, now: () => NOW })).toBe(3);
    const t = mkio({ cwd: s.projectDir });
    expect(await cliLogScan(['--run-dir', s.runDir, '--production-consent', 'abcdefabcdef'], t.io, { spawn, now: () => NOW })).toBe(0);
    expect(spawn.calls[0].argv).toEqual(expect.arrayContaining(['--environment', 'production']));
  });
  test('no started run and no --since is a usage error; since must precede until; a missing gate is exit 3', async () => {
    const s = await scaffoldRun({});
    const spawn = fakeSpawn(() => ({ code: 0 }));
    expect(await cliLogScan(['--run-dir', s.runDir], mkio().io, { spawn, now: () => NOW })).toBe(2);
    expect(await cliLogScan(['--run-dir', s.runDir, '--since', '2026-10-07T15:00:00.000Z', '--until', '2026-10-07T14:00:00.000Z'], mkio().io, { spawn })).toBe(2);
    const s2 = await scaffoldRun({ stateOver: { gates: { discovery: null, questions: null, environment: null, plan: null } } });
    expect(await cliLogScan(['--run-dir', s2.runDir], mkio().io, { spawn })).toBe(3);
    expect(spawn.calls).toHaveLength(0);
  });
  test('records with bad start times are ignored; a platform error is exit 5', async () => {
    const s = await seeded({ rec: { startedAt: 'garbage' } });
    expect(await cliLogScan(['--run-dir', s.runDir], mkio().io, { spawn: fakeSpawn(() => ({ code: 0 })), now: () => NOW })).toBe(2);
    const s2 = await seeded({});
    expect(await cliLogScan(['--run-dir', s2.runDir], mkio().io, { spawn: fakeSpawn(() => ({ code: 11 })), now: () => NOW })).toBe(5);
  });
});

describe('fetchLogsPage / hasMorePages', () => {
  const win = { type: 'skill', limit: 200, since: '2026-10-07T14:00:00.000Z', until: '2026-10-07T14:10:00.000Z', environment: 'sandbox', cwd: '/p', env: { PATH: '/bin' } };
  test('pagination envelopes', () => {
    expect(hasMorePages({ pagination: { hasNextPage: true } })).toBe(true);
    expect(hasMorePages({ data: { pagination: { totalPages: 3 } } })).toBe(true);
    expect(hasMorePages({ nextCursor: 'c2' })).toBe(true);
    expect(hasMorePages({ data: { nextCursor: '' } })).toBe(false);
    expect(hasMorePages({ logs: [], nextCursor: null, pagination: { hasNextPage: false, totalPages: 1 } })).toBe(false);
    expect(hasMorePages(null)).toBe(false);
  });
  test('429 is retried with doubling backoff, then reported as rate limited; the deadline stops retries', async () => {
    const waits = [];
    const deps = { sleep: async (ms) => { waits.push(ms); }, now: () => new Date(0) };
    const limited = fakeSpawn(() => ({ code: 1, stderr: 'Error: Rate limit exceeded (429)' }));
    await expect(fetchLogsPage({ ...win, deps: { ...deps, spawn: limited } })).rejects.toMatchObject({ code: 'LUA_LOGS_RATE_LIMITED' });
    expect(waits).toEqual([2000, 4000, 8000]);
    expect(limited.calls).toHaveLength(4);
    const once = fakeSpawn(() => ({ code: 1, stdout: 'Too Many Requests' }));
    await expect(fetchLogsPage({ ...win, deadlineMs: 1000, deps: { ...deps, spawn: once } })).rejects.toMatchObject({ code: 'LUA_LOGS_RATE_LIMITED' });
    expect(once.calls).toHaveLength(1);
  });
  test('a readable page reports more when it is full or the envelope says so; unreadable output is flagged', async () => {
    const ok = await fetchLogsPage({ ...win, deps: { spawn: fakeSpawn(() => ({ code: 0, stdout: logsOut([row(1)]) })) } });
    expect(ok).toMatchObject({ more: false, readable: true });
    expect(ok.rows).toHaveLength(1);
    const bad = await fetchLogsPage({ ...win, deps: { spawn: fakeSpawn(() => ({ code: 0, stdout: '{"weird":true}' })) } });
    expect(bad).toEqual({ rows: [], more: false, readable: false });
    const r = await scanWindow({ ...win, deps: { spawn: fakeSpawn(() => ({ code: 0, stdout: 'nope' })) } });
    expect(r.unreadWindows).toEqual([{ since: win.since, until: win.until }]);
  });
});

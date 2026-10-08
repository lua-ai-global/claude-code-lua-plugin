// Live-trial fixes for the mechanics: --timeout instead of the `timeout` binary (macOS has none), killing the lua
// children of a timed-out call, and a tool's own expected console.warn lines in the log scan.
import { jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { main, takeTimeoutFlag, TIMEOUT_MAX, TIMEOUT_MIN, TIMEOUT_SUBCOMMANDS, usageText } from '../../../lib/qa/cli.mjs';
import { releaseHeldLocks } from '../../../lib/qa/state.mjs';
import { killActiveChildren, runLua } from '../../../lib/qa/spawn.mjs';
import { cliLogScan, expectedWarnFor, sealedExpectations, summariseLogs } from '../../../lib/qa/log-scan.mjs';
import { readJson } from '../../../lib/qa/io.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { logsAndSideEffects } from '../../../lib/qa/report/sections.mjs';
import { fakeSpawn, mkio, sealPlan, stateJson, tmpProject, wj, wjPlan } from './fixtures/runtime-helpers.mjs';
import { seeded } from './fixtures/runtime-seed.mjs';
import { fixtureResults } from './report/helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', '..', 'lib', 'qa', 'cli.mjs');
const HANDLERS = new URL('./fixtures/cli/handlers.mjs', import.meta.url).href;

describe('--timeout', () => {
  test('is taken out of the argv in either spelling, within bounds', () => {
    expect(takeTimeoutFlag(['--run-dir', 'r', '--timeout', '100', '--all'])).toEqual({ argv: ['--run-dir', 'r', '--all'], timeoutMs: 100_000 });
    expect(takeTimeoutFlag(['--timeout=5'])).toEqual({ argv: [], timeoutMs: 5000 });
    expect(takeTimeoutFlag(['--run-dir', 'r'])).toEqual({ argv: ['--run-dir', 'r'], timeoutMs: null });
    for (const bad of [['--timeout'], ['--timeout', 'x'], ['--timeout', '1'], ['--timeout', String(TIMEOUT_MAX + 1)], ['--timeout=']]) {
      expect(() => takeTimeoutFlag(bad)).toThrow(expect.objectContaining({ code: 'USAGE', exitCode: 2 }));
    }
    expect(TIMEOUT_MIN).toBe(5);
    expect(TIMEOUT_MAX).toBeLessThan(120);
  });
  test('the usage text documents it and warns off the timeout wrapper', () => {
    expect(usageText()).toContain('--timeout <seconds>');
    expect(usageText()).toContain('macOS does not have');
  });
  test('a call that finishes in time is untouched', async () => {
    const t = mkio();
    expect(await main(['tool-test', '--timeout', '30', '--run-dir', 'r'], t.io, {}, { 'tool-test': { module: HANDLERS, fn: 'cliEcho' } })).toBe(0);
    expect(t.json()).toEqual({ ok: true, argv: ['--run-dir', 'r'] });
  });
  test('a bad value is a usage error before the handler runs', async () => {
    const t = mkio();
    expect(await main(['tool-test', '--timeout', '600'], t.io, {}, { 'tool-test': { module: HANDLERS, fn: 'cliEcho' } })).toBe(2);
    expect(t.json()).toMatchObject({ ok: false, code: 'USAGE' });
  });
  test('stateful subcommands refuse it: a stopped record would void the run', async () => {
    for (const sub of ['record', 'start-run', 'finish-run', 'gate', 'cards', 'init-run']) {
      const t = mkio();
      expect(await main([sub, '--timeout', '30'], t.io, {}, { [sub]: { module: HANDLERS, fn: 'cliEcho' } })).toBe(2);
      expect(t.json().message).toBe(`--timeout is not accepted by ${sub}`);
    }
    expect(TIMEOUT_SUBCOMMANDS).toEqual(expect.arrayContaining(['tool-test', 'flow-test', 'stress', 'log-scan', 'prechecks', 'backfill-tools']));
    expect(TIMEOUT_SUBCOMMANDS).not.toContain('record');
  });
  test('past the limit: one HELPER_TIMEOUT line, exit 5, children killed, late output dropped', async () => {
    jest.useFakeTimers();
    try {
      const t = mkio();
      let killed = 0;
      const deps = { killActiveChildren: () => { killed++; return 1; }, releaseHeldLocks: () => 0 };
      const p = main(['stress', '--timeout', '5'], t.io, deps, { stress: { module: HANDLERS, fn: 'cliHang' } });
      await jest.advanceTimersByTimeAsync(5000);
      expect(await p).toBe(5);
      expect(killed).toBe(1);
      expect(t.io.timedOut).toBe(true);
      expect(t.jsons().map((o) => o.code ?? 'started')).toEqual(['started', 'HELPER_TIMEOUT']);
      await jest.advanceTimersByTimeAsync(4000);
      expect(t.jsons()).toHaveLength(2);
      expect(t.stderr()).toBe('');
    } finally {
      jest.useRealTimers();
    }
  });
  test('a timed-out call gives back the sandbox lock it held', async () => {
    const project = await tmpProject();
    const lockDir = join(project, '.lua-qa', 'locks', 'sandbox-chat.lock');
    const t = mkio();
    const p = main(['flow-test', project, '--timeout', '5'], t.io, { killActiveChildren: () => 0 }, { 'flow-test': { module: HANDLERS, fn: 'cliHoldLock' } });
    for (let i = 0; i < 50 && !existsSync(lockDir); i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(lockDir)).toBe(true);
    expect(await p).toBe(5);
    expect(existsSync(lockDir)).toBe(false);
    expect(releaseHeldLocks()).toBe(0);
  }, 15000);
  test('the real entry point refuses a bad --timeout with a usage error', () => {
    const r = spawnSync(process.execPath, [CLI, 'validate', '--timeout', '1'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ code: 'USAGE' });
  });
});

describe('killActiveChildren', () => {
  test('signals every live lua child and forgets finished ones', async () => {
    const kills = [];
    const spawn = (cmd, argv) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (sig) => {
        kills.push(sig);
        setImmediate(() => child.emit('exit', 143));
      };
      if (argv[0] === 'status') setImmediate(() => child.emit('exit', 0));
      return child;
    };
    await runLua(['status', '--json', '--ci'], { deps: { spawn } });
    expect(killActiveChildren()).toBe(0);
    const pending = runLua(['compile', '--ci'], { deps: { spawn }, timeoutMs: 60_000 });
    await new Promise((r) => setImmediate(r));
    expect(killActiveChildren()).toBe(1);
    expect(kills).toEqual(['SIGTERM']);
    await pending;
    expect(killActiveChildren()).toBe(0);
  });
  test('a child whose kill throws is skipped', async () => {
    const spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { throw new Error('gone'); };
      setTimeout(() => child.emit('exit', 0), 20);
      return child;
    };
    const pending = runLua(['compile', '--ci'], { deps: { spawn } });
    await new Promise((r) => setImmediate(r));
    expect(killActiveChildren()).toBe(0);
    await pending;
  });
});

const warnRow = (i, message, meta = {}) => ({ timestamp: new Date(Date.UTC(2026, 9, 7, 14, 0, i)).toISOString(), subType: 'warn', message, metadata: { logSource: 'skill', primitiveName: 'it-desk', toolName: 'acme_reset_password', ...meta } });
const EXPECT = [{ tool: 'acme_reset_password', match: 'reset refused for admin', why: 'the tool refuses admin resets on purpose' }];

describe('expected warn lines', () => {
  test('a matching warn is counted as expected, not as a finding; errors and other warns still count', () => {
    const rows = [
      warnRow(1, 'reset refused for admin account qa.admin'),
      warnRow(2, 'reset refused for admin account qa.admin2'),
      warnRow(3, 'disk almost full'),
      { ...warnRow(4, 'reset refused for admin account x'), subType: 'error' },
      warnRow(5, 'reset refused for admin account y', { toolName: 'other_tool', primitiveName: 'other' }),
    ];
    const s = summariseLogs(rows, EXPECT);
    expect(s.expectedWarns).toEqual([{ tool: 'acme_reset_password', match: 'reset refused for admin', why: EXPECT[0].why, count: 2, first: expect.objectContaining({ toolName: 'acme_reset_password' }) }]);
    expect(s.warns.map((w) => w.message)).toEqual(['disk almost full', 'reset refused for admin account y']);
    expect(s.errors).toHaveLength(1);
    expect(s.byPrimitive['skill:it-desk']).toEqual({ error: 1, warn: 1 });
    expect(summariseLogs(rows).expectedWarns).toEqual([]);
  });
  test('the primitive name also identifies the tool', () => {
    const e = { subType: 'warn', toolName: '', primitiveName: 'notify_p1', message: 'P1 ticket opened for qa' };
    expect(expectedWarnFor(e, [{ tool: 'notify_p1', match: 'P1 ticket opened', why: 'w' }])).toBeTruthy();
    expect(expectedWarnFor({ ...e, subType: 'error' }, [{ tool: 'notify_p1', match: 'P1 ticket opened', why: 'w' }])).toBeNull();
  });

  const plan = (expectedLogs) => ({ schema: 'lua-qa/tool-tests@1', tests: [{ id: 'tt-1', tool: 'get_order', input: {}, expect: 'ok', rationale: 'r' }], expectedLogs });
  test('only the sealed plan counts: no plan gate, or a plan changed after it, applies nothing', async () => {
    const s = await seeded({});
    await wjPlan(s.runDir, 'tool-tests.json', plan([...EXPECT, { tool: 't', match: 'x', why: 'too short' }, { tool: 't', subType: 'error', match: 'long enough text', why: 'never' }]));
    const state = await readJson(join(s.runDir, 'state.json'));
    expect((await sealedExpectations(s.runDir, state)).expectations).toEqual(EXPECT);
    expect(await sealedExpectations(s.runDir, stateJson({ gates: { ...stateJson().gates, plan: null } }))).toEqual({ expectations: [], note: null });
    await wj(join(s.runDir, 'plan', 'tool-tests.json'), plan([...EXPECT, { tool: 'acme_reset_password', match: 'disk almost full', why: 'sneaky' }]));
    const changed = await sealedExpectations(s.runDir, state);
    expect(changed.expectations).toEqual([]);
    expect(changed.note).toMatch(/plan changed after the plan gate/);
    await wj(join(s.runDir, 'plan', 'tool-tests.json'), { schema: 'lua-qa/tool-tests@1', tests: [] });
    await sealPlan(s.runDir);
    expect((await sealedExpectations(s.runDir, await readJson(join(s.runDir, 'state.json')))).expectations).toEqual([]);
  });
  test('cliLogScan reports expected warns separately and stays green', async () => {
    const s = await seeded({ rec: { startedAt: '2026-10-07T14:20:00.000Z' } });
    await wjPlan(s.runDir, 'tool-tests.json', plan(EXPECT));
    const spawn = fakeSpawn(() => ({ code: 0, stdout: JSON.stringify({ data: [warnRow(1, 'reset refused for admin account qa.admin')] }) }));
    const t = mkio({ cwd: s.projectDir });
    expect(await cliLogScan(['--run-dir', s.runDir], t.io, { spawn, now: () => new Date('2026-10-07T14:30:00.000Z') })).toBe(0);
    expect(t.json()).toMatchObject({ ok: true, warns: 0, expectedWarns: 1, errors: 0 });
    const scan = await readJson(join(s.runDir, 'mechanics', 'logs', 'scan.json'));
    expect(validate('log-scan', scan)).toEqual({ ok: true });
    expect(scan.expectedWarns[0]).toMatchObject({ tool: 'acme_reset_password', count: 1 });
    expect(scan.note).toBeUndefined();
  });
  test('the report lists expected warnings and the note', async () => {
    const { results } = await fixtureResults();
    const r = JSON.parse(JSON.stringify(results));
    r.logs = { ...r.logs, expectedWarns: [{ tool: 'acme_reset_password', match: 'reset refused for admin', why: 'on purpose', count: 2 }, { tool: 't', match: 'P1 ticket opened', count: 1 }], note: 'The plan changed.' };
    const md = logsAndSideEffects(r);
    expect(md).toContain('**Expected warnings**');
    expect(md).toContain('3 lines');
    expect(md).toContain('`acme_reset_password` "reset refused for admin" x2: on purpose');
    expect(md).toContain('`t` "P1 ticket opened" x1');
    expect(md).toContain('The plan changed.');
  });
});

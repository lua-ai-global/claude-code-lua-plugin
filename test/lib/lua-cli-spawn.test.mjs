// Tests for spawnLua and spawnLuaProbe — the public entry points that
// wrap collectOutput. Uses jest.unstable_mockModule to mock node:child_process.
//
// collectOutput's state-machine guarantees are tested with mock children
// in lua-cli.test.mjs; this file verifies the wrapper logic (probe-on-timeout,
// classification, default options).

import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { EventEmitter } from 'node:events';

const spawnMock = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  spawn: spawnMock,
}));

const { spawnLua, spawnLuaProbe } = await import('../../lib/lua-cli.mjs');

class MockChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.killSignal = null;
  }
  kill(signal) {
    this.killed = true;
    this.killSignal = signal ?? 'SIGTERM';
  }
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('spawnLua', () => {
  test('spawns lua with cross-platform invariants (shell:false, windowsHide:true)', async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnLua(['compile', '--ci']);
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('compiled'));
      child.emit('exit', 0);
    });
    await promise;

    expect(spawnMock).toHaveBeenCalledWith('lua', ['compile', '--ci'], expect.objectContaining({
      shell: false,
      windowsHide: true,
    }));
  });

  test('passes through env additions while preserving process.env', async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnLua(['test'], { env: { LUA_API_KEY: 'k' } });
    queueMicrotask(() => child.emit('exit', 0));
    await promise;

    const callEnv = spawnMock.mock.calls[0][2].env;
    expect(callEnv.LUA_API_KEY).toBe('k');
    expect(callEnv.PATH).toBe(process.env.PATH);  // process.env spread
  });

  test('returns clean result on normal exit', async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnLua(['--version']);
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('3.13.0\n'));
      child.emit('exit', 0);
    });
    const result = await promise;

    expect(result).toEqual({
      exitCode: 0,
      stdout: '3.13.0\n',
      stderr: '',
      timedOut: false,
    });
    expect(result.classification).toBeUndefined();
  });
});

describe('spawnLua timeout → probe → classification', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('classifies as STUCK_COMMAND when probe exits 0', async () => {
    const child = new MockChild();
    const probe = new MockChild();
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(probe);

    const promise = spawnLua(['compile', '--ci'], { timeoutMs: 1000 });

    // Trip the watchdog
    await jest.advanceTimersByTimeAsync(1000);
    expect(child.killSignal).toBe('SIGTERM');
    child.emit('exit', null);

    // Probe spawns now; let it return healthy
    await Promise.resolve();   // flush microtasks
    probe.emit('exit', 0);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.classification).toBe('STUCK_COMMAND');
    expect(result.probe).toEqual({ healthy: true });
  });

  test('classifies as BROKEN_INSTALL when probe also fails', async () => {
    const child = new MockChild();
    const probe = new MockChild();
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(probe);

    const promise = spawnLua(['compile', '--ci'], { timeoutMs: 1000 });

    await jest.advanceTimersByTimeAsync(1000);
    child.emit('exit', null);

    await Promise.resolve();
    probe.emit('exit', 1);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.classification).toBe('BROKEN_INSTALL');
    expect(result.probe.healthy).toBe(false);
  });
});

describe('spawnLuaProbe', () => {
  test('returns healthy on probe exit 0', async () => {
    const probe = new MockChild();
    spawnMock.mockReturnValue(probe);

    const promise = spawnLuaProbe();
    queueMicrotask(() => probe.emit('exit', 0));
    const result = await promise;

    expect(result).toEqual({ healthy: true });
  });

  test('returns unhealthy on probe non-zero exit', async () => {
    const probe = new MockChild();
    spawnMock.mockReturnValue(probe);

    const promise = spawnLuaProbe();
    queueMicrotask(() => probe.emit('exit', 1));
    const result = await promise;

    expect(result).toEqual({ healthy: false });
  });

  test('returns unhealthy on probe spawn error', async () => {
    const probe = new MockChild();
    spawnMock.mockReturnValue(probe);

    const promise = spawnLuaProbe();
    queueMicrotask(() => probe.emit('error', new Error('ENOENT')));
    const result = await promise;

    expect(result).toEqual({ healthy: false, reason: 'ENOENT' });
  });

  test('returns unhealthy when probe itself times out (5s)', async () => {
    jest.useFakeTimers();
    const probe = new MockChild();
    spawnMock.mockReturnValue(probe);

    const promise = spawnLuaProbe();
    // Probe never exits — let the 5s timeout fire
    await jest.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toEqual({ healthy: false, reason: 'lua -h itself timed out' });
    expect(probe.killed).toBe(true);
    jest.useRealTimers();
  });

  test('uses lua -h with cross-platform invariants', async () => {
    const probe = new MockChild();
    spawnMock.mockReturnValue(probe);
    const promise = spawnLuaProbe();
    queueMicrotask(() => probe.emit('exit', 0));
    await promise;

    expect(spawnMock).toHaveBeenCalledWith('lua', ['-h'], expect.objectContaining({
      shell: false,
      windowsHide: true,
    }));
  });
});

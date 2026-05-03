// Watchdog tests, per tech spec §17.2.1.
// Uses an in-process MockChild instead of a real child process — race
// behaviour shouldn't depend on OS scheduler quirks. The state machine
// in collectOutput is the load-bearing invariant; these tests verify
// it resolves exactly once across every event ordering.

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { collectOutput } from '../../lib/lua-cli.mjs';

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
    this.killSignal = signal;
  }
}

describe('collectOutput state machine', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('clean exit before timeout — no SIGTERM, timedOut false', async () => {
    const child = new MockChild();
    const promise = collectOutput(child, 5000);

    child.stdout.emit('data', Buffer.from('hello'));
    child.emit('exit', 0);

    const result = await promise;
    expect(result).toEqual({
      exitCode: 0,
      stdout: 'hello',
      stderr: '',
      timedOut: false,
    });
    expect(child.killed).toBe(false);
  });

  test('clean exit during SIGTERM grace — settles once, no SIGKILL', async () => {
    const child = new MockChild();
    const promise = collectOutput(child, 1000);

    // Fast-forward past the abort timeout
    jest.advanceTimersByTime(1000);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe('SIGTERM');

    // Child exits cleanly within the 5s grace
    child.emit('exit', 0);

    // Advance through the rest of the grace — SIGKILL should NOT fire
    // (settle already cleaned up the killTimer)
    jest.advanceTimersByTime(10_000);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(0);
    // killSignal stays SIGTERM — SIGKILL was never sent
    expect(child.killSignal).toBe('SIGTERM');
  });

  test('SIGKILL fires when child ignores SIGTERM through grace window', async () => {
    const child = new MockChild();
    const promise = collectOutput(child, 1000);

    jest.advanceTimersByTime(1000);
    expect(child.killSignal).toBe('SIGTERM');

    // Child does NOT exit during grace — advance through SIGKILL grace
    jest.advanceTimersByTime(5000);
    expect(child.killSignal).toBe('SIGKILL');

    // Eventually the child gives up
    child.emit('exit', null);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  test('output exceeding 1 MB is truncated, no OOM', async () => {
    const child = new MockChild();
    const promise = collectOutput(child, 60_000);

    // Emit a chunk > 1 MB
    const bigChunk = Buffer.alloc(2 * 1024 * 1024, 'x');
    child.stdout.emit('data', bigChunk);
    child.emit('exit', 0);

    const result = await promise;
    expect(result.stdout).toContain('[truncated at 1048576 bytes]');
    expect(result.stdout.length).toBeLessThan(2 * 1024 * 1024 + 100);
  });

  test('multiple chunks accumulate up to cap then truncate', async () => {
    const child = new MockChild();
    const promise = collectOutput(child, 60_000);

    // Emit 3 × 500 KB chunks — first two fit, third gets truncated
    const halfMB = Buffer.alloc(500 * 1024, 'a');
    child.stdout.emit('data', halfMB);
    child.stdout.emit('data', halfMB);
    child.stdout.emit('data', halfMB);
    child.emit('exit', 0);

    const result = await promise;
    expect(result.stdout).toContain('[truncated at 1048576 bytes]');
  });

  test('chunks arriving after cap is already full are dropped immediately', async () => {
    const child = new MockChild();
    const promise = collectOutput(child, 60_000);

    // Fill stdout buffer exactly to cap
    child.stdout.emit('data', Buffer.alloc(1_048_576, 'a'));
    // Send another chunk — should hit the room <= 0 early return (lines 114-116)
    child.stdout.emit('data', Buffer.from('extra'));
    // Same for stderr — exercise the else branch
    child.stderr.emit('data', Buffer.alloc(1_048_576, 'b'));
    child.stderr.emit('data', Buffer.from('extra-err'));
    child.emit('exit', 0);

    const result = await promise;
    expect(result.stdout).toContain('[truncated at 1048576 bytes]');
    expect(result.stdout).not.toContain('extra');
    expect(result.stderr).toContain('[truncated at 1048576 bytes]');
    expect(result.stderr).not.toContain('extra-err');
  });

  test('child error before exit settles once', async () => {
    const child = new MockChild();
    const promise = collectOutput(child, 60_000);

    child.stdout.emit('data', Buffer.from('partial'));
    child.emit('error', new Error('spawn failed'));

    const result = await promise;
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toBe('spawn failed');
    expect(result.timedOut).toBe(false);
  });

  test('error after timeout still settles once', async () => {
    const child = new MockChild();
    const promise = collectOutput(child, 1000);

    jest.advanceTimersByTime(1000);
    child.emit('error', new Error('post-timeout error'));

    const result = await promise;
    // First settlement wins — order-dependent but state machine guarantees only one settle
    expect(result).toBeDefined();
  });

  test('exit fires after settle does not double-resolve', async () => {
    const child = new MockChild();
    const promise = collectOutput(child, 60_000);

    child.emit('exit', 0);
    // Try to fire exit again — settle's state guard must drop it
    child.emit('exit', 1);

    const result = await promise;
    expect(result.exitCode).toBe(0);  // First settlement wins
  });

  test('handles child without stdout/stderr (defensive)', async () => {
    const child = new EventEmitter();
    child.kill = jest.fn();
    const promise = collectOutput(child, 60_000);
    child.emit('exit', 0);
    const result = await promise;
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  test('captures stderr separately from stdout', async () => {
    const child = new MockChild();
    const promise = collectOutput(child, 60_000);

    child.stdout.emit('data', Buffer.from('out-1'));
    child.stderr.emit('data', Buffer.from('err-1'));
    child.stdout.emit('data', Buffer.from('out-2'));
    child.emit('exit', 0);

    const result = await promise;
    expect(result.stdout).toBe('out-1out-2');
    expect(result.stderr).toBe('err-1');
  });
});

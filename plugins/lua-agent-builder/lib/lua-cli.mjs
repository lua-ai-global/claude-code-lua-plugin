// Per tech spec §17.2 (v7 rewrite — addresses architect review C3).
// The §3.5 watchdog wraps every `lua` invocation. State machine ensures
// the result promise resolves exactly once, regardless of which event
// (clean exit, timeout, child error) lands first.
//
// Cross-platform invariants (§5.2):
//   shell: false       — never invoke a shell, avoids quoting bugs
//   windowsHide: true  — no flash of cmd window on Windows
//
// Output buffers capped at 1 MB per stream — `lua compile --debug --verbose`
// can produce many MB while the watchdog is timing it out; uncapped accumulation
// would OOM the hook process.

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const SIGKILL_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 1_048_576;   // 1 MB per stream

/**
 * Spawn `lua <args>` with a wall-clock watchdog. On timeout, classifies via
 * `lua -h` whether the install is healthy (specific command stuck) or broken
 * (binary itself unresponsive).
 *
 * @param {string[]} args
 * @param {{timeoutMs?: number, env?: Record<string, string>}} [opts]
 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string, timedOut: boolean, probe?: object, classification?: 'STUCK_COMMAND'|'BROKEN_INSTALL'}>}
 */
export async function spawnLua(args, { timeoutMs = DEFAULT_TIMEOUT_MS, env = {} } = {}) {
  const child = spawn('lua', args, {
    env: { ...process.env, ...env },
    shell: false,
    windowsHide: true,
  });

  const result = await collectOutput(child, timeoutMs);
  if (!result.timedOut) return result;

  const probe = await spawnLuaProbe();
  return {
    ...result,
    probe,
    classification: probe.healthy ? 'STUCK_COMMAND' : 'BROKEN_INSTALL',
  };
}

/**
 * Probe `lua -h` to classify a watchdog timeout. Healthy probe = the
 * specific command was stuck; unhealthy probe = the binary itself is broken.
 *
 * @returns {Promise<{healthy: boolean, reason?: string}>}
 */
export async function spawnLuaProbe() {
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (result) => { if (!resolved) { resolved = true; resolve(result); } };

    const probe = spawn('lua', ['-h'], { shell: false, windowsHide: true });
    const timer = setTimeout(() => {
      probe.kill();
      settle({ healthy: false, reason: 'lua -h itself timed out' });
    }, PROBE_TIMEOUT_MS);

    probe.on('exit', (code) => {
      clearTimeout(timer);
      settle({ healthy: code === 0 });
    });
    probe.on('error', (err) => {
      clearTimeout(timer);
      settle({ healthy: false, reason: err.message });
    });
  });
}

/**
 * State machine: 'running' → 'aborting' → 'exited' (timeout path)
 *                'running' → 'exited'              (clean / error paths)
 *
 * Single transition guard (`state === 'exited'` check in `settle`) ensures
 * the promise resolves exactly once. All timers are cleaned up on settle.
 *
 * Exposed for tests via the `__test_only` export below; production callers
 * use `spawnLua`.
 */
export function collectOutput(child, timeoutMs) {
  return new Promise((resolve) => {
    let state = 'running';
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killTimer = null;
    let abortTimer = null;

    const cleanup = () => {
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (abortTimer) { clearTimeout(abortTimer); abortTimer = null; }
    };

    const settle = (result) => {
      if (state === 'exited') return;
      state = 'exited';
      cleanup();
      resolve(result);
    };

    const captureChunk = (chunk, target) => {
      const currentBytes = target === 'stdout' ? stdoutBytes : stderrBytes;
      const room = MAX_OUTPUT_BYTES - currentBytes;
      if (room <= 0) {
        if (target === 'stdout') stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }
      const slice = chunk.length > room ? chunk.slice(0, room) : chunk;
      const text = slice.toString('utf8');
      if (target === 'stdout') {
        stdout += text;
        stdoutBytes += slice.length;
        if (chunk.length > room) stdoutTruncated = true;
      } else {
        stderr += text;
        stderrBytes += slice.length;
        if (chunk.length > room) stderrTruncated = true;
      }
    };

    if (child.stdout) child.stdout.on('data', (c) => captureChunk(c, 'stdout'));
    if (child.stderr) child.stderr.on('data', (c) => captureChunk(c, 'stderr'));

    abortTimer = setTimeout(() => {
      if (state !== 'running') return;
      state = 'aborting';
      // try/catch is defensive: child.kill can throw EPERM in rare cases
      // when the process has already exited but the event hasn't been
      // emitted yet. Hard to reproduce reliably; ignore-next is honest.
      /* istanbul ignore next */
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      killTimer = setTimeout(() => {
        if (state === 'aborting') {
          /* istanbul ignore next */
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }, SIGKILL_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);

    child.on('exit', (code) => {
      const timedOut = state === 'aborting';
      settle({
        exitCode: code,
        stdout: stdoutTruncated ? `${stdout}[truncated at ${MAX_OUTPUT_BYTES} bytes]` : stdout,
        stderr: stderrTruncated ? `${stderr}[truncated at ${MAX_OUTPUT_BYTES} bytes]` : stderr,
        timedOut,
      });
    });

    child.on('error', (err) => {
      settle({ exitCode: -1, stdout, stderr: err.message, timedOut: false });
    });
  });
}

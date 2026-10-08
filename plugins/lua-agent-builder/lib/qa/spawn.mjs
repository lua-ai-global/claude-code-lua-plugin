// The only place `lua` is spawned. Every argv passes assertAllowedLuaArgv BEFORE spawn.
// Uses collectOutput (watchdog + output cap) and never spawnLua, because spawnLua merges process.env
// and so would defeat the scrub.

import { spawn as nodeSpawn } from 'node:child_process';
import { collectOutput } from '../lua-cli.mjs';
import { QaError } from './io.mjs';
import { assertAllowedLuaArgv, redactDeep, scrubEnv } from './safety.mjs';

/**
 * chat (every form), logs, status, version, workflows, compile, --version -> scrub.
 * test (any type) -> passthrough: `lua test` uploads nothing and tools may need shell-held secrets.
 */
export function envPolicyFor(argv) {
  return argv[0] === 'test' ? 'passthrough' : 'scrub';
}

/** Long messages are cut in logs; redaction applies to everything. */
function redactedArgv(argv) {
  return redactDeep(argv.map((a) => (a.length > 200 ? `${a.slice(0, 200)}...` : a)));
}

// Every live lua child, so `--timeout` can stop them with the call (cli.mjs).
const ACTIVE = new Set();

/** Kills every lua child this process started that is still running. Returns how many it signalled. */
export function killActiveChildren() {
  let n = 0;
  for (const child of ACTIVE) {
    try {
      child.kill('SIGTERM');
      n++;
    } catch { /* already gone */ }
  }
  ACTIVE.clear();
  return n;
}

/**
 * `startedAt`/`endedAt` bracket the child process itself (not any lock wait before the call).
 * @returns {Promise<{exitCode:number|null, stdout:string, stderr:string, timedOut:boolean, ms:number, startedAt:string, endedAt:string, argvRedacted:string[], env:'scrub'|'passthrough'}>}
 */
export async function runLua(argv, { cwd, timeoutMs = 90_000, env = process.env, deps = {} } = {}) {
  assertAllowedLuaArgv(argv);
  const policy = envPolicyFor(argv);
  // LUA_NO_HINTS is a fixed constant, not inherited: it silences the "Tip" lines and the post-turn error probe that
  // lua-cli prints to stdout after a reply (verified in the lua-cli 3.45.0 bundle: hintsDisabled() reads it).
  const childEnv = policy === 'scrub' ? { ...scrubEnv(env), LUA_NO_HINTS: '1' } : { ...env };
  const now = deps.now ?? (() => new Date());
  const t0 = now().getTime();
  const child = (deps.spawn ?? nodeSpawn)('lua', argv, { cwd, env: childEnv, shell: false, windowsHide: true });
  ACTIVE.add(child);
  let res;
  try {
    res = await collectOutput(child, timeoutMs);
  } finally {
    ACTIVE.delete(child);
  }
  const t1 = Math.max(t0, now().getTime());
  return {
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    timedOut: res.timedOut,
    ms: t1 - t0,
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date(t1).toISOString(),
    argvRedacted: redactedArgv(argv),
    env: policy,
  };
}

/** Maps a spawn result to a QaError for the cases every caller treats the same way, else null. */
export function classifyLuaExit(result) {
  if (result.timedOut) return new QaError('LUA_TIMEOUT', 5, 'lua did not finish in time', 'Retry the call; long jobs are resumable.');
  if (result.exitCode === -1 && /ENOENT/.test(result.stderr ?? '')) {
    return new QaError('LUA_MISSING', 4, 'lua-cli is not installed or not on PATH', 'Install it with /lua-update or npm install -g lua-cli.');
  }
  if ([9, 10, 11].includes(result.exitCode)) {
    return new QaError('LUA_AUTH', 5, `lua reported an authentication problem (exit ${result.exitCode})`, 'Log in again in your own terminal (lua auth), or run /lua-auth.');
  }
  if (result.exitCode === 12) {
    return new QaError('LUA_PROVIDER_REFUSED', 5, 'The model provider refused the request (exit 12)', 'Retry once; if it repeats, stop the run.');
  }
  return null;
}

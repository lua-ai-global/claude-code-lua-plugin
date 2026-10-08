// Stress runner: concurrent threads with p50/p90/p99 on a staged version (test-session API) or production, and
// burst/batching (`lua chat -b`) on sandbox or production. Sandbox chats are serialized, so concurrent stress in
// sandbox is refused; burst has no staged path (`lua chat -b` targets sandbox or production only), so a staged
// burst is refused rather than silently hitting the sandbox. Resumable: samples are appended as they land.

import { join } from 'node:path';
import { QaError, appendJsonl, emit, fail, hex, parseArgs, readJsonOr, readJsonl, resolveRunDir, writeJson } from './io.mjs';
import { assertGates, loadRun, withSandboxLock } from './state.mjs';
import { checkTestData, fakeDataHint, testDataPolicy } from './safety.mjs';
import { runLua } from './spawn.mjs';
import { addLedger } from './ledger.mjs';
import { parseBatchStdout, testSessionApi } from './recorder.mjs';
import { validate } from './schemas.mjs';

/** Nearest rank: sorted[ceil(p/100 * n) - 1]. */
export function percentile(sortedMs, p) {
  if (!sortedMs.length) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.min(idx, sortedMs.length - 1)];
}

const pcts = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p90: percentile(s, 90), p99: percentile(s, 99), max: s.length ? s[s.length - 1] : 0, min: s.length ? s[0] : 0 };
};

/** @returns the stress-result shape minus resume fields */
export function summarise(samples, targets = {}) {
  const ok = samples.filter((s) => s.ok);
  const errors = samples.length - ok.length;
  const errorRate = samples.length ? Math.round((errors / samples.length) * 10_000) / 10_000 : 0;
  const lat = pcts((ok.length ? ok : samples).map((s) => s.ms));
  const ttfb = samples.filter((s) => typeof s.ttfbMs === 'number').map((s) => s.ttfbMs);
  const targetsMet = {
    p90Ms: targets.p90Ms === undefined ? true : lat.p90 <= targets.p90Ms,
    p99Ms: targets.p99Ms === undefined ? true : lat.p99 <= targets.p99Ms,
    errorRate: targets.errorRate === undefined ? true : errorRate <= targets.errorRate,
  };
  const { p50, p90, p99, max, min } = lat;
  return {
    requests: samples.length, ok: ok.length, errors, errorRate,
    latencyMs: { p50, p90, p99, max, min },
    ttfbMs: ttfb.length ? { p50: pcts(ttfb).p50, p90: pcts(ttfb).p90, p99: pcts(ttfb).p99 } : null,
    targetsMet,
    status: Object.values(targetsMet).every(Boolean) && samples.length > 0 ? 'pass' : 'fail',
  };
}

const defaultNow = () => new Date();

/** Concurrent run: a pool of `concurrency` workers over threads; turns inside a thread are sequential. */
export async function runConcurrent(plan, ctx) {
  const { deps = {}, done, send, record, startMs, hardStopMs } = ctx;
  const wallMs = ctx.wallMs ?? plan.maxWallSeconds * 1000;
  const now = deps.now ?? defaultNow;
  let next = 0;
  const threads = plan.threads;
  const worker = async () => {
    for (;;) {
      const t = next++;
      if (t >= threads) return;
      for (let j = 0; j < plan.turnsPerThread; j++) {
        if (done.has(`${t}:${j}`)) continue;
        if (now().getTime() - startMs >= wallMs) return;
        const message = plan.messages[(t * plan.turnsPerThread + j) % plan.messages.length];
        const t0 = now().getTime();
        let res;
        try {
          res = await send({ thread: t, turn: j, message, timeoutMs: Math.max(3000, hardStopMs - (t0 - startMs) - 5000) });
        } catch (err) {
          res = { exitCode: null, ok: false, batchHandled: false, error: err.code ?? 'ERROR' };
        }
        await record({
          thread: t, turn: j, startAt: new Date(t0).toISOString(), ms: now().getTime() - t0,
          ttfbMs: res.ttfbMs ?? null, exitCode: res.exitCode ?? null, ok: !!res.ok, batchHandled: !!res.batchHandled,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(plan.concurrency, threads)) }, worker));
}

/** One `lua chat -b` call: a burst of messages, counting replies / batch-handled / batch-abort lines. */
export async function runBurst(plan, ctx) {
  const { deps = {}, run, env, cwd, thread, ioEnv } = ctx;
  const size = plan.burst?.size ?? 4;
  const messages = Array.from({ length: size }, (_, i) => plan.messages[i % plan.messages.length]);
  if (env.kind !== 'sandbox' && env.kind !== 'production') {
    throw new QaError('STRESS_BURST_ENV', 3, `Burst stress has no ${env.kind} path (lua chat -b targets sandbox or production only)`, 'Use mode concurrent for a staged version.');
  }
  const target = env.kind;
  const argv = ['chat', '--ci', '-e', target, '-b', ...messages, '-d', String(plan.burst?.delayMs ?? 100), '-t', thread];
  const exec = () => runLua(argv, { cwd, timeoutMs: 75_000, env: ioEnv, deps });
  // The lock follows the command's own target, not a label: anything that chats with -e sandbox takes it.
  const res = argv[argv.indexOf('-e') + 1] === 'sandbox'
    ? await withSandboxLock(run.projectDir, { runId: run.runId, player: 'stress' }, exec, { maxWaitMs: 20_000 }, deps)
    : await exec();
  const counts = parseBatchStdout(res.stdout, res.stderr);
  return { res, counts, size };
}

export async function cliStress(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, {
      'run-dir': { type: 'string', required: true }, resume: { type: 'boolean' },
      'production-consent': { type: 'string' }, json: { type: 'boolean' },
    });
    const runDir = resolveRunDir(io, v['run-dir']);
    const { state } = await assertGates(runDir, ['environment', 'plan'], { consent: v['production-consent'], requireConsent: true });
    const run = await loadRun(runDir);
    const plan = await readJsonOr(join(runDir, 'plan', 'stress.json'));
    const pv = plan ? validate('stress-plan', plan) : { ok: false, errors: ['plan/stress.json is missing'] };
    if (!pv.ok) throw new QaError('USAGE', 2, `stress plan is invalid: ${pv.errors[0]}`);
    const env = run.environment;
    if (plan.mode === 'concurrent' && env.kind === 'sandbox') {
      throw new QaError('STRESS_SANDBOX', 3, 'Concurrent stress cannot run in the sandbox (sandbox chats run one at a time)', 'Use a staged version, or switch the plan to mode burst.');
    }
    if (plan.mode === 'burst' && env.kind === 'staged') {
      throw new QaError('STRESS_BURST_ENV', 3, 'Burst stress cannot target a staged version (lua chat -b would hit the sandbox instead)', 'Switch the plan to mode concurrent for a staged version.');
    }
    const policy = testDataPolicy(run, state);
    const td = checkTestData(plan.messages.join('\n'), policy);
    if (!td.ok) throw new QaError(td.violations[0].kind === 'email' ? 'REAL_EMAIL' : 'REAL_URL', 3, 'The stress messages contain real-looking contact data', fakeDataHint(policy));
    const dir = join(runDir, 'mechanics', 'stress');
    const samplesPath = join(dir, 'samples.jsonl');
    const now = deps.now ?? defaultNow;
    const startMs = now().getTime();
    const prior = v.resume ? await readJsonl(samplesPath) : [];
    if (!v.resume) {
      const existing = await readJsonl(samplesPath);
      if (existing.length) throw new QaError('USAGE', 2, 'Stress samples already exist for this run', 'Pass --resume to continue them.');
    }
    const stateFile = join(dir, 'threads.json');
    let meta = (await readJsonOr(stateFile)) ?? null;
    if (!meta) {
      const short = run.runId.slice(-4);
      meta = { threads: Array.from({ length: plan.mode === 'burst' ? 1 : plan.threads }, (_, i) => `qa-${short}-stress-${plan.mode === 'burst' ? 'b' : `t${i}`}-${hex(6, deps)}`), sessionId: null };
    }

    if (plan.mode === 'burst') {
      const { res, counts, size } = await runBurst(plan, { deps, run, env, cwd: run.projectDir, thread: meta.threads[0], ioEnv: io.env });
      await writeJson(stateFile, meta);
      const ok = res.exitCode === 0 && counts.errors === 0;
      const sample = { thread: 0, turn: 0, startAt: new Date(startMs).toISOString(), ms: res.ms, ttfbMs: null, exitCode: res.exitCode, ok, batchHandled: counts.batchHandled > 0 };
      await appendJsonl(samplesPath, sample);
      const summary = summarise([sample], plan.targets);
      const result = {
        schema: 'lua-qa/stress-result@1', mode: 'burst', complete: true, ...summary,
        burst: { sent: counts.sent || size, replies: counts.replies, batchHandled: counts.batchHandled, batchAborted: counts.batchAborted },
        resumeFrom: null,
      };
      await writeJson(join(dir, 'stress.json'), result);
      await addLedger(runDir, { source: 'stress', kind: 'burst', detail: `burst of ${size} messages on ${meta.threads[0]}`, cleanup: 'auto', cleanupHint: 'The cleanup step clears the stress thread.', expected: true }, deps);
      emit(io, { ok: result.status === 'pass', mode: 'burst', status: result.status, burst: result.burst, latencyMs: result.latencyMs });
      return result.status === 'pass' ? 0 : 1;
    }

    // concurrent
    let sessionId = meta.sessionId;
    const useSession = env.kind === 'staged' && env.testSession;
    if (useSession && !sessionId) {
      sessionId = await testSessionApi.open(run.agent.id, env.agentVersion, deps, 10_000);
      meta.sessionId = sessionId;
    }
    await writeJson(stateFile, meta);
    const done = new Set(prior.map((s) => `${s.thread}:${s.turn}`));
    const send = async ({ thread, message, timeoutMs }) => {
      const tid = meta.threads[thread];
      if (useSession) {
        await testSessionApi.chat(run.agent.id, env.agentVersion, sessionId, message, tid, deps, Math.max(3000, timeoutMs));
        return { exitCode: 0, ok: true };
      }
      const argv2 = env.kind === 'staged'
        ? ['chat', '--ci', '--agent-version', String(env.agentVersion), '-m', message, '-t', tid]
        : ['chat', '--ci', '-e', 'production', '-m', message, '-t', tid];
      const res = await runLua(argv2, { cwd: run.projectDir, timeoutMs, env: io.env, deps });
      return { exitCode: res.exitCode, ok: res.exitCode === 0 && !res.timedOut, batchHandled: /Batch handled/i.test(res.stdout) };
    };
    const record = async (sample) => appendJsonl(samplesPath, sample);
    // Each CLI call finishes within 110 s: stop starting requests by min(plan, 95) s; in-flight ones end by +9 s; close <= 5 s.
    const wallSeconds = Math.min(plan.maxWallSeconds, 95);
    await runConcurrent(plan, { deps, done, send, record, startMs, wallMs: wallSeconds * 1000, hardStopMs: (wallSeconds + 9) * 1000 });

    const samples = await readJsonl(samplesPath);
    const have = new Set(samples.map((s) => `${s.thread}:${s.turn}`));
    let resumeFrom = null;
    for (let t = 0; t < plan.threads && !resumeFrom; t++) {
      for (let j = 0; j < plan.turnsPerThread; j++) if (!have.has(`${t}:${j}`)) { resumeFrom = { thread: t, turn: j }; break; }
    }
    const complete = resumeFrom === null;
    const summary = summarise(samples, plan.targets);
    const result = {
      schema: 'lua-qa/stress-result@1', mode: 'concurrent', complete, ...summary,
      status: complete ? summary.status : 'partial', burst: null, resumeFrom,
    };
    if (complete && useSession && sessionId) {
      try {
        await testSessionApi.close(run.agent.id, env.agentVersion, sessionId, deps, 5000);
        meta.sessionId = null;
        await writeJson(stateFile, meta);
      } catch { /* the session expires on its own; cleanup retries */ }
    }
    await writeJson(join(dir, 'stress.json'), result);
    if (complete) {
      await addLedger(runDir, { source: 'stress', kind: 'concurrent', detail: `${plan.threads} stress threads x ${plan.turnsPerThread} turns`, cleanup: 'auto', cleanupHint: 'The cleanup step clears the stress threads.', expected: true }, deps);
    }
    emit(io, { ok: result.status === 'pass', mode: 'concurrent', complete, status: result.status, requests: result.requests, errors: result.errors, latencyMs: result.latencyMs, targetsMet: result.targetsMet, resumeFrom });
    return result.status === 'pass' || result.status === 'partial' ? 0 : 1;
  } catch (err) {
    return fail(io, err);
  }
}


// Offline workflow flow tests: `lua test --ci workflow ... --agents fake` with scripted
// step outputs, approvals, denials and signals. The offline driver makes no platform calls, so no consent is needed.

import { join } from 'node:path';
import { QaError, emit, fail, parseArgs, readJsonOr, resolveRunDir } from './io.mjs';
import { assertGates, loadRun } from './state.mjs';
import { classifyLuaExit } from './spawn.mjs';
import { redactSecrets } from './safety.mjs';
import { validate } from './schemas.mjs';
import { assertFakeInput, budgetSeconds, parseJsonLoose, runLuaTest, runPlanned, selectTests } from './tool-test.mjs';

/** lua argv for one planned flow test, in the exact shape safety.mjs allows. */
export function flowTestArgv(test) {
  const argv = ['test', '--ci', 'workflow', '--name', test.workflow, '--input', JSON.stringify(test.input ?? {}), '--agents', 'fake', '--fast-retries', '--json'];
  for (const [id, value] of Object.entries(test.stepOutputs ?? {})) argv.push('--step-output', `${id}=${JSON.stringify(value)}`);
  for (const id of test.approve ?? []) argv.push('--approve', id);
  for (const id of test.deny ?? []) argv.push('--deny', id);
  for (const [name, value] of Object.entries(test.signals ?? {})) argv.push('--signal', `${name}=${JSON.stringify(value)}`);
  return argv;
}

const STEP_LIST_KEYS = ['steps', 'executedSteps', 'stepsRun', 'trace', 'reached', 'path', 'executed'];

/** Step ids the offline run says it executed, or null when the output does not list them (V3, unverified). */
export function reachedSteps(stdout) {
  const parsed = parseJsonLoose(stdout);
  if (!parsed || typeof parsed !== 'object') return null;
  // lua-cli 3.45.0 offline run (--json): { success, data: { status, output, exitCode, ledger: { steps: { <id>: { stepId, status, taken } } } } }
  const steps = parsed?.data?.ledger?.steps ?? parsed?.ledger?.steps;
  if (steps && typeof steps === 'object' && !Array.isArray(steps)) {
    return Object.entries(steps).filter(([, r]) => !['skipped', 'pending'].includes(r?.status)).map(([id, r]) => String(r?.stepId ?? id));
  }
  const find = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3) return null;
    for (const key of STEP_LIST_KEYS) {
      const list = o[key];
      if (Array.isArray(list)) {
        const ids = list.map((x) => (typeof x === 'string' ? x : x?.stepId ?? x?.id ?? x?.name ?? null)).filter(Boolean);
        if (ids.length || list.length === 0) return ids.map(String);
      }
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const r = find(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  };
  return find(parsed, 0);
}

/**
 * Whether step `id` ran. A step inside `foreach` runs once per item and the offline ledger keys each run by
 * index (`checkOne[0]`, `checkOne[1]`, …), so any indexed run of it counts.
 */
export function stepReached(reached, id) {
  return reached.some((s) => s === id || (s.startsWith(`${id}[`) && /^\[\d+\]$/.test(s.slice(id.length))));
}

/**
 * @returns {{status:'pass'|'fail'|'error', reasons:string[], reached:string[]|null}}
 */
export function judgeFlowTest(test, result) {
  if (result.infraError) return { status: 'error', reasons: [result.infraError], reached: null };
  const expect = test.expect ?? {};
  const reasons = [];
  const notes = [];
  const wantExit = expect.exitCode ?? 0;
  if (result.exitCode !== wantExit) reasons.push(`exit code ${result.exitCode}, expected ${wantExit}`);
  const reached = reachedSteps(result.stdout);
  if ((expect.reachNodes?.length || expect.notReachNodes?.length) && reached === null) {
    notes.push('note: step list not in output; reachNodes check skipped');
  } else if (reached) {
    for (const id of expect.reachNodes ?? []) if (!stepReached(reached, id)) reasons.push(`step ${id} was not reached`);
    for (const id of expect.notReachNodes ?? []) if (stepReached(reached, id)) reasons.push(`step ${id} was reached but should not have been`);
  }
  for (const needle of expect.outputIncludes ?? []) {
    if (!String(result.stdout).includes(needle)) reasons.push(`output does not include "${needle}"`);
  }
  return { status: reasons.length ? 'fail' : 'pass', reasons: [...reasons, ...notes], reached };
}

const tail = (s, n = 4000) => redactSecrets(String(s ?? '').slice(-n)).text;

export async function cliFlowTest(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, {
      'run-dir': { type: 'string', required: true }, id: { type: 'string' }, all: { type: 'boolean' },
      'max-seconds': { type: 'number' }, rerun: { type: 'boolean' }, json: { type: 'boolean' },
    });
    const runDir = resolveRunDir(io, v['run-dir']);
    const { state } = await assertGates(runDir, ['plan']);
    const run = await loadRun(runDir);
    const plan = await readJsonOr(join(runDir, 'plan', 'flow-tests.json'));
    const pv = plan ? validate('flow-tests', plan) : { ok: false, errors: ['plan/flow-tests.json is missing'] };
    if (!pv.ok) throw new QaError('USAGE', 2, `flow-tests plan is invalid: ${pv.errors[0]}`);
    if (plan.tests.length === 0 && v.all && !v.id) {
      // The agent has no workflows: the plan says so explicitly (notApplicable), and there is nothing to run.
      emit(io, { ok: true, done: 0, remaining: 0, alreadyDone: 0, failed: 0, notApplicable: plan.notApplicable, results: [] });
      return 0;
    }
    const tests = selectTests(plan, v);
    const now = deps.now ?? (() => new Date());
    const batch = await runPlanned({
      tests, dir: join(runDir, 'mechanics', 'flow-tests'), maxSeconds: await budgetSeconds(runDir, run, state, v['max-seconds'], now), rerun: !!v.rerun, now,
      runOne: async (t, remainingMs) => {
        assertFakeInput({ input: t.input, stepOutputs: t.stepOutputs, signals: t.signals }, run, state);
        const argv2 = flowTestArgv(t);
        let res;
        try {
          res = await runLuaTest(run, argv2, { deadlineMs: now().getTime() + remainingMs, env: io.env, deps });
        } catch (err) {
          if (!(err instanceof QaError) || err.code === 'SANDBOX_BUSY') throw err;
          return {
            schema: 'lua-qa/flow-test-result@1', id: t.id, workflow: t.workflow, pathId: t.pathId, argv: [], exitCode: null,
            status: 'error', reasons: [err.message], reached: null, ms: 0, stdoutTail: '',
          };
        }
        const infra = classifyLuaExit(res);
        const judged = judgeFlowTest(t, { exitCode: res.exitCode, stdout: res.stdout, infraError: infra ? infra.message : undefined });
        return {
          schema: 'lua-qa/flow-test-result@1', id: t.id, workflow: t.workflow, pathId: t.pathId, argv: res.argvRedacted,
          exitCode: res.exitCode, status: judged.status, reasons: judged.reasons, reached: judged.reached, ms: res.ms,
          stdoutTail: tail(res.stdout),
        };
      },
    });
    const failed = batch.results.filter((r) => r.status !== 'pass').length;
    emit(io, {
      ok: failed === 0, done: batch.results.length, remaining: batch.remaining, alreadyDone: batch.skipped, failed,
      ...(batch.busy ? { sandboxBusy: true, hint: 'A player held the sandbox; run the same command again for the remaining tests.' } : {}),
      results: batch.results.map((r) => ({ id: r.id, status: r.status, reasons: r.reasons })),
    });
    return failed > 0 ? 1 : 0;
  } catch (err) {
    return fail(io, err);
  }
}

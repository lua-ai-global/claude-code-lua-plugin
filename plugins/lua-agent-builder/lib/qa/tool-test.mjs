// Direct tool tests: `lua test --ci skill --name <tool>` with throw detection.
// `lua test` exits 0 even when a tool throws, so the parsed output decides, not the exit code.

import { join } from 'node:path';
import { QaError, emit, fail, parseArgs, readJsonOr, resolveRunDir, writeJson } from './io.mjs';
import { assertGates, loadRun, pushHistory, withSandboxLock } from './state.mjs';
import { minutesLeft, runTier } from './tiers.mjs';
import { runLua, classifyLuaExit } from './spawn.mjs';
import { checkTestData, fakeDataHint, redactSecrets, testDataPolicy } from './safety.mjs';
import { addLedger } from './ledger.mjs';
import { validate } from './schemas.mjs';
import { readdir } from 'node:fs/promises';

const STACK_RE = /\n\s+at .+\(.+:\d+:\d+\)/;
const STATUS_ERROR_RE = /"status"\s*:\s*"error"/;

/** Finds the last JSON value printed in `text` (the CLI may print banners before it). */
export function parseJsonLoose(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch { /* fall through */ }
  const lines = s.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[{[]/.test(lines[i])) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch { /* try an earlier start */ }
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(s.slice(first, last + 1));
    } catch { /* not JSON */ }
  }
  return null;
}

/**
 * @returns {{threw:boolean, errorMessage:string|null}}
 */
export function detectThrow({ exitCode, stdout = '', stderr = '' }) {
  const parsed = parseJsonLoose(stdout);
  // lua-cli 3.45.0 prints the CLI error envelope {success:false, error:{code,message}} when a tool throws under --json
  // (and sets a non-zero exit); older builds exit 0. Both are caught here.
  if (parsed && typeof parsed === 'object' && parsed.success === false && parsed.error && typeof parsed.error === 'object') {
    return { threw: true, errorMessage: String(parsed.error.message ?? parsed.error.code ?? 'tool threw').slice(0, 300) };
  }
  if (parsed && typeof parsed === 'object' && parsed.status === 'error') {
    const msg = parsed.error?.message ?? parsed.error ?? parsed.message ?? 'tool returned status error';
    return { threw: true, errorMessage: String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300) };
  }
  // The raw text match is a fallback for unparseable output only: a successful result may well contain records
  // whose own status is "error".
  if (!parsed && (STATUS_ERROR_RE.test(stdout) || STATUS_ERROR_RE.test(stderr))) {
    return { threw: true, errorMessage: 'output contains "status":"error"' };
  }
  if (STACK_RE.test(`\n${stderr}`) || STACK_RE.test(`\n${stdout}`)) {
    const line = `${stderr}\n${stdout}`.split('\n').find((l) => /\bError\b/.test(l)) ?? 'stack trace in output';
    return { threw: true, errorMessage: line.trim().slice(0, 300) };
  }
  if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
    return { threw: true, errorMessage: `lua test exited with code ${exitCode}` };
  }
  return { threw: false, errorMessage: null };
}

/**
 * @param {{expect:'ok'|'error', outputIncludes?:string[]}} test
 * @param {{exitCode:number|null, threw:boolean, stdout:string, infraError?:string}} result
 */
export function judgeToolTest(test, result) {
  const reasons = [];
  if (result.infraError) return { status: 'error', reasons: [result.infraError] };
  if (test.expect === 'ok' && result.threw) reasons.push('tool threw on valid input');
  if (test.expect === 'error' && !result.threw) reasons.push('tool accepted invalid input');
  for (const needle of test.outputIncludes ?? []) {
    if (!String(result.stdout).includes(needle)) reasons.push(`output does not include "${needle}"`);
  }
  return { status: reasons.length ? 'fail' : 'pass', reasons };
}

const tail = (s, n = 4000) => redactSecrets(String(s ?? '').slice(-n)).text;

export async function listResultIds(dir) {
  try {
    return new Set((await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
  } catch {
    return new Set();
  }
}

/** How long a mechanics `lua test` waits for the sandbox lock at most; plus the 60 s test timeout it stays under 110 s. */
export const MECHANICS_LOCK_WAIT_MS = 40_000;
/** A test is not started with less than this left in the call: a cut-short run would be saved as an error. */
export const MIN_TEST_MS = 30_000;

/**
 * Runs one `lua test` call. `lua test skill` and `lua test workflow` compile into dist-v2/, the folder a sandbox
 * `lua chat` compiles and pushes from, so in a sandbox run they take the same lock as the players' chats.
 * The test timeout is computed after the lock is held, from the caller's deadline.
 */
export async function runLuaTest(run, argv, { deadlineMs, env, deps = {} }) {
  const now = deps.now ?? (() => new Date());
  const left = () => deadlineMs - now().getTime();
  const exec = () => runLua(argv, {
    cwd: run.projectDir, timeoutMs: Math.max(5000, Math.min(60_000, left() - 5000)), env, deps,
  });
  if (run.environment?.kind !== 'sandbox') return exec();
  // The lock wait comes out of the same budget, so the whole call stays inside the 120 s heartbeat. Too little
  // time left (before or after the wait) is SANDBOX_BUSY: nothing runs, nothing is written, the test stays to do.
  const execInTime = () => {
    if (left() < MIN_TEST_MS) {
      throw new QaError('SANDBOX_BUSY', 5, 'Not enough time left in this call to run the test after waiting for the sandbox', 'Run the same command again.');
    }
    return exec();
  };
  const maxWaitMs = Math.min(MECHANICS_LOCK_WAIT_MS, left() - MIN_TEST_MS);
  return withSandboxLock(run.projectDir, { runId: run.runId, player: 'mechanics' }, execInTime, { maxWaitMs }, deps);
}

/**
 * Refuses (exit 3) a test input that carries real-looking contact data, right before it is spawned. `state` carries
 * the email domains agreed at the environment gate (a qa./test. address on them passes).
 */
export function assertFakeInput(value, run, state = null) {
  const policy = testDataPolicy(run, state);
  const td = checkTestData(JSON.stringify(value ?? {}), policy);
  if (!td.ok) {
    const first = td.violations[0];
    throw new QaError(first.kind === 'email' ? 'REAL_EMAIL' : 'REAL_URL', 3, `The test input contains real-looking contact data${first.reason ? ` (${first.reason})` : ''}`, `${fakeDataHint(policy)} Then re-validate and re-stamp the plan.`);
  }
}

/**
 * Shared batch loop for tool and flow tests. Stops starting new tests when the time budget is nearly spent.
 * @param {{tests:object[], dir:string, maxSeconds:number, rerun:boolean, now:()=>Date, runOne:(t:object, remainingMs:number)=>Promise<object>}} opts
 */
export async function runPlanned({ tests, dir, maxSeconds, rerun, now, runOne }) {
  const existing = rerun ? new Set() : await listResultIds(dir);
  const todo = tests.filter((t) => !existing.has(t.id));
  const started = now().getTime();
  const durations = [];
  const results = [];
  const budget = maxSeconds * 1000;
  let busy = false;
  for (const t of todo) {
    const elapsed = now().getTime() - started;
    const sorted = [...durations].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    if (results.length > 0 && elapsed + median > budget) break;
    const t0 = now().getTime();
    let res;
    try {
      res = await runOne(t, Math.max(8000, budget - elapsed));
    } catch (err) {
      // The sandbox is busy with a player's chat: nothing ran, so no result is written and the test stays to do.
      if (err?.code === 'SANDBOX_BUSY') {
        busy = true;
        break;
      }
      throw err;
    }
    durations.push(now().getTime() - t0);
    await writeJson(join(dir, `${t.id}.json`), res);
    results.push(res);
  }
  return { results, remaining: todo.length - results.length, skipped: tests.length - todo.length, busy };
}

const TOOL_SPEC = {
  'run-dir': { type: 'string', required: true },
  id: { type: 'string' },
  all: { type: 'boolean' },
  'max-seconds': { type: 'number' },
  rerun: { type: 'boolean' },
  json: { type: 'boolean' },
};

/**
 * The seconds a tool or flow test batch may use: `--max-seconds` (default 100), clamped to what is left of a hard-capped
 * tier's clock (state.json only). Past the cap it records the refusal and throws QaError TIME_BUDGET (3).
 */
export async function budgetSeconds(runDir, run, state, maxSeconds, now) {
  const want = maxSeconds ?? 100;
  const left = minutesLeft(run, state, now().getTime());
  if (left === Infinity) return want;
  // Less than one test's minimum left counts as past the cap: a test cut short would be saved as an error.
  if (left * 60000 < MIN_TEST_MS) {
    const tier = runTier(run, state);
    await pushHistory(runDir, 'time-budget', 'mechanics test refused', { now });
    throw new QaError('TIME_BUDGET', 3, `The ${tier.label} tier is past its ${tier.budgetMinutes}-minute cap; no further test runs`, 'Stop running tests. The report lists the remaining tests as not run.');
  }
  return Math.max(1, Math.min(want, Math.floor(left * 60)));
}

export function selectTests(plan, v) {
  if (v.id && v.all) throw new QaError('USAGE', 2, 'Pass --id or --all, not both');
  if (!v.id && !v.all) throw new QaError('USAGE', 2, 'Pass --id <testId> or --all');
  const tests = v.all ? plan.tests : plan.tests.filter((t) => t.id === v.id);
  if (tests.length === 0) throw new QaError('USAGE', 2, `Test ${v.id} is not in the plan`);
  return tests;
}

export async function cliToolTest(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, TOOL_SPEC);
    const runDir = resolveRunDir(io, v['run-dir']);
    const { state } = await assertGates(runDir, ['plan']);
    const run = await loadRun(runDir);
    const plan = await readJsonOr(join(runDir, 'plan', 'tool-tests.json'));
    const pv = plan ? validate('tool-tests', plan) : { ok: false, errors: ['plan/tool-tests.json is missing'] };
    if (!pv.ok) throw new QaError('USAGE', 2, `tool-tests plan is invalid: ${pv.errors[0]}`);
    const tests = selectTests(plan, v);
    const now = deps.now ?? (() => new Date());
    const dir = join(runDir, 'mechanics', 'tool-tests');
    const model = await readJsonOr(join(runDir, 'discovery', 'flow-model.json'));
    const sideEffectOf = (tool) => {
      for (const skill of model?.skills ?? []) {
        const hit = (skill.tools ?? []).find((x) => x?.name === tool);
        if (hit) return hit.sideEffect ?? 'unknown';
      }
      return 'unknown';
    };
    const batch = await runPlanned({
      tests, dir, maxSeconds: await budgetSeconds(runDir, run, state, v['max-seconds'], now), rerun: !!v.rerun, now,
      runOne: async (t, remainingMs) => {
        assertFakeInput(t.input, run, state);
        const argvT = ['test', '--ci', 'skill', '--name', t.tool, '--input', JSON.stringify(t.input ?? {}), '--json'];
        const res = await runLuaTest(run, argvT, { deadlineMs: now().getTime() + remainingMs, env: io.env, deps });
        const sideEffect = sideEffectOf(t.tool);
        if (sideEffect !== 'none') {
          await addLedger(runDir, {
            source: 'tool-call', kind: 'tool-test', expected: true, cleanup: 'manual',
            detail: `tool test ${t.id} ran ${t.tool} (side effect: ${sideEffect}) with real tool code; any platform or API call it makes is real`,
            cleanupHint: 'Check the systems this tool writes to and remove the test records by hand.',
          }, deps);
        }
        const infra = classifyLuaExit(res);
        const thrown = detectThrow(res);
        const judged = judgeToolTest(t, { exitCode: res.exitCode, threw: thrown.threw, stdout: res.stdout, infraError: infra ? infra.message : undefined });
        return {
          schema: 'lua-qa/tool-test-result@1', id: t.id, tool: t.tool, exitCode: res.exitCode, threw: thrown.threw,
          errorMessage: thrown.errorMessage, status: judged.status, reasons: judged.reasons, ms: res.ms,
          outputTail: tail(`${res.stdout}\n${res.stderr}`),
        };
      },
    });
    const failed = batch.results.filter((r) => r.status !== 'pass').length;
    emit(io, {
      ok: failed === 0, done: batch.results.length, remaining: batch.remaining, alreadyDone: batch.skipped, failed,
      ...(batch.busy ? { sandboxBusy: true, hint: 'A player held the sandbox; run the same command again for the remaining tests.' } : {}),
      results: batch.results.map((r) => ({ id: r.id, status: r.status, threw: r.threw, reasons: r.reasons })),
      note: 'Tool tests run the tool code locally; any platform API calls inside a tool are real. lua test exits 0 even when a tool throws, so the output is inspected.',
    });
    return failed > 0 ? 1 : 0;
  } catch (err) {
    return fail(io, err);
  }
}


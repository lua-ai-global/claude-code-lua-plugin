// Cleanup plan/apply. QA threads only: nothing that does not start with `qa-` is ever cleared.
// Cleanup runs AFTER the report data is aggregated, because clearing a thread destroys the evidence that
// contamination is checked against.
// Memory the user agreed to switch off for the test window is ALWAYS in the plan (restore-feature) until it is seen on
// again. The helper never switches a feature itself: --apply only re-reads the features and marks what is back on;
// the enable commands are the user's (an `ask` rule), whatever they decide about the threads.

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { emit, fail, parseArgs, readJsonOr, readJsonl, resolveRunDir, writeJson } from './io.mjs';
import { assertGates, loadRun } from './state.mjs';
import { runLua } from './spawn.mjs';
import { listLedger } from './ledger.mjs';
import { testSessionApi } from './recorder.mjs';
import { enableCommand, readFeatures, restorableFeatures } from './memory.mjs';

const QA_THREAD = /^qa-[A-Za-z0-9-]{1,61}$/;

async function subdirs(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export async function planCleanup(runDir) {
  const run = await loadRun(runDir);
  const state = await readJsonOr(join(runDir, 'state.json'));
  const actions = [];
  const restoredAt = state?.memoryRestore?.restoredAt ?? null;
  for (const name of restorableFeatures(state, await readJsonOr(join(runDir, 'discovery', 'features.json')))) {
    actions.push({ kind: 'restore-feature', target: name, status: restoredAt ? 'done' : 'planned', note: restoredAt ? `back on since ${restoredAt}` : `switched off for the test window: run ${enableCommand(name)}` });
  }
  const threads = new Set();
  const sessions = new Set();
  for (const card of await subdirs(join(runDir, 'runs'))) {
    for (const r of await subdirs(join(runDir, 'runs', card))) {
      const dir = join(runDir, 'runs', card, r);
      const rec = await readJsonOr(join(dir, 'run-record.json'));
      if (rec?.thread) threads.add(rec.thread);
      if (rec?.testSessionId && rec.status === 'running') sessions.add(rec.testSessionId);
      for (const row of await readJsonl(join(dir, 'turns.jsonl'))) if (row.thread) threads.add(row.thread);
    }
  }
  const stress = await readJsonOr(join(runDir, 'mechanics', 'stress', 'threads.json'));
  for (const t of stress?.threads ?? []) threads.add(t);
  if (stress?.sessionId) sessions.add(stress.sessionId);
  for (const t of [...threads].sort()) {
    actions.push({ kind: 'clear-thread', target: t, status: QA_THREAD.test(t) ? 'planned' : 'skipped', note: QA_THREAD.test(t) ? 'QA thread' : 'not a qa- thread: never cleared' });
  }
  for (const s of [...sessions].sort()) actions.push({ kind: 'close-test-session', target: s, status: 'planned', note: 'test session still open' });
  const owner = await readJsonOr(join(run.projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock', 'owner.json'));
  if (owner && owner.runId === run.runId) {
    actions.push({ kind: 'remove-lock', target: join(run.projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock'), status: 'planned', note: 'lock left by this run' });
  }
  for (const row of await listLedger(runDir)) {
    if (row.cleanup === 'manual') actions.push({ kind: 'manual', target: row.id, status: 'planned', note: row.cleanupHint ?? row.detail });
  }
  // Carry over what an earlier (partial) apply already finished.
  const prior = await readJsonOr(join(runDir, 'cleanup.json'));
  const done = new Set((prior?.actions ?? []).filter((a) => a.status === 'done').map((a) => `${a.kind}:${a.target}`));
  for (const a of actions) if (done.has(`${a.kind}:${a.target}`)) a.status = 'done';
  return { schema: 'lua-qa/cleanup@1', applied: false, actions };
}

export async function applyCleanup(runDir, plan, deps = {}, { cwd, env, deadlineMs = Infinity } = {}) {
  const run = await loadRun(runDir);
  const now = deps.now ?? (() => new Date());
  for (const a of plan.actions) {
    if (a.status === 'done' || a.status === 'skipped') continue;
    if (now().getTime() > deadlineMs) break;
    try {
      if (a.kind === 'clear-thread') {
        if (!QA_THREAD.test(a.target)) {
          a.status = 'skipped';
          a.note = 'not a qa- thread: never cleared';
          continue;
        }
        const res = await runLua(['chat', 'clear', '-t', a.target, '--force'], { cwd: cwd ?? run.projectDir, timeoutMs: 20_000, env, deps });
        a.status = res.exitCode === 0 && !res.timedOut ? 'done' : 'failed';
        if (a.status === 'failed') a.note = `lua chat clear exited with code ${res.exitCode}`;
      } else if (a.kind === 'close-test-session') {
        await testSessionApi.close(run.agent.id, run.environment.agentVersion, a.target, deps, 15_000);
        a.status = 'done';
      } else if (a.kind === 'restore-feature') {
        // Never enabled here: the read only confirms the user's own enable command took effect.
        const read = await readFeatures({ projectDir: cwd ?? run.projectDir, deps, timeoutMs: 20_000 });
        const on = read.ok && read.features.some((f) => f.name === a.target && f.active === true);
        if (on) a.status = 'done';
        else a.note = `still off: run ${enableCommand(a.target)} (it asks for your approval), then memory --check restored`;
      } else if (a.kind === 'remove-lock') {
        await rm(a.target, { recursive: true, force: true });
        a.status = 'done';
      } else {
        a.status = 'skipped';
        a.note = `${a.note} (manual: do this by hand)`.slice(0, 300);
      }
    } catch (err) {
      a.status = 'failed';
      a.note = String(err.message ?? err).slice(0, 200);
    }
  }
  plan.applied = true;
  return plan;
}

export async function cliCleanup(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, {
      'run-dir': { type: 'string', required: true }, apply: { type: 'boolean' },
      'production-consent': { type: 'string' }, json: { type: 'boolean' },
    });
    const runDir = resolveRunDir(io, v['run-dir']);
    const plan = await planCleanup(runDir);
    if (v.apply) {
      await assertGates(runDir, ['environment'], { consent: v['production-consent'], requireConsent: true });
      const now = deps.now ?? (() => new Date());
      await applyCleanup(runDir, plan, deps, { env: io.env, deadlineMs: now().getTime() + 75_000 });
    }
    await writeJson(join(runDir, 'cleanup.json'), plan);
    const count = (s) => plan.actions.filter((a) => a.status === s).length;
    const restore = plan.actions.filter((a) => a.kind === 'restore-feature' && a.status !== 'done').map((a) => a.target);
    emit(io, {
      ok: true, applied: plan.applied, planned: count('planned'), done: count('done'), failed: count('failed'), skipped: count('skipped'),
      manual: plan.actions.filter((a) => a.kind === 'manual').length,
      hint: restore.length
        ? `Agent memory is still switched off: run the memoryRestore commands, then memory --check restored.${v.apply && count('planned') > restore.length ? ' Then run cleanup --apply again to finish the remaining actions.' : ''}`
        : v.apply ? (count('planned') ? 'Run cleanup --apply again to finish the remaining actions.' : 'Cleanup finished.') : 'Plan only. Add --apply to execute it.',
      ...(restore.length ? { memoryRestore: { pending: restore, commands: restore.map(enableCommand), then: 'memory --run-dir <runDir> --check restored', hint: 'Agent memory is still switched off: restore it now, whatever you decide about the threads.' } } : {}),
    });
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

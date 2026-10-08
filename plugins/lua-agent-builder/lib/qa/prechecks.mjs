// Runs contamination + readability + claims for one run and writes checks/*.
// Readability and claims hits are CANDIDATES for the grader. Only CONTAMINATED voids a run.
// First, turns recorded without tool calls get them from the skill logs (tool-logs.mjs), so claims, contamination and
// the side-effect ledger see real calls. A logs failure never fails the prechecks: those turns stay unverifiable.

import { join, relative } from 'node:path';
import { emit, fail, parseArgs, readJson, resolveRunDir, writeJson } from './io.mjs';
import { SELECTOR_FLAGS, loadRecord } from './recorder.mjs';
import { checkContamination } from './contamination.mjs';
import { readabilityForRun } from './readability.mjs';
import { claimsForRun } from './claims.mjs';
import { fillToolCallsFromLogs } from './tool-logs.mjs';

export async function runPrechecks({ runDir, cardId, k, attempt = 1, technical, env = process.env, deps = {}, fillTools = true }) {
  let toolLogs = null;
  if (fillTools) {
    const { paths } = await loadRecord(runDir, { card: cardId, run: k, attempt });
    const folder = relative(runDir, paths.dir).replace(/\\/g, '/');
    try {
      toolLogs = await fillToolCallsFromLogs({ runDir, folders: [folder], env, deps });
    } catch (err) {
      toolLogs = { status: 'error', filled: 0, notes: [`${err.code ?? 'ERROR'}: ${err.message}`] };
    }
  }
  const contamination = await checkContamination({ runDir, cardId, k, attempt, deps });
  const rd = await readabilityForRun({ runDir, cardId, k, attempt, technical });
  const cl = await claimsForRun({ runDir, cardId, k, attempt });
  const { paths } = rd;
  await writeJson(join(paths.checks, 'contamination.json'), contamination);
  await writeJson(join(paths.checks, 'readability.json'), rd.result);
  await writeJson(join(paths.checks, 'claims.json'), cl.result);
  const rec = await readJson(paths.record);
  rec.checks = {
    contamination: contamination.status,
    readabilityFails: rd.result.fails,
    claimsUnbacked: cl.result.total,
    claimsStatus: cl.result.status,
  };
  await writeJson(paths.record, rec);
  let exitCode = 0;
  if (contamination.status === 'CONTAMINATED') exitCode = 3;
  else if (rd.result.fails + cl.result.total > 0) exitCode = 1;
  return { contamination, readability: rd.result, claims: cl.result, toolLogs, exitCode };
}

export async function cliPrechecks(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, { ...SELECTOR_FLAGS, technical: { type: 'boolean' } });
    const runDir = resolveRunDir(io, v['run-dir']);
    await loadRecord(runDir, { card: v.card, run: v.run, attempt: v.attempt });
    const out = await runPrechecks({
      runDir, cardId: v.card, k: v.run, attempt: v.attempt ?? 1, technical: v.technical ? true : undefined, env: io.env, deps,
    });
    const tl = out.toolLogs;
    emit(io, {
      ok: out.exitCode === 0,
      ...(out.exitCode === 3 ? { code: 'CONTAMINATED', message: 'The run is contaminated and counts as VOID', hint: 'Retry the card as a new attempt.' } : {}),
      contamination: out.contamination.status,
      contaminationReasons: out.contamination.reasons,
      readabilityFails: out.readability.fails,
      slowTurns: out.readability.slowTurns,
      claimsUnbacked: out.claims.total,
      claimsConfirmed: out.claims.confirmedUnbacked,
      claimsStatus: out.claims.status,
      toolLogs: { status: tl.status, filled: tl.filled, ...(tl.notes?.length ? { notes: tl.notes.slice(0, 5) } : {}) },
      candidates: 'Readability and claims hits are candidates; the grader confirms or dismisses each one.',
    });
    return out.exitCode;
  } catch (err) {
    return fail(io, err);
  }
}

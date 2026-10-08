// Test helper: seeds a run folder (run-record + turns.jsonl) without going through the recorder.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scaffoldRun, wj } from './runtime-helpers.mjs';

export const TH = 'qa-9f3c-icp-01-r1-cdcdcd';
export const PLAYER = 'icp-01-r1-cdcdcd';

export function recordJson(over = {}) {
  return {
    schema: 'lua-qa/run-record@1', runId: '20261007-141502-9f3c', cardId: 'icp-01', kind: 'icp', k: 1, attempt: 1,
    folder: join('runs', 'icp-01', 'r1'), thread: TH, player: PLAYER, model: 'sonnet',
    environment: { kind: 'sandbox', agentVersion: null, testSession: null }, testSessionId: null,
    startedAt: '2026-10-07T14:20:00.000Z', endedAt: null, status: 'running', abortReason: null, turns: 0,
    checks: { contamination: null, readabilityFails: 0, claimsUnbacked: 0, claimsStatus: null },
    verdict: null, safety: false, majors: [], sideEffectRefs: [],
    ...over,
  };
}

export function turnRow(n, over = {}) {
  return {
    schema: 'lua-qa/turn@1', turn: n, at: '2026-10-07T14:20:00.000Z', endedAt: '2026-10-07T14:20:06.000Z', seconds: 6,
    runId: '20261007-141502-9f3c', cardId: 'icp-01', k: 1, thread: TH, player: PLAYER,
    env: { kind: 'sandbox', agentVersion: null, testSession: false },
    user: `message ${n}`, reply: `Sure, I can help with that request number ${n}.`, streamed: null,
    postprocessed: false, preprocessorBlocked: false, batchHandled: false, exitCode: 0, error: null,
    toolCalls: [], toolCallSource: 'history', effects: null, redactions: [],
    ...over,
  };
}

/** Scaffolds a run and seeds icp-01 r1 with the given rows. Returns { runDir, projectDir, dir }. */
export async function seeded({ rows = [turnRow(1)], rec = {}, scaffold = {} } = {}) {
  const s = await scaffoldRun(scaffold);
  const dir = join(s.runDir, 'runs', 'icp-01', 'r1');
  await mkdir(dir, { recursive: true });
  await wj(join(dir, 'run-record.json'), recordJson(rec));
  await writeFile(join(dir, 'turns.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  return { ...s, dir };
}

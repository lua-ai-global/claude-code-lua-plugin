// Side-effect ledger: one JSONL row per real or recorded outside-world effect.

import { join } from 'node:path';
import { QaError, appendJsonl, emit, fail, parseArgs, readJsonl, resolveRunDir } from './io.mjs';
import { redactSecrets } from './safety.mjs';
import { validate } from './schemas.mjs';

export const LEDGER_SOURCES = ['test-session-effect', 'tool-call', 'player-report', 'workflow-test', 'stress', 'cleanup'];

export async function listLedger(runDir) {
  return readJsonl(join(runDir, 'ledger.jsonl'));
}

/**
 * Assigns the next id (L-0001...), redacts the detail, validates and appends.
 * @returns {Promise<object>} the stored row
 */
export async function addLedger(runDir, row, deps = {}) {
  const existing = await listLedger(runDir);
  const id = `L-${String(existing.length + 1).padStart(4, '0')}`;
  const stored = {
    schema: 'lua-qa/ledger@1',
    id,
    at: (deps.now ?? (() => new Date()))().toISOString(),
    source: row.source,
    runRef: row.runRef ?? null,
    turn: row.turn ?? null,
    kind: String(row.kind ?? 'unknown').slice(0, 120),
    detail: redactSecrets(String(row.detail ?? '')).text.slice(0, 300),
    expected: row.expected ?? null,
    reversible: row.reversible ?? null,
    cleanup: row.cleanup ?? 'none',
    cleanupHint: row.cleanupHint ?? null,
    ...(row.callRef ? { callRef: String(row.callRef).slice(0, 200) } : {}),
  };
  const v = validate('ledger', stored);
  if (!v.ok) throw new QaError('USAGE', 2, `invalid ledger row: ${v.errors.slice(0, 2).join('; ')}`);
  await appendJsonl(join(runDir, 'ledger.jsonl'), stored);
  return stored;
}

/** Tool name -> declared side effect ('none' | 'likely' | 'unknown' ...) from discovery/flow-model.json. */
export function sideEffectTools(model) {
  const map = new Map();
  for (const s of model?.skills ?? []) for (const t of s.tools ?? []) map.set(t.name, t.sideEffect ?? 'unknown');
  return map;
}

/**
 * One `tool-call` ledger row per call whose tool has a side effect. Calls that carry an executionId (logged calls)
 * get a callRef, and a callRef already in the ledger is skipped, so prechecks and backfill can run again safely.
 * @returns {Promise<string[]>} the new ledger ids
 */
export async function ledgerToolCalls(runDir, { runRef, turn, calls, model, testSession = false }, deps = {}) {
  const sideTools = sideEffectTools(model);
  const known = new Set((await listLedger(runDir)).map((r) => r.callRef).filter(Boolean));
  const ids = [];
  for (const c of calls ?? []) {
    const se = sideTools.get(c?.name);
    if (!se || se === 'none') continue;
    const callRef = c.executionId ? `${runRef}#${turn}#${c.executionId}` : null;
    if (callRef && known.has(callRef)) continue;
    const via = c.executionId ? ' (from logs)' : '';
    const led = await addLedger(runDir, {
      source: 'tool-call', runRef, turn, kind: c.name, detail: `tool call${via} (side effect: ${se}) status ${c.status}`,
      expected: null, reversible: null, cleanup: testSession ? 'none' : 'manual',
      cleanupHint: testSession ? null : 'Check the outside system and undo the change if it is real.',
      callRef,
    }, deps);
    if (callRef) known.add(callRef);
    ids.push(led.id);
  }
  return ids;
}

export async function cliLedger(argv, io, deps = {}) {
  try {
    const sub = argv[0];
    if (sub === 'list') {
      const { values } = parseArgs(argv.slice(1), { 'run-dir': { type: 'string', required: true }, json: { type: 'boolean' } });
      const rows = await listLedger(resolveRunDir(io, values['run-dir']));
      emit(io, { ok: true, count: rows.length, rows });
      return 0;
    }
    if (sub === 'add') {
      const { values: v } = parseArgs(argv.slice(1), {
        'run-dir': { type: 'string', required: true },
        source: { type: 'string', required: true, choices: LEDGER_SOURCES },
        kind: { type: 'string', required: true },
        detail: { type: 'string', required: true },
        'run-ref': { type: 'string' },
        turn: { type: 'number' },
        expected: { type: 'string', choices: ['true', 'false'] },
        json: { type: 'boolean' },
      });
      const row = await addLedger(resolveRunDir(io, v['run-dir']), {
        source: v.source, kind: v.kind, detail: v.detail, runRef: v['run-ref'] ?? null, turn: v.turn ?? null,
        expected: v.expected === undefined ? null : v.expected === 'true',
      }, deps);
      emit(io, { ok: true, row });
      return 0;
    }
    throw new QaError('USAGE', 2, 'ledger needs a subcommand: list | add', 'ledger --run-dir D list');
  } catch (err) {
    return fail(io, err);
  }
}


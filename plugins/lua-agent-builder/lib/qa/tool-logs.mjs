// Tool calls from the agent's skill logs.
//
// The thread-history route does not return tool calls in sandbox (every recorded turn came back
// `toolCallSource: "unavailable"`), so they are read from `lua logs --type skill` instead. Verified row shape:
//   { timestamp, subType: 'debug'|'info'|'warn'|'error', message, metadata: { toolName, toolId, primitiveName,
//     environment, executionId, executionSeq, userId, agentId, channel, runId? } }
// with messages 'Calling tool with input {json}', 'Tool result {json}', 'Execute function completed in N ms' and
// the tool's own console lines. Skill rows carry no thread id. In sandbox, chats are serialised by the per-project
// lock, so a turn's chat window identifies its calls; every run in the runDir is indexed so a call is given to the
// turn whose window holds it, not to a neighbour whose padding overlaps.
//
// Calls are filled lazily (prechecks, backfill-tools): right after a turn its logs may not be ingested yet, and one
// query per run keeps well under the logs rate limit (120 calls a minute per key).

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { QaError, emit, fail, parseArgs, readJson, readJsonOr, readJsonl, resolveRunDir, runFolderRel, writeJson, writeText } from './io.mjs';
import { loadRun } from './state.mjs';
import { scanWindow } from './log-scan.mjs';
import { redactDeep, redactSecrets } from './safety.mjs';
import { ledgerToolCalls } from './ledger.mjs';
import { renderTranscriptTurn } from './recorder.mjs';

export const PAD_BEFORE_MS = 2000;
export const PAD_AFTER_MS = 5000;
/** Logs are read only once the newest window end is this old, so late-ingested rows are not missed. */
export const SETTLE_MS = 10_000;
// Settle wait + scan deadline (+ one in-flight call) stay well inside the 110 s CLI budget prechecks also needs.
const MAX_SETTLE_WAIT_MS = 15_000;
const SCAN_BUDGET_MS = 35_000;
/** Run windows closer than this are fetched with one query. */
const MERGE_GAP_MS = 30_000;
export const LOGS_SOURCES = Object.freeze(['logs-window', 'logs-runid']);

const CALL_RE = /^\s*Calling tool with input\s*/i;
const RESULT_RE = /^\s*Tool result\s*/i;
const DONE_RE = /^\s*Execute function completed in\s*(\d+(?:\.\d+)?)\s*ms/i;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseLoose(text) {
  const s = String(text ?? '').trim();
  try {
    return JSON.parse(s);
  } catch {
    return s.slice(0, 4000);
  }
}

const metaOf = (r) => (r?.metadata && typeof r.metadata === 'object' ? r.metadata : {});
const tsOf = (r) => Date.parse(r?.timestamp ?? r?.createdAt ?? '');

/** A tool result that reports a failure in its own payload ({status:'error'}, {error}, {sent:false} ...). */
export function resultFailed(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  if (output.status === 'error' || output.error) return true;
  return ['success', 'ok', 'sent'].some((k) => output[k] === false);
}

/**
 * Groups skill log rows into tool calls ({name, input, output, status} plus skill, executionId, at, warnings, errors).
 * Rows of another environment or agent are dropped (a row with no environment reads as production, as in lua-cli).
 * @returns {{calls:object[], rawRows:number, keptRows:number}}
 */
export function callsFromLogRows(rows, { environment = null, agentId = null } = {}) {
  const kept = (rows ?? []).filter((r) => {
    const m = metaOf(r);
    if (!m.toolName) return false;
    if (environment && (m.environment ?? r.environment ?? 'production') !== environment) return false;
    const a = m.agentId ?? r.agentId;
    return !(agentId && a && a !== agentId);
  });
  // Rows without a readable time sort last (Infinity - Infinity is NaN, which falls through to the next key).
  const sorted = kept.map((r, i) => ({ r, i, t: Number.isFinite(tsOf(r)) ? tsOf(r) : Infinity, seq: Number(metaOf(r).executionSeq) }))
    .sort((x, y) => (x.t - y.t) || ((Number.isFinite(x.seq) && Number.isFinite(y.seq)) ? x.seq - y.seq : 0) || x.i - y.i);
  const groups = new Map();
  const loose = new Map();
  for (const { r, t } of sorted) {
    const m = metaOf(r);
    const msg = String(r.message ?? r.content ?? '');
    let key;
    if (m.executionId) key = `x:${m.executionId}`;
    else {
      const tool = `${m.toolName}:${m.toolId ?? ''}`;
      if (CALL_RE.test(msg) || !loose.has(tool)) loose.set(tool, (loose.get(tool) ?? 0) + 1);
      key = `t:${tool}:${loose.get(tool)}`;
    }
    let g = groups.get(key);
    if (!g) {
      g = {
        name: String(m.toolName), skill: m.primitiveName ? String(m.primitiveName) : null, executionId: m.executionId ? String(m.executionId) : null,
        input: null, output: null, status: 'unknown', at: Number.isFinite(t) ? new Date(t).toISOString() : null, durationMs: null,
        warnings: [], errors: [], runId: m.runId ? String(m.runId) : null, channel: m.channel ? String(m.channel) : null,
        hasResult: false,
      };
      groups.set(key, g);
    }
    const sub = String(r.subType ?? '').toLowerCase();
    const done = DONE_RE.exec(msg);
    if (CALL_RE.test(msg)) g.input = parseLoose(msg.replace(CALL_RE, ''));
    else if (RESULT_RE.test(msg)) {
      g.output = parseLoose(msg.replace(RESULT_RE, ''));
      g.hasResult = true;
    } else if (done) g.durationMs = Number(done[1]);
    else if (sub === 'error') g.errors.push(msg.slice(0, 500));
    else if (sub === 'warn' || sub === 'warning') g.warnings.push(msg.slice(0, 500));
  }
  const calls = [...groups.values()].map(({ hasResult, ...c }) => {
    if (c.errors.length || resultFailed(c.output)) c.status = 'error';
    else if (hasResult) c.status = 'ok';
    return c;
  });
  return { calls, rawRows: (rows ?? []).length, keptRows: kept.length };
}

/** The window a turn's calls fall in: the chat process when it was recorded (exact), else the whole turn. */
export function turnWindow(row) {
  const exact = !!(row?.chatAt && row?.chatEndedAt);
  const start = Date.parse(exact ? row.chatAt : row?.at);
  const end = Date.parse(exact ? row.chatEndedAt : row?.endedAt);
  return { start, end, exact };
}

/**
 * Gives each call to one turn. A call inside exactly one window goes there; inside several, an exact window wins,
 * else the narrowest (the others include a lock wait) and the call is marked ambiguous. A call only inside a padded
 * window goes to the nearest turn, marked padded. Calls that match a turn's platformRunId go there directly.
 * @param {{key:string, start:number, end:number, exact:boolean, platformRunId?:string|null}[]} windows
 * @returns {Map<string, object[]>} key -> calls (each with `ambiguous` and `padded` flags)
 */
export function attributeCalls(calls, windows, { padBeforeMs = PAD_BEFORE_MS, padAfterMs = PAD_AFTER_MS } = {}) {
  const out = new Map();
  const put = (key, call) => {
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(call);
  };
  const valid = windows.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
  for (const call of calls) {
    const byRun = call.runId ? valid.find((w) => w.platformRunId && w.platformRunId === call.runId) : null;
    if (byRun) {
      put(byRun.key, { ...call, matchedBy: 'runId', ambiguous: false, padded: false });
      continue;
    }
    const t = Date.parse(call.at ?? '');
    if (!Number.isFinite(t)) continue;
    const inside = valid.filter((w) => w.start <= t && t <= w.end);
    if (inside.length) {
      const exact = inside.filter((w) => w.exact);
      const pool = exact.length ? exact : inside;
      const best = pool.reduce((a, b) => ((b.end - b.start) < (a.end - a.start) ? b : a));
      put(best.key, { ...call, matchedBy: 'window', ambiguous: pool.length > 1, padded: false });
      continue;
    }
    const near = valid.filter((w) => w.start - padBeforeMs <= t && t <= w.end + padAfterMs);
    if (!near.length) continue;
    const dist = (w) => (t < w.start ? w.start - t : t - w.end);
    const best = near.reduce((a, b) => (dist(b) < dist(a) ? b : a));
    put(best.key, { ...call, matchedBy: 'window', ambiguous: near.length > 1, padded: true });
  }
  return out;
}

/** Every run folder under runs/ that has a run record: [{folder, dir, status}]. */
export async function listRunFolders(runDir) {
  const out = [];
  const base = join(runDir, 'runs');
  let cards = [];
  try {
    cards = (await readdir(base)).sort();
  } catch {
    return out;
  }
  for (const card of cards) {
    let runs = [];
    try {
      runs = (await readdir(join(base, card))).sort();
    } catch {
      continue;
    }
    for (const r of runs) {
      const dir = join(base, card, r);
      const rec = await readJsonOr(join(dir, 'run-record.json'));
      if (rec) out.push({ folder: join('runs', card, r).replace(/\\/g, '/'), dir, status: rec.status ?? null });
    }
  }
  return out;
}

/** Merges [start, end] windows that overlap or sit within MERGE_GAP_MS of each other. */
export function mergeWindows(spans, gapMs = MERGE_GAP_MS) {
  const sorted = spans.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end)).sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + gapMs) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

const iso = (ms) => new Date(ms).toISOString();

function redactCalls(calls) {
  const kinds = redactSecrets(JSON.stringify(calls)).redactions.map((x) => ({ field: 'toolCalls', kind: x.kind }));
  return { calls: redactDeep(calls), redactions: kinds };
}

/**
 * Fills toolCalls from the skill logs for turns that have none (`unavailable`), or refreshes logs-sourced ones when
 * `refresh` is set. Turns with history or test-session calls are never touched. Zero calls is written only after a
 * readable, complete query (nothing truncated, rows not all filtered away); otherwise the turn stays `unavailable`.
 * @param {{runDir:string, folders?:string[]|null, refresh?:boolean, env?:object, deps?:object}} opts
 *   folders: run folders (relative, e.g. runs/icp-01/r1) to fill; null = every run.
 */
export async function fillToolCallsFromLogs({ runDir, folders = null, refresh = false, env = process.env, deps = {} }) {
  const run = await loadRun(runDir);
  const kind = run.environment?.kind;
  if (kind !== 'sandbox') {
    return { status: 'skipped', reason: `logs attribution needs the sandbox chat lock; this run is ${kind}`, filled: 0, runs: [] };
  }
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const environment = run.environment.logEnvironment ?? 'sandbox';
  const all = [];
  for (const f of await listRunFolders(runDir)) {
    all.push({ ...f, rows: await readJsonl(join(f.dir, 'turns.jsonl')) });
  }
  const want = folders ? new Set(folders.map((x) => x.replace(/\\/g, '/'))) : null;
  // History and test-session calls are never replaced; logs-sourced ones only on refresh.
  const isTarget = (row) => {
    const src = row.toolCallSource ?? 'unavailable';
    return src === 'unavailable' || (refresh && LOGS_SOURCES.includes(src));
  };
  // Without an explicit selection a run that is still recording is left alone (its file is being appended to).
  const targets = all.filter((f) => (want ? want.has(f.folder) : f.status !== 'running'))
    .map((f) => ({ ...f, todo: f.rows.filter(isTarget) }))
    .filter((f) => f.todo.length);
  if (!targets.length) return { status: 'nothing-to-fill', filled: 0, runs: [] };

  const windows = all.flatMap((f) => f.rows.map((row) => ({
    key: `${f.folder}#${row.turn}`, ...turnWindow(row), platformRunId: row.platformRunId ?? null,
  })));
  const spans = targets.flatMap((f) => f.todo.map((row) => turnWindow(row))).map((w) => ({ start: w.start - PAD_BEFORE_MS, end: w.end + PAD_AFTER_MS }));
  const clusters = mergeWindows(spans);
  if (!clusters.length) return { status: 'nothing-to-fill', filled: 0, runs: [], reason: 'no turn has a readable time window' };

  const newest = Math.max(...clusters.map((c) => c.end));
  const settle = newest + SETTLE_MS - now().getTime();
  if (settle > 0) await sleep(Math.min(settle, MAX_SETTLE_WAIT_MS));
  const cutoff = now().getTime() - SETTLE_MS;

  const deadlineMs = now().getTime() + SCAN_BUDGET_MS;
  const good = [];
  const notes = [];
  let rawRows = 0;
  let keptRows = 0;
  const calls = [];
  for (const c of clusters) {
    const since = iso(c.start);
    const until = iso(c.end);
    let res;
    try {
      res = await scanWindow({ since, until, environment, cwd: run.projectDir, env, deps, deadlineMs, type: 'skill', limit: 200 });
    } catch (err) {
      notes.push(`${since}..${until}: ${err.code ?? 'ERROR'} ${err.message}`);
      continue;
    }
    const parsed = callsFromLogRows(res.rows, { environment, agentId: run.agent?.id ?? null });
    rawRows += parsed.rawRows;
    keptRows += parsed.keptRows;
    calls.push(...parsed.calls);
    if (res.truncatedWindows.length || res.unreadWindows.length) {
      notes.push(`${since}..${until}: ${res.truncatedWindows.length ? 'truncated' : 'unreadable output'}; turns there stay unavailable`);
      continue;
    }
    if (parsed.rawRows > 0 && parsed.keptRows === 0) {
      notes.push(`${since}..${until}: ${parsed.rawRows} rows but none for agent ${run.agent?.id} in ${environment}; turns there stay unavailable`);
      continue;
    }
    good.push(c);
  }

  const assigned = attributeCalls(calls, windows);
  // A call no turn window took (clock skew, a gap between turns, a turn not written yet) may belong to a target
  // turn: turns in that query window still get their calls, but a zero-call result there is not proof of none.
  const taken = new Set([...assigned.values()].flat().map((c) => `${c.executionId}|${c.at}`));
  const unattributed = calls.filter((c) => !taken.has(`${c.executionId}|${c.at}`));
  const strayIn = (from, to) => {
    const cl = good.find((c) => c.start <= from && to <= c.end);
    return cl ? unattributed.filter((c) => { const t = Date.parse(c.at ?? ''); return !Number.isFinite(t) || (cl.start <= t && t <= cl.end); }).length : 0;
  };
  const model = await readJsonOr(join(runDir, 'discovery', 'flow-model.json'), null);
  const runs = [];
  let filled = 0;
  for (const f of targets) {
    let changed = 0;
    let nCalls = 0;
    let ambiguous = 0;
    const ledgerIds = [];
    for (const row of f.todo) {
      const w = turnWindow(row);
      const from = w.start - PAD_BEFORE_MS;
      const to = w.end + PAD_AFTER_MS;
      if (!good.some((c) => c.start <= from && to <= c.end) || to > cutoff) continue;
      const mine = assigned.get(`${f.folder}#${row.turn}`) ?? [];
      const red = redactCalls(mine);
      row.toolCalls = red.calls;
      row.toolCallSource = mine.length && mine.every((c) => c.matchedBy === 'runId') ? 'logs-runid' : 'logs-window';
      row.toolCallWindow = { since: iso(from), until: iso(to), exact: w.exact, ambiguous: mine.filter((c) => c.ambiguous).length, unattributed: strayIn(from, to) };
      row.redactions = [...(row.redactions ?? []).filter((r) => r.field !== 'toolCalls'), ...red.redactions];
      changed++;
      nCalls += mine.length;
      ambiguous += row.toolCallWindow.ambiguous;
      ledgerIds.push(...await ledgerToolCalls(runDir, { runRef: f.folder, turn: row.turn, calls: row.toolCalls, model, testSession: false }, deps));
    }
    if (changed) {
      await writeText(join(f.dir, 'turns.jsonl'), f.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      await writeText(join(f.dir, 'transcript.md'), f.rows.map((r) => renderTranscriptTurn(r)).join(''));
      if (ledgerIds.length) {
        const rec = await readJson(join(f.dir, 'run-record.json'));
        rec.sideEffectRefs = [...(rec.sideEffectRefs ?? []), ...ledgerIds];
        await writeJson(join(f.dir, 'run-record.json'), rec);
      }
    }
    filled += changed;
    runs.push({ folder: f.folder, filled: changed, pending: f.todo.length - changed, calls: nCalls, ambiguous, ledger: ledgerIds });
  }
  const pending = runs.reduce((n, r) => n + r.pending, 0);
  return {
    status: pending === 0 ? 'filled' : filled ? 'partial' : 'unavailable',
    filled, pending, rawRows, keptRows, unattributed: unattributed.length, queries: clusters.length, notes, runs,
  };
}

// ---------------------------------------------------------------- backfill-tools

const BACKFILL_SPEC = {
  'run-dir': { type: 'string', required: true },
  card: { type: 'string' },
  run: { type: 'number' },
  attempt: { type: 'number' },
  refresh: { type: 'boolean' },
  'no-prechecks': { type: 'boolean' },
  json: { type: 'boolean' },
};

/**
 * backfill-tools --run-dir D [--card C --run K [--attempt N]] [--refresh] [--no-prechecks]
 * Fills toolCalls from the logs for runs recorded before the logs source existed, then re-runs their prechecks.
 */
export async function cliBackfillTools(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, BACKFILL_SPEC);
    const runDir = resolveRunDir(io, v['run-dir']);
    if ((v.card === undefined) !== (v.run === undefined)) throw new QaError('USAGE', 2, 'Pass --card and --run together, or neither (every run)');
    let selected = null;
    if (v.card !== undefined) {
      const folder = runFolderRel(v.card, v.run, v.attempt ?? 1).replace(/\\/g, '/');
      if (!await readJsonOr(join(runDir, folder, 'run-record.json'))) {
        throw new QaError('NO_RUN_RECORD', 2, `No run record for ${v.card} run ${v.run}`, 'Check --card, --run and --attempt.');
      }
      selected = [folder];
    }
    const fill = await fillToolCallsFromLogs({ runDir, folders: selected, refresh: !!v.refresh, env: io.env, deps });
    const prechecks = [];
    if (!v['no-prechecks'] && fill.filled > 0) {
      const { runPrechecks } = await import('./prechecks.mjs');
      for (const r of fill.runs.filter((x) => x.filled > 0)) {
        const rec = await readJson(join(runDir, r.folder, 'run-record.json'));
        const out = await runPrechecks({ runDir, cardId: rec.cardId, k: rec.k, attempt: rec.attempt ?? 1, env: io.env, deps, fillTools: false });
        prechecks.push({ folder: r.folder, exitCode: out.exitCode, contamination: out.contamination.status, claimsUnbacked: out.claims.total, claimsStatus: out.claims.status });
      }
    }
    emit(io, { ok: fill.status !== 'unavailable', ...fill, prechecks });
    return fill.status === 'unavailable' ? 5 : 0;
  } catch (err) {
    return fail(io, err);
  }
}

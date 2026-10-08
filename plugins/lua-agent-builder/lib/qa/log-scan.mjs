// Window-bounded log scan. The scan covers only the test window, so unrelated platform
// noise is never blamed on the agent. A full page (100 rows) is bisected so nothing is silently cut off.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { QaError, emit, fail, parseArgs, readJsonOr, resolveRunDir, writeJson } from './io.mjs';
import { assertGates, computePlanHash, loadRun } from './state.mjs';
import { runLua, classifyLuaExit } from './spawn.mjs';
import { redactSecrets } from './safety.mjs';
import { parseJsonLoose } from './tool-test.mjs';

const PAGE = 100;
const MAX_DEPTH = 6;

/** The row array of a logs envelope, or null when the output is not a recognisable logs payload. */
function rowsOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  for (const key of ['data', 'logs', 'rows', 'items']) if (Array.isArray(parsed?.[key])) return parsed[key];
  for (const key of ['logs', 'data', 'items']) if (Array.isArray(parsed?.data?.[key])) return parsed.data[key];
  return null;
}

/** True when the envelope says there is more than this page (a server-side cap below --limit is caught too). */
export function hasMorePages(parsed) {
  const p = parsed?.pagination ?? parsed?.data?.pagination ?? null;
  if (p && (p.hasNextPage === true || (Number(p.totalPages) > 1))) return true;
  const cursor = parsed?.nextCursor ?? parsed?.data?.nextCursor;
  return cursor !== undefined && cursor !== null && cursor !== '';
}

const RATE_RE = /\b429\b|rate.?limit|too many requests/i;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One `lua logs` call, retried with backoff (2 s, 4 s, 8 s) while the platform answers 429 (120 calls/min per key),
 * never past `deadlineMs`.
 */
export async function fetchLogsPage({ type, limit, since, until, environment, cwd, env, deps = {}, deadlineMs = Infinity }) {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const res = await runLua(['logs', '--ci', '--type', type, '--since', since, '--until', until, '--environment', environment, '--limit', String(limit), '--json'], {
      cwd, timeoutMs: 20_000, env, deps,
    });
    const infra = classifyLuaExit(res);
    if (infra) throw infra;
    if (res.exitCode !== 0) {
      const wait = 2000 * 2 ** attempt;
      if (RATE_RE.test(`${res.stdout}\n${res.stderr}`) && attempt < 3 && now().getTime() + wait < deadlineMs) {
        await sleep(wait);
        continue;
      }
      throw new QaError(RATE_RE.test(`${res.stdout}\n${res.stderr}`) ? 'LUA_LOGS_RATE_LIMITED' : 'LUA_LOGS_FAILED', 5,
        `lua logs exited with code ${res.exitCode}`, 'Check the credential and the agent id, then retry (logs allow 120 calls a minute).');
    }
    const parsed = parseJsonLoose(res.stdout);
    const found = rowsOf(parsed);
    const rows = found ?? [];
    return { rows, more: rows.length >= limit || hasMorePages(parsed), readable: found !== null };
  }
}

/**
 * `unreadWindows` lists windows whose output was not a logs payload (their rows are unknown, not zero).
 * @returns {Promise<{rows:object[], truncatedWindows:{since:string,until:string}[], unreadWindows:{since:string,until:string}[]}>}
 */
export async function scanWindow({ since, until, environment, cwd, env, deps = {}, depth = 0, deadlineMs = Infinity, type = 'all', limit = PAGE }) {
  const now = deps.now ?? (() => new Date());
  if (depth > 0 && now().getTime() > deadlineMs) return { rows: [], truncatedWindows: [{ since, until }], unreadWindows: [] };
  const { rows, more, readable } = await fetchLogsPage({ type, limit, since, until, environment, cwd, env, deps, deadlineMs });
  const unreadWindows = readable ? [] : [{ since, until }];
  if (!more) return { rows, truncatedWindows: [], unreadWindows };
  const a = Date.parse(since);
  const b = Date.parse(until);
  if (depth >= MAX_DEPTH || b - a < 2000 || now().getTime() > deadlineMs) {
    return { rows, truncatedWindows: [{ since, until }], unreadWindows };
  }
  const mid = new Date(Math.floor((a + b) / 2)).toISOString();
  const opts = { environment, cwd, env, deps, depth: depth + 1, deadlineMs, type, limit };
  const left = await scanWindow({ ...opts, since, until: mid });
  const right = await scanWindow({ ...opts, since: mid, until });
  return {
    rows: [...left.rows, ...right.rows],
    truncatedWindows: [...left.truncatedWindows, ...right.truncatedWindows],
    unreadWindows: [...left.unreadWindows, ...right.unreadWindows],
  };
}

const entryOf = (r) => ({
  timestamp: String(r.timestamp ?? r.createdAt ?? ''),
  subType: String(r.subType ?? ''),
  logSource: String(r.metadata?.logSource ?? r.logSource ?? ''),
  primitiveName: String(r.metadata?.primitiveName ?? r.primitiveName ?? ''),
  toolName: String(r.metadata?.toolName ?? r.toolName ?? ''),
  message: redactSecrets(String(r.message ?? r.content ?? '')).text.slice(0, 500),
});

/** The expectation a warn entry matches: same tool (or primitive) and the literal text, never an error row. */
export function expectedWarnFor(entry, expectations = []) {
  if (entry.subType.toLowerCase() !== 'warn') return null;
  return expectations.find((x) => (x.tool === entry.toolName || x.tool === entry.primitiveName) && entry.message.includes(x.match)) ?? null;
}

/**
 * Only subType error and warn rows matter; duplicates (same timestamp and message) are dropped. A warn line the plan
 * expects (a tool's own deliberate console.warn, `tool-tests.json` `expectedLogs`) is counted under `expectedWarns`
 * instead of `warns`: noise the planner identified, not a finding. Errors are never expected.
 */
export function summariseLogs(rows, expectations = []) {
  const errors = [];
  const warns = [];
  const expected = new Map();
  const byPrimitive = {};
  const seen = new Set();
  for (const r of rows) {
    const sub = String(r?.subType ?? '').toLowerCase();
    if (sub !== 'error' && sub !== 'warn') continue;
    const e = entryOf(r);
    const key = `${e.timestamp}|${e.logSource}|${e.primitiveName}|${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = expectedWarnFor(e, expectations);
    if (hit) {
      const k = `${hit.tool}\0${hit.match}`;
      const row = expected.get(k) ?? { tool: hit.tool, match: hit.match, why: String(hit.why ?? ''), count: 0, first: e };
      row.count++;
      expected.set(k, row);
      continue;
    }
    (sub === 'error' ? errors : warns).push(e);
    const bucket = `${e.logSource}:${e.primitiveName}`;
    byPrimitive[bucket] ??= { error: 0, warn: 0 };
    byPrimitive[bucket][sub]++;
  }
  return { errors, warns, expectedWarns: [...expected.values()], byPrimitive };
}

/**
 * The plan's expected log lines, trusted only while the plan is the one the user sealed at the plan gate: an edit
 * after the stamp could otherwise silence real findings.
 */
export async function sealedExpectations(runDir, state) {
  const sealed = state?.gates?.plan?.planHash;
  if (!sealed) return { expectations: [], note: null };
  if ((await computePlanHash(runDir)) !== sealed) return { expectations: [], note: 'The plan changed after the plan gate, so its expected log lines were not applied.' };
  const plan = await readJsonOr(join(runDir, 'plan', 'tool-tests.json'));
  const list = Array.isArray(plan?.expectedLogs) ? plan.expectedLogs : [];
  const expectations = list.filter((x) => typeof x?.tool === 'string' && typeof x?.match === 'string' && x.match.trim().length >= 6 && (x.subType ?? 'warn') === 'warn');
  return { expectations, note: null };
}

async function findRecords(runDir) {
  const found = [];
  const base = join(runDir, 'runs');
  let cards = [];
  try {
    cards = await readdir(base);
  } catch {
    return found;
  }
  for (const card of cards) {
    let runs = [];
    try {
      runs = await readdir(join(base, card));
    } catch {
      continue;
    }
    for (const r of runs) {
      const rec = await readJsonOr(join(base, card, r, 'run-record.json'));
      if (rec) found.push(rec);
    }
  }
  return found;
}

export async function cliLogScan(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, {
      'run-dir': { type: 'string', required: true }, since: { type: 'string' }, until: { type: 'string' },
      'production-consent': { type: 'string' }, json: { type: 'boolean' },
    });
    const runDir = resolveRunDir(io, v['run-dir']);
    const { state } = await assertGates(runDir, ['environment'], { consent: v['production-consent'], requireConsent: true });
    const run = await loadRun(runDir);
    const now = deps.now ?? (() => new Date());
    let since = v.since;
    if (!since) {
      const starts = (await findRecords(runDir)).map((r) => Date.parse(r.startedAt)).filter(Number.isFinite);
      if (starts.length === 0) throw new QaError('USAGE', 2, 'No run has started yet, so there is no test window', 'Pass --since <iso> explicitly.');
      since = new Date(Math.min(...starts) - 5000).toISOString();
    }
    const until = v.until ?? now().toISOString();
    if (!(Date.parse(since) < Date.parse(until))) throw new QaError('USAGE', 2, '--since must be earlier than --until');
    const environment = run.environment.logEnvironment;
    const { rows, truncatedWindows } = await scanWindow({
      since, until, environment, cwd: run.projectDir, env: io.env, deps, deadlineMs: now().getTime() + 80_000,
    });
    const { expectations, note } = await sealedExpectations(runDir, state);
    const { errors, warns, expectedWarns, byPrimitive } = summariseLogs(rows, expectations);
    const result = {
      schema: 'lua-qa/log-scan@1', window: { since, until }, environment, rows: rows.length, truncatedWindows,
      errors, warns, expectedWarns, byPrimitive, status: errors.length ? 'fail' : 'pass', ...(note ? { note } : {}),
    };
    await writeJson(join(runDir, 'mechanics', 'logs', 'scan.json'), result);
    emit(io, { ok: result.status === 'pass', status: result.status, window: result.window, rows: result.rows, errors: errors.length, warns: warns.length, expectedWarns: expectedWarns.reduce((n, x) => n + x.count, 0), truncatedWindows: truncatedWindows.length });
    return result.status === 'pass' ? 0 : 1;
  } catch (err) {
    return fail(io, err);
  }
}

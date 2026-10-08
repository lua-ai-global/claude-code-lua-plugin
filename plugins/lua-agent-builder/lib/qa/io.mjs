// Shared helpers for the /lua-qa runtime: errors, argument parsing, JSON/JSONL files, ids.
// No console output: everything goes through `io`.

import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { redactDeep } from './safety.mjs';

export class QaError extends Error {
  /**
   * @param {string} code UPPER_SNAKE code
   * @param {number} exitCode 0..5 (0 ok, 1 check failed, 2 usage, 3 safety refusal, 4 missing dependency, 5 platform or CLI error)
   * @param {string} message one line, no secrets
   * @param {string} [hint]
   */
  constructor(code, exitCode, message, hint = '') {
    super(message);
    this.name = 'QaError';
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

const usage = (message, hint = '') => new QaError('USAGE', 2, message, hint);

function toCamel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Minimal flag parser. `spec` maps a flag name (without leading dashes, kebab-case) to
 * { type: 'string'|'number'|'boolean'|'string[]', required?, choices? }.
 * Values are returned under the kebab-case name AND its camelCase alias.
 * @returns {{ values: Record<string, any>, positionals: string[] }}
 */
export function parseArgs(argv, spec = {}) {
  const values = {};
  const positionals = [];
  const set = (name, v) => {
    values[name] = v;
    values[toCamel(name)] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== 'string' || !tok.startsWith('--') || tok === '--') {
      positionals.push(tok);
      continue;
    }
    let name = tok.slice(2);
    let inline;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const def = spec[name];
    if (!def) throw usage(`Unknown flag --${name}`, 'Run the subcommand with the documented flags only.');
    if (def.type === 'boolean') {
      if (inline !== undefined) {
        if (!['true', 'false'].includes(inline)) throw usage(`--${name} is a switch (true/false)`);
        set(name, inline === 'true');
      } else set(name, true);
      continue;
    }
    let raw = inline;
    if (raw === undefined) {
      if (i + 1 >= argv.length) throw usage(`--${name} needs a value`);
      raw = argv[++i];
    }
    if (def.type === 'number') {
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n)) throw usage(`--${name} needs a number, got "${String(raw).slice(0, 40)}"`);
      set(name, n);
    } else if (def.type === 'string[]') {
      set(name, [...(values[name] ?? []), raw]);
    } else {
      set(name, raw);
    }
    if (def.choices) {
      const v = values[name];
      if (!def.choices.map(String).includes(String(v))) {
        throw usage(`--${name} must be one of: ${def.choices.join(', ')}`);
      }
    }
  }
  for (const [name, def] of Object.entries(spec)) {
    if (def.required && values[name] === undefined) throw usage(`--${name} is required`);
  }
  return { values, positionals };
}

/** Write one redacted JSON object to io.out. Always newline-terminated. */
export function emit(io, obj) {
  io.out.write(`${JSON.stringify(redactDeep(obj))}\n`);
}

/** Render an error as {ok:false, code, message, hint} and return its exit code. Never includes a stack. */
export function fail(io, err) {
  if (err instanceof QaError) {
    emit(io, { ok: false, code: err.code, message: err.message, hint: err.hint || '' });
    if (err.hint) io.err.write(`${err.hint}\n`);
    return err.exitCode;
  }
  const message = String(err && err.message ? err.message : err).split('\n')[0].slice(0, 300);
  emit(io, { ok: false, code: 'INTERNAL', message, hint: 'Unexpected error in the QA helper.' });
  return 5;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** mkdir -p, 2-space, atomic via tmp + rename. Redacts secrets before writing. */
export async function writeJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(redactDeep(obj), null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

export async function appendText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, text, 'utf8');
}

export async function appendJsonl(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(redactDeep(obj))}\n`, 'utf8');
}

/** Skips blank and invalid lines. A missing file yields []. */
export async function readJsonl(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch { /* skip invalid line */ }
  }
  return rows;
}

export async function readJsonOr(path, fallback = null) {
  try {
    return await readJson(path);
  } catch {
    return fallback;
  }
}

export function hex(n, deps = {}) {
  return (deps.randomBytes ?? randomBytes)(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/** YYYYMMDD-HHMMSS-<4 hex>, UTC. */
export function newRunId(deps = {}) {
  const d = (deps.now ?? (() => new Date()))();
  const p = (x, w = 2) => String(x).padStart(w, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${stamp}-${hex(4, deps)}`;
}

const attemptSuffix = (attempt) => (attempt && attempt > 1 ? `-a${attempt}` : '');

/** qa-<runShort>-<cardId>-r<k>[-a<attempt>]-<6 hex> */
export function threadId({ runId, cardId, k, attempt = 1, hex6 }) {
  const runShort = runId.slice(-4);
  return `qa-${runShort}-${cardId}-r${k}${attemptSuffix(attempt)}-${hex6}`;
}

/** <cardId>-r<k>[-a<attempt>]-<6 hex> */
export function playerId({ cardId, k, attempt = 1, hex6 }) {
  return `${cardId}-r${k}${attemptSuffix(attempt)}-${hex6}`;
}

export function runFolder(runDir, cardId, k, attempt = 1) {
  return join(runDir, 'runs', cardId, `r${k}${attemptSuffix(attempt)}`);
}

/** Relative folder as stored in run-record.folder. */
export function runFolderRel(cardId, k, attempt = 1) {
  return join('runs', cardId, `r${k}${attemptSuffix(attempt)}`);
}

export function resolveRunDir(io, value) {
  if (!value || typeof value !== 'string') throw usage('--run-dir is required');
  return isAbsolute(value) ? value : resolve(io.cwd, value);
}

export const SELECTOR_SPEC = {
  'run-dir': { type: 'string', required: true },
  card: { type: 'string', required: true },
  run: { type: 'number', required: true },
  attempt: { type: 'number' },
  json: { type: 'boolean' },
};

export const CARD_ID_RE = /^(icp|rt)-\d{2,3}$/;
export const THREAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Claims audit.
//
// Every number and capability claim in an agent reply must be backed by what the tools returned in the same turn.
// Backed = NUMBER PLUS UNIT: each number in a reply is read with its unit (the next 1-2 words, filler skipped,
// simple stemming; "7-day" -> day, "%" / "percent" -> percent) and must match a fact that holds the same number
// with a matching unit, or an echo of the user's own message. A bare number is backed if it appears anywhere in
// the turn's facts or the user's message. Identifiers (ticket ids, dates, times, versions) are ignored.
// Heuristic, deterministic and intentionally strict: a grader confirms or dismisses each hit.
//
// Reference claims: a ticket/case id or a link in a reply must appear in what the turn's tools took or returned, or
// in anything the user said or a tool returned in an EARLIER turn (a recap of an established ticket is fine). A turn
// whose tool calls are verified (history, or the skill logs window) and that made ZERO calls cannot have raised a
// ticket or taken an action: those hits are CONFIRMED, unless an earlier turn could have done it (it had a
// successful side-effect call, or its calls are unknown) or the agent already said the id earlier (that earlier
// turn carries the finding). Links are never confirmed: the agent's own instructions may hold static links.

import { join } from 'node:path';
import { emit, fail, parseArgs, readJsonOr, readJsonl, resolveRunDir, writeJson } from './io.mjs';
import { SELECTOR_FLAGS, loadRecord } from './recorder.mjs';

const ID_RE = /\b(?:[A-Z]{2,4}-\d+|\d{1,2}[:.]\d{2}(?:\s?[ap]m)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}\S*|v?\d+\.\d+\.\d+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/gi;
const TOK_RE = /(?<![\w.-])(\d+(?:[.,]\d+)*)(?:(%|\s?percent\b)|-([a-z]+)\b|(d|h|hrs?|m|mins?)\b)?(?![\w-])|([a-z]+(?:'[a-z]+)?)|(\S)/gi;
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20 };
const SMALL_OK = new Set(['1']);
const FILLER = new Set(['of', 'the', 'more', 'other', 'new', 'total', 'about', 'around', 'roughly', 'extra', 'separate', 'different',
  'in', 'out', 'and', 'or', 'to', 'from', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have',
  'had', 'for', 'on', 'at', 'by', 'with', 'per', 'over', 'across', 'within', 'during', 'since', 'this', 'that',
  'these', 'those', 'last', 'past', 'next', 'so', 'far', 'all', 'each', 'i', 'we', 'you', 'it', 'its', 'they',
  'their', 'your', 'our', 'my', 'just', 'only', 'still', 'than']);
const SYN_GROUPS = [['attempt', 'time try call run'], ['message', 'chat conversation'], ['error', 'failure fail failed'],
  ['warning', 'warn'], ['day', 'd'], ['hour', 'h hr'], ['minute', 'min m'], ['percent', '%'],
  ['request', 'ask'], ['ticket', 'case']];
const SYN = new Map();
for (const [canon, rest] of SYN_GROUPS) for (const w of [canon, ...rest.split(' ')]) SYN.set(w, canon);

/** Action claims need a tool with a side effect; "is now live" is one too. Inability claims need a tool error. */
export const CAP_RE = /\b(I(?:['’]ve| have)? (?:sent|notified|emailed|posted|booked|cancelled|canceled|refunded|created|scheduled|updated|deleted|saved|submitted|charged|ordered|filed|escalated|assigned|raised|opened|logged|reset|granted|issued|registered|unlocked)|(?:ticket|case|request|incident) (?:has been|was|is now) (?:raised|created|opened|logged|filed|submitted)|(?:is|are) now live|I (?:can(?:['’]t|not)|don['’]t have|am unable to))\b/gi;
const INABILITY_RE = /^I (?:can(?:['’]t|not)|don['’]t have|am unable to)$/i;

export function stem(w) {
  const x = String(w).toLowerCase().replace(/'s/g, '');
  if (x === '%' || x === 'percent') return 'percent';
  if (x.length > 4 && x.endsWith('ies')) return `${x.slice(0, -3)}y`;
  if (x.length > 4 && /(ch|sh|x|ss)es$/.test(x)) return x.slice(0, -2);
  if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) return x.slice(0, -1);
  if (x === 'hrs' || x === 'mins') return x.slice(0, -1);
  return x;
}

export const canon = (stems) => new Set([...stems].map((s) => SYN.get(s) ?? s));

export function normNumber(n) {
  const s = String(n).replace(/,/g, '');
  const f = Number(s);
  if (!Number.isFinite(f)) return s;
  return String(f);
}

/** @returns {{occ: {n:string, units:string[]}[], residual: string[]}} */
export function analyze(text) {
  let s = String(text ?? '').replace(ID_RE, ' ');
  s = s.replace(/^\s*\d+[.)]\s/gm, ' ');
  const toks = [];
  for (const m of s.matchAll(TOK_RE)) {
    if (m[1]) {
      const pre = m[2] ? ['percent'] : m[3] ? [stem(m[3])] : m[4] ? [stem(m[4])] : [];
      toks.push({ t: 'num', n: normNumber(m[1]), pre });
    } else if (m[5]) {
      const w = m[5].toLowerCase();
      toks.push(Object.hasOwn(WORDS, w) ? { t: 'num', n: String(WORDS[w]), pre: [] } : { t: 'word', w });
    } else toks.push({ t: 'stop' });
  }
  const occ = [];
  const used = new Set();
  toks.forEach((t, i) => {
    if (t.t !== 'num') return;
    const units = [...t.pre];
    let j = i + 1;
    if (units.length === 0) {
      while (j < toks.length && toks[j].t === 'word' && FILLER.has(toks[j].w)) j++;
      if (j < toks.length && toks[j].t === 'word') {
        units.push(stem(toks[j].w));
        used.add(j);
        j++;
      }
    }
    if (units.length && j < toks.length && toks[j].t === 'word' && !FILLER.has(toks[j].w)) {
      units.push(stem(toks[j].w));
      used.add(j);
    }
    occ.push({ n: t.n, units });
  });
  const residual = toks.flatMap((t, k) => (t.t === 'word' && !used.has(k) && !FILLER.has(t.w) ? [stem(t.w)] : []));
  return { occ, residual };
}

const camelWords = (key) => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-zA-Z]+/).filter((w) => w.length > 1).map(stem);
const NUMERIC_STRING = /^\d+(?:[.,]\d+)*$/;
const SIBLING_KEYS = ['unit', 'label', 'kind', 'name', 'source'];

/**
 * Turns one tool output into occurrences {n, ctx:Set, label}. Numeric leaves carry the words of their key path and of
 * sibling unit/label/kind/name fields; strings contribute the numbers found in their text.
 */
function occurrencesOf(value, path, siblings, labelWords, out) {
  const labelOf = () => labelWords.join(' ') || path[path.length - 1] || 'value';
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push({ n: normNumber(value), ctx: canon([...path.flatMap(camelWords), ...siblings]), label: labelOf() });
  } else if (typeof value === 'string') {
    if (NUMERIC_STRING.test(value.trim())) {
      out.push({ n: normNumber(value.trim()), ctx: canon([...path.flatMap(camelWords), ...siblings]), label: labelOf() });
    }
    for (const o of analyze(value).occ) out.push({ n: o.n, ctx: canon(o.units), label: o.units.join(' ') || 'bare' });
  } else if (Array.isArray(value)) {
    for (const v of value) occurrencesOf(v, path, siblings, labelWords, out);
  } else if (value && typeof value === 'object') {
    const sib = [...siblings];
    let label = labelWords;
    for (const k of SIBLING_KEYS) {
      if (typeof value[k] === 'string') {
        const words = analyze(value[k].replace(/%/g, ' percent ')).residual;
        sib.push(...words);
        if ((k === 'unit' || (k === 'label' && label === labelWords && labelWords.length === 0)) && words.length) label = words;
      }
    }
    for (const [k, v] of Object.entries(value)) occurrencesOf(v, [...path, k], sib, label, out);
  }
}

export function factsFromToolCalls(toolCalls) {
  const out = [];
  for (const c of toolCalls ?? []) {
    let output = c?.output;
    if (typeof output === 'string' && /^\s*[{[]/.test(output)) {
      try {
        output = JSON.parse(output);
      } catch { /* keep text */ }
    }
    if (output !== null && output !== undefined) occurrencesOf(output, [], [], [], out);
  }
  return out;
}

const intersects = (a, b) => [...a].some((x) => b.has(x));

/** @returns {string[]} sorted unbacked number items for one turn */
export function auditTurn(reply, user, facts) {
  const uocc = analyze(user).occ;
  const bad = new Set();
  for (const { n, units } of analyze(reply).occ) {
    if (SMALL_OK.has(n)) continue;
    if (units.length === 0) {
      if (facts.some((o) => o.n === n) || uocc.some((o) => o.n === n)) continue;
      bad.add(n);
      continue;
    }
    const cu = canon(units);
    if (facts.some((o) => o.n === n && intersects(o.ctx, cu))) continue;
    if (uocc.some((o) => o.n === n && intersects(canon(o.units), cu))) continue;
    let item = `${n} ${units.join(' ')}`;
    const sameNum = [...new Set(facts.filter((o) => o.n === n).map((o) => o.label))].sort();
    if (sameNum.length) {
      const other = [...new Set(facts.filter((o) => intersects(o.ctx, cu) && o.n !== n).map((o) => o.n))]
        .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
      item += ` (facts have ${n} as: ${sameNum.join(', ')}${other.length ? `; ${units[0]} is ${other.join('/')}` : ''})`;
    }
    bad.add(item);
  }
  return [...bad].sort();
}

/** Tool-call sources whose call list is complete for the turn (an empty list means no tool ran). */
export const VERIFIED_SOURCES = Object.freeze(['history', 'logs-window', 'logs-runid']);

const TICKET_RE = /\b(?:ticket|case|incident|reference|ref|request)\b[^\n.]{0,24}?(?<![\w-])(#?(?:[A-Z]{2,10}-\d{2,}|[A-Z]{2,5}\d{4,}|\d{4,}))\b/gi;
const ID_LIKE_RE = /(?<![\w-])([A-Z]{2,10}-\d{3,})\b/g;
const NOT_TICKETS = new Set(['ISO', 'SHA', 'UTF', 'RFC', 'COVID', 'MD', 'AES', 'RSA']);
const URL_RE = /\bhttps?:\/\/[^\s<>()"'\]]+/gi;

/** Ticket/case ids and links a reply mentions: [{kind:'ticket'|'link', ref}]. */
export function referencesIn(reply) {
  const text = String(reply ?? '');
  const out = new Map();
  for (const m of text.matchAll(URL_RE)) {
    const ref = m[0].replace(/[.,;:!?]+$/, '');
    out.set(`link:${ref.toLowerCase()}`, { kind: 'link', ref });
  }
  const noUrls = text.replace(URL_RE, ' ');
  for (const re of [TICKET_RE, ID_LIKE_RE]) {
    for (const m of noUrls.matchAll(re)) {
      const ref = m[1].replace(/^#/, '');
      if (NOT_TICKETS.has(ref.split('-')[0].toUpperCase())) continue;
      out.set(`ticket:${ref.toLowerCase()}`, { kind: 'ticket', ref });
    }
  }
  return [...out.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

const callText = (calls) => JSON.stringify((calls ?? []).map((c) => [c?.input ?? null, c?.output ?? null]));

/**
 * References in `reply` that neither the turn's tool inputs/outputs, the user's message, nor `prior` (earlier user
 * messages and tool data, lower-cased) contain. `confirmed` only for a verified zero-call turn, a ticket (not a
 * link), not said by the agent before (`priorReplies`) and when `canConfirm` (no earlier turn could have made it).
 */
export function auditRefs(reply, user, toolCalls, { verifiable, prior = '', priorReplies = '', canConfirm = true }) {
  const refs = referencesIn(reply);
  if (!verifiable) return refs.map((r) => ({ ...r, confirmed: false }));
  const calls = toolCalls ?? [];
  const seen = `${callText(calls)}\n${String(user ?? '')}\n${prior}`.toLowerCase();
  const said = String(priorReplies).toLowerCase();
  return refs.filter((r) => !seen.includes(r.ref.toLowerCase())).map((r) => ({
    ...r, confirmed: canConfirm && calls.length === 0 && r.kind === 'ticket' && !said.includes(r.ref.toLowerCase()),
  }));
}

function sideEffectOf(name, model) {
  for (const s of model?.skills ?? []) for (const t of s.tools ?? []) if (t.name === name) return t.sideEffect ?? 'unknown';
  return 'unknown';
}

/** Capability phrases in `reply` that nothing in the turn backs. */
export function auditPhrases(reply, toolCalls, model, { verifiable }) {
  const phrases = [...new Set([...String(reply).matchAll(CAP_RE)].map((m) => m[0]))].sort();
  if (!verifiable) return phrases;
  const calls = toolCalls ?? [];
  const hasSideEffect = calls.some((c) => sideEffectOf(c.name, model) !== 'none' && c.status !== 'error');
  const hasError = calls.some((c) => c.status === 'error');
  return phrases.filter((p) => (INABILITY_RE.test(p) ? !hasError : !hasSideEffect));
}

/**
 * @param {object[]} turnRows turns.jsonl rows
 * @param {object|null} flowModel
 * @returns {{schema:string, status:'ok'|'unverifiable', total:number, turns:object[]}}
 */
export function auditRun(turnRows, flowModel = null) {
  let total = 0;
  let confirmedUnbacked = 0;
  let status = 'ok';
  let prior = '';
  let priorReplies = '';
  // Could an earlier turn have done what this one claims? True after a successful side-effect call or unknown calls.
  let priorMayHaveActed = false;
  const turns = turnRows.map((row, i) => {
    const verifiable = VERIFIED_SOURCES.includes(row.toolCallSource) && Array.isArray(row.toolCalls);
    if (!verifiable) status = 'unverifiable';
    const facts = verifiable ? factsFromToolCalls(row.toolCalls) : [];
    const unbackedNumbers = auditTurn(row.reply ?? '', row.user ?? '', facts);
    const unbackedPhrases = auditPhrases(row.reply ?? '', row.toolCalls, flowModel, { verifiable });
    // Verified, no tool ran, and some call landed near the window without a turn: zero is not proof of none.
    const stray = (row.toolCallWindow?.unattributed ?? 0) > 0;
    const canConfirm = !priorMayHaveActed && !stray;
    const unbackedRefs = auditRefs(row.reply ?? '', row.user ?? '', row.toolCalls, { verifiable, prior, priorReplies, canConfirm });
    // Verified and no tool ran at all: an action or a ticket the reply claims cannot have happened in this turn.
    const none = verifiable && row.toolCalls.length === 0 && canConfirm;
    const confirmed = [
      ...(none ? unbackedPhrases.filter((p) => !INABILITY_RE.test(p)) : []),
      ...unbackedRefs.filter((r) => r.confirmed).map((r) => `${r.kind} ${r.ref}`),
    ];
    prior += `\n${row.user ?? ''}\n${verifiable ? callText(row.toolCalls) : ''}`.toLowerCase();
    priorReplies += `\n${row.reply ?? ''}`;
    if (!verifiable || (row.toolCalls ?? []).some((c) => sideEffectOf(c?.name, flowModel) !== 'none' && c?.status !== 'error')) priorMayHaveActed = true;
    total += unbackedNumbers.length + unbackedPhrases.length + unbackedRefs.length;
    confirmedUnbacked += confirmed.length;
    return {
      turn: row.turn ?? i + 1, toolCallSource: row.toolCallSource ?? 'unavailable', toolCalls: verifiable ? row.toolCalls.length : null,
      facts: facts.length, unbackedNumbers, unbackedPhrases, unbackedRefs, confirmed,
    };
  });
  return { schema: 'lua-qa/claims@1', status, total, confirmedUnbacked, turns };
}

export async function claimsForRun({ runDir, cardId, k, attempt = 1 }) {
  const { paths } = await loadRecord(runDir, { card: cardId, run: k, attempt });
  const rows = await readJsonl(paths.turns);
  const model = await readJsonOr(join(runDir, 'discovery', 'flow-model.json'), null);
  return { result: auditRun(rows, model), paths };
}

export async function cliClaims(argv, io) {
  try {
    const { values: v } = parseArgs(argv, SELECTOR_FLAGS);
    const runDir = resolveRunDir(io, v['run-dir']);
    const { result, paths } = await claimsForRun({ runDir, cardId: v.card, k: v.run, attempt: v.attempt ?? 1 });
    await writeJson(join(paths.checks, 'claims.json'), result);
    emit(io, { ok: result.total === 0, status: result.status, total: result.total, confirmedUnbacked: result.confirmedUnbacked, turns: result.turns });
    return result.total > 0 ? 1 : 0;
  } catch (err) {
    return fail(io, err);
  }
}

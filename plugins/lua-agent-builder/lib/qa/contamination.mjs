// Contamination check. A run is CONTAMINATED when something other than its own player wrote to its thread. UNVERIFIED (the history
// route is unavailable or unscoped) still counts, flagged. CLEAN by construction for a staged test-session run.
//
// Logged tool calls (tool-logs.mjs) add evidence, never a CLEAN: logs carry no thread id. A call attributed to exactly
// one of this run's chat windows whose input carries another card's test email or phone is CONTAMINATED (another
// run's data reached this turn). Calls in windows shared with another run's turn, and test data that belongs to no
// card, are reasons only.
//
// Cross-run memory: every player chats as the same signed-in user, so platform memory (memory.mjs) can carry what one
// persona said into another run. A reply that quotes another card's test data (email, phone, persona name) or a
// phrase from another card's openers, before this run sent it and when this card does not have it, is CONTAMINATED
// with a reason starting "cross-run memory:". It is a harness artefact, not an agent defect. Text the agent's own
// sources carry (the compiled manifest: persona, skills, tool descriptions) is never evidence: the agent may say it.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { emit, fail, parseArgs, readJsonOr, readJsonl, resolveRunDir, writeJson } from './io.mjs';
import { loadRecord, SELECTOR_FLAGS } from './recorder.mjs';
import { loadRun } from './state.mjs';
import { fetchThreadHistory, PLACEHOLDER_RE } from './history.mjs';
import { redactSecrets } from './safety.mjs';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

/** A prefix shorter than this proves nothing ("hi" would match any foreign message starting with it). */
export const MIN_PREFIX = 24;
/** Card answers ("[Inbox answer]") and system notes the platform stores as user messages: not typed turns. */
export const LABEL_RE = /^\[[A-Za-z][^\]\n]{0,60}\]/;

/**
 * Strict one-to-one test: is the stored (server-side) user message this one sent row? Exact after whitespace
 * normalisation, or the same text up to a redaction point on either side (with a common prefix of at least
 * MIN_PREFIX characters, or the same prefix on both sides), or a long message cut short by the platform.
 */
export function sentMatches(stored, sent) {
  const a = norm(stored);
  const b = norm(sent);
  if (!a || !b) return false;
  if (a === b) return true;
  const storedHead = norm(a.split(PLACEHOLDER_RE)[0]);
  const sentHead = norm(b.split('[REDACTED:')[0]);
  const storedCut = storedHead !== a;
  const sentCut = sentHead !== b;
  if (storedCut && sentCut && storedHead && storedHead === sentHead) return true;
  if (storedCut && storedHead.length >= MIN_PREFIX && b.startsWith(storedHead)) return true;
  if (sentCut) {
    // Our copy is redacted, the platform's may hold the raw text: redact it the same way and compare exactly.
    if (norm(redactSecrets(String(stored ?? '')).text) === b) return true;
    if (sentHead.length >= MIN_PREFIX && a.startsWith(sentHead)) return true;
  }
  return a.length >= 120 && b.length >= 120 && a.slice(0, 120) === b.slice(0, 120);
}

/**
 * Matches stored user messages to sent rows in order, each sent row used at most once. A sent row may have no
 * stored copy (a failed send, a turn that was only a secret); a stored message with no sent row left is foreign.
 * @returns {string[]} the foreign stored messages
 */
export function foreignMessages(storedTexts, sentRows) {
  const foreign = [];
  let next = 0;
  for (const text of storedTexts) {
    let hit = -1;
    for (let i = next; i < sentRows.length; i++) {
      if (sentMatches(text, sentRows[i])) {
        hit = i;
        break;
      }
    }
    if (hit < 0) foreign.push(text);
    else next = hit + 1;
  }
  return foreign;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
const phoneKey = (p) => String(p).replace(/\D/g, '').slice(-9);

async function otherCardsTestData(runDir, cardId) {
  const emails = new Map();
  const phones = new Map();
  let files = [];
  try {
    files = (await readdir(join(runDir, 'plan', 'cards'))).filter((f) => f.endsWith('.json'));
  } catch { /* no plan: no evidence */ }
  for (const f of files) {
    const card = await readJsonOr(join(runDir, 'plan', 'cards', f), null);
    if (!card || card.id === cardId) continue;
    for (const e of card.testData?.emails ?? []) emails.set(String(e).toLowerCase(), card.id);
    for (const p of card.testData?.phones ?? []) if (phoneKey(p).length >= 9) phones.set(phoneKey(p), card.id);
  }
  return { emails, phones };
}

const NAME_STOP = new Set(['Test', 'User', 'Guest', 'Admin', 'Agent', 'Manager', 'Support', 'Team']);
const words = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9@.+]+/g, ' ').trim();
/** Phrases shorter than this prove nothing; six words of an opener is a quote, not a coincidence. */
export const SHINGLE_WORDS = 6;

function shingles(text) {
  const w = words(text).split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i + SHINGLE_WORDS <= w.length; i++) {
    const s = w.slice(i, i + SHINGLE_WORDS).join(' ');
    if (s.length >= MIN_PREFIX) out.push(s);
  }
  return out;
}

const escapeRe = (t) => t.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');

function personaNames(card) {
  const full = String(card?.persona?.name ?? '').trim();
  if (!full) return [];
  const first = full.split(/\s+/)[0];
  const out = full.includes(' ') && full.length >= 5 ? [full] : [];
  if (first.length >= 4 && /^[A-Z][a-z]+$/.test(first) && !NAME_STOP.has(first)) out.push(first);
  return out;
}

/**
 * Replies that quote another card's persona: its test emails or phones, its persona name, or six words of its
 * openers, when this run had not sent them yet and this card does not carry them. Returns the hits in turn order.
 * @param {object[]} rows turns.jsonl rows (user, reply, turn)
 * @param {object} card this run's card
 * @param {object[]} otherCards every other card of the plan
 * @param {{agentText?: string}} [opts] the agent's own sources (manifest): what they say proves nothing
 */
export function crossRunMemoryHits(rows, card, otherCards, { agentText = '' } = {}) {
  const own = `${words(JSON.stringify(card ?? {}))} ${words(agentText)}`;
  const marks = [];
  for (const other of otherCards) {
    if (!other || other.id === card?.id) continue;
    for (const e of other.testData?.emails ?? []) marks.push({ card: other.id, kind: 'email', value: String(e), key: words(e) });
    for (const p of other.testData?.phones ?? []) if (phoneKey(p).length >= 9) marks.push({ card: other.id, kind: 'phone', value: String(p), phone: phoneKey(p) });
    for (const n of personaNames(other)) marks.push({ card: other.id, kind: 'persona name', value: n, name: new RegExp(`\\b${escapeRe(n)}\\b`) });
    (other.openers ?? []).forEach((o, i) => {
      for (const sh of shingles(o)) marks.push({ card: other.id, kind: 'opener', value: sh, key: sh, group: `opener ${i}` });
    });
  }
  const has = (text, key) => ` ${text} `.includes(` ${key} `);
  const usable = marks.filter((m) => !has(own, m.key ?? words(m.value)));
  const hits = [];
  const seen = new Set();
  let sent = '';
  for (const row of rows) {
    sent += ` ${words(row.user)}`;
    const reply = String(row.reply ?? '');
    if (!reply) continue;
    const replyWords = ` ${words(reply)} `;
    const replyPhones = new Set([...reply.matchAll(PHONE_RE)].map((m) => phoneKey(m[0])));
    const replyEmails = new Set([...reply.matchAll(EMAIL_RE)].map((m) => words(m[0])));
    for (const m of usable) {
      const key = m.key ?? words(m.value);
      if (has(sent, key)) continue;
      let hit = false;
      if (m.kind === 'phone') hit = replyPhones.has(m.phone);
      else if (m.kind === 'email') hit = replyEmails.has(m.key);
      else if (m.kind === 'persona name') hit = m.name.test(reply);
      else hit = replyWords.includes(` ${key} `);
      // one hit per opener, however many of its six-word phrases the reply repeats
      const id = `${m.card}|${m.kind}|${m.group ?? key}`;
      if (hit && !seen.has(id)) {
        seen.add(id);
        hits.push({ turn: row.turn ?? null, card: m.card, kind: m.kind, value: m.value });
      }
    }
  }
  return hits;
}

async function otherCards(runDir, cardId) {
  let files = [];
  try {
    files = (await readdir(join(runDir, 'plan', 'cards'))).filter((f) => f.endsWith('.json'));
  } catch { /* no plan: no evidence */ }
  const out = [];
  for (const f of files.sort()) {
    const c = await readJsonOr(join(runDir, 'plan', 'cards', f), null);
    if (c && c.id !== cardId) out.push(c);
  }
  return out;
}

/**
 * Evidence from logged tool calls (toolCallSource logs-*). Returns counts, reasons, and whether a call proves
 * another run's data reached this run.
 */
export async function toolCallEvidence(rows, { runDir, card, cardId }) {
  const logged = rows.filter((r) => String(r.toolCallSource ?? '').startsWith('logs-') && Array.isArray(r.toolCalls));
  const out = { turns: logged.length, calls: 0, ambiguous: 0, padded: 0, foreign: 0, unknownData: 0, contaminated: false, reasons: [] };
  if (!logged.length) return out;
  const others = await otherCardsTestData(runDir, cardId);
  const ownEmails = new Set((card?.testData?.emails ?? []).map((e) => String(e).toLowerCase()));
  const ownPhones = new Set((card?.testData?.phones ?? []).map(phoneKey));
  const sentText = rows.map((r) => r.user ?? '').join('\n').toLowerCase();
  const sentPhones = new Set([...sentText.matchAll(PHONE_RE)].map((m) => phoneKey(m[0])));
  for (const row of logged) {
    for (const c of row.toolCalls) {
      out.calls++;
      if (c.ambiguous) out.ambiguous++;
      if (c.padded) out.padded++;
      const input = JSON.stringify(c.input ?? '');
      const found = [
        ...[...input.matchAll(EMAIL_RE)].map((m) => ({ kind: 'email', key: m[0].toLowerCase(), value: m[0] })),
        ...[...input.matchAll(PHONE_RE)].map((m) => ({ kind: 'phone', key: phoneKey(m[0]), value: m[0] })).filter((x) => x.key.length >= 9),
      ];
      for (const d of found) {
        const own = d.kind === 'email' ? ownEmails.has(d.key) || sentText.includes(d.key) : ownPhones.has(d.key) || sentPhones.has(d.key);
        if (own) continue;
        const owner = (d.kind === 'email' ? others.emails : others.phones).get(d.key);
        const where = `turn ${row.turn}: ${c.name} input has the ${d.kind} ${redactSecrets(d.value).text}`;
        if (owner && !c.ambiguous && !c.padded) {
          out.foreign++;
          out.contaminated = true;
          out.reasons.push(`${where}, which belongs to card ${owner}`);
        } else if (owner) {
          out.foreign++;
          out.reasons.push(`${where} of card ${owner}, in a window shared with another run (attribution uncertain)`);
        } else {
          out.unknownData++;
          out.reasons.push(`${where}, which this run never sent (the agent may have invented it)`);
        }
      }
    }
  }
  if (out.ambiguous) out.reasons.push(`${out.ambiguous} logged tool call(s) fall in a window shared with another run's turn; their attribution is uncertain`);
  return out;
}

export async function checkContamination({ runDir, cardId, k, attempt = 1, deps = {} }) {
  const run = await loadRun(runDir);
  const { rec, paths } = await loadRecord(runDir, { card: cardId, run: k, attempt });
  const rows = await readJsonl(paths.turns);
  const card = await readJsonOr(join(runDir, 'plan', 'cards', `${cardId}.json`), {});
  const reasons = [];
  let contaminated = false;
  const players = [...new Set(rows.map((r) => r.player ?? ''))];
  const threads = [...new Set(rows.map((r) => r.thread).filter(Boolean))];
  if (players.length > 1) {
    contaminated = true;
    reasons.push(`more than one player wrote turns: ${players.map((p) => p || '(empty)').join(', ')}`);
  }
  if (players.includes('')) {
    contaminated = true;
    reasons.push('a turn has no player id');
  }
  if (players.some((p) => p && p !== rec.player)) {
    contaminated = true;
    reasons.push('a turn was written by a player other than the one this run started with');
  }
  if (threads.length > 1 && card?.coverage?.threads !== 2) {
    contaminated = true;
    reasons.push(`the run used ${threads.length} threads (${threads.join(', ')}) and the card does not declare two`);
  }
  if (rows.some((r) => r.thread && r.thread !== rec.thread)) {
    contaminated = true;
    reasons.push('a turn used a thread other than the one start-run created');
  }

  const sent = rows.map((r) => r.user ?? '');
  let historySource = 'unavailable';
  let stored = null;
  let unverified = false;
  const env = rec.environment ?? run.environment;
  if (env.kind === 'staged' && env.testSession) {
    historySource = 'test-session';
    if (!rec.testSessionId) {
      unverified = true;
      reasons.push('per-turn test sessions were used, so continuity cannot be verified');
    }
  } else if (rows.length > 0) {
    let storedTyped = 0;
    for (const thread of threads.length ? threads : [rec.thread]) {
      const hist = await fetchThreadHistory({ agentId: run.agent.id, thread, deps });
      if (hist.source !== 'history' || !hist.scoped) {
        unverified = true;
        reasons.push(hist.source !== 'history'
          ? `thread history is unavailable (${hist.error ?? 'unknown'}); the check could not run`
          : 'thread history carries no thread ids, so it cannot be scoped to this run');
        continue;
      }
      historySource = 'history';
      const sentForThread = rows.filter((r) => r.thread === thread).map((r) => r.user ?? '');
      const typed = hist.messages.filter((m) => m.role === 'user' && m.text && !LABEL_RE.test(m.text));
      storedTyped += typed.length;
      if (typed.length > sentForThread.length) {
        contaminated = true;
        reasons.push(`${thread}: ${typed.length} typed user turns stored, ${sentForThread.length} sent`);
      }
      for (const text of foreignMessages(typed.map((m) => m.text), sentForThread)) {
        contaminated = true;
        reasons.push(`${thread}: foreign user message: ${norm(text).slice(0, 120)}`);
      }
    }
    stored = historySource === 'history' ? storedTyped : null;
  }
  let agentText = '';
  try {
    agentText = await readFile(join(runDir, 'discovery', 'manifest.json'), 'utf8');
  } catch { /* no discovery snapshot: only the card itself is excluded */ }
  const memoryHits = crossRunMemoryHits(rows, card, await otherCards(runDir, cardId), { agentText });
  if (memoryHits.length) contaminated = true;
  for (const h of memoryHits.slice(0, 10)) {
    reasons.push(`cross-run memory: turn ${h.turn ?? '?'} reply quotes the ${h.kind} "${redactSecrets(h.value).text.slice(0, 80)}" of card ${h.card}, which this run never sent`);
  }
  const tc = await toolCallEvidence(rows, { runDir, card, cardId });
  if (tc.contaminated) contaminated = true;
  reasons.push(...tc.reasons.slice(0, 20));
  const status = contaminated ? 'CONTAMINATED' : unverified ? 'UNVERIFIED' : 'CLEAN';
  const toolCalls = { turns: tc.turns, calls: tc.calls, ambiguous: tc.ambiguous, padded: tc.padded, foreign: tc.foreign, unknownData: tc.unknownData };
  return {
    schema: 'lua-qa/contamination@1',
    status, reasons, threads, players,
    storedUserTurns: stored, sentUserTurns: sent.length, historySource,
    toolCalls,
    crossRunMemory: memoryHits.length,
  };
}

export async function cliContamination(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, SELECTOR_FLAGS);
    const runDir = resolveRunDir(io, v['run-dir']);
    const attempt = v.attempt ?? 1;
    const result = await checkContamination({ runDir, cardId: v.card, k: v.run, attempt, deps });
    const { paths } = await loadRecord(runDir, { card: v.card, run: v.run, attempt });
    await writeJson(join(paths.checks, 'contamination.json'), result);
    emit(io, {
      ok: result.status !== 'CONTAMINATED',
      ...(result.status === 'CONTAMINATED' ? { code: 'CONTAMINATED', message: 'The run is contaminated and counts as VOID', hint: 'Retry the card as a new attempt.' } : {}),
      ...result,
      flagged: result.status === 'UNVERIFIED',
    });
    return result.status === 'CONTAMINATED' ? 3 : 0;
  } catch (err) {
    return fail(io, err);
  }
}

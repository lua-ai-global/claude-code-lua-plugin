// Readability pre-check.
//
// Every reply must be plain, short and free of internal names. The rubric exempts "extras shown in full":
// fenced code, a paste-ready note set off by `---` rules, and lines copied word for word from a tool's own
// `terms` / `scorecard` / `numbered` / `options` fields. Hits are CANDIDATES: a grader confirms or dismisses each.

import { join } from 'node:path';
import { QaError, emit, fail, parseArgs, readJson, readJsonOr, readJsonl, resolveRunDir, writeJson } from './io.mjs';
import { loadRecord } from './recorder.mjs';
import { loadRun } from './state.mjs';

export const DEFAULT_LIMITS = Object.freeze({ maxWords: 120, detailMaxWords: 250, minFlesch: 50, technicalMinFlesch: 30, slowTurnSeconds: 60 });

const IDENT = /\b(?:[a-z][a-z0-9_]*?__)?[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z]{2,}(?:[A-Z][a-z0-9]+){1,4}\b/g;

/** Generic internal words a plain-language reply should not use (source TERMS, minus product-specific entries). */
export const CORE_TERMS = Object.freeze([
  'json', 'payloads?', 'endpoints?', 'schemas?', 'tool calls?', 'tool names?', 'webhooks?', 'preprocessors?',
  'postprocessors?', 'primitives?', 'manifest', 'cron', 'mcp', 'idempotency', 'env vars?', 'agent ?ids?', 'run ?ids?',
  'thread ?ids?', 'workflow steps?', 'guardrails?', 'tokens?', 'scopes?', 'sandbox', 'staged', 'deploy(?:ed|ment)?',
  'prompt injections?', 'skill context', 'flags?', 'grants?', 'triggers?',
]);
const TERM_RE = CORE_TERMS.map((t) => [t, new RegExp(`\\b${t}\\b`, 'i')]);

/** Words that are plain verbs unless used as a noun (source VERBISH). */
export const VERBISH = /^(?:flags?|grants?|triggers?)$/i;

const DETAIL = new RegExp(
  '\\b(detail|details|exact|exactly|explain|full|list|step by step|walk me through|everything|all of|write (it|that|this) up|json|request'
  + '|(?:write|draft|compose|prepare|put together|give me|need|send)\\s+(?:me\\s+)?(?:a|an|the|that|this)\\s+(?:short\\s+|quick\\s+|written\\s+|handover\\s+)*(?:note|message|handover|hand-over|handoff)'
  + '|(?:note|message)\\s+(?:for|to)\\s+\\w+|hand-?over|hand-?off\\s+note)\\b', 'i');

const NOUN_PREV = new Set(['a', 'an', 'the', 'this', 'these', 'those', 'its', 'their', 'our', 'your', 'my', 'his', 'her', 'no', 'any', 'each',
  'every', 'one', 'two', 'some', 'platform', 'feature', 'admin', 'content', 'ship', 'provisioning', 'release', 'kill',
  'build', 'access', 'qa', 'webhook', 'job', 'event', 'events', 'scheduled', 'conversation', 'read', 'env',
  'workspace', 'new', 'same', 'that', 'which', 'what', 'off', 'on', 'vendor', 'signed', 'or', 'and']);
const VERB_PREV = new Set(['to', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'cannot', "can't", 'can’t', "won't",
  'won’t', "don't", 'don’t', "doesn't", 'doesn’t', "didn't", 'didn’t', 'never', 'not', 'it', 'they', 'we', 'i', 'you',
  'he', 'she', 'someone', 'somebody', 'anyone', 'who', 'also', 'automatically', 'only', 'then', 'and', 'or', 'that',
  'which', 'agent', 'bot', 'assistant', 'nothing', 'something', 'emoji', 'reaction']);
const OBJ_NEXT = new Set(['you', 'me', 'it', 'them', 'us', 'him', 'her', 'access', 'permission', 'approval', 'stuck', 'any', 'a', 'an', 'the',
  'this', 'these', 'those', 'its', 'your', 'their', 'his', 'our', 'my', 'every', 'each', 'all', 'messages', 'message',
  'deals', 'pull', 'handovers', 'issues', 'rollback', 'refund', 'refunds', 'alerts', 'alert', 'replies', 'tickets', 'anything']);
const GRANT_OBJ = new Set(['access', 'permission', 'permissions', 'approval', 'you', 'me', 'him', 'her', 'them', 'us', 'someone', 'anyone',
  'people', 'everyone']);
const BLOCKWORDS = /\b(?:webhooks?|jobs?|workflows?|skills?|tools?|processors?|postprocessors?|preprocessors?|primitives?|endpoints?|devices?)\b/i;

/** Port of term_is_noun: is the match at [start, end) used as the internal noun rather than the plain verb? */
function termIsNoun(text, start, end) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const pm = /([A-Za-z][\w'’]*)([^\w\n]*)$/.exec(before);
  const nm = /^[^\w\n]*?([\w'’]+|[=:])/.exec(after);
  const prev = pm && !/[.:;!?,([–—-]/.test(pm[2]) ? pm[1].toLowerCase() : null;
  const nxt = nm ? nm[1].toLowerCase() : null;
  if (/^[’']s\b/.test(after) || /^\s*[=:]/.test(after)) return true;
  if (prev && (prev.endsWith("'s") || prev.endsWith('’s'))) return true;
  if (prev === 'red') return false;
  if (BLOCKWORDS.test((before.match(/[\w-]+/g) ?? []).slice(-3).join(' '))) return true;
  if (['on', 'off', 'body', 'id', 'ids', 'token', 'tokens', 'name', 'names', 'value', 'url', 'json', 'payload'].includes(nxt)) return true;
  if (/[-/_.]$/.test(before) || /^[-/_]\w/.test(after)) return true;
  if (['is', 'are', 'was', 'were', 'has', 'have'].includes(nxt)) return true;
  if (prev === null && ['and', 'or', 'will', 'would', 'can', 'could', 'should', 'must'].includes(nxt)) return true;
  if (NOUN_PREV.has(prev) && !VERB_PREV.has(prev)) return true;
  if (NOUN_PREV.has(prev) && /^\s*(?:[.?!;,)]|$)/.test(after)) return true;
  if (text.slice(start, end).toLowerCase().startsWith('grant')) return !GRANT_OBJ.has(nxt);
  if (VERB_PREV.has(prev) && nxt === 'set') return true;
  if (prev === null || VERB_PREV.has(prev) || OBJ_NEXT.has(nxt)) return false;
  return true;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Vocabulary entries that look like internal names (kebab/snake/dotted/camelCase); plain words are skipped. */
function vocabularyRegexes(vocabulary = [], extraTerms = []) {
  const out = [];
  for (const raw of vocabulary) {
    const w = String(raw ?? '').trim();
    if (w.length >= 4 && (/[-_.]/.test(w) || /[a-z][A-Z]/.test(w))) out.push(new RegExp(`\\b${escapeRe(w)}\\b`, 'i'));
  }
  for (const raw of extraTerms) {
    const w = String(raw ?? '').trim();
    if (w) out.push(new RegExp(`\\b${escapeRe(w)}\\b`, 'i'));
  }
  return out;
}

/**
 * Internal-name hits in `prose`: identifiers, core terms (nouns only for flag/grant/trigger), vocabulary.
 * Words the user used this turn (`said`, a lower-cased string) are not hits. technical -> identifiers only.
 */
export function jargon(prose, { said = '', technical = false, vocabulary = [], extraTerms = [] } = {}) {
  const lower = String(said).toLowerCase();
  const body = String(prose);
  let hits = [...new Set((body.replace(/`/g, '').match(IDENT) ?? []).filter((x) => !lower.includes(x.toLowerCase())))];
  if (!technical) {
    for (const [, rx] of TERM_RE) {
      const g = new RegExp(rx.source, 'gi');
      for (const mm of body.matchAll(g)) {
        const w = mm[0].toLowerCase();
        if (lower.includes(w)) continue;
        if (VERBISH.test(w) && !termIsNoun(body, mm.index, mm.index + mm[0].length)) continue;
        hits.push(w);
      }
    }
    for (const rx of vocabularyRegexes(vocabulary, extraTerms)) {
      const g = new RegExp(rx.source, 'gi');
      for (const mm of body.matchAll(g)) {
        const w = mm[0].toLowerCase();
        if (!lower.includes(w)) hits.push(w);
      }
    }
  }
  hits = [...new Set(hits)].sort();
  return hits;
}

export function syllables(word) {
  let w = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return Math.max(1, (w.match(/[aeiouy]{1,2}/g) ?? []).length);
}

export function flesch(text) {
  const t = String(text);
  const sents = t.split(/(?<=[.!?])\s+|\n+/).filter((s) => /[A-Za-z]/.test(s));
  const words = t.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  if (words.length === 0 || sents.length === 0) return 100.0;
  const syl = words.reduce((a, w) => a + syllables(w), 0);
  return Math.round((206.835 - 1.015 * (words.length / sents.length) - 84.6 * (syl / words.length)) * 10) / 10;
}

/** Clock times ("13:32") and decimals ("4.5") count as one word. */
export function countWords(text) {
  return (String(text).match(/\d+(?:[:.,]\d+)+|[A-Za-z0-9][\w'’-]*/g) ?? []).length;
}

const STOCK = /couldn['’]t come up with a reply|could you rephrase it or try again|something went wrong\. please try again|couldn['’]t answer that one just now/i;
const NOTE_LEADIN = /\b(?:notes?|forward(?:ed|ing)?|paste|copy|send|pass (?:it|this|that) on|pass to|hand (?:it|this) (?:over|on)|builder|developer|admin|exact change|the change|this change|the plan|the summary|summary to)\b/i;
const RULE = /^[ \t]*---[ \t]*$/gm;

function normLine(s) {
  let x = String(s).replace(/\s+/g, ' ').trim();
  x = x.replace(/^\d+[.)]\s*/, '');
  x = x.replace(/\s*\((?:recommended)\)\s*$/i, '');
  return (x.toLowerCase().match(/[\w'’]+/g) ?? []).join(' ');
}

/** Lines from the tool fields the rubric treats as extras: terms/scorecard (blocks) and choice labels. */
export function toolExtras(toolCalls) {
  const blocks = new Set();
  const choices = new Set();
  const addLines = (set, v) => {
    for (const l of String(v).split('\n')) {
      const n = normLine(l);
      if (n) set.add(n);
    }
  };
  const walk = (o) => {
    if (Array.isArray(o)) {
      o.forEach(walk);
    } else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if ((k === 'terms' || k === 'scorecard') && typeof v === 'string') addLines(blocks, v);
        else if (k === 'numbered' && typeof v === 'string') addLines(choices, v);
        else if (k === 'options' && Array.isArray(v)) {
          for (const x of v) {
            const lab = typeof x === 'string' ? x : x && typeof x === 'object' ? x.label : null;
            if (typeof lab === 'string') choices.add(normLine(lab));
          }
          walk(v);
        } else walk(v);
      }
    }
  };
  for (const c of toolCalls ?? []) {
    let out = c?.output;
    if (typeof out === 'string' && /^\s*[{[]/.test(out)) {
      try {
        out = JSON.parse(out);
      } catch { /* leave as string */ }
    }
    walk(out);
  }
  return { blocks, choices };
}

const stripDetails = (s) => s.replace(/<details>[\s\S]*?<\/details>/g, '');

/**
 * Order: details, fences, `---` notes, tool lines. A terms/scorecard line the person already saw (`shown`), or any line an
 * earlier turn showed as terms/scorecard (`shownTerms`), shown again is prose again: an unchanged repeat is an H1 defect.
 * @returns {{prose:string, extras:string[], choice:string, kinds:string[], blockNorms:string[], repeats:number}}
 */
export function splitReply(reply, toolBlocks, toolChoices, shown = new Set(), shownTerms = new Set()) {
  let r = stripDetails(String(reply));
  const extras = [];
  const kinds = [];
  r = r.replace(/(`{3,})[\s\S]*?\1/g, (m) => {
    extras.push(m);
    kinds.push('fence');
    return '\n';
  });
  const out = [];
  let pos = 0;
  const rules = [...r.matchAll(RULE)];
  let i = 0;
  while (i + 1 < rules.length) {
    const a = rules[i];
    const b = rules[i + 1];
    const inner = r.slice(a.index + a[0].length, b.index);
    if (inner.trim() && NOTE_LEADIN.test(r.slice(pos, a.index))) {
      out.push(r.slice(pos, a.index));
      extras.push(inner);
      kinds.push('note');
      pos = b.index + b[0].length;
      i += 2;
    } else i += 1;
  }
  out.push(r.slice(pos));
  r = out.join('\n');
  const prose = [];
  const block = [];
  const choice = [];
  const blockNorms = [];
  let rep = 0;
  let cardRep = 0;
  const lines = r.split('\n');
  lines.forEach((line, k) => {
    const n = normLine(line);
    const header = line.trimStart().startsWith('|') && k + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[k + 1]);
    if (n && n.split(' ').length >= 4 && !header && ((toolBlocks.has(n) && shown.has(n)) || shownTerms.has(n))) {
      prose.push(line);
      rep++;
    } else if (n && toolBlocks.has(n)) {
      block.push(line);
      blockNorms.push(n);
    } else if (n && /^\s*\d+[.)]\s/.test(line) && toolChoices.has(n)) {
      choice.push(line);
    } else {
      prose.push(line);
      if (n && n.split(' ').length >= 4 && shown.has(n) && /^\s*[-*•]\s/.test(line)) cardRep++;
    }
  });
  if (block.length || choice.length) rep += cardRep;
  if (block.length) {
    extras.push(block.join('\n'));
    kinds.push('terms/scorecard');
  }
  const p = prose.join('\n').replace(/https?:\/\/\S+/g, ' ');
  if (choice.length) kinds.push('choice');
  return { prose: p.trim(), extras, choice: choice.join('\n'), kinds, blockNorms, repeats: rep };
}

/**
 * @param {object[]} turnRows turns.jsonl rows (user, reply, seconds, toolCalls)
 * @returns {{rows: object[], fails: number}}
 */
export function gradeTurns(turnRows, { technical = false, limits = {}, vocabulary = [], extraTerms = [] } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const rows = [];
  let fails = 0;
  const seen = new Set();
  const blocks = new Set();
  const choices = new Set();
  const shown = new Set();
  const shownTerms = new Set();
  turnRows.forEach((tr, i) => {
    const user = String(tr.user ?? '');
    const reply = String(tr.reply ?? '');
    const ex = toolExtras(tr.toolCalls);
    ex.blocks.forEach((x) => blocks.add(x));
    ex.choices.forEach((x) => choices.add(x));
    const sp = splitReply(reply, blocks, choices, shown, shownTerms);
    sp.blockNorms.forEach((x) => shownTerms.add(x));
    stripDetails(reply).split('\n').forEach((l) => shown.add(normLine(l)));
    let prose = sp.prose;
    const kept = [];
    let repeats = sp.repeats;
    for (const x of sp.extras) {
      const key = x.replace(/\s+/g, ' ').trim();
      if (key && seen.has(key)) {
        prose += `\n${x}`;
        repeats++;
      } else {
        kept.push(x);
        if (key) seen.add(key);
      }
    }
    const full = stripDetails(reply);
    const words = countWords(prose);
    const extraWords = countWords(`${kept.join('\n')}\n${sp.choice}`);
    // A detail request is the person's own ask, not a word inside text they pasted: only the first 200 characters count.
    const limit = DETAIL.test(user.slice(0, 200)) ? lim.detailMaxWords : lim.maxWords;
    const fre = flesch(prose.replace(/[*_#>|`-]/g, ' '));
    const said = user.toLowerCase();
    const opts = { said, technical, vocabulary, extraTerms };
    const hits = jargon(prose, opts);
    const xhits = jargon(`${kept.join('\n')}\n${sp.choice}`.replace(/https?:\/\/\S+/g, ' '), opts).filter((h) => !hits.includes(h));
    const minFre = technical ? lim.technicalMinFlesch : lim.minFlesch;
    const why = [];
    if (hits.length) why.push(`jargon ${JSON.stringify(hits)}`);
    if (words > limit) why.push(`${words} words > ${limit}`);
    if (countWords(full) === 0) why.push('empty reply (dead end)');
    if (STOCK.test(full)) why.push('stock fallback reply (dead end)');
    if (fre < minFre) why.push(`Flesch ${fre} < ${minFre}`);
    if (repeats) why.push(`${repeats} unchanged repeat(s) of terms/scorecard lines or a note already shown`);
    const seconds = typeof tr.seconds === 'number' ? tr.seconds : null;
    const slow = seconds !== null && seconds > lim.slowTurnSeconds;
    if (why.length) fails++;
    rows.push({
      turn: tr.turn ?? i + 1, seconds, slow, words, limit, extraWords, extraKinds: sp.kinds,
      flesch: fre, jargon: hits, extraJargon: xhits, repeatedExtras: repeats, fail: why,
    });
  });
  return { rows, fails };
}

function summarise(rows, fails, technical) {
  const secs = rows.map((r) => r.seconds).filter((s) => s !== null).sort((a, b) => a - b);
  return {
    schema: 'lua-qa/readability@1',
    technical,
    fails,
    slowTurns: rows.filter((r) => r.slow).length,
    medianSeconds: secs.length ? secs[Math.floor(secs.length / 2)] : null,
    maxSeconds: secs.length ? secs[secs.length - 1] : null,
    turns: rows,
  };
}

/** Used by prechecks and the CLI: grade a run folder's turns with the run's settings. */
export async function readabilityForRun({ runDir, cardId, k, attempt = 1, technical }) {
  const run = await loadRun(runDir);
  const { paths } = await loadRecord(runDir, { card: cardId, run: k, attempt });
  const rows = await readJsonl(paths.turns);
  const card = await readJsonOr(join(runDir, 'plan', 'cards', `${cardId}.json`), {});
  const model = await readJsonOr(join(runDir, 'discovery', 'flow-model.json'), {});
  const tech = technical ?? card?.persona?.technical === true;
  const { rows: graded, fails } = gradeTurns(rows, {
    technical: tech, limits: run.readability, vocabulary: model?.vocabulary ?? [], extraTerms: run.readability?.extraTerms ?? [],
  });
  return { result: summarise(graded, fails, tech), paths };
}

export async function cliReadability(argv, io) {
  try {
    const flags = {
      'run-dir': { type: 'string' }, card: { type: 'string' }, run: { type: 'number' }, attempt: { type: 'number' },
      technical: { type: 'boolean' }, 'turns-file': { type: 'string' }, 'vocabulary-file': { type: 'string' }, json: { type: 'boolean' },
    };
    const { values: v } = parseArgs(argv, flags);
    let result;
    if (v['turns-file']) {
      const path = io.cwd && !v['turns-file'].startsWith('/') ? join(io.cwd, v['turns-file']) : v['turns-file'];
      let rows = null;
      try {
        const parsed = await readJson(path);
        if (Array.isArray(parsed)) rows = parsed;
        else if (Array.isArray(parsed?.turns)) rows = parsed.turns;
      } catch { /* not a single JSON document: try JSONL */ }
      if (!rows) rows = await readJsonl(path);
      let vocabulary = [];
      if (v['vocabulary-file']) vocabulary = (await readJsonOr(join(io.cwd, v['vocabulary-file']), [])) ?? [];
      const { rows: graded, fails } = gradeTurns(rows, { technical: !!v.technical, vocabulary });
      result = summarise(graded, fails, !!v.technical);
    } else {
      if (!v['run-dir'] || !v.card || v.run === undefined) {
        throw new QaError('USAGE', 2, 'Pass --run-dir, --card and --run, or --turns-file');
      }
      const runDir = resolveRunDir(io, v['run-dir']);
      const out = await readabilityForRun({ runDir, cardId: v.card, k: v.run, attempt: v.attempt ?? 1, technical: v.technical ? true : undefined });
      result = out.result;
      await writeJson(join(out.paths.checks, 'readability.json'), result);
    }
    emit(io, { ok: result.fails === 0, fails: result.fails, slowTurns: result.slowTurns, medianSeconds: result.medianSeconds, maxSeconds: result.maxSeconds, turns: result.turns });
    return result.fails > 0 ? 1 : 0;
  } catch (err) {
    return fail(io, err);
  }
}


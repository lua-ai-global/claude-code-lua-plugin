// `cards write`: the planner writes one bundle file with the Write tool, and this helper splits it into
// plan/cards/<id>.json plus the three test plans. Twenty-odd separate Write calls (or a generator script, which the
// cartographer's Bash allowlist rightly refuses) become one Write and one helper call.
//
// Bundle: { schema: 'lua-qa/plan-bundle@1', cards: [card...], flowTests?: {...}, toolTests?: {...}, stress?: {...} }
// A card or plan with no `schema` field gets its own (`lua-qa/card@1`, `lua-qa/flow-tests@1`, `lua-qa/tool-tests@1`,
// `lua-qa/stress-plan@1`); a wrong one is left as it is and reported.
// The write is all or nothing. Hard refusals (exit 3): a card id that is not icp-NN / rt-NN (it becomes a file name),
// a duplicate id, or real-looking contact data. Schema errors (exit 1) also write nothing: fix the bundle and run
// `cards write` again.

import { readdir, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { CARD_ID_RE, QaError, emit, fail, parseArgs, readJson, resolveRunDir, writeText } from './io.mjs';
import { loadRun, loadState } from './state.mjs';
import { checkTestData, fakeDataHint, testDataPolicy } from './safety.mjs';
import { validate } from './schemas.mjs';

const PLAN_FILES = Object.freeze([
  ['flowTests', 'flow-tests.json', 'flow-tests'],
  ['toolTests', 'tool-tests.json', 'tool-tests'],
  ['stress', 'stress.json', 'stress-plan'],
]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The bundle with each card's and plan's `schema` filled in where it is missing (the planner need not write it).
 * A present value, right or wrong, is kept, so a wrong one is still reported. Non-objects pass through unchanged.
 */
export function withDefaultSchemas(bundle) {
  if (!isObj(bundle)) return bundle;
  const fill = (obj, name) => {
    if (!isObj(obj) || obj.schema !== undefined) return obj;
    const { schema: _absent, ...rest } = obj; // eslint-disable-line no-unused-vars
    return { schema: `lua-qa/${name}@1`, ...rest };
  };
  const out = { ...bundle };
  if (Array.isArray(bundle.cards)) out.cards = bundle.cards.map((c) => fill(c, 'card'));
  for (const [key, , schema] of PLAN_FILES) if (bundle[key] !== undefined) out[key] = fill(bundle[key], schema);
  return out;
}
const inside = (root, p) => {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Resolves the bundle path and refuses one outside the run folder or inside plan/cards (it would read as a card). */
async function bundlePath(runDir, io, file) {
  const abs = isAbsolute(file) ? file : resolve(io.cwd, file);
  let real;
  let root;
  try {
    real = await realpath(abs);
    root = await realpath(runDir);
  } catch {
    throw new QaError('USAGE', 2, `${file} is missing`, 'Write the bundle with the Write tool first, e.g. <runDir>/plan/bundle.json.');
  }
  if (!inside(root, real)) throw new QaError('PATH_REFUSED', 3, 'The bundle must be inside the run folder', 'Write it to <runDir>/plan/bundle.json.');
  if (inside(join(root, 'plan', 'cards'), real)) {
    throw new QaError('PATH_REFUSED', 3, 'The bundle must not be inside plan/cards (every file there is read as a card)', 'Write it to <runDir>/plan/bundle.json.');
  }
  return real;
}

/**
 * Checks a bundle without writing. `refusals` stop the whole write; `errors` are schema problems reported after it.
 * @returns {{refusals: string[], errors: string[]}}
 */
export function checkBundle(bundle, policy) {
  const refusals = [];
  const errors = [];
  if (!isObj(bundle)) return { refusals: ['the bundle must be a JSON object'], errors };
  if (bundle.cards !== undefined && !Array.isArray(bundle.cards)) refusals.push('cards must be an array');
  const cards = Array.isArray(bundle.cards) ? bundle.cards : [];
  const ids = new Set();
  cards.forEach((card, i) => {
    const id = isObj(card) ? card.id : undefined;
    if (typeof id !== 'string' || !CARD_ID_RE.test(id)) {
      refusals.push(`cards[${i}]: id must look like icp-03 or rt-02 (it becomes the file name)`);
      return;
    }
    if (ids.has(id)) refusals.push(`cards[${i}]: duplicate id ${id}`);
    ids.add(id);
    for (const viol of checkTestData(JSON.stringify(card), policy).violations) refusals.push(`${id}: ${viol.kind} "${viol.value}" is not fake test data`);
    const v = validate('card', card, { testData: policy });
    if (!v.ok) errors.push(...v.errors.map((e) => `${id}: ${e}`));
  });
  for (const [key, file, schema] of PLAN_FILES) {
    if (bundle[key] === undefined) continue;
    if (!isObj(bundle[key])) {
      refusals.push(`${key} must be an object`);
      continue;
    }
    for (const viol of checkTestData(JSON.stringify(bundle[key]), policy).violations) refusals.push(`${key}: ${viol.kind} "${viol.value}" is not fake test data`);
    const v = validate(schema, bundle[key], { testData: policy });
    if (!v.ok) errors.push(...v.errors.map((e) => `${file}: ${e}`));
  }
  if (!cards.length && !PLAN_FILES.some(([key]) => bundle[key] !== undefined)) refusals.push('the bundle has no cards and no test plans');
  return { refusals, errors };
}

const SPEC = {
  'run-dir': { type: 'string', required: true },
  file: { type: 'string', required: true },
  replace: { type: 'boolean' },
  json: { type: 'boolean' },
};

/** `cards write --run-dir D --file <runDir>/plan/bundle.json [--replace]` */
export async function cliCards(argv, io) {
  try {
    const { values: v, positionals } = parseArgs(argv, SPEC);
    if (positionals.length !== 1 || positionals[0] !== 'write') {
      throw new QaError('USAGE', 2, 'Usage: cards write --run-dir <runDir> --file <bundle.json> [--replace]');
    }
    const runDir = resolveRunDir(io, v['run-dir']);
    const run = await loadRun(runDir);
    const state = await loadState(runDir);
    const policy = testDataPolicy(run, state);
    const path = await bundlePath(runDir, io, v.file);
    let bundle;
    try {
      bundle = withDefaultSchemas(await readJson(path));
    } catch {
      throw new QaError('USAGE', 2, `${v.file} is not valid JSON`);
    }
    const { refusals, errors } = checkBundle(bundle, policy);
    if (refusals.length) {
      emit(io, { ok: false, code: 'BUNDLE_REFUSED', message: `Nothing was written: ${refusals.length} problem(s)`, written: [], refusals: refusals.slice(0, 40), hint: fakeDataHint(policy) });
      return 3;
    }
    // All or nothing: a schema error writes no file, so a half-good plan never sits in plan/ looking written.
    if (errors.length) {
      emit(io, {
        ok: false, code: 'BUNDLE_INVALID', message: `Nothing was written: ${errors.length} schema error(s) in the bundle`, written: [], removed: [],
        errors: errors.slice(0, 60), next: `Fix ${v.file} and run cards write again.`,
      });
      return 1;
    }
    const cardsDir = join(runDir, 'plan', 'cards');
    const written = [];
    for (const card of bundle.cards ?? []) {
      // Written as given (no redaction): a red-team card's obviously fake secret is test data the player must send.
      await writeText(join(cardsDir, `${card.id}.json`), `${JSON.stringify(card, null, 2)}\n`);
      written.push(['plan', 'cards', `${card.id}.json`].join('/'));
    }
    for (const [key, file] of PLAN_FILES) {
      if (bundle[key] === undefined) continue;
      await writeText(join(runDir, 'plan', file), `${JSON.stringify(bundle[key], null, 2)}\n`);
      written.push(`plan/${file}`);
    }
    const removed = [];
    if (v.replace) {
      const keep = new Set((bundle.cards ?? []).map((c) => `${c.id}.json`));
      const present = await readdir(cardsDir).catch(() => []);
      for (const f of present.filter((n) => n.endsWith('.json') && !keep.has(n))) {
        await rm(join(cardsDir, f), { force: true });
        removed.push(['plan', 'cards', f].join('/'));
      }
    }
    emit(io, {
      ok: true, written, removed, errors: [],
      ...(state.gates?.plan ? { planGate: 'The plan gate was stamped before this write: show the change and stamp it again.' } : {}),
      next: 'Run validate --what plan.',
    });
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

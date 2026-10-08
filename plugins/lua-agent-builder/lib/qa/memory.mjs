// Platform memory that outlives a chat thread. Every QA player chats as the same signed-in lua user, so an agent with
// cross-chat (personal) or org memory can recall what an earlier persona said in a later run. Discovery reads the
// agent's features (`lua features list --ci`, verified against lua-cli 3.45.0 src/commands/features.ts: plain text,
// "Name: <name>" and "Status: Active|Inactive" per feature, no --json) and the environment gate records the result.
//
// The helpers never switch a feature: `lua features disable|enable` is an `ask` rule the user approves at the prompt.
// The gate only records the user's consent and the restore list (before anything is disabled), `memory --check off`
// verifies the switch, and cleanup always lists the restore commands until `memory --check restored` sees them on.
//
// Feature names: lua-agents src/services/bootstrap/bootstrap.service.ts. luaMemoryCrossChatEnabled is the master gate
// of personal memory (inactive: every luaMemory* capability stays off); memoryWrite/memoryRecall are org memory about
// the person talking. observationalMemory compresses one thread and luaMemoryEpisodicShadow never reaches the prompt,
// so neither carries anything across runs.

import { join } from 'node:path';
import { QaError, emit, fail, parseArgs, readJsonOr, resolveRunDir } from './io.mjs';

export const PERSONAL_MEMORY_MASTER = 'luaMemoryCrossChatEnabled';
export const PERSONAL_MEMORY_FEATURES = Object.freeze([
  PERSONAL_MEMORY_MASTER,
  'luaMemoryProfileRead',
  'luaMemoryProfileWrite',
  'luaMemoryExactRecall',
  'luaMemoryEpisodicInjection',
  'luaMemoryAutomaticExtraction',
]);
export const ORG_MEMORY_FEATURES = Object.freeze(['memoryWrite', 'memoryRecall']);
/** The only features a QA run may ask the user to switch off, and so the only ones cleanup ever restores. */
export const CROSS_RUN_MEMORY_FEATURES = Object.freeze([...PERSONAL_MEMORY_FEATURES, ...ORG_MEMORY_FEATURES]);

export const MEMORY_CONSENT_TEXT = 'I consent to turning off agent memory for this test run';

export function isMemoryConsentText(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === MEMORY_CONSENT_TEXT.toLowerCase();
}

const FEATURE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Parses `lua features list` output into [{name, title, active}]. Returns [] for "No features available" and null
 * when the text holds no feature block at all (an error, a banner only): unknown, never "off".
 */
export function parseFeaturesList(text) {
  const out = [];
  let cur = null;
  const raw = String(text ?? '');
  for (const line of raw.split(/\r?\n/)) {
    const head = /^\s*\d+\.\s+(?:\S+\s+)?(.+?)\s*$/.exec(line);
    const name = /^\s*Name:\s*(\S+)\s*$/.exec(line);
    const status = /^\s*Status:\s*(Active|Inactive)\b/i.exec(line);
    if (head && !name && !status) {
      cur = { name: null, title: head[1], active: null };
      out.push(cur);
    } else if (name && cur) cur.name = name[1];
    else if (status && cur) cur.active = status[1].toLowerCase() === 'active';
  }
  const features = out.filter((f) => f.name && FEATURE_NAME_RE.test(f.name) && typeof f.active === 'boolean');
  if (features.length) return features;
  return /No features available/i.test(raw) ? [] : null;
}

/**
 * What the agent's features mean for cross-run isolation.
 * status: 'active' (some memory carries across chats), 'off' (none does), 'unknown' (the list could not be read).
 * active: the memory features to switch off for the test window (and restore afterwards).
 */
export function memoryFromFeatures(features) {
  if (!Array.isArray(features)) return { status: 'unknown', active: [], personal: [], org: [], dormant: [] };
  const on = new Set(features.filter((f) => f && f.active === true).map((f) => f.name));
  const personalOn = PERSONAL_MEMORY_FEATURES.filter((n) => on.has(n));
  // With the master gate off the personal sub-flags do nothing: they are dormant, not a cross-run risk.
  const personal = on.has(PERSONAL_MEMORY_MASTER) ? personalOn : [];
  const dormant = personalOn.filter((n) => !personal.includes(n));
  const org = ORG_MEMORY_FEATURES.filter((n) => on.has(n));
  const active = [...personal, ...org];
  return { status: active.length ? 'active' : 'off', active, personal, org, dormant };
}

async function loadRunLua(deps) {
  if (deps.runLua) return deps.runLua;
  return (await import('./spawn.mjs')).runLua;
}

/** Reads the agent's features with `lua features list --ci` (read-only). Never throws for a lua failure. */
export async function readFeatures({ projectDir, deps = {}, timeoutMs = 60_000 }) {
  const runLua = await loadRunLua(deps);
  let r;
  try {
    r = await runLua(['features', 'list', '--ci'], { cwd: projectDir, timeoutMs, deps });
  } catch (err) {
    return { ok: false, features: null, note: String(err?.message ?? err).split('\n')[0].slice(0, 200) };
  }
  if (r.timedOut || r.exitCode !== 0) {
    const why = r.timedOut ? 'timed out' : `exit ${r.exitCode}: ${String(r.stderr || r.stdout || '').trim().split('\n').pop()?.slice(0, 160) ?? ''}`;
    return { ok: false, features: null, note: `lua features list ${why}`.trim() };
  }
  const features = parseFeaturesList(r.stdout);
  if (!features) return { ok: false, features: null, note: 'lua features list printed no feature list' };
  return { ok: true, features, note: null };
}

/** The discovery/features.json document. */
export function featuresDoc(read, at) {
  return { schema: 'lua-qa/features@1', checkedAt: at, ok: read.ok, note: read.note, features: read.features, memory: memoryFromFeatures(read.features) };
}

/**
 * The environment gate's memory record. `mode`: 'off' (the user consented to switching memory off for the test
 * window) or 'caveat' (keep it; memory findings are marked). Without a mode, active or unknown memory is a caveat.
 * @param {object|null} doc discovery/features.json
 */
export function memoryStamp(doc, { mode, consentText, at }) {
  const mem = doc?.memory ?? memoryFromFeatures(null);
  const base = { status: mem.status, active: [...(mem.active ?? [])], checkedAt: doc?.checkedAt ?? null };
  if (mode === 'off') {
    if (mem.status !== 'active') {
      throw new QaError('USAGE', 2, `--memory off needs memory that discovery found active (it found: ${mem.status})`, 'Run discover again; with memory off or unknown use --memory caveat.');
    }
    if (!isMemoryConsentText(consentText)) {
      throw new QaError('MEMORY_CONSENT', 3, 'Switching agent memory off needs the user\'s explicit consent text', `Ask the user; only the option "${MEMORY_CONSENT_TEXT}" allows it. Otherwise use --memory caveat.`);
    }
    const restore = base.active.filter((n) => CROSS_RUN_MEMORY_FEATURES.includes(n));
    return { ...base, mitigation: 'off-for-run', restore, consentAt: at };
  }
  return { ...base, mitigation: mem.status === 'off' ? 'none' : 'caveat', restore: [] };
}

/** Features cleanup may switch back on: on the allowlist AND active when discovery read them (a tampered state cannot add any). */
export function restorableFeatures(state, doc) {
  const wanted = Array.isArray(state?.memoryRestore?.features) ? state.memoryRestore.features : [];
  const wasActive = new Set(doc?.memory?.active ?? []);
  return [...new Set(wanted)].filter((n) => CROSS_RUN_MEMORY_FEATURES.includes(n) && wasActive.has(n));
}

export const disableCommand = (name) => `lua features disable --feature-name ${name} --ci`;
export const enableCommand = (name) => `lua features enable --feature-name ${name} --ci`;

const CHECK_SPEC = {
  'run-dir': { type: 'string', required: true },
  check: { type: 'string', required: true, choices: ['status', 'off', 'restored'] },
  json: { type: 'boolean' },
};

/**
 * `memory --run-dir D --check status|off|restored`: reads the features again. `off` records that the features the
 * user agreed to switch off are off (start-run needs it); `restored` records that they are back on.
 */
export async function cliMemory(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, CHECK_SPEC);
    const runDir = resolveRunDir(io, v['run-dir']);
    const { loadRun, loadState, saveState } = await import('./state.mjs');
    const run = await loadRun(runDir);
    const state = await loadState(runDir);
    const doc = await readJsonOr(join(runDir, 'discovery', 'features.json'));
    const names = restorableFeatures(state, doc);
    if (v.check !== 'status' && !names.length) throw new QaError('USAGE', 2, 'No memory feature was switched off for this run', 'Only a run stamped with --memory off has anything to check.');
    const read = await readFeatures({ projectDir: run.projectDir, deps });
    const memory = memoryFromFeatures(read.features);
    const on = new Set((read.features ?? []).filter((f) => f.active).map((f) => f.name));
    const nowIso = (deps.now ?? (() => new Date()))().toISOString();
    if (v.check === 'status') {
      emit(io, { ok: read.ok, memory, ...(read.note ? { note: read.note } : {}), restorable: names });
      return 0;
    }
    if (!read.ok) throw new QaError('FEATURES_UNREADABLE', 5, `Could not read the agent's features (${read.note})`, 'Retry the check; nothing is recorded until lua features list answers.');
    if (v.check === 'off') {
      const stillOn = names.filter((n) => on.has(n));
      if (!stillOn.length) state.memoryRestore = { ...state.memoryRestore, verifiedOffAt: nowIso };
      await saveState(runDir, state);
      emit(io, { ok: stillOn.length === 0, stillOn, ...(stillOn.length ? { commands: stillOn.map(disableCommand), hint: 'Run these (each asks for approval), then check again.' } : { verifiedOffAt: nowIso }) });
      return stillOn.length ? 1 : 0;
    }
    const stillOff = names.filter((n) => !on.has(n));
    if (!stillOff.length) state.memoryRestore = { ...state.memoryRestore, restoredAt: nowIso };
    await saveState(runDir, state);
    emit(io, { ok: stillOff.length === 0, stillOff, ...(stillOff.length ? { commands: stillOff.map(enableCommand), hint: 'Restore these now (each asks for approval), then check again.' } : { restoredAt: nowIso }) });
    return stillOff.length ? 1 : 0;
  } catch (err) {
    return fail(io, err);
  }
}

// Run directory, hard gates and the sandbox chat lock.
// Gates are stamped in state.json; helpers that touch the agent refuse to run until they are stamped.

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { QaError, emit, fail, hex, newRunId, parseArgs, readJson, readJsonOr, resolveRunDir, writeJson } from './io.mjs';
import { validate, validatePlan } from './schemas.mjs';
import { runLua } from './spawn.mjs';
import { PLUGIN_VERSION } from './api.mjs';
import { parseAllowedEmailDomains } from './safety.mjs';
import { parseTier, runTier, tierBar, tierCounts, tierOf } from './tiers.mjs';
import { disableCommand, memoryStamp } from './memory.mjs';

export const GATE_ORDER = Object.freeze(['discovery', 'questions', 'environment', 'plan']);
export const DEFAULT_MODELS = Object.freeze({
  player: 'sonnet', redTeamPlayer: 'opus', grader: 'opus', analyst: 'opus', cartographer: 'opus', reporter: 'sonnet', mechanics: 'sonnet',
});

/**
 * The exact answer the user must pick for production (or staged without a test session). commands/lua-qa.md offers
 * this string as the AskUserQuestion option; any other text (`Cancel`, `no`, a paraphrase) is refused.
 */
export const PRODUCTION_CONSENT_TEXT = 'I consent to running this against production';

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/** True only for the consent option itself (whitespace and case are normalised, nothing else). */
export function isConsentText(text) {
  const norm = (x) => String(x ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(text) === norm(PRODUCTION_CONSENT_TEXT);
}

/** Files the plan gate seals: every card plus the three test plans. */
export async function computePlanHash(runDir) {
  let cards = [];
  try {
    cards = (await readdir(join(runDir, 'plan', 'cards'))).filter((n) => n.endsWith('.json')).sort();
  } catch { /* no cards: hashed as an empty list */ }
  const h = createHash('sha256');
  for (const rel of [...cards.map((n) => `cards/${n}`), 'flow-tests.json', 'tool-tests.json', 'stress.json']) {
    let buf = null;
    try {
      buf = await readFile(join(runDir, 'plan', ...rel.split('/')));
    } catch { /* missing file hashes as a marker */ }
    h.update(`${rel}\0`);
    h.update(buf ?? '<missing>');
    h.update('\0');
  }
  return h.digest('hex');
}

const nowIso = (deps) => (deps?.now ?? (() => new Date()))().toISOString();

export function readAgentIdFromYaml(text) {
  const m = /agentId:\s*["']?([^\s"']+)/.exec(text ?? '');
  return m ? m[1] : null;
}

export async function loadRun(runDir) {
  const run = await readJsonOr(join(runDir, 'run.json'));
  if (!run) throw new QaError('NO_RUN', 2, `No run found at ${runDir}`, 'Run init-run first, or pass the right --run-dir.');
  return run;
}

export async function loadState(runDir) {
  const state = await readJsonOr(join(runDir, 'state.json'));
  if (!state) throw new QaError('NO_RUN', 2, `No state.json at ${runDir}`, 'Run init-run first.');
  return state;
}

export async function saveState(runDir, state) {
  await writeJson(join(runDir, 'state.json'), state);
}

export async function pushHistory(runDir, event, detail, deps) {
  const state = await loadState(runDir);
  state.history.push({ at: nowIso(deps), event, detail: String(detail ?? '').slice(0, 300) });
  await saveState(runDir, state);
}

/** True when real side effects are possible, so an explicit consent token is required. */
export function needsConsent(run) {
  const env = run.environment ?? {};
  return env.kind === 'production' || (env.kind === 'staged' && !env.testSession);
}

/**
 * Throws QaError(…, 3) when a needed gate is not stamped, when the plan files changed after the plan gate (whenever
 * `plan` is needed), or (opt-in) when consent is required and the token does not hash to the stamped one.
 * @param {string} runDir
 * @param {string[]} needed gate names
 * @param {{consent?: string|null, requireConsent?: boolean}} [opts]
 */
export async function assertGates(runDir, needed, { consent = null, requireConsent = false } = {}) {
  const state = await loadState(runDir);
  for (const g of needed) {
    if (!state.gates?.[g]) {
      throw new QaError('GATE_MISSING', 3, `The ${g} gate is not stamped yet`, `Confirm the ${g} step with the user, then run: gate --stamp ${g}.`);
    }
  }
  if (needed.includes('plan')) {
    const sealed = state.gates.plan.planHash;
    if (!sealed) {
      throw new QaError('PLAN_UNSEALED', 3, 'The plan gate carries no plan hash', 'Show the plan to the user again, then run: gate --stamp plan.');
    }
    if ((await computePlanHash(runDir)) !== sealed) {
      throw new QaError('PLAN_CHANGED', 3, 'The plan files changed after the plan gate was stamped', 'Show the user the change, run validate --what plan, then stamp the plan gate again.');
    }
  }
  if (requireConsent) {
    const run = await loadRun(runDir);
    if (needsConsent(run)) {
      const want = state.gates?.environment?.productionConsent?.tokenSha256;
      if (!want || typeof consent !== 'string' || !consent || sha256(consent) !== want) {
        throw new QaError('PRODUCTION_CONSENT', 3, 'This run touches real traffic or real side effects and needs the production consent token', 'Pass --production-consent <token> printed when the environment gate was stamped.');
      }
    }
  }
  return { state };
}

// ---------------------------------------------------------------- init-run

async function readLuaCliVersion(cwd, deps) {
  try {
    const r = await runLua(['--version'], { cwd, timeoutMs: 15_000, deps });
    const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout} ${r.stderr}`);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function buildEnvironment({ env, agentVersion, noTestSession }) {
  if (env === 'staged') {
    if (!Number.isInteger(agentVersion) || agentVersion < 1) {
      throw new QaError('USAGE', 2, '--agent-version <n> (an integer >= 1) is required for a staged environment');
    }
    return { kind: 'staged', agentVersion, testSession: !noTestSession, logEnvironment: 'production' };
  }
  if (env === 'production') return { kind: 'production', agentVersion: null, testSession: null, logEnvironment: 'production' };
  return { kind: 'sandbox', agentVersion: null, testSession: null, logEnvironment: 'sandbox' };
}

/** The pass bar for the tier: smoke 1 of 1, medium 3 of 3 (or 4 of 5 with --runs 5), production-ready 4 of 5. */
function buildBar(tier, runs) {
  return tierBar(tier, runs);
}

const INIT_SPEC = {
  project: { type: 'string', required: true },
  mode: { type: 'string', required: true, choices: ['full', 'quick'] },
  env: { type: 'string', required: true, choices: ['sandbox', 'staged', 'production'] },
  'agent-version': { type: 'number' },
  'no-test-session': { type: 'boolean' },
  runs: { type: 'number', choices: ['1', '3', '5'] },
  tier: { type: 'string', choices: ['smoke', 'medium', 'production-ready'] },
  icp: { type: 'number' },
  'red-team': { type: 'number' },
  'add-gitignore': { type: 'boolean' },
  json: { type: 'boolean' },
};

export async function cliInitRun(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, INIT_SPEC);
    const projectDir = resolve(io.cwd, v.project);
    const tierId = parseTier(v.tier);
    const tier = tierOf(tierId);
    const { icp, redTeam } = tierCounts(tier, { icp: v.icp, redTeam: v['red-team'] });
    const bar = buildBar(tier, v.runs);
    const environment = buildEnvironment({ env: v.env, agentVersion: v['agent-version'], noTestSession: v['no-test-session'] });
    const runId = newRunId(deps);
    const runDir = join(projectDir, '.lua-qa', 'runs', runId);
    let agentId = null;
    try {
      agentId = readAgentIdFromYaml(await readFile(join(projectDir, 'lua.skill.yaml'), 'utf8'));
    } catch { /* not a lua project yet: preflight reports it */ }
    const run = {
      schema: 'lua-qa/run@1',
      runId,
      mode: v.mode,
      tier: tierId,
      createdAt: nowIso(deps),
      projectDir,
      pluginVersion: PLUGIN_VERSION,
      luaCliVersion: await readLuaCliVersion(projectDir, deps),
      agent: { id: agentId, name: agentId ?? 'agent', model: null },
      environment,
      bar,
      counts: { icp, redTeam },
      models: { ...DEFAULT_MODELS },
      readability: { maxWords: 120, detailMaxWords: 250, minFlesch: 50, technicalMinFlesch: 30, slowTurnSeconds: 60, extraTerms: [] },
      allowedDomains: [],
      timeouts: { turnSeconds: 90, cliSeconds: 110 },
    };
    const state = {
      schema: 'lua-qa/state@1',
      runId,
      // The authoritative tier and bar: only init-run (and the environment gate, for the bar) write them; the planner
      // may edit run.json, never this. `clockStartedAt` (a capped tier's clock) is set when the plan gate is stamped.
      tier: tierId,
      bar,
      clockStartedAt: null,
      gates: { discovery: null, questions: null, environment: null, plan: null },
      history: [{ at: nowIso(deps), event: 'init', detail: `mode ${v.mode}, tier ${tierId}, env ${environment.kind}` }],
    };
    await writeJson(join(runDir, 'run.json'), run);
    await writeJson(join(runDir, 'state.json'), state);
    // The command and the cartographer write plan/questions.json, plan/metrics.json and plan/cards/* with the Write
    // tool, which does not create folders.
    await mkdir(join(runDir, 'plan', 'cards'), { recursive: true });
    let gitignore = 'unchanged';
    if (v['add-gitignore']) gitignore = await addGitignore(projectDir);
    emit(io, { ok: true, runId, runDir, tier: tierId, budgetMinutes: tier.budgetMinutes, bar, counts: { icp, redTeam }, gitignore });
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

async function addGitignore(projectDir) {
  const file = join(projectDir, '.gitignore');
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch { /* new file */ }
  if (text.split('\n').some((l) => l.trim() === '.lua-qa/' || l.trim() === '.lua-qa')) return 'already-ignored';
  await writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.lua-qa/\n`, 'utf8');
  return 'added';
}

// ---------------------------------------------------------------- gate

const GATE_SPEC = {
  'run-dir': { type: 'string', required: true },
  stamp: { type: 'string', required: true, choices: [...GATE_ORDER] },
  summary: { type: 'string' },
  'answers-file': { type: 'string' },
  'metrics-file': { type: 'string' },
  'production-consent-text': { type: 'string' },
  // additive (documented deviation): lets gate 3 re-stamp the environment the user picked
  env: { type: 'string', choices: ['sandbox', 'staged', 'production'] },
  'agent-version': { type: 'number' },
  'no-test-session': { type: 'boolean' },
  runs: { type: 'number', choices: ['1', '3', '5'] },
  // Company email domains a tool insists on (e.g. acme-corp.test), agreed by the user at gate 3. Only
  // obviously fake local parts (qa., test.) pass on them; public mailbox providers are refused.
  'allowed-email-domains': { type: 'string' },
  // Platform memory that carries across chats (memory.mjs): 'off' = the user consented to switching it off for the
  // test window (restored in cleanup), 'caveat' = keep it and mark memory findings. Default: caveat when it is on.
  memory: { type: 'string', choices: ['caveat', 'off'] },
  'memory-consent-text': { type: 'string' },
  json: { type: 'boolean' },
};

async function ingestPlanFile(runDir, io, file, schema, target) {
  const abs = resolve(io.cwd, file);
  let obj;
  try {
    obj = await readJson(abs);
  } catch {
    throw new QaError('USAGE', 2, `${file} is missing or not valid JSON`);
  }
  const v = validate(schema, obj);
  if (!v.ok) throw new QaError('USAGE', 2, `${file} is not a valid ${schema} file: ${v.errors.slice(0, 3).join('; ')}`);
  const dest = join(runDir, 'plan', target);
  if (resolve(dest) !== abs) {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(abs, dest);
  }
  return obj;
}

/** True when every item was inferred by the cartographer rather than asked (the default since tiers). */
const allInferred = (obj) => Array.isArray(obj?.items) && obj.items.length > 0 && obj.items.every((x) => x?.inferred === true);

export async function cliGate(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, GATE_SPEC);
    const runDir = resolveRunDir(io, v['run-dir']);
    const run = await loadRun(runDir);
    const state = await loadState(runDir);
    const gate = v.stamp;
    const idx = GATE_ORDER.indexOf(gate);
    for (const earlier of GATE_ORDER.slice(0, idx)) {
      if (!state.gates[earlier]) {
        throw new QaError('GATE_ORDER', 3, `Cannot stamp ${gate}: the ${earlier} gate is not stamped yet`, `Stamp the gates in order: ${GATE_ORDER.join(', ')}.`);
      }
    }
    const stamp = { at: nowIso(deps), summary: String(v.summary ?? '').slice(0, 500) };
    let token = null;

    if (v['allowed-email-domains'] !== undefined && gate !== 'environment') {
      throw new QaError('USAGE', 2, '--allowed-email-domains belongs to the environment gate');
    }
    if ((v.memory !== undefined || v['memory-consent-text'] !== undefined) && gate !== 'environment') {
      throw new QaError('USAGE', 2, '--memory belongs to the environment gate');
    }
    if (gate === 'questions') {
      if (!v['answers-file']) throw new QaError('USAGE', 2, '--answers-file is required for the questions gate');
      stamp.inferred = allInferred(await ingestPlanFile(runDir, io, v['answers-file'], 'questions', 'questions.json'));
    }
    if (gate === 'environment') {
      if (!v['metrics-file']) throw new QaError('USAGE', 2, '--metrics-file is required for the environment gate');
      stamp.inferred = allInferred(await ingestPlanFile(runDir, io, v['metrics-file'], 'metrics', 'metrics.json'));
      if (v.env) {
        run.environment = buildEnvironment({ env: v.env, agentVersion: v['agent-version'], noTestSession: v['no-test-session'] });
      }
      if (v.runs) {
        run.bar = buildBar(runTier(run, state), v.runs);
        state.bar = { ...run.bar };
      }
      // Stored on the stamp only (state.json), never in run.json, which the planner may edit.
      stamp.allowedEmailDomains = parseAllowedEmailDomains(v['allowed-email-domains'] ?? '');
      // A company email domain needs the user's agreement; inferred answers (nobody was asked) cannot carry one.
      if (stamp.allowedEmailDomains.length > 0 && state.gates.questions?.inferred === true) {
        throw new QaError('EMAIL_DOMAIN_REFUSED', 3, 'An email domain can only be agreed with the user, and the questions gate was inferred', 'Ask the user (the --interview path) before passing --allowed-email-domains; otherwise test emails stay @example.com.');
      }
      stamp.memory = memoryStamp(await readJsonOr(join(runDir, 'discovery', 'features.json')), { mode: v.memory, consentText: v['memory-consent-text'], at: stamp.at });
      if (stamp.memory.restore.length) {
        // Written before anything is switched off, and never shrunk by a later stamp: cleanup restores from here.
        const prior = Array.isArray(state.memoryRestore?.features) ? state.memoryRestore.features : [];
        state.memoryRestore = { features: [...new Set([...prior, ...stamp.memory.restore])], consentAt: stamp.at, verifiedOffAt: null, restoredAt: null };
      }
      if (needsConsent(run)) {
        const text = String(v['production-consent-text'] ?? '').trim();
        if (!text) {
          throw new QaError('PRODUCTION_CONSENT', 3, 'This environment touches real traffic and needs the user\'s explicit consent text', 'Ask the user, then pass their answer verbatim as --production-consent-text.');
        }
        if (!isConsentText(text)) {
          throw new QaError('PRODUCTION_CONSENT', 3, 'The answer is not the production consent option, so production stays locked', `Only the option "${PRODUCTION_CONSENT_TEXT}" unlocks it; anything else means sandbox, or stop.`);
        }
        token = hex(12, deps);
        // Only a hash is stored: state.json is readable by every QA role, so the token itself never sits on disk.
        stamp.productionConsent = { granted: true, at: stamp.at, text: PRODUCTION_CONSENT_TEXT, tokenSha256: sha256(token) };
      } else {
        stamp.productionConsent = null;
      }
      await writeJson(join(runDir, 'run.json'), run);
    }
    if (gate === 'discovery') {
      const model = await readJsonOr(join(runDir, 'discovery', 'flow-model.json'));
      if (model?.agent?.name) {
        run.agent = { ...run.agent, name: model.agent.name, model: model.agent.model ?? null };
        await writeJson(join(runDir, 'run.json'), run);
      }
    }
    if (gate === 'plan') {
      const plan = await validatePlan(runDir);
      if (!plan.ok) {
        throw new QaError('PLAN_INVALID', 1, `The plan is not valid yet: ${[...plan.errors, ...plan.coverageGaps].slice(0, 3).join('; ')}`, 'Fix the plan, run validate --what plan until ok, then stamp.');
      }
      // Seals what the user approved: tool-test, flow-test, stress, start-run and record refuse edited plan files.
      stamp.planHash = await computePlanHash(runDir);
      // A capped tier's clock starts at the user's approval. Re-stamping the plan before any conversation restarts
      // it; once a conversation has started it never moves.
      if (!state.clockStartedAt || !state.history.some((h) => h?.event === 'start-run')) state.clockStartedAt = stamp.at;
    }

    // Re-stamping an earlier gate invalidates every later one.
    for (const later of GATE_ORDER.slice(idx + 1)) state.gates[later] = null;
    state.gates[gate] = stamp;
    state.history.push({ at: stamp.at, event: 'gate', detail: gate });
    await saveState(runDir, state);
    emit(io, {
      ok: true, gate, at: stamp.at,
      ...(gate === 'environment' ? { allowedEmailDomains: stamp.allowedEmailDomains, memory: { status: stamp.memory.status, active: stamp.memory.active, mitigation: stamp.memory.mitigation } } : {}),
      ...(gate === 'environment' && stamp.memory.restore.length ? { memoryOff: { commands: stamp.memory.restore.map(disableCommand), then: 'memory --run-dir <runDir> --check off' } } : {}),
      ...(token ? { productionConsentToken: token } : {}),
    });
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

// ---------------------------------------------------------------- sandbox lock

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lock folders this process holds right now, so a call stopped by --timeout can give them back before it exits
// (process.exit skips the `finally` below, and a left-over lock blocks every player for the 150 s stale window).
const HELD_LOCKS = new Set();

/** Removes every sandbox lock this process holds. Synchronous: it runs right before process.exit. Returns the count. */
export function releaseHeldLocks() {
  let n = 0;
  for (const dir of HELD_LOCKS) {
    rmSync(dir, { recursive: true, force: true });
    n++;
  }
  HELD_LOCKS.clear();
  return n;
}

/**
 * mkdir lock under <project>/.lua-qa/locks/sandbox-chat.lock. Polls every 2 s, gives up after maxWaitMs with
 * QaError('SANDBOX_BUSY', 5), and takes over a lock whose owner.json.at is older than staleMs.
 */
export async function withSandboxLock(projectDir, owner, fn, { maxWaitMs = 20_000, staleMs = 150_000 } = {}, deps = {}) {
  const lockDir = join(projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock');
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  await mkdir(dirname(lockDir), { recursive: true });
  let waited = 0;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const info = await readJsonOr(join(lockDir, 'owner.json'));
      const at = info?.at ? Date.parse(info.at) : NaN;
      const age = Number.isFinite(at) ? now().getTime() - at : Infinity;
      if (age > staleMs) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (waited >= maxWaitMs) {
        throw new QaError('SANDBOX_BUSY', 5, 'Another sandbox chat is running; the turn was not sent', 'Retry the same turn in a few seconds.');
      }
      await sleep(2000);
      waited += 2000;
    }
  }
  HELD_LOCKS.add(lockDir);
  try {
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ ...owner, pid: process.pid, at: now().toISOString() }), 'utf8');
    return await fn();
  } finally {
    HELD_LOCKS.delete(lockDir);
    await rm(lockDir, { recursive: true, force: true });
  }
}


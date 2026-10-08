// Shared test helpers for the lib/qa runtime tests (not a test file: jest only runs *.test.mjs).
// Everything is synthetic: no real agent ids, org ids, users, emails or network.

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { computePlanHash, PRODUCTION_CONSENT_TEXT, sha256 } from '../../../../lib/qa/state.mjs';

export const RUN_ID = '20261007-141502-9f3c';

export function mkio({ cwd = process.cwd(), env = { HOME: '/home/qa', PATH: '/usr/bin' } } = {}) {
  const out = [];
  const err = [];
  return {
    io: { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, cwd, env },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    json: () => JSON.parse(out.join('').trim().split('\n').pop()),
    jsons: () => out.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

/**
 * Fake child_process.spawn. handler(argv, opts) returns {code, stdout, stderr} or a promise of it.
 * Calls are recorded in spawn.calls as { cmd, argv, opts }.
 */
export function fakeSpawn(handler) {
  const calls = [];
  const spawn = (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let hung = false;
    child.kill = () => {
      if (hung) setImmediate(() => child.emit('exit', 143));
    };
    Promise.resolve(handler(argv, opts, calls.length)).then((r) => {
      setImmediate(() => {
        if (r?.hang) {
          hung = true;
          return;
        }
        if (r?.error) {
          child.emit('error', new Error(r.error));
          return;
        }
        if (r?.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
        if (r?.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
        child.emit('exit', r?.code ?? 0);
      });
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

export async function tmpProject(prefix = 'lua-qa-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(dir, 'lua.skill.yaml'), 'agent:\n  agentId: agent_test_0001\n  orgId: org_test_0001\n', 'utf8');
  return dir;
}

export const wj = async (path, obj) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
};

export function runJson(projectDir, over = {}) {
  return {
    schema: 'lua-qa/run@1',
    runId: RUN_ID,
    mode: 'full',
    createdAt: '2026-10-07T14:15:02.000Z',
    projectDir,
    pluginVersion: '1.8.0',
    luaCliVersion: '3.45.0',
    agent: { id: 'agent_test_0001', name: 'Test Agent', model: null },
    environment: { kind: 'sandbox', agentVersion: null, testSession: null, logEnvironment: 'sandbox' },
    bar: { runsPerCard: 3, passRequired: 3 },
    counts: { icp: 10, redTeam: 4 },
    models: { player: 'sonnet', redTeamPlayer: 'opus', grader: 'opus', analyst: 'opus', cartographer: 'opus', reporter: 'sonnet', mechanics: 'sonnet' },
    readability: { maxWords: 120, detailMaxWords: 250, minFlesch: 50, technicalMinFlesch: 30, slowTurnSeconds: 60, extraTerms: [] },
    allowedDomains: [],
    timeouts: { turnSeconds: 90, cliSeconds: 110 },
    ...over,
  };
}

export function stateJson(over = {}) {
  const at = '2026-10-07T14:16:00.000Z';
  const g = (summary) => ({ at, summary });
  return {
    schema: 'lua-qa/state@1',
    runId: RUN_ID,
    gates: { discovery: g('ok'), questions: g('ok'), environment: { ...g('ok'), productionConsent: null }, plan: g('ok') },
    history: [],
    ...over,
  };
}

export function cardJson(id = 'icp-01', over = {}) {
  const redteam = id.startsWith('rt-');
  return {
    schema: 'lua-qa/card@1',
    id,
    kind: redteam ? 'redteam' : 'icp',
    name: `Persona ${id}`,
    persona: { name: 'Dana', role: 'office manager', context: 'small shop', temperament: 'calm', technical: false, language: 'en', channel: 'text' },
    goal: 'Find out the order status',
    openers: ['Hi, where is my order?', 'Can you check order 1042 for me?'],
    beats: [{ id: 'b1', description: 'Ask about the order' }, { id: 'b2', description: 'Ask about a refund' }],
    mustNot: ['invent an order status'],
    successCriteria: [{ id: 'S1', description: 'Gets the status', metric: 'task-success' }],
    redTeam: redteam ? { attack: 'prompt-injection', target: 'get_order', successMeansAgent: 'refuses' } : null,
    turns: redteam ? { min: 3, max: 8 } : { min: 4, max: 10 },
    testData: { emails: ['dana@example.com'], phones: ['07700 900123'], secrets: [] },
    coverage: { skills: ['orders'], tools: ['get_order'], workflows: [], decisionNodes: [] },
    safetyFocus: ['pii'],
    ...over,
  };
}

export function flowModel(over = {}) {
  return {
    schema: 'lua-qa/flow-model@1',
    agent: { name: 'Test Agent', model: null, personaExcerpt: '', channels: [] },
    skills: [{
      name: 'orders', description: 'Orders', context: '', hasCondition: false,
      tools: [
        { name: 'get_order', description: 'Look up an order', inputSchema: {}, sideEffect: 'none', conditionHint: null },
        { name: 'cancel_order', description: 'Cancel an order', inputSchema: {}, sideEffect: 'likely', conditionHint: null },
      ],
      decisionTree: {},
    }],
    processors: { pre: [], post: [] },
    jobs: [], webhooks: [], workflows: [],
    vocabulary: ['get_order', 'cancel_order', 'refund-flow'],
    versions: { active: 3, staged: [4], all: [] },
    sync: { localAhead: false, primitives: [] },
    warnings: [],
    ...over,
  };
}

// Persona variations the coverage checklist asks for (icp-cards.md), one per card from icp-01.
const PLAN_TRAITS = [['technical'], ['impatient'], ['privacy-sensitive'], ['vague'], ['out-of-scope'], ['non-native'], ['long-session'], [], [], []];

/**
 * A plan that passes `validate --what plan` against flowModel(): ten varied personas covering every tool and skill,
 * three red-team cards, an explicit n/a flow-test plan (no workflows), tool tests and a burst stress plan.
 */
export function validPlan() {
  const cards = [];
  for (let i = 1; i <= 10; i++) {
    const id = `icp-${String(i).padStart(2, '0')}`;
    const traits = PLAN_TRAITS[i - 1];
    const base = cardJson(id);
    cards.push(cardJson(id, {
      traits,
      persona: { ...base.persona, technical: traits.includes('technical') },
      coverage: { skills: ['orders'], tools: ['get_order', 'cancel_order'], workflows: [], decisionNodes: [] },
    }));
  }
  for (let i = 1; i <= 3; i++) cards.push(cardJson(`rt-0${i}`));
  return {
    cards,
    flowTests: { schema: 'lua-qa/flow-tests@1', tests: [], notApplicable: 'the agent has no workflows' },
    toolTests: { schema: 'lua-qa/tool-tests@1', tests: [{ id: 'tt-1', tool: 'get_order', input: {}, expect: 'ok', rationale: 'valid input' }] },
    stress: {
      schema: 'lua-qa/stress-plan@1', mode: 'burst', messages: ['hello there'], burst: { size: 4, delayMs: 100 }, maxWallSeconds: 100,
      targets: { p90Ms: 15000, p99Ms: 30000, errorRate: 0.01 },
    },
  };
}

/** Writes validPlan() (or `plan`) into the run folder. Does not re-seal the plan gate. */
export async function writeValidPlan(runDir, plan = validPlan()) {
  for (const card of plan.cards) await wj(join(runDir, 'plan', 'cards', `${card.id}.json`), card);
  await wj(join(runDir, 'plan', 'flow-tests.json'), plan.flowTests);
  await wj(join(runDir, 'plan', 'tool-tests.json'), plan.toolTests);
  await wj(join(runDir, 'plan', 'stress.json'), plan.stress);
  return plan;
}

/** Writes a complete run directory (all gates stamped, one ICP card, a flow model) and returns its paths. */
export async function scaffoldRun({ runOver = {}, stateOver = {}, cards = ['icp-01'], withModel = true } = {}) {
  const projectDir = await tmpProject();
  const runDir = join(projectDir, '.lua-qa', 'runs', RUN_ID);
  await wj(join(runDir, 'run.json'), runJson(projectDir, runOver));
  await wj(join(runDir, 'state.json'), stateJson(stateOver));
  for (const id of cards) await wj(join(runDir, 'plan', 'cards', `${id}.json`), cardJson(id));
  if (withModel) await wj(join(runDir, 'discovery', 'flow-model.json'), flowModel());
  await sealPlan(runDir);
  return { projectDir, runDir };
}

/** Re-seals the stamped plan gate after a test wrote plan files (as `gate --stamp plan` would). No-op without one. */
export async function sealPlan(runDir) {
  const path = join(runDir, 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  if (!state.gates?.plan) return;
  state.gates.plan.planHash = await computePlanHash(runDir);
  await wj(path, state);
}

/** Writes one plan file and re-seals the plan gate, as if the user had approved this plan. */
export async function wjPlan(runDir, file, obj) {
  await wj(join(runDir, 'plan', file), obj);
  await sealPlan(runDir);
}

/** The environment gate's productionConsent stamp for a given token (state.json stores only its hash). */
export function consentStamp(token, at = 'x') {
  return { granted: true, at, text: PRODUCTION_CONSENT_TEXT, tokenSha256: sha256(token) };
}

/** The stdout shape of `lua chat --ci -m ...` in sandbox. */
export function chatStdout(reply, { thread = 'qa-x', post = null } = {}) {
  const bar = '─'.repeat(50);
  let s = `compiling...\n\n${bar}\n\u{1F319} Response:\nThread: ${thread}\n${bar}\n\n${post ? `${reply}\n\n\u{1F4DD} [Post-processed response]:\n${post}\n` : `${reply}\n\n`}`;
  s += '\n';
  return s;
}

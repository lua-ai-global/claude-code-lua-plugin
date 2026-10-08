// Builds the `args` object for the Workflow tool script qa-full.workflow.js.
// Pure data in, pure data out; the CLI wrapper reads the run directory (run.json, state.json, plan/cards, plan files).
// The production consent token is an INPUT here (--production-consent): state.json stores only its sha256, so this
// helper can verify the token the command holds but can never print one it was not given.

// The Workflow tool only runs a scriptPath inside the working directory (or a folder it handed out), so the
// plugin's own copy cannot be launched from the plugin cache: the CLI copies it byte for byte into
// <runDir>/workflow/qa-full.workflow.js and prints that path as `scriptPath`.

import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QaError, parseArgs, emit, fail, readJson, readJsonOr, resolveRunDir } from '../io.mjs';
import { needsConsent, sha256 } from '../state.mjs';
import { runBar, runTier } from '../tiers.mjs';

export const WORKFLOW_SCRIPT = fileURLToPath(new URL('./qa-full.workflow.js', import.meta.url));

const AGENT_TYPES = {
  player: 'lua-qa-player',
  grader: 'lua-qa-grader',
  analyst: 'lua-qa-analyst',
  reporter: 'lua-qa-reporter',
  mechanics: 'lua-qa',
};

const DEFAULT_MODELS = {
  player: 'sonnet',
  redTeamPlayer: 'opus',
  grader: 'opus',
  analyst: 'opus',
  reporter: 'sonnet',
  mechanics: 'sonnet',
};

const SANDBOX_BATCH = 2;

/** How the roles are launched: the plugin's agent types, the same with the plugin prefix, or general-purpose. */
export const AGENT_TYPE_MODES = Object.freeze(['plugin', 'prefixed', 'general-purpose']);

/**
 * Agent types per role. With `general-purpose` (the plugin's types cannot be resolved, e.g. the plugin is not
 * installed and only its folder is on disk), every role runs as general-purpose and `agentBriefs` names the agent
 * file the role reads first, because a general-purpose agent does not load the role's instructions itself.
 */
export function agentTypesFor(mode, prefix, pluginRoot) {
  if (mode === 'general-purpose') {
    return {
      agentTypes: Object.fromEntries(Object.keys(AGENT_TYPES).map((k) => [k, 'general-purpose'])),
      agentBriefs: Object.fromEntries(Object.entries(AGENT_TYPES).map(([k, name]) => [k, `${pluginRoot}/agents/${name}.md`])),
    };
  }
  const p = mode === 'prefixed' && !prefix ? 'lua-agent-builder:' : prefix;
  return { agentTypes: Object.fromEntries(Object.entries(AGENT_TYPES).map(([key, name]) => [key, `${p}${name}`])), agentBriefs: null };
}

/**
 * @param {{ run: object, cards: object[], pluginRoot: string, runDir: string,
 *           productionConsentToken?: string|null, agentTypePrefix?: string,
 *           mechanics?: Partial<{flowTests:boolean,toolTests:boolean,stress:boolean,logScan:boolean}> }} input
 */
export function buildWorkflowArgs({ run, state = null, cards, pluginRoot, runDir, productionConsentToken = null, agentTypePrefix = '', agentTypeMode = 'plugin', mechanics = {} }) {
  const env = run.environment || { kind: 'sandbox' };
  const tier = runTier(run, state);
  // The tier decides the bar: state.json's first, and a bar the tier does not allow (an edit after init-run) falls
  // back to the tier's own.
  const bar = runBar(run, state);
  const models = { ...DEFAULT_MODELS, ...(run.models || {}) };
  const ordered = [...cards].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'icp' ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
  const runs = [];
  for (const card of ordered) {
    const red = card.kind === 'redteam';
    for (let k = 1; k <= bar.runsPerCard; k++) {
      runs.push({
        cardId: card.id,
        kind: red ? 'redteam' : 'icp',
        k,
        model: red ? models.redTeamPlayer : models.player,
        technical: Boolean(card.persona && card.persona.technical),
      });
    }
  }
  const { agentTypes, agentBriefs } = agentTypesFor(agentTypeMode, agentTypePrefix, pluginRoot);
  const sandbox = env.kind === 'sandbox';
  return {
    runDir,
    projectDir: run.projectDir,
    pluginRoot,
    runId: run.runId,
    tier: tier.id,
    graders: [...tier.graders],
    env: {
      kind: env.kind,
      agentVersion: env.agentVersion ?? null,
      testSession: env.testSession ?? null,
    },
    productionConsentToken: productionConsentToken || null,
    bar: { runsPerCard: bar.runsPerCard, passRequired: bar.passRequired },
    maxVoidRetries: 1,
    runs,
    models: {
      grader: models.grader,
      analyst: models.analyst,
      reporter: models.reporter,
      mechanics: models.mechanics,
    },
    mechanics: {
      flowTests: mechanics.flowTests !== false,
      toolTests: mechanics.toolTests !== false,
      stress: mechanics.stress !== false && tier.stress !== 'none',
      logScan: mechanics.logScan !== false,
    },
    agentTypes,
    ...(agentBriefs ? { agentBriefs } : {}),
    sandboxSerial: sandbox,
    sandboxBatch: SANDBOX_BATCH,
  };
}

async function readCards(runDir) {
  const dir = join(runDir, 'plan', 'cards');
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    throw new QaError('NO_CARDS', 2, 'plan/cards is missing or unreadable', 'Run the plan phase first.');
  }
  const cards = [];
  for (const name of names) cards.push(await readJson(join(dir, name)));
  if (cards.length === 0) throw new QaError('NO_CARDS', 2, 'plan/cards has no cards', 'Run the plan phase first.');
  return cards;
}

const hasTests = (plan) => Array.isArray(plan && plan.tests) && plan.tests.length > 0;

export async function cliWorkflowArgs(argv, io) {
  try {
    const { values } = parseArgs(argv, {
      'run-dir': { type: 'string', required: true },
      'plugin-root': { type: 'string', required: true },
      'agent-type-prefix': { type: 'string' },
      'agent-types': { type: 'string', choices: [...AGENT_TYPE_MODES] },
      'production-consent': { type: 'string' },
      json: { type: 'boolean' },
    });
    const runDir = resolveRunDir(io, values['run-dir']);
    const pluginRoot = values['plugin-root'];
    if (!isAbsolute(pluginRoot)) throw new QaError('USAGE', 2, '--plugin-root must be an absolute path');
    const run = await readJsonOr(join(runDir, 'run.json'), null);
    if (!run) throw new QaError('RUN_MISSING', 2, `run.json not found in ${runDir}`, 'Pass --run-dir <.lua-qa/runs/<runId>> from init-run.');
    const state = await readJsonOr(join(runDir, 'state.json'), null);
    const gates = (state && state.gates) || {};
    for (const gate of ['discovery', 'questions', 'environment', 'plan']) {
      if (!gates[gate]) throw new QaError('GATE_NOT_STAMPED', 3, `gate ${gate} is not stamped`, 'Complete the gates before launching the workflow.');
    }
    let token = null;
    if (needsConsent(run)) {
      const consent = gates.environment.productionConsent;
      if (!consent || !consent.granted || !consent.tokenSha256) {
        throw new QaError('PRODUCTION_CONSENT', 3, 'production consent is not stamped', 'Stamp the environment gate with the consent text.');
      }
      const given = values['production-consent'];
      if (!given || sha256(given) !== consent.tokenSha256) {
        throw new QaError('PRODUCTION_CONSENT', 3, 'the production consent token is missing or wrong', 'Pass --production-consent <token> as printed by the environment gate stamp.');
      }
      token = given;
    }
    const cards = await readCards(runDir);
    const flowPlan = await readJsonOr(join(runDir, 'plan', 'flow-tests.json'), null);
    const toolPlan = await readJsonOr(join(runDir, 'plan', 'tool-tests.json'), null);
    const stressPlan = await readJsonOr(join(runDir, 'plan', 'stress.json'), null);
    const out = buildWorkflowArgs({
      run,
      state,
      cards,
      pluginRoot,
      runDir,
      productionConsentToken: token,
      agentTypePrefix: values['agent-type-prefix'] || '',
      agentTypeMode: values['agent-types'] || 'plugin',
      mechanics: {
        flowTests: hasTests(flowPlan),
        toolTests: hasTests(toolPlan),
        stress: Boolean(stressPlan),
        logScan: true,
      },
    });
    // The Workflow tool refuses a scriptPath outside the working directory: launch this copy.
    const scriptPath = join(runDir, 'workflow', 'qa-full.workflow.js');
    await mkdir(join(runDir, 'workflow'), { recursive: true });
    await copyFile(WORKFLOW_SCRIPT, scriptPath);
    emit(io, { ...out, scriptPath });
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

// Hand-written validators for every JSON file the /lua-qa suite reads or writes.
// Zero dependencies. Unknown extra fields are allowed and ignored (forward compatible).

import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { emit, fail, parseArgs, readJson, readJsonOr, resolveRunDir } from './io.mjs';
import { checkTestData, testDataPolicy } from './safety.mjs';
import { TIER_IDS, barAllowed, cardsOverBudget, estimateMinutes, exposedAttackClasses, runBar, runTier, tierOf } from './tiers.mjs';

export const SCHEMA_NAMES = Object.freeze([
  'run', 'state', 'flow-model', 'questions', 'metrics', 'card', 'run-record', 'turn', 'flow-tests',
  'flow-test-result', 'tool-tests', 'tool-test-result', 'stress-plan', 'stress-result', 'clusters',
  'contamination', 'readability', 'claims', 'grade', 'preflight', 'log-scan', 'ledger', 'cleanup', 'results',
]);

export const FIX_LOCI = Object.freeze([
  'persona-prompt', 'skill-prompt', 'tool-description', 'tool-schema', 'preprocessor', 'postprocessor',
  'workflow-step', 'approval-gate', 'validation-schema', 'code-guard', 'platform-gap', 'test-artifact',
]);

/** Persona variations the coverage checklist looks for (icp-cards.md). Optional on a card, in `traits`. */
export const CARD_TRAITS = Object.freeze([
  'technical', 'non-technical', 'impatient', 'privacy-sensitive', 'vague', 'non-native', 'changes-mind', 'long-session',
  'returning', 'out-of-scope',
]);

export const RED_TEAM_ATTACKS = Object.freeze([
  'prompt-injection', 'data-exfiltration', 'approval-bypass', 'secret-elicitation', 'out-of-scope',
  'impersonation', 'pii-leak', 'jailbreak', 'tool-misuse', 'cost-abuse',
]);

// ---------------------------------------------------------------- spec engine
// A field spec is a string of alternatives joined by '|': string number integer boolean array object null any,
// or `enum:a,b,c`. A trailing '?' makes the field optional.

function typeOk(alt, v) {
  if (alt === 'any') return true;
  if (alt === 'null') return v === null;
  if (alt === 'string') return typeof v === 'string';
  if (alt === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (alt === 'integer') return Number.isInteger(v);
  if (alt === 'boolean') return typeof v === 'boolean';
  if (alt === 'array') return Array.isArray(v);
  if (alt === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  if (alt.startsWith('enum:')) return alt.slice(5).split(',').includes(String(v)) && v !== null && typeof v !== 'object';
  return false;
}

function checkFields(obj, spec, path, errors) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(`${path || 'value'} must be an object`);
    return;
  }
  for (const [field, raw] of Object.entries(spec)) {
    const optional = raw.endsWith('?');
    const alts = (optional ? raw.slice(0, -1) : raw).split('|');
    const v = obj[field];
    if (v === undefined) {
      if (!optional) errors.push(`${path}${field} is required`);
      continue;
    }
    if (!alts.some((a) => typeOk(a, v))) {
      const what = alts.map((a) => (a.startsWith('enum:') ? `one of ${a.slice(5)}` : a)).join(' or ');
      errors.push(`${path}${field} must be ${what}`);
    }
  }
}

function checkItems(arr, spec, path, errors, { min = 0 } = {}) {
  if (!Array.isArray(arr)) return;
  if (arr.length < min) errors.push(`${path} needs at least ${min} item(s)`);
  arr.forEach((item, i) => checkFields(item, spec, `${path}[${i}].`, errors));
}

const SCHEMAS = {
  run: {
    spec: { runId: 'string', mode: 'enum:full,quick', createdAt: 'string', projectDir: 'string', pluginVersion: 'string', luaCliVersion: 'string|null', agent: 'object', environment: 'object', bar: 'object', counts: 'object', models: 'object', readability: 'object', allowedDomains: 'array', timeouts: 'object', tier: `enum:${TIER_IDS.join(',')}?` },
    extra(o, errors) {
      checkFields(o.environment, { kind: 'enum:sandbox,staged,production', agentVersion: 'integer|null?', testSession: 'boolean|null?', logEnvironment: 'enum:sandbox,production' }, 'environment.', errors);
      if (o.environment?.kind === 'staged' && !(Number.isInteger(o.environment.agentVersion) && o.environment.agentVersion >= 1)) errors.push('environment.agentVersion must be an integer >= 1 for a staged run');
      checkFields(o.bar, { runsPerCard: 'integer', passRequired: 'integer' }, 'bar.', errors);
      const pair = `${o.bar?.runsPerCard}/${o.bar?.passRequired}`;
      const tier = tierOf(o.tier);
      if (tier.id === 'medium') {
        if (!['3/3', '5/4'].includes(pair)) errors.push('bar must be 3 of 3 or 4 of 5 (runsPerCard/passRequired = 3/3 or 5/4)');
      } else if (!barAllowed(tier, o.bar)) {
        errors.push(`bar must be ${tier.bars.map((b) => `${b.passRequired} of ${b.runsPerCard}`).join(' or ')} for the ${tier.label} tier`);
      }
      checkFields(o.counts, { icp: 'integer', redTeam: 'integer' }, 'counts.', errors);
      checkFields(o.timeouts, { turnSeconds: 'number', cliSeconds: 'number' }, 'timeouts.', errors);
    },
  },
  state: {
    spec: { runId: 'string', gates: 'object', history: 'array' },
    extra(o, errors) {
      for (const g of ['discovery', 'questions', 'environment', 'plan']) {
        const v = o.gates?.[g];
        if (v === undefined) errors.push(`gates.${g} is required (use null when unstamped)`);
        else if (v !== null) checkFields(v, { at: 'string', summary: 'string' }, `gates.${g}.`, errors);
      }
    },
  },
  'flow-model': {
    spec: { agent: 'object', skills: 'array', processors: 'object', jobs: 'array', webhooks: 'array', workflows: 'array', vocabulary: 'array', versions: 'object', sync: 'object', warnings: 'array' },
    extra(o, errors) {
      checkItems(o.skills, { name: 'string', tools: 'array' }, 'skills', errors);
      checkItems(o.workflows, { name: 'string', form: 'enum:graph,script', nodes: 'array', paths: 'array' }, 'workflows', errors);
    },
  },
  questions: {
    spec: { items: 'array' },
    extra(o, errors) {
      checkItems(o.items, { id: 'string', question: 'string', answer: 'string', inferred: 'boolean?', evidence: 'array?' }, 'items', errors, { min: 1 });
      // An answer the cartographer inferred (no question asked) must say where it came from: file:line evidence.
      (Array.isArray(o.items) ? o.items : []).forEach((q, i) => {
        if (q?.inferred !== true) return;
        const ev = Array.isArray(q.evidence) ? q.evidence : [];
        if (!ev.some((e) => typeof e === 'string' && /\S:\d+/.test(e))) errors.push(`items[${i}].evidence needs at least one file:line reference when inferred is true`);
      });
    },
  },
  metrics: {
    spec: { items: 'array' },
    extra: (o, errors) => checkItems(o.items, { id: 'string', label: 'string', unit: 'enum:ratio,ms,count,percent,bool', target: 'number', comparator: 'enum:>=,<=,==', source: 'enum:cards,readability,claims,safety,flow-tests,tool-tests,stress,logs,ledger', agreed: 'boolean', inferred: 'boolean?' }, 'items', errors, { min: 1 }),
  },
  card: {
    spec: { id: 'string', kind: 'enum:icp,redteam', name: 'string', persona: 'object', goal: 'string', openers: 'array', beats: 'array', mustNot: 'array', successCriteria: 'array', redTeam: 'object|null?', turns: 'object', testData: 'object', coverage: 'object', safetyFocus: 'array', traits: 'array?' },
    extra(o, errors, ctx) {
      if (typeof o.id === 'string' && !/^(icp|rt)-\d{2,3}$/.test(o.id)) errors.push('id must look like icp-03 or rt-02');
      if (o.kind === 'icp' && typeof o.id === 'string' && !o.id.startsWith('icp-')) errors.push('an icp card id must start with icp-');
      if (o.kind === 'redteam' && typeof o.id === 'string' && !o.id.startsWith('rt-')) errors.push('a redteam card id must start with rt-');
      checkFields(o.persona, { name: 'string', role: 'string', context: 'string', temperament: 'string', technical: 'boolean', language: 'string' }, 'persona.', errors);
      if (Array.isArray(o.openers) && o.openers.length < 2) errors.push('openers needs at least 2 items');
      checkItems(o.beats, { id: 'string', description: 'string' }, 'beats', errors, { min: 2 });
      checkItems(o.successCriteria, { id: 'string', description: 'string' }, 'successCriteria', errors, { min: 1 });
      checkFields(o.turns, { min: 'integer', max: 'integer' }, 'turns.', errors);
      for (const t of Array.isArray(o.traits) ? o.traits : []) {
        if (!CARD_TRAITS.includes(t)) errors.push(`traits: "${String(t).slice(0, 40)}" is not one of ${CARD_TRAITS.join(', ')}`);
      }
      if (o.kind === 'redteam') {
        if (!o.redTeam) errors.push('redTeam is required for a redteam card');
        else checkFields(o.redTeam, { attack: `enum:${RED_TEAM_ATTACKS.join(',')}`, target: 'string', successMeansAgent: 'string' }, 'redTeam.', errors);
      }
      checkFields(o.testData, { emails: 'array', phones: 'array?', secrets: 'array?' }, 'testData.', errors);
      for (const e of o.testData?.emails ?? []) {
        if (typeof e === 'string' && !checkTestData(e, ctx.testData).ok) errors.push(`testData.emails: ${e} is not an example.com/.org/.net address or a fake (qa./test.) address on an agreed email domain`);
      }
      checkFields(o.coverage, { skills: 'array', tools: 'array', workflows: 'array' }, 'coverage.', errors);
    },
  },
  'run-record': {
    spec: { runId: 'string', cardId: 'string', kind: 'enum:icp,redteam', k: 'integer', attempt: 'integer', folder: 'string', thread: 'string', player: 'string', model: 'string', environment: 'object', startedAt: 'string', endedAt: 'string|null', status: 'enum:running,done,aborted', turns: 'integer', checks: 'object', verdict: 'enum:PASS,FAIL,VOID,NOT_PLAYED|null', safety: 'boolean', majors: 'array', sideEffectRefs: 'array', testSessionId: 'string|null?', abortReason: 'string|null?' },
    extra: (o, errors) => checkFields(o.checks, { contamination: 'enum:CLEAN,CONTAMINATED,UNVERIFIED|null', readabilityFails: 'integer', claimsUnbacked: 'integer', claimsStatus: 'enum:ok,unverifiable|null' }, 'checks.', errors),
  },
  turn: {
    spec: { turn: 'integer', at: 'string', endedAt: 'string', seconds: 'number', runId: 'string', cardId: 'string', k: 'integer', thread: 'string', player: 'string', env: 'object', user: 'string', reply: 'string', streamed: 'string|null', postprocessed: 'boolean', preprocessorBlocked: 'boolean', batchHandled: 'boolean', exitCode: 'integer|null', error: 'object|null', toolCalls: 'array|null', toolCallSource: 'enum:history,test-session,logs-window,logs-runid,unavailable', effects: 'array|null', redactions: 'array' },
  },
  'flow-tests': {
    spec: { tests: 'array', notApplicable: 'string?', notChatStartable: 'array?' },
    extra(o, errors) {
      checkItems(o.tests, { id: 'string', workflow: 'string', pathId: 'string', input: 'object', expect: 'object' }, 'tests', errors);
      const na = typeof o.notApplicable === 'string' ? o.notApplicable.trim() : '';
      if (Array.isArray(o.tests) && o.tests.length === 0 && !na) errors.push('tests is empty: set notApplicable to the reason (for example "the agent has no workflows")');
      if (Array.isArray(o.tests) && o.tests.length > 0 && na) errors.push('notApplicable is set but tests is not empty: use one or the other');
      const ids = (o.tests ?? []).map((t) => t?.id);
      if (new Set(ids).size !== ids.length) errors.push('tests: ids must be unique');
    },
  },
  'flow-test-result': {
    spec: { id: 'string', workflow: 'string', pathId: 'string', argv: 'array', exitCode: 'integer|null', status: 'enum:pass,fail,error', reasons: 'array', reached: 'array|null', ms: 'number', stdoutTail: 'string' },
  },
  'tool-tests': {
    spec: { tests: 'array', expectedLogs: 'array?' },
    extra(o, errors) {
      checkItems(o.tests, { id: 'string', tool: 'string', input: 'object', expect: 'enum:ok,error', rationale: 'string' }, 'tests', errors);
      // A tool's own deliberate console.warn lines (a refused reset, a P1 ticket notice), found in its code at plan time.
      // Sealed with the plan, warn only, a literal substring: the log scan counts them as expected, never hides an error.
      checkItems(o.expectedLogs, { tool: 'string', subType: 'enum:warn?', match: 'string', why: 'string' }, 'expectedLogs', errors);
      (Array.isArray(o.expectedLogs) ? o.expectedLogs : []).forEach((x, i) => {
        if (typeof x?.match === 'string' && x.match.trim().length < 6) errors.push(`expectedLogs[${i}].match must be at least 6 characters of the logged text`);
      });
      const ids = (o.tests ?? []).map((t) => t?.id);
      if (new Set(ids).size !== ids.length) errors.push('tests: ids must be unique');
    },
  },
  'tool-test-result': {
    spec: { id: 'string', tool: 'string', exitCode: 'integer|null', threw: 'boolean', errorMessage: 'string|null', status: 'enum:pass,fail,error', reasons: 'array', ms: 'number', outputTail: 'string' },
  },
  'stress-plan': {
    spec: { mode: 'enum:concurrent,burst', threads: 'integer?', turnsPerThread: 'integer?', concurrency: 'integer?', messages: 'array', burst: 'object|null?', maxWallSeconds: 'number', targets: 'object' },
    extra(o, errors) {
      if (Array.isArray(o.messages) && o.messages.length < 1) errors.push('messages needs at least 1 item');
      if (o.mode === 'concurrent') {
        for (const f of ['threads', 'turnsPerThread', 'concurrency']) {
          if (!(Number.isInteger(o[f]) && o[f] >= 1)) errors.push(`${f} is required (an integer >= 1) when mode is concurrent`);
        }
      }
      if (o.mode === 'burst') {
        if (!o.burst) errors.push('burst is required when mode is burst');
        else checkFields(o.burst, { size: 'integer', delayMs: 'integer' }, 'burst.', errors);
      }
      checkFields(o.targets, { p90Ms: 'number', p99Ms: 'number', errorRate: 'number' }, 'targets.', errors);
      if (typeof o.maxWallSeconds === 'number' && o.maxWallSeconds > 105) errors.push('maxWallSeconds must be <= 105 (each CLI call finishes within 110 s)');
    },
  },
  'stress-result': {
    spec: { mode: 'enum:concurrent,burst', complete: 'boolean', requests: 'integer', ok: 'integer', errors: 'integer', errorRate: 'number', latencyMs: 'object', ttfbMs: 'object|null', burst: 'object|null', targetsMet: 'object', status: 'enum:pass,fail,partial', resumeFrom: 'object|null' },
  },
  clusters: {
    spec: { clusters: 'array' },
    extra: (o, errors) => checkItems(o.clusters, { id: 'string', title: 'string', rootCause: 'string', severity: 'enum:critical,major,minor', rank: 'integer', count: 'integer', affected: 'object', evidence: 'array', fixLocus: `enum:${FIX_LOCI.join(',')}`, movesLogicOutOfPrompt: 'boolean', recommendation: 'string', fixPath: 'enum:/lua-new,/lua-test,/lua-workflow,persona-edit,/lua-deploy,operational,platform-report', effort: 'enum:S,M,L', harnessArtefact: 'boolean?' }, 'clusters', errors),
    extra2(o, errors) {
      (o.clusters ?? []).forEach((c, i) => {
        if (Array.isArray(c?.evidence) && c.evidence.length < 1) errors.push(`clusters[${i}].evidence needs at least 1 item`);
      });
    },
  },
  contamination: {
    spec: { status: 'enum:CLEAN,CONTAMINATED,UNVERIFIED', reasons: 'array', threads: 'array', players: 'array', storedUserTurns: 'integer|null', sentUserTurns: 'integer', historySource: 'enum:history,test-session,unavailable' },
  },
  readability: {
    spec: { technical: 'boolean', fails: 'integer', slowTurns: 'integer', medianSeconds: 'number|null', maxSeconds: 'number|null', turns: 'array' },
  },
  claims: {
    spec: { status: 'enum:ok,unverifiable', total: 'integer', turns: 'array' },
  },
  grade: {
    spec: { grader: 'enum:A,B', runRef: 'string', cardId: 'string', verdict: 'enum:PASS,PARTIAL,FAIL', safety: 'boolean', safetyNotes: 'array', criteria: 'array', candidates: 'array', defects: 'array', best: 'array' },
    extra(o, errors) {
      checkItems(o.criteria, { id: 'string', status: 'enum:met,partly,not-met,n/a' }, 'criteria', errors);
      checkItems(o.candidates, { source: 'enum:readability,claims', turn: 'integer', item: 'string', decision: 'enum:confirmed,dismissed', why: 'string' }, 'candidates', errors);
      checkItems(o.defects, { severity: 'enum:major,minor', why: 'string' }, 'defects', errors);
    },
  },
  preflight: {
    spec: { node: 'string', luaCli: 'object', credential: 'object', dotenv: 'object', gitignore: 'object', report: 'object', project: 'object', warnings: 'array' },
  },
  'log-scan': {
    spec: { window: 'object', environment: 'enum:sandbox,production', rows: 'integer', truncatedWindows: 'array', errors: 'array', warns: 'array', byPrimitive: 'object', status: 'enum:pass,fail' },
  },
  ledger: {
    spec: { id: 'string', at: 'string', source: 'enum:test-session-effect,tool-call,player-report,workflow-test,stress,cleanup', runRef: 'string|null', turn: 'integer|null', kind: 'string', detail: 'string', expected: 'boolean|null', reversible: 'boolean|null', cleanup: 'enum:none,auto,manual', cleanupHint: 'string|null' },
  },
  cleanup: {
    spec: { applied: 'boolean', actions: 'array' },
    extra: (o, errors) => checkItems(o.actions, { kind: 'enum:clear-thread,close-test-session,remove-lock,restore-feature,manual', target: 'string', status: 'enum:planned,done,failed,skipped', note: 'string' }, 'actions', errors),
  },
  results: {
    spec: { runId: 'string', mode: 'enum:full,quick', generatedAt: 'string', plugin: 'object', luaCli: 'object', agent: 'object', environment: 'object', window: 'object', config: 'object', qualifying: 'array', metrics: 'array', summary: 'object', cards: 'array', flowTests: 'array', toolTests: 'array', stress: 'object|null', logs: 'object|null', sideEffects: 'array', cleanup: 'object|null', clusters: 'array', diagrams: 'object', artifacts: 'object', tier: `enum:${TIER_IDS.join(',')}?`, budgetMinutes: 'number?', elapsedMinutes: 'number|null?', verdict: 'object?', scope: 'object?' },
    extra(o, errors) {
      checkFields(o.summary, { overall: 'enum:pass,partial,fail', cards: 'object', runs: 'object', redTeam: 'object', safetyVetoes: 'integer', flowTests: 'object', toolTests: 'object', stress: 'object', logErrors: 'integer', sideEffects: 'object' }, 'summary.', errors);
      checkItems(o.cards, { id: 'string', kind: 'enum:icp,redteam', chip: 'enum:pass,partial,fail', inconclusive: 'boolean', safetyVeto: 'boolean', bar: 'object', runs: 'array' }, 'cards', errors);
      checkItems(o.metrics, { id: 'string', status: 'enum:pass,partial,fail,n/a,not-in-tier' }, 'metrics', errors);
      if (o.verdict) checkFields(o.verdict, { text: 'string', passed: 'boolean', releaseReady: 'boolean', blockers: 'array', nextTier: 'string|null' }, 'verdict.', errors);
      checkFields(o.artifacts, { md: 'string', html: 'string', pdf: 'string|null', pdfSkippedReason: 'string|null' }, 'artifacts.', errors);
    },
  },
};

/**
 * @param {string} name one of SCHEMA_NAMES
 * @param {any} obj
 * @param {{testData?: {allowedDomains?: string[], allowedEmailDomains?: string[]}}} [ctx] the run's test-data policy
 * @returns {{ok:true}|{ok:false, errors:string[]}}
 */
export function validate(name, obj, ctx = {}) {
  const def = SCHEMAS[name];
  if (!def) return { ok: false, errors: [`unknown schema "${name}"`] };
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['value must be an object'] };
  const id = `lua-qa/${name}@1`;
  if (obj.schema !== id) errors.push(`schema must be "${id}"`);
  checkFields(obj, def.spec, '', errors);
  if (errors.length === 0 || obj.schema === id) {
    def.extra?.(obj, errors, ctx);
    def.extra2?.(obj, errors, ctx);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

// ---------------------------------------------------------------- plan validation (3.6)

async function listJsonFiles(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/**
 * The coverage checklist of icp-cards.md, as numbers, for the run's tier (lib/qa/tiers.mjs holds the per-tier
 * values). The counts come from run.json, never below the tier's floor; the tier comes from state.json first.
 */
export function planChecklist(run, state = null) {
  const tier = runTier(run, state);
  return {
    tier: tier.id,
    minIcp: Math.max(tier.icp.min, run?.counts?.icp ?? tier.icp.min),
    maxIcp: tier.icp.max,
    minRedTeam: tier.redTeam.min,
    maxRedTeam: tier.redTeam.max,
    personasPerSkill: tier.personasPerSkill,
    turns: { icp: { min: 4, max: 12 }, redteam: { min: 3, max: 8 } },
    variations: [...tier.variations],
    everyToolInCards: tier.everyToolInCards,
    chatWorkflowsInCards: tier.chatWorkflowsInCards,
    flowTests: tier.flowTests,
    stress: tier.stress,
    attackCoverage: tier.attackCoverage,
    budgetMinutes: tier.budgetMinutes,
  };
}

// Free-text fallbacks for a card that names its variation in the temperament or name instead of `traits`.
const TRAIT_WORDS = {
  impatient: /\b(impatient|hurried|rushed|in a hurry)\b/i,
  'privacy-sensitive': /\b(privacy|private|suspicious|guarded)\b/i,
  vague: /\b(vague|unsure|unclear|undecided)\b/i,
  'out-of-scope': /\bout[- ]of[- ]scope\b/i,
};

function hasTrait(card, trait) {
  if (Array.isArray(card.traits) && card.traits.includes(trait)) return true;
  const re = TRAIT_WORDS[trait];
  return Boolean(re && re.test(`${card.name ?? ''} ${card.persona?.temperament ?? ''}`));
}

function checkTurns(card, f, rules, errors) {
  const t = card.turns;
  if (!Number.isInteger(t?.min) || !Number.isInteger(t?.max)) return;
  const range = rules.turns[card.kind] ?? rules.turns.icp;
  if (t.min > t.max) errors.push(`plan/cards/${f}: turns.min (${t.min}) is greater than turns.max (${t.max})`);
  if (t.min < range.min || t.max > range.max) {
    errors.push(`plan/cards/${f}: turns must stay within ${range.min} to ${range.max} for a ${card.kind === 'redteam' ? 'red-team' : 'persona'} card (got ${t.min} to ${t.max})`);
  }
}

/** Checklist lines the cards do not meet yet (coverage gaps, so the plan gate stays shut until they are fixed). */
function checklistGaps(icp, model, flowPlan, rules) {
  const gaps = [];
  if (icp.length && !icp.some((c) => c.persona?.technical === true || hasTrait(c, 'technical'))) gaps.push('checklist: no technical persona');
  if (icp.length && !icp.some((c) => c.persona?.technical === false || hasTrait(c, 'non-technical'))) gaps.push('checklist: no non-technical persona');
  for (const trait of rules.variations) {
    if (icp.length && !icp.some((c) => hasTrait(c, trait))) gaps.push(`checklist: no ${trait} persona (add "${trait}" to a card's traits)`);
  }
  if (!model) return gaps;
  for (const skill of rules.personasPerSkill > 0 ? model.skills ?? [] : []) {
    const n = icp.filter((c) => (c.coverage?.skills ?? []).includes(skill.name)).length;
    if (n < rules.personasPerSkill) gaps.push(`checklist: skill ${skill.name} is hit by ${n} persona(s), needs ${rules.personasPerSkill}`);
  }
  if (rules.chatWorkflowsInCards === false) return gaps;
  const notFromChat = new Set(Array.isArray(flowPlan?.notChatStartable) ? flowPlan.notChatStartable : []);
  const inCards = new Set(icp.flatMap((c) => c.coverage?.workflows ?? []));
  for (const wf of model.workflows ?? []) {
    if (wf.schedule || notFromChat.has(wf.name) || inCards.has(wf.name)) continue;
    gaps.push(`checklist: workflow ${wf.name} is not in any persona's coverage.workflows (list it in flow-tests.json notChatStartable if a user cannot start it from chat)`);
  }
  return gaps;
}

/**
 * Flow tests against the flow model: n/a only without workflows, every path of a graph workflow tested. The smoke
 * tier tests the happy path only: one test per workflow, no more.
 */
function flowCoverage(flowPlan, model, errors, gaps, mode = 'all') {
  if (!flowPlan || !model || !Array.isArray(flowPlan.tests)) return;
  const wfs = model.workflows ?? [];
  const byName = new Map(wfs.map((w) => [w.name, w]));
  if (wfs.length && typeof flowPlan.notApplicable === 'string' && flowPlan.notApplicable.trim()) {
    errors.push(`plan/flow-tests.json: notApplicable is only for an agent without workflows; this one has ${wfs.length}`);
  }
  for (const t of flowPlan.tests) {
    if (t && typeof t.workflow === 'string' && !byName.has(t.workflow)) errors.push(`plan/flow-tests.json: ${t.id}: workflow ${t.workflow} is not in the flow model`);
  }
  for (const wf of wfs) {
    const tests = flowPlan.tests.filter((t) => t?.workflow === wf.name);
    if (mode === 'happy-path') {
      if (!tests.length) gaps.push(`flow-tests: workflow ${wf.name} has no happy-path test`);
      if (tests.length > 1) errors.push(`plan/flow-tests.json: the smoke tier tests the happy path only, one test per workflow; ${wf.name} has ${tests.length}`);
      continue;
    }
    if (wf.form === 'script' || !(wf.paths ?? []).length) {
      if (!tests.length) gaps.push(`flow-tests: workflow ${wf.name} has no test (a script-form workflow needs one happy-path test)`);
      continue;
    }
    const tested = new Set(tests.map((t) => t.pathId));
    for (const p of wf.paths) if (!tested.has(p.id)) gaps.push(`flow-tests: path ${wf.name}/${p.id} has no test`);
  }
}

/** Plan rules beyond per-file schemas. Never throws for missing files: they become errors. */
export async function validatePlan(runDir) {
  const result = await validatePlanWithEstimate(runDir);
  delete result.estimate;
  return result;
}

/** validatePlan plus the time estimate against the tier's budget (`validate --what plan` prints it). */
export async function validatePlanWithEstimate(runDir) {
  const errors = [];
  const coverageGaps = [];
  const run = await readJsonOr(join(runDir, 'run.json'));
  if (!run) return { ok: false, errors: ['run.json is missing'], coverageGaps, estimate: null };
  const rv = validate('run', run);
  if (!rv.ok) errors.push(...rv.errors.map((e) => `run.json: ${e}`));
  const state = await readJsonOr(join(runDir, 'state.json'));
  const policy = testDataPolicy(run, state);
  const rules = planChecklist(run, state);
  const tier = runTier(run, state);
  if (run.tier !== undefined && run.tier !== tier.id) errors.push(`run.json: tier ${run.tier} does not match the run's tier ${tier.id} (set by init-run)`);
  if (!barAllowed(tier, run.bar)) errors.push(`run.json: the bar ${run.bar?.passRequired} of ${run.bar?.runsPerCard} is not one the ${tier.label} tier allows`);
  const cards = [];
  for (const f of await listJsonFiles(join(runDir, 'plan', 'cards'))) {
    const card = await readJsonOr(join(runDir, 'plan', 'cards', f));
    if (!card) {
      errors.push(`plan/cards/${f}: not valid JSON`);
      continue;
    }
    const v = validate('card', card, { testData: policy });
    if (!v.ok) errors.push(...v.errors.map((e) => `plan/cards/${f}: ${e}`));
    else if (f !== `${card.id}.json`) errors.push(`plan/cards/${f}: file name must be ${card.id}.json`);
    cards.push(card);
    checkTurns(card, f, rules, errors);
    // Every text field: persona.context, mustNot, successCriteria, redTeam.target ... not only the openers.
    const td = checkTestData(JSON.stringify(card), policy);
    const seen = new Set();
    for (const viol of td.violations) {
      if (seen.has(viol.value)) continue;
      seen.add(viol.value);
      errors.push(`plan/cards/${f}: ${viol.kind} "${viol.value}" is not fake test data${viol.reason ? ` (${viol.reason})` : ''}`);
    }
  }
  const icp = cards.filter((c) => c.kind === 'icp');
  const rt = cards.filter((c) => c.kind === 'redteam');
  const model = await readJsonOr(join(runDir, 'discovery', 'flow-model.json'));
  const exposed = rules.attackCoverage ? exposedAttackClasses(model) : [];
  const minRedTeam = Math.max(rules.minRedTeam, exposed.length);
  if (icp.length < rules.minIcp) errors.push(`need at least ${rules.minIcp} ICP cards, found ${icp.length}`);
  if (rules.maxIcp !== null && icp.length > rules.maxIcp) errors.push(`the ${tier.label} tier has at most ${rules.maxIcp} ICP cards, found ${icp.length}`);
  if (rt.length < minRedTeam) errors.push(`need at least ${minRedTeam} red-team cards, found ${rt.length}`);
  if (rules.maxRedTeam !== null && rt.length > rules.maxRedTeam) errors.push(`the ${tier.label} tier has at most ${rules.maxRedTeam} red-team card(s), found ${rt.length}`);
  const attacks = new Set(rt.map((c) => c.redTeam?.attack));
  for (const a of exposed) if (!attacks.has(a)) coverageGaps.push(`red team: the tools expose ${a}, and no red-team card attacks it (the ${tier.label} tier covers every exposed attack class)`);

  if (model && rules.everyToolInCards) {
    const covered = new Set(cards.flatMap((c) => c.coverage?.tools ?? []));
    for (const skill of model.skills ?? []) {
      for (const tool of skill.tools ?? []) {
        if (!covered.has(tool.name)) coverageGaps.push(`tool ${tool.name} (skill ${skill.name}) is not covered by any card`);
      }
    }
  }
  if (!model) errors.push('discovery/flow-model.json is missing (run discover and flow-model first)');

  let flowPlan = null;
  let toolPlan = null;
  let stressPlan = null;
  for (const [file, name] of [['flow-tests.json', 'flow-tests'], ['tool-tests.json', 'tool-tests'], ['stress.json', 'stress-plan']]) {
    const obj = await readJsonOr(join(runDir, 'plan', file));
    if (name === 'stress-plan' && rules.stress === 'none') {
      if (obj) errors.push(`plan/stress.json: the ${tier.label} tier has no stress test; remove the file`);
      continue;
    }
    if (!obj) {
      errors.push(`plan/${file} is missing`);
      continue;
    }
    if (name === 'flow-tests') flowPlan = obj;
    if (name === 'tool-tests') toolPlan = obj;
    if (name === 'stress-plan') stressPlan = obj;
    const v = validate(name, obj, { testData: policy });
    if (!v.ok) errors.push(...v.errors.map((e) => `plan/${file}: ${e}`));
    const td = checkTestData(JSON.stringify(obj), policy);
    for (const viol of td.violations) errors.push(`plan/${file}: ${viol.kind} "${viol.value}" is not fake test data${viol.reason ? ` (${viol.reason})` : ''}`);
    if (name === 'stress-plan' && obj.mode === 'concurrent' && run.environment?.kind === 'sandbox') {
      errors.push('plan/stress.json: concurrent stress needs a staged or production environment (sandbox chats run one at a time); use mode burst');
    }
    if (name === 'stress-plan' && obj.mode === 'burst' && run.environment?.kind === 'staged') {
      errors.push('plan/stress.json: burst stress has no staged path (lua chat -b targets sandbox or production); use mode concurrent');
    }
  }
  flowCoverage(flowPlan, model, errors, coverageGaps, rules.flowTests);
  coverageGaps.push(...checklistGaps(icp, model, flowPlan, rules));

  // Time budget: the plan must fit the tier's wall clock (sandbox pacing, lib/qa/tiers.mjs estimateMinutes).
  const sizing = {
    envKind: run.environment?.kind ?? 'sandbox',
    icp: icp.length,
    redTeam: rt.length,
    runsPerCard: runBar(run, state).runsPerCard,
    toolTests: Array.isArray(toolPlan?.tests) ? toolPlan.tests.length : 0,
    flowTests: Array.isArray(flowPlan?.tests) ? flowPlan.tests.length : 0,
    stress: stressPlan?.mode ?? null,
  };
  const estimate = { minutes: estimateMinutes(sizing), budgetMinutes: rules.budgetMinutes, tier: tier.id };
  if (estimate.minutes > estimate.budgetMinutes) {
    const drop = cardsOverBudget(sizing, estimate.budgetMinutes);
    errors.push(`the plan needs about ${estimate.minutes} min, over the ${tier.label} budget of ${estimate.budgetMinutes} min: ${drop > 0 && sizing.icp + sizing.redTeam - drop >= rules.minIcp + minRedTeam ? `drop ${drop} card(s)` : 'trim the tool and flow tests, or run a larger tier'}`);
  }
  return { ok: errors.length === 0 && coverageGaps.length === 0, errors, coverageGaps, estimate };
}

const WHAT_FILES = {
  run: ['run.json', 'run'],
  metrics: [join('plan', 'metrics.json'), 'metrics'],
  questions: [join('plan', 'questions.json'), 'questions'],
  'flow-tests': [join('plan', 'flow-tests.json'), 'flow-tests'],
  'tool-tests': [join('plan', 'tool-tests.json'), 'tool-tests'],
  stress: [join('plan', 'stress.json'), 'stress-plan'],
};

export async function cliValidate(argv, io) {
  try {
    const { values } = parseArgs(argv, {
      'run-dir': { type: 'string', required: true },
      what: { type: 'string', required: true, choices: ['cards', 'flow-tests', 'tool-tests', 'stress', 'plan', 'run', 'metrics', 'questions'] },
      json: { type: 'boolean' },
    });
    const runDir = resolveRunDir(io, values['run-dir']);
    const what = values.what;
    let result;
    if (what === 'plan') result = await validatePlanWithEstimate(runDir);
    else if (what === 'cards') {
      const errors = [];
      const policy = testDataPolicy(await readJsonOr(join(runDir, 'run.json')), await readJsonOr(join(runDir, 'state.json')));
      const files = await listJsonFiles(join(runDir, 'plan', 'cards'));
      if (files.length === 0) errors.push('no cards found in plan/cards');
      for (const f of files) {
        let card;
        try {
          card = await readJson(join(runDir, 'plan', 'cards', f));
        } catch {
          errors.push(`plan/cards/${f}: not valid JSON`);
          continue;
        }
        const v = validate('card', card, { testData: policy });
        if (!v.ok) errors.push(...v.errors.map((e) => `plan/cards/${f}: ${e}`));
        for (const viol of checkTestData(JSON.stringify(card), policy).violations) {
          errors.push(`plan/cards/${f}: ${viol.kind} "${viol.value}" is not fake test data${viol.reason ? ` (${viol.reason})` : ''}`);
        }
      }
      result = { ok: errors.length === 0, errors, coverageGaps: [] };
    } else {
      const [rel, schema] = WHAT_FILES[what];
      const obj = await readJsonOr(join(runDir, rel));
      if (!obj) result = { ok: false, errors: [`${rel} is missing or not valid JSON`], coverageGaps: [] };
      else {
        const v = validate(schema, obj);
        result = { ok: v.ok, errors: v.ok ? [] : v.errors, coverageGaps: [] };
      }
    }
    emit(io, result);
    return result.ok ? 0 : 1;
  } catch (err) {
    return fail(io, err);
  }
}


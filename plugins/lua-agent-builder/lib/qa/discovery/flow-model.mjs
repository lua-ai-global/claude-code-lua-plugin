// Flow model: compiled manifest + CLI snapshots -> discovery/flow-model.json.
// Pure functions except the CLI wrapper.
//
// Manifest shape (read from the lua-cli 3.45 compiler, `createManifest`): { version, compiledAt,
// primitives: [{ kind, name, description, ... }] } where kind is tool | skill | job | webhook | trigger |
// preprocessor | postprocessor | mcp-server | agent | workflow | ... Skills carry `context`, `tools` (names) and
// `hasCondition`; tools carry `schemas.input`; the agent carries `persona` and `model`; a graph-form workflow
// carries `graph: { definition: { graph: [entries], inputSchema, ... } }`, a script-form one `script`.
// Graph entries: step {step:{id,description}}, mapping, sleep, tool {toolId}, agent {agentId}, workflow
// {workflowId}, approval, waitForSignal, conditional {steps[], predicates[], exclusive, otherwise?},
// parallel {steps[]}, foreach {step}, loop {loopType, step, predicate}.

import { join } from 'node:path';
import { QaError, readJsonOr, writeJson, emit, fail, parseArgs, resolveRunDir } from '../io.mjs';

const MAX_PATHS_DEFAULT = 64;
const PERSONA_EXCERPT = 600;

const asArray = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

// ---------------------------------------------------------------------------------------------
// predicates

const CMP = { eq: '==', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function renderPath(p) {
  const s = String(p);
  if (s.startsWith('stepResults.')) return s.slice('stepResults.'.length);
  if (s === 'initData') return 'input';
  if (s.startsWith('initData.')) return `input.${s.slice('initData.'.length)}`;
  return s;
}

function renderOperand(o) {
  if (isObj(o) && typeof o.path === 'string') return renderPath(o.path);
  const lit = isObj(o) && 'literal' in o ? o.literal : o;
  if (typeof lit === 'string') return `'${lit}'`;
  if (lit === undefined) return 'null';
  return JSON.stringify(lit);
}

function renderChild(pred) {
  const text = renderPredicate(pred);
  return isObj(pred) && (pred.op === 'and' || pred.op === 'or') ? `(${text})` : text;
}

/** {op, left, right, ...} -> "classify.needsApproval == true", "not (watch.state == 'watching')". */
export function renderPredicate(pred) {
  if (pred === null || pred === undefined) return 'always';
  if (typeof pred === 'string') return pred;
  if (!isObj(pred) || typeof pred.op !== 'string') return JSON.stringify(pred).slice(0, 80);
  const { op } = pred;
  if (CMP[op]) return `${renderOperand(pred.left)} ${CMP[op]} ${renderOperand(pred.right)}`;
  if (op === 'in' || op === 'notIn') {
    const set = asArray(pred.set).map((v) => renderOperand({ literal: v })).join(', ');
    return `${renderOperand(pred.value)} ${op === 'in' ? 'in' : 'not in'} [${set}]`;
  }
  if (op === 'exists') return `${renderPath(pred.path)} exists`;
  if (op === 'notExists') return `${renderPath(pred.path)} is missing`;
  if (op === 'truthy') return `${renderOperand(pred.value)} is truthy`;
  if (op === 'falsy') return `${renderOperand(pred.value)} is falsy`;
  if (op === 'and' || op === 'or') return asArray(pred.args).map(renderChild).join(` ${op} `) || 'always';
  if (op === 'not') return `not (${renderPredicate(pred.arg)})`;
  return `${op}(...)`;
}

/** Step ids a predicate reads (`stepResults.<id>...` paths). */
export function predicateStepIds(pred, out = []) {
  if (Array.isArray(pred)) pred.forEach((p) => predicateStepIds(p, out));
  else if (isObj(pred)) {
    for (const [k, v] of Object.entries(pred)) {
      if (k === 'path' && typeof v === 'string') {
        const m = /^stepResults\.([^.]+)/.exec(v);
        if (m && !out.includes(m[1])) out.push(m[1]);
      } else predicateStepIds(v, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// graph -> nodes

function humanMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 'a while';
  if (n < 1000) return `${n} ms`;
  const s = n / 1000;
  if (s < 90) return `${+s.toFixed(1)} s`;
  const m = s / 60;
  if (m < 90) return `${+m.toFixed(1)} min`;
  return `${+(m / 60).toFixed(1)} h`;
}

const gist = (s, n = 80) => {
  const t = str(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

function extractEntries(definitionGraph) {
  if (Array.isArray(definitionGraph)) return definitionGraph;
  if (!isObj(definitionGraph)) return [];
  if (Array.isArray(definitionGraph.graph)) return definitionGraph.graph;
  if (isObj(definitionGraph.definition)) return extractEntries(definitionGraph.definition);
  return [];
}

/**
 * Walk a serialized workflow graph into a flat node list. The top-level entries form a spine linked by `next`;
 * container arms/bodies hang off `children` (and have `parent`). Returns { nodes, entry }.
 * @param {any} definitionGraph array of entries, `{graph:[...]}` or `{definition:{graph:[...]}}`
 */
export function graphToNodes(definitionGraph) {
  const nodes = [];
  const make = (type, label, extra = {}) => {
    const node = {
      id: `n${nodes.length + 1}`,
      type,
      label,
      stepId: null,
      sideEffects: null,
      approvalId: null,
      signal: null,
      predicate: null,
      children: [],
      branchLabels: [],
      next: null,
      parent: null,
      ...extra,
    };
    nodes.push(node);
    return node;
  };

  const convert = (entry, parent) => {
    const e = isObj(entry) ? entry : {};
    const t = str(e.type);
    let node;
    switch (t) {
      case 'step': {
        const s = isObj(e.step) ? e.step : {};
        node = make('step', gist(s.description || s.id || 'step', 70), { stepId: str(s.id) || null, sideEffects: e.sideEffects ?? null });
        break;
      }
      case 'mapping':
        node = make('mapping', `map ${str(e.id) || 'data'}`, { stepId: str(e.id) || null });
        break;
      case 'sleep':
        node = make('sleep', `wait ${humanMs(e.duration)}`, { stepId: str(e.id) || null });
        break;
      case 'tool':
        node = make('tool', `tool ${str(e.toolId) || str(e.id)}`, { stepId: str(e.id) || null, sideEffects: e.sideEffects ?? null, toolId: str(e.toolId) || null });
        break;
      case 'agent':
        node = make('agent', `AI step ${str(e.id)}`.trim(), { stepId: str(e.id) || null, detail: gist(e.promptTemplate, 90) || null });
        break;
      case 'workflow':
        node = make('workflow', `run workflow ${str(e.workflowId)}`.trim(), { stepId: str(e.id) || null, workflowId: str(e.workflowId) || null });
        break;
      case 'approval':
        node = make('approval', gist(e.title || e.id || 'approval', 70), {
          stepId: str(e.id) || null,
          approvalId: str(e.id) || null,
          onDeny: e.onDeny ?? null,
          onTimeout: typeof e.onTimeout === 'string' ? e.onTimeout : e.onTimeout ? 'escalate' : null,
        });
        break;
      case 'waitForSignal':
        node = make('waitForSignal', `wait for signal ${str(e.signal)}`.trim(), {
          stepId: str(e.id) || null,
          signal: str(e.signal) || null,
          onTimeout: typeof e.onTimeout === 'string' ? e.onTimeout : null,
        });
        break;
      case 'parallel': {
        node = make('parallel', 'in parallel');
        asArray(e.steps).forEach((arm, i) => {
          const child = convert(arm, node.id);
          node.children.push(child.id);
          node.branchLabels.push(`arm ${i + 1}`);
        });
        break;
      }
      case 'conditional': {
        node = make('conditional', e.exclusive ? 'choose one branch' : 'branches');
        node.exclusive = Boolean(e.exclusive);
        const preds = asArray(e.predicates);
        asArray(e.steps).forEach((arm, i) => {
          const child = convert(arm, node.id);
          node.children.push(child.id);
          node.branchLabels.push(renderPredicate(preds[i]));
          child.armPredicate = preds[i] ?? null;
        });
        if (isObj(e.otherwise)) {
          const child = convert(e.otherwise, node.id);
          node.children.push(child.id);
          node.branchLabels.push('else');
          node.hasOtherwise = true;
        } else {
          node.hasOtherwise = false;
        }
        node.predicate = node.branchLabels.filter((l) => l !== 'else').join(' | ') || null;
        break;
      }
      case 'foreach': {
        node = make('foreach', 'for each item');
        if (isObj(e.step)) {
          const child = convert(e.step, node.id);
          node.children.push(child.id);
          node.branchLabels.push('each item');
        }
        break;
      }
      case 'loop': {
        const until = e.loopType === 'until' || e.loopType === 'dountil';
        node = make('loop', until ? 'repeat until' : 'repeat while', { predicate: renderPredicate(e.predicate), loopPredicate: e.predicate ?? null });
        if (isObj(e.step)) {
          const child = convert(e.step, node.id);
          node.children.push(child.id);
          node.branchLabels.push(renderPredicate(e.predicate));
        }
        break;
      }
      default:
        node = make('opaque', `${t || 'unknown'} (not drawn)`, { stepId: str(e.id) || null });
    }
    node.parent = parent ?? null;
    return node;
  };

  let prev = null;
  let entry = null;
  for (const raw of extractEntries(definitionGraph)) {
    const node = convert(raw, null);
    if (prev) prev.next = node.id;
    else entry = node.id;
    prev = node;
  }
  // `convert` allocates ids depth-first, so arms get lower ids than their later siblings; the spine still follows `next`.
  return { nodes, entry };
}

// ---------------------------------------------------------------------------------------------
// paths

const addUnique = (arr, v) => {
  if (v && !arr.includes(v)) arr.push(v);
};

const emptyNeeds = () => ({ approve: [], deny: [], signals: [], stepOutputs: [], timeouts: [] });

const cloneState = (s) => ({
  nodes: [...s.nodes],
  needs: Object.fromEntries(Object.entries(s.needs).map(([k, v]) => [k, [...v]])),
});

/** Same as enumeratePaths, plus the truncation flag. */
export function enumeratePathsDetailed(nodes, entry, { maxPaths = MAX_PATHS_DEFAULT } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let truncated = false;
  if (!entry || !byId.has(entry)) return { paths: [], truncated };

  // Expand one node over a set of in-flight path states; returns the new set.
  const expandNode = (states, node) => {
    let out = [];
    const apply = (fn) => {
      for (const s of states) out.push(...fn(cloneState(s)));
    };
    switch (node.type) {
      case 'conditional': {
        const refs = [];
        node.children.forEach((cid) => {
          const child = byId.get(cid);
          if (child && child.armPredicate !== undefined) predicateStepIds(child.armPredicate, refs);
        });
        const arms = node.children.map((cid) => byId.get(cid)).filter(Boolean);
        const other = node.hasOtherwise ? arms[arms.length - 1] : null;
        const normal = node.hasOtherwise ? arms.slice(0, -1) : arms;
        for (const s of states) {
          for (const arm of normal) {
            const c = cloneState(s);
            c.nodes.push(node.id, arm.id);
            predicateStepIds(arm.armPredicate, []).forEach((id) => addUnique(c.needs.stepOutputs, id));
            if (arm.type === 'agent') addUnique(c.needs.stepOutputs, arm.stepId);
            out.push(...expandInner(c, arm));
          }
          // the "else" arm: a real catch-all node, or "no branch taken"
          const c = cloneState(s);
          refs.forEach((id) => addUnique(c.needs.stepOutputs, id));
          if (other) {
            c.nodes.push(node.id, other.id);
            if (other.type === 'agent') addUnique(c.needs.stepOutputs, other.stepId);
            out.push(...expandInner(c, other));
          } else {
            c.nodes.push(node.id);
            out.push(c);
          }
        }
        break;
      }
      case 'parallel':
        apply((c) => {
          c.nodes.push(node.id);
          let sub = [c];
          for (const cid of node.children) {
            const child = byId.get(cid);
            if (!child) continue;
            sub = sub.flatMap((st) => {
              const cc = cloneState(st);
              cc.nodes.push(child.id);
              if (child.type === 'agent') addUnique(cc.needs.stepOutputs, child.stepId);
              return expandInner(cc, child);
            });
          }
          return sub;
        });
        break;
      case 'approval':
        apply((c) => {
          c.nodes.push(node.id);
          const approve = cloneState(c);
          addUnique(approve.needs.approve, node.approvalId);
          if (node.onDeny === 'continue') {
            const deny = cloneState(c);
            addUnique(deny.needs.deny, node.approvalId);
            return [approve, deny];
          }
          return [approve];
        });
        break;
      case 'waitForSignal':
        apply((c) => {
          c.nodes.push(node.id);
          const got = cloneState(c);
          addUnique(got.needs.signals, node.signal);
          if (node.onTimeout === 'continue') {
            const timeout = cloneState(c);
            addUnique(timeout.needs.timeouts, node.stepId);
            return [got, timeout];
          }
          return [got];
        });
        break;
      case 'loop':
      case 'foreach':
        apply((c) => {
          c.nodes.push(node.id);
          if (node.type === 'loop') predicateStepIds(node.loopPredicate, []).forEach((id) => addUnique(c.needs.stepOutputs, id));
          const child = byId.get(node.children[0]);
          if (child) {
            c.nodes.push(child.id);
            if (child.type === 'agent') addUnique(c.needs.stepOutputs, child.stepId);
            return expandInner(c, child);
          }
          return [c];
        });
        break;
      default:
        apply((c) => {
          c.nodes.push(node.id);
          if (node.type === 'agent') addUnique(c.needs.stepOutputs, node.stepId);
          return [c];
        });
    }
    if (out.length > maxPaths) {
      truncated = true;
      out = out.slice(0, maxPaths);
    }
    return out;
  };

  // An arm that is itself a container (rare): expand its own children on top of the state.
  const expandInner = (state, arm) => {
    if (!['conditional', 'parallel', 'approval', 'waitForSignal', 'loop', 'foreach'].includes(arm.type)) return [state];
    state.nodes.pop(); // expandNode pushes the arm id itself
    return expandNode([state], arm);
  };

  let states = [{ nodes: [], needs: emptyNeeds() }];
  let cur = byId.get(entry);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    states = expandNode(states, cur);
    cur = cur.next ? byId.get(cur.next) : null;
  }
  const paths = states.slice(0, maxPaths).map((s, i) => {
    const needs = { ...s.needs };
    if (!needs.timeouts.length) delete needs.timeouts;
    return { id: `p${i + 1}`, nodes: s.nodes, needs };
  });
  if (states.length > maxPaths) truncated = true;
  return { paths, truncated };
}

/**
 * DFS over the spine. conditional -> one path per arm (+ else); approval -> approve (+ deny when onDeny is
 * 'continue'); waitForSignal -> signal (+ timeout when onTimeout is 'continue'); loop -> one iteration;
 * foreach -> one item; parallel -> all arms in one path.
 */
export function enumeratePaths(nodes, entry, opts = {}) {
  return enumeratePathsDetailed(nodes, entry, opts).paths;
}

// ---------------------------------------------------------------------------------------------
// tools, skills

// One source for both checks: the first verb in the tool name decides, the description is the fallback.
// open/raise/file/log/reset/grant/request/register/submit change data too (acme_open_it_ticket, reset_password).
export const WRITE_WORDS = Object.freeze([
  'create', 'send', 'post', 'update', 'delete', 'remove', 'book', 'cancel', 'refund', 'charge', 'pay', 'order', 'submit',
  'schedule', 'assign', 'close', 'write', 'upsert', 'insert', 'notify', 'email', 'sms', 'publish', 'open', 'raise', 'file',
  'log', 'reset', 'grant', 'request', 'register', 'revoke', 'escalate', 'approve', 'reject', 'transfer', 'unlock', 'disable',
  'enable', 'add', 'set', 'save', 'issue', 'provision', 'deprovision', 'archive', 'upload', 'invite', 'enroll',
]);
export const READ_WORDS = Object.freeze([
  'get', 'list', 'search', 'find', 'lookup', 'read', 'fetch', 'check', 'status', 'view', 'describe', 'show', 'query', 'retrieve', 'count',
]);
// Words that are also nouns ("get_order_status", "list_schedule", "get_open_tickets", "list_log_entries"): not enough on
// their own to call a read tool a writer.
const AMBIGUOUS = new Set(['order', 'schedule', 'close', 'post', 'assign', 'pay', 'status', 'open', 'log', 'file', 'request', 'register', 'set', 'issue']);
const WRITE_SET = new Set(WRITE_WORDS);
const READ_SET = new Set(READ_WORDS);

function words(s) {
  return str(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./:]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 'likely' when the tool name/description has a write verb; 'none' when it only reads; else 'unknown'.
 * The first verb in the tool name decides, so a vendor prefix ("acme_open_it_ticket") does not hide it: a read verb
 * reads unless an unambiguous write verb follows ("get_and_update_cart"); a write verb writes, except a noun-like one
 * after a prefix that is followed by a read verb ("acme_order_status"). Without a verb in the name, the description
 * decides. 'unknown' is never drawn as "reads only".
 */
export function toolSideEffect(tool) {
  const nameWords = words(tool && tool.name);
  const idx = nameWords.findIndex((w) => WRITE_SET.has(w) || READ_SET.has(w));
  if (idx >= 0) {
    const verb = nameWords[idx];
    const rest = nameWords.slice(idx + 1);
    if (READ_SET.has(verb)) return rest.some((w) => WRITE_SET.has(w) && !AMBIGUOUS.has(w)) ? 'likely' : 'none';
    if (idx === 0 || !AMBIGUOUS.has(verb)) return 'likely';
    return rest.some((w) => READ_SET.has(w)) ? 'none' : 'likely';
  }
  const text = [...nameWords, ...words(tool && tool.description)];
  if (text.some((w) => WRITE_SET.has(w) && !AMBIGUOUS.has(w))) return 'likely';
  if (text.some((w) => READ_SET.has(w))) return 'none';
  if (text.some((w) => WRITE_SET.has(w))) return 'likely';
  return 'unknown';
}

/** The edge text for a call: only a tool known to read is "reads only". */
export function effectLabel(effect) {
  if (effect === 'likely') return 'may change data';
  if (effect === 'none') return 'reads only';
  return 'effect unknown';
}

function requiredFields(schema) {
  return isObj(schema) && Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [];
}

function conditionHintOf(description) {
  const m = /\b(use (?:this )?(?:tool )?(?:only )?(?:when|if|for)\b[^.\n]*)/i.exec(str(description));
  return m ? gist(m[1], 120) : null;
}

// ---------------------------------------------------------------------------------------------
// rules from the persona and the skill context

const MUST_NEVER_RE = /\b(never|must not|mustn't|do not|don't|cannot|can't|may not|not allowed|forbidden|prohibited|refuse|under no circumstances)\b/i;
const ESCALATE_RE = /\b(escalat\w*|hand(?:s|ed)? (?:it )?(?:off|over)|handoff|transfer\w* (?:to|the)|human agent|a human|supervisor|on-call|on call|p1|urgent|emergency)\b/i;
const ASK_RE = /\b(ask|asks|asking|confirm|collect|request)\b/i;
const CONDITION_RE = /\b(only|when|whenever|if|before|after|unless|first)\b/i;
const RULE_MAX = 8;

/** Sentences and bullet lines of a prompt text, without bullet markers. */
export function ruleSentences(text) {
  return str(text)
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 8);
}

/** Must-never and escalation rules stated in a persona or a skill context (a sentence can be both). */
export function extractRules(text) {
  const mustNever = [];
  const escalation = [];
  for (const s of ruleSentences(text)) {
    if (MUST_NEVER_RE.test(s)) addUnique(mustNever, gist(s, 160));
    if (ESCALATE_RE.test(s)) addUnique(escalation, gist(s, 160));
  }
  return { mustNever: mustNever.slice(0, RULE_MAX), escalation: escalation.slice(0, RULE_MAX) };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A matcher for a code name in prose: "employeeEmail" also matches "employee email", "open_ticket" "open ticket". */
function mentionRe(name) {
  const w = words(name);
  if (!w.length) return null;
  const alts = new Set([escapeRe(str(name)), w.map(escapeRe).join('[\\s_-]?')]);
  return new RegExp(`(?:^|[^A-Za-z0-9])(?:${[...alts].join('|')})(?:$|[^A-Za-z0-9])`, 'i');
}

/** When the tool is meant to run: its description's condition sentences plus skill-context sentences naming it. */
export function toolConditions(tool, skillContext) {
  const out = [];
  addUnique(out, conditionHintOf(tool && tool.description));
  for (const s of ruleSentences(tool && tool.description)) if (CONDITION_RE.test(s)) addUnique(out, gist(s, 140));
  const re = mentionRe(tool && tool.name);
  if (re) for (const s of ruleSentences(skillContext)) if (re.test(s)) addUnique(out, gist(s, 140));
  return out.slice(0, 4);
}

/** One ask path per required field: what the agent asks when the field is missing (context, schema or default). */
export function askPaths(tool, skillContext) {
  const schema = isObj(tool && tool.inputSchema) ? tool.inputSchema : {};
  const props = isObj(schema.properties) ? schema.properties : {};
  const sentences = [...ruleSentences(skillContext), ...ruleSentences(tool && tool.description)];
  return requiredFields(schema).map((field) => {
    const re = mentionRe(field);
    const said = re ? sentences.find((s) => ASK_RE.test(s) && re.test(s)) : null;
    if (said) return { field, ask: gist(said, 140), source: 'context' };
    const desc = isObj(props[field]) ? str(props[field].description) : '';
    if (desc) return { field, ask: gist(`ask the user for ${desc.replace(/\.$/, '')}`, 140), source: 'schema' };
    return { field, ask: `ask the user for ${words(field).join(' ') || field}`, source: 'default' };
  });
}

const ASKS_SHOWN = 4;

/**
 * Tree for one skill, consumed by diagrams.layoutTree: skill -> the persona/skill rules (must never, escalate) ->
 * one decision node per tool (its condition) -> the call leaf plus one "ask for <field>" node per required field;
 * plus a "no tool" fallback leaf.
 * @param {object} skill
 * @param {{mustNever?: string[], escalation?: string[]}} [personaRules] the agent-wide rules from the persona
 */
export function buildDecisionTree(skill, personaRules = {}) {
  const tools = asArray(skill && skill.tools);
  const hint = skill && skill.hasCondition ? 'has a run condition' : null;
  const root = {
    id: 's',
    kind: 'skill',
    label: str(skill && skill.name) || 'skill',
    sub: hint || gist((skill && skill.context) || (skill && skill.description) || '', 90) || '',
    children: [],
  };
  const own = (skill && skill.rules) || extractRules(skill && skill.context);
  const mustNever = [...asArray(own.mustNever), ...asArray(personaRules.mustNever)];
  const escalation = [...asArray(own.escalation), ...asArray(personaRules.escalation)];
  if (mustNever.length) {
    root.children.push({ id: 'r.never', kind: 'rule', label: `must never (${mustNever.length})`, sub: gist(mustNever[0], 90), edge: 'always', rules: mustNever, children: [] });
  }
  if (escalation.length) {
    root.children.push({ id: 'r.escalate', kind: 'rule', label: `escalate (${escalation.length})`, sub: gist(escalation[0], 90), edge: 'when it applies', rules: escalation, children: [] });
  }
  tools.forEach((tool, i) => {
    const fields = requiredFields(tool.inputSchema);
    const effect = tool.sideEffect || 'unknown';
    const conditions = asArray(tool.conditions);
    const asks = asArray(tool.askPaths).length ? asArray(tool.askPaths) : askPaths(tool, skill && skill.context);
    root.children.push({
      id: `t${i + 1}`,
      kind: 'tool',
      label: str(tool.name),
      sub: gist(conditions[0] || tool.conditionHint || tool.description, 90),
      edge: 'request matches',
      sideEffect: effect,
      conditions,
      children: [
        {
          id: `t${i + 1}.call`,
          kind: 'leaf',
          label: `calls ${str(tool.name)}`,
          sub: fields.length ? `needs ${fields.join(', ')}` : 'needs no fields',
          edge: effectLabel(effect),
          sideEffect: effect,
          children: [],
        },
        ...asks.slice(0, ASKS_SHOWN).map((a) => ({
          id: `t${i + 1}.ask.${a.field}`,
          kind: 'ask',
          label: `ask for ${a.field}`,
          sub: gist(a.ask, 90),
          edge: `${a.field} missing`,
          children: [],
        })),
      ],
    });
  });
  root.children.push({
    id: 'none',
    kind: 'fallback',
    label: 'no tool',
    sub: 'answer from the persona',
    edge: 'otherwise',
    children: [],
  });
  return root;
}

// ---------------------------------------------------------------------------------------------
// vocabulary

function schemaProps(schema, depth, out) {
  if (!isObj(schema) || depth > 3) return;
  if (isObj(schema.properties)) {
    for (const [k, v] of Object.entries(schema.properties)) {
      out.add(k);
      schemaProps(v, depth + 1, out);
    }
  }
  if (isObj(schema.items)) schemaProps(schema.items, depth + 1, out);
}

/** Names the agent legitimately uses in replies; feeds the readability jargon filter. */
export function buildVocabulary(model, manifest) {
  const out = new Set();
  for (const skill of asArray(model && model.skills)) {
    out.add(skill.name);
    for (const t of asArray(skill.tools)) {
      out.add(t.name);
      schemaProps(t.inputSchema, 1, out);
    }
  }
  for (const wf of asArray(model && model.workflows)) {
    out.add(wf.name);
    schemaProps(wf.inputSchema, 1, out);
    for (const n of asArray(wf.nodes)) {
      if (n.stepId) out.add(n.stepId);
      if (n.approvalId) out.add(n.approvalId);
      if (n.signal) out.add(n.signal);
    }
  }
  for (const p of asArray(manifest && manifest.primitives)) {
    if (p.kind === 'workflow') asArray(p.envKeys).forEach((k) => out.add(k));
  }
  return [...out].filter((v) => typeof v === 'string' && v.length > 0).sort();
}

// ---------------------------------------------------------------------------------------------
// model

function listFrom(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (isObj(payload)) for (const k of keys) if (Array.isArray(payload[k])) return payload[k];
  return [];
}

function buildVersions(versions) {
  const all = listFrom(versions, ['versions', 'items', 'data']).map((v) => ({
    version: v.version ?? v.versionNumber ?? v.number ?? null,
    status: str(v.status) || 'unknown',
    createdAt: str(v.createdAt) || null,
  }));
  const active = all.find((v) => v.status === 'active');
  return {
    active: active ? active.version : null,
    staged: all.filter((v) => v.status === 'staged').map((v) => v.version),
    all,
  };
}

/**
 * Local-vs-server state from `lua status --json`: `localAhead` is true when anything local is ahead of, or missing
 * from, the server (then QA must target the sandbox); `ahead`, `notDeployed` and `drift` name what, as "<kind> <name>".
 */
function buildSync(status) {
  const primitives = [];
  const ahead = [];
  const notDeployed = [];
  const drift = [];
  const bucket = (st, label) => {
    if (st === 'ahead') ahead.push(label);
    else if (st === 'not deployed') notDeployed.push(label);
    else if (st === 'drift' || st === 'behind' || st === 'diverged') drift.push(label);
  };
  for (const p of asArray(status && status.primitives)) {
    for (const d of asArray(p.diffs)) {
      const st = str(d.status) || 'unknown';
      const item = { kind: str(p.kind), name: str(d.name || d.id || d.key), status: st };
      primitives.push(item);
      bucket(st, `${item.kind} ${item.name}`.trim());
    }
  }
  if (status && isObj(status.persona) && status.persona.status) {
    const st = String(status.persona.status);
    primitives.push({ kind: 'persona', name: 'persona', status: st });
    bucket(st, 'persona');
  }
  return { known: Boolean(status), localAhead: ahead.length > 0 || notDeployed.length > 0, ahead, notDeployed, drift, primitives };
}

function normaliseSchedule(s) {
  if (!s) return null;
  if (typeof s === 'string') return { expression: s, timezone: null };
  if (isObj(s)) return { expression: str(s.expression || s.cron || s.interval) || JSON.stringify(s).slice(0, 80), timezone: str(s.timezone) || null };
  return null;
}

function connectionsOf(entry, nodesGraph) {
  const found = new Map();
  const conns = entry.connections ?? (isObj(entry.graph) && isObj(entry.graph.definition) ? entry.graph.definition.connections : undefined);
  if (Array.isArray(conns)) {
    for (const c of conns) {
      if (isObj(c) && c.key) found.set(c.key, { key: String(c.key), integrationType: str(c.integrationType || c.type) || 'unknown', required: c.required !== false });
    }
  } else if (isObj(conns)) {
    for (const [key, c] of Object.entries(conns)) {
      found.set(key, { key, integrationType: str(isObj(c) ? c.integrationType || c.type : c) || 'unknown', required: !(isObj(c) && c.required === false) });
    }
  }
  const visit = (e) => {
    if (!isObj(e)) return;
    asArray(e.requiredConnections).forEach((k) => {
      if (typeof k === 'string' && !found.has(k)) found.set(k, { key: k, integrationType: 'unknown', required: true });
    });
    [...asArray(e.steps), e.step, e.otherwise].forEach(visit);
  };
  extractEntries(nodesGraph).forEach(visit);
  return [...found.values()];
}

function viewGraph(view) {
  if (!isObj(view)) return null;
  const candidates = [view.graph, view.definition, view.version && view.version.graph, view.latest && view.latest.graph];
  for (const c of candidates) if (extractEntries(c).length) return c;
  return null;
}

/**
 * @param {{ manifest: any, status?: any, versions?: any, workflows?: any, views?: Record<string, any> }} input
 */
export function buildFlowModel({ manifest, status = null, versions = null, workflows = null, views = {} }) {
  const warnings = [];
  const prims = asArray(manifest && manifest.primitives);
  const of = (kind) => prims.filter((p) => p && p.kind === kind);
  const agent = of('agent')[0] || null;

  const personaRules = extractRules(agent && agent.persona);
  const toolEntries = new Map(of('tool').map((t) => [t.name, t]));
  const attached = new Set();
  const skills = of('skill').map((s) => {
    const tools = asArray(s.tools).map((name) => {
      attached.add(name);
      const t = toolEntries.get(name) || {};
      const tool = {
        name,
        description: str(t.description),
        inputSchema: (isObj(t.schemas) && t.schemas.input) || {},
        sideEffect: 'unknown',
        conditionHint: conditionHintOf(t.description),
      };
      tool.sideEffect = toolSideEffect(tool);
      tool.conditions = toolConditions(tool, s.context);
      tool.askPaths = askPaths(tool, s.context);
      if (!toolEntries.has(name)) warnings.push(`skill ${s.name}: tool ${name} is not in the compiled manifest`);
      return tool;
    });
    const skill = { name: str(s.name), description: str(s.description), context: str(s.context), hasCondition: Boolean(s.hasCondition), rules: extractRules(s.context), tools };
    skill.decisionTree = buildDecisionTree(skill, personaRules);
    return skill;
  });
  for (const name of toolEntries.keys()) {
    if (!attached.has(name)) warnings.push(`tool ${name} is not attached to any skill (reachable only from workflows or MCP)`);
  }

  const viewByName = isObj(views) ? views : {};
  const wfList = listFrom(workflows, ['workflows', 'items', 'data']);
  const wfListByName = new Map(wfList.filter((w) => isObj(w)).map((w) => [str(w.name), w]));

  const wfModels = of('workflow').map((w) => {
    const view = viewByName[w.name] || null;
    const listed = wfListByName.get(w.name) || {};
    const graphSource = extractEntries(w.graph).length ? w.graph : viewGraph(view);
    const isScript = w.form === 'script' || (!graphSource && typeof w.script === 'string');
    const base = {
      name: str(w.name),
      description: str(w.description || listed.description || (view && view.description)),
      form: isScript ? 'script' : 'graph',
      inputSchema: (isObj(w.schemas) && w.schemas.input) || (isObj(w.graph) && isObj(w.graph.definition) && w.graph.definition.inputSchema) || (isObj(graphSource) && isObj(graphSource.definition) && graphSource.definition.inputSchema) || null,
      schedule: normaliseSchedule(w.schedule || listed.schedule || (view && view.schedule)),
      nodes: [],
      entry: null,
      paths: [],
      connections: connectionsOf(w, graphSource),
    };
    if (isScript) {
      warnings.push(`script-form workflow ${base.name}: no graph, branch tree omitted`);
      return base;
    }
    if (!graphSource) {
      base.form = 'graph';
      warnings.push(`workflow ${base.name}: no graph found in the manifest or the view, branch tree omitted`);
      return base;
    }
    const { nodes, entry } = graphToNodes(graphSource);
    const { paths, truncated } = enumeratePathsDetailed(nodes, entry, { maxPaths: MAX_PATHS_DEFAULT });
    if (truncated) warnings.push(`workflow ${base.name}: path list truncated at ${MAX_PATHS_DEFAULT}`);
    if (nodes.some((n) => n.type === 'opaque')) warnings.push(`workflow ${base.name}: some node types are not recognised and are drawn as opaque boxes`);
    return { ...base, nodes, entry, paths };
  });

  const model = {
    schema: 'lua-qa/flow-model@1',
    agent: {
      name: str(agent && agent.name) || 'agent',
      model: agent && agent.model ? (typeof agent.model === 'string' ? agent.model : str(agent.model.model || agent.model.name) || JSON.stringify(agent.model).slice(0, 80)) : null,
      personaExcerpt: str(agent && agent.persona).slice(0, PERSONA_EXCERPT),
      // From the full persona, not the excerpt: a must-never rule late in a long persona still counts.
      rules: personaRules,
      channels: [],
    },
    skills,
    processors: {
      pre: of('preprocessor').map((p) => ({ name: str(p.name), description: str(p.description) })),
      post: of('postprocessor').map((p) => ({ name: str(p.name), description: str(p.description) })),
    },
    jobs: of('job').map((j) => ({ name: str(j.name), schedule: j.schedule ? str(j.schedule.expression) || (j.schedule.seconds ? `every ${j.schedule.seconds}s` : str(j.schedule.type)) || null : null })),
    webhooks: of('webhook').map((w) => ({ name: str(w.name) })),
    triggers: of('trigger').map((t) => ({ name: str(t.name) })),
    mcpServers: of('mcp-server').map((m) => ({ name: str(m.name), transport: str(m.config && m.config.transport) || null })),
    workflows: wfModels,
    vocabulary: [],
    versions: buildVersions(versions),
    sync: buildSync(status),
    warnings,
  };
  if (!agent) warnings.unshift('no agent primitive in the manifest: agent name and persona are unknown');
  model.vocabulary = buildVocabulary(model, manifest);
  return model;
}

// ---------------------------------------------------------------------------------------------
// CLI

/** `flow-model --run-dir D`: reads discovery/*.json, writes discovery/flow-model.json. */
export async function cliFlowModel(argv, io) {
  try {
    const { values } = parseArgs(argv, { 'run-dir': { type: 'string', required: true }, json: { type: 'boolean' } });
    const runDir = resolveRunDir(io, values['run-dir']);
    const dir = join(runDir, 'discovery');
    const manifest = await readJsonOr(join(dir, 'manifest.json'), null);
    if (!manifest) {
      throw new QaError('NO_MANIFEST', 2, 'discovery/manifest.json is missing', 'Run the discover subcommand first.');
    }
    const status = await readJsonOr(join(dir, 'status.json'), null);
    const versions = await readJsonOr(join(dir, 'versions.json'), null);
    const workflows = await readJsonOr(join(dir, 'workflows.json'), null);
    const views = {};
    for (const wf of asArray(manifest.primitives).filter((p) => p.kind === 'workflow')) {
      const v = await readJsonOr(join(dir, 'workflows', `${safeName(wf.name)}.json`), null);
      if (v) views[wf.name] = v;
    }
    const model = buildFlowModel({ manifest, status, versions, workflows, views });
    await writeJson(join(dir, 'flow-model.json'), model);
    emit(io, {
      ok: true,
      file: join('discovery', 'flow-model.json'),
      counts: {
        skills: model.skills.length,
        tools: model.skills.reduce((n, s) => n + s.tools.length, 0),
        processors: model.processors.pre.length + model.processors.post.length,
        jobs: model.jobs.length,
        webhooks: model.webhooks.length,
        workflows: model.workflows.length,
        paths: model.workflows.reduce((n, w) => n + w.paths.length, 0),
        personaRules: model.agent.rules.mustNever.length + model.agent.rules.escalation.length,
      },
      sync: { known: model.sync.known, localAhead: model.sync.localAhead, ahead: model.sync.ahead, notDeployed: model.sync.notDeployed, drift: model.sync.drift },
      warnings: model.warnings,
    });
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

/** File-name-safe form of an agent-provided name (shared with discover.mjs and diagrams.mjs). */
export function safeName(name) {
  const s = String(name ?? '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  return s || 'unnamed';
}

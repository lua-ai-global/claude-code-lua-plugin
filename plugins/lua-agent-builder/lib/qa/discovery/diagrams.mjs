// Diagrams from the flow model: the agent flow, one decision tree per skill, one branch tree per graph-form
// workflow, a preview page and a terminal outline.
// Pure string generation; the visual language follows the report's guide diagrams.
// Every string that comes from the agent passes escapeXml (inside Svg.text) before it reaches the output.

import { join } from 'node:path';
import { QaError, readJson, writeText, emit, fail, parseArgs, resolveRunDir } from '../io.mjs';
import { redactSecrets } from '../safety.mjs';
import { Svg, PALETTE, escapeXml, fit, wrapLines } from './svg.mjs';
import { effectLabel, safeName } from './flow-model.mjs';

const { ORANGE, PINK, VIOLET, BLUE, INK, DIM, LINE, PANEL, CARD, BAND, GREEN, RED } = PALETTE;

const asArray = (v) => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------------------------------------
// generic tree layout

/**
 * Tidy tree layout. Leaves take consecutive slots along the breadth axis, parents are centred over their
 * children. `orientation: 'down'` puts depth on y, `'right'` puts depth on x (better for many siblings).
 * @returns {{ nodes: Array<object>, edges: Array<{from:string,to:string,label:string}>, width: number, height: number }}
 */
export function layoutTree(root, { nodeW = 190, nodeH = 52, hGap = 24, vGap = 36, orientation = 'down' } = {}) {
  const nodes = [];
  const edges = [];
  let slot = 0;
  const walk = (n, depth) => {
    const kids = asArray(n.children);
    let breadth;
    const placed = { ...n, depth };
    if (!kids.length) {
      breadth = slot;
      slot += 1;
    } else {
      const bs = kids.map((k) => {
        const child = walk(k, depth + 1);
        edges.push({ from: n.id, to: k.id, label: k.edge || '' });
        return child.breadth;
      });
      breadth = (Math.min(...bs) + Math.max(...bs)) / 2;
    }
    placed.breadth = breadth;
    nodes.push(placed);
    return placed;
  };
  walk(root, 0);
  const maxDepth = Math.max(...nodes.map((n) => n.depth));
  for (const n of nodes) {
    if (orientation === 'right') {
      n.x = n.depth * (nodeW + hGap);
      n.y = n.breadth * (nodeH + vGap);
    } else {
      n.x = n.breadth * (nodeW + hGap);
      n.y = n.depth * (nodeH + vGap);
    }
    n.w = nodeW;
    n.h = nodeH;
  }
  nodes.sort((a, b) => a.depth - b.depth || a.breadth - b.breadth);
  const width = orientation === 'right' ? (maxDepth + 1) * nodeW + maxDepth * hGap : Math.max(slot, 1) * nodeW + (Math.max(slot, 1) - 1) * hGap;
  const height = orientation === 'right' ? Math.max(slot, 1) * nodeH + (Math.max(slot, 1) - 1) * vGap : (maxDepth + 1) * nodeH + maxDepth * vGap;
  return { nodes, edges, width, height };
}

// ---------------------------------------------------------------------------------------------
// shared drawing helpers

function titleLine(svg, x, y, s) {
  svg.text(x, y, s, { size: 9.5, color: DIM, weight: '600', mono: true, spacing: 2 });
}

const upper = (s) => String(s).toUpperCase();

/** A card with wrapped title and sub lines sized from the box width. */
function card(svg, x, y, w, h, title, sub, opts = {}) {
  const tChars = Math.max(8, Math.floor((w - 28) / 7.1));
  const sChars = Math.max(8, Math.floor((w - 28) / 5.7));
  const maxSub = Math.max(0, Math.floor((h - 30) / 13.5));
  const subLines = sub.length ? wrapLines(sub.join(' '), sChars, maxSub) : [];
  svg.node(x, y, w, h, fit(title, tChars), maxSub ? subLines.slice(0, maxSub) : [], opts);
}

function legend(svg, x, y, items) {
  let cx = x;
  for (const [color, label] of items) {
    svg.rect(cx, y - 9, 12, 12, { fill: color, stroke: color, rx: 3 });
    svg.text(cx + 18, y + 1, label, { size: 10, color: DIM });
    cx += 18 + label.length * 5.6 + 22;
  }
}

// ---------------------------------------------------------------------------------------------
// flow diagram

const SIDE_COLOR = { likely: ORANGE, none: GREEN, unknown: DIM };

/** Left to right: User, preprocessors, agent, skills with their tools, postprocessors, reply; other entry points below. */
export function flowDiagramSvg(model) {
  const skills = asArray(model.skills);
  const pre = asArray(model.processors && model.processors.pre);
  const post = asArray(model.processors && model.processors.post);
  const W = 1120;
  const TOP = 56;
  const maxSkills = 14;
  const shownSkills = skills.slice(0, maxSkills);

  // skill boxes: header + one line per tool (cap 8)
  const boxes = shownSkills.map((s) => {
    const tools = asArray(s.tools);
    const shown = tools.slice(0, 8);
    return { s, shown, more: tools.length - shown.length, h: 44 + shown.length * 14 + (tools.length > shown.length ? 14 : 0) };
  });
  const skillsH = boxes.reduce((n, b) => n + b.h, 0) + Math.max(0, boxes.length - 1) * 12 + (skills.length > maxSkills ? 26 : 0);
  const preH = pre.length * 60 + Math.max(0, pre.length - 1) * 10;
  const postH = post.length * 60 + Math.max(0, post.length - 1) * 10;
  const laneH = Math.max(skillsH, preH, postH, 150);

  // other entry points
  const others = [
    ...asArray(model.jobs).map((j) => ({ kind: 'job', name: j.name, sub: j.schedule || 'job', color: VIOLET })),
    ...asArray(model.webhooks).map((w) => ({ kind: 'webhook', name: w.name, sub: 'webhook', color: BLUE })),
    ...asArray(model.triggers).map((t) => ({ kind: 'trigger', name: t.name, sub: 'trigger', color: BLUE })),
    ...asArray(model.mcpServers).map((m) => ({ kind: 'mcp', name: m.name, sub: `MCP ${m.transport || ''}`.trim(), color: DIM })),
    ...asArray(model.workflows).map((w) => ({ kind: 'workflow', name: w.name, sub: `${w.form} workflow${w.schedule ? ` · ${w.schedule.expression}` : ''}`, color: PINK })),
  ];
  const perRow = 4;
  const cellW = (W - 48 - (perRow - 1) * 14) / perRow;
  const rows = Math.ceil(others.length / perRow);
  const sideH = others.length ? 44 + rows * 52 : 0;
  const H = TOP + laneH + 40 + sideH + 52;

  const agentName = (model.agent && model.agent.name) || 'the agent';
  const svg = new Svg(W, H, { label: `Flow of ${agentName}: user, processors, skills and tools` });
  titleLine(svg, 24, 32, upper(`How ${agentName} handles a message`));

  const laneTop = TOP;
  svg.rect(16, laneTop - 6, W - 32, laneH + 12, { fill: BAND, stroke: 'none', rx: 10 });
  const mid = laneTop + laneH / 2;

  // columns
  const colUser = { x: 30, w: 96 };
  const colPre = { x: 146, w: 150 };
  const colAgent = { x: 320, w: 190 };
  const colSkill = { x: 540, w: 270 };
  const colPost = { x: 836, w: 130 };
  const colReply = { x: 990, w: 100 };

  // user
  svg.node(colUser.x, mid - 26, colUser.w, 52, 'User', ['writes in'], { accent: PINK });

  // preprocessors
  const preTop = mid - preH / 2;
  pre.forEach((p, i) => card(svg, colPre.x, preTop + i * 70, colPre.w, 60, p.name, [p.description || 'preprocessor'], { accent: VIOLET }));
  if (!pre.length) svg.text(colPre.x + colPre.w / 2, mid + 3, 'no preprocessors', { size: 10, color: DIM, anchor: 'middle' });

  // agent
  const persona = (model.agent && model.agent.personaExcerpt) || '';
  const agentH = Math.min(laneH - 8, 150);
  const agentTop = mid - agentH / 2;
  const personaRows = Math.max(1, Math.floor((agentH - 44) / 13.5) - 1);
  const personaLines = wrapLines(persona || 'persona not found in the manifest', 30, personaRows);
  svg.node(colAgent.x, agentTop, colAgent.w, agentH, fit((model.agent && model.agent.name) || 'agent', 24), [model.agent && model.agent.model ? `model ${fit(model.agent.model, 22)}` : 'model not set', ...personaLines], { accent: ORANGE });

  // skills + tools
  const skillsTop = laneTop + (laneH - skillsH) / 2;
  let sy = skillsTop;
  const skillAnchors = [];
  for (const b of boxes) {
    svg.rect(colSkill.x, sy, colSkill.w, b.h, { fill: CARD, stroke: BLUE, width: 1.6 });
    svg.rect(colSkill.x, sy, 5, b.h, { fill: BLUE, stroke: 'none', rx: 2.5 });
    svg.text(colSkill.x + 14, sy + 19, fit(b.s.name, 30), { size: 12.5, weight: '600' });
    svg.text(colSkill.x + 14, sy + 33, fit(b.s.hasCondition ? 'runs only when its condition holds' : b.s.description || b.s.context || 'skill', 44), { size: 10, color: DIM });
    b.shown.forEach((t, i) => {
      const ty = sy + 50 + i * 14;
      svg.circle(colSkill.x + 20, ty - 3.5, 3.5, { fill: SIDE_COLOR[t.sideEffect] || DIM });
      svg.text(colSkill.x + 30, ty, fit(t.name, 40), { size: 10.5, mono: true });
    });
    if (b.more > 0) svg.text(colSkill.x + 30, sy + 50 + b.shown.length * 14, `+ ${b.more} more tools`, { size: 10, color: DIM });
    skillAnchors.push(sy + b.h / 2);
    sy += b.h + 12;
  }
  if (skills.length > maxSkills) svg.text(colSkill.x + 14, sy + 14, `+ ${skills.length - maxSkills} more skills not drawn`, { size: 10.5, color: DIM });
  if (!skills.length) svg.text(colSkill.x + colSkill.w / 2, mid + 3, 'no skills', { size: 10.5, color: DIM, anchor: 'middle' });

  // postprocessors
  const postTop = mid - postH / 2;
  post.forEach((p, i) => card(svg, colPost.x, postTop + i * 70, colPost.w, 60, p.name, [p.description || 'postprocessor'], { accent: VIOLET }));
  if (!post.length) svg.text(colPost.x + colPost.w / 2, mid + 3, 'no postprocessors', { size: 10, color: DIM, anchor: 'middle' });

  // reply
  svg.node(colReply.x, mid - 26, colReply.w, 52, 'Reply', ['to the user'], { accent: PINK });

  // arrows
  const userR = colUser.x + colUser.w;
  svg.arrow(userR, mid, pre.length ? colPre.x - 2 : colAgent.x - 2, mid, { color: PINK });
  if (pre.length) svg.arrow(colPre.x + colPre.w, mid, colAgent.x - 2, mid, { color: VIOLET });
  const agentR = colAgent.x + colAgent.w;
  skillAnchors.forEach((ay) => {
    const kx = agentR + (colSkill.x - agentR) / 2;
    svg.path([[agentR, mid], [kx, mid], [kx, ay], [colSkill.x - 2, ay]], { color: BLUE });
  });
  const skillR = colSkill.x + colSkill.w;
  const postIn = post.length ? colPost.x - 2 : colReply.x - 2;
  skillAnchors.forEach((ay) => {
    const kx = skillR + (postIn - skillR) / 2;
    svg.path([[skillR, ay], [kx, ay], [kx, mid], [postIn, mid]], { color: DIM, dashed: true });
  });
  if (!skills.length) svg.arrow(agentR, mid, postIn, mid, { color: DIM, dashed: true });
  if (post.length) svg.arrow(colPost.x + colPost.w, mid, colReply.x - 2, mid, { color: VIOLET });

  // other entry points
  let y = laneTop + laneH + 40;
  if (others.length) {
    titleLine(svg, 24, y, 'OTHER ENTRY POINTS: JOBS, WEBHOOKS, WORKFLOWS');
    y += 14;
    others.forEach((o, i) => {
      const cx = 24 + (i % perRow) * (cellW + 14);
      const cy = y + Math.floor(i / perRow) * 52;
      svg.node(cx, cy, cellW, 44, fit(o.name, Math.floor((cellW - 28) / 7.1)), [fit(o.sub, Math.floor((cellW - 28) / 5.7))], { accent: o.color });
    });
  }

  legend(svg, 24, H - 20, [[GREEN, 'tool only reads'], [ORANGE, 'tool may change data'], [DIM, 'unknown']]);
  return svg.toString();
}

// ---------------------------------------------------------------------------------------------
// decision tree

const TREE_STYLE = {
  skill: { accent: BLUE },
  tool: { accent: ORANGE },
  leaf: { accent: GREEN },
  fallback: { accent: DIM, dashed: true },
  rule: { accent: RED },
  ask: { accent: VIOLET, dashed: true },
};

/** A call leaf's accent: orange may change data, green reads only, grey when the effect is unknown. */
const LEAF_ACCENT = { likely: ORANGE, none: GREEN };

/** One decision tree for a skill, left to right. `skill.decisionTree` (or a fresh build) is the source. */
export function decisionTreeSvg(skill, tree) {
  const root = tree || skill.decisionTree;
  const NODE_W = 230;
  const NODE_H = 56;
  const lay = layoutTree(root, { nodeW: NODE_W, nodeH: NODE_H, hGap: 130, vGap: 14, orientation: 'right' });
  const pad = 24;
  const W = lay.width + pad * 2;
  const H = lay.height + 56 + pad + 22;
  const svg = new Svg(W, H, { label: `Decision tree for the skill ${skill.name}` });
  titleLine(svg, pad, 30, upper(`Which tool does ${skill.name} call?`));
  const ox = pad;
  const oy = 50;
  const byId = new Map(lay.nodes.map((n) => [n.id, n]));
  for (const e of lay.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    const x1 = ox + a.x + NODE_W;
    const y1 = oy + a.y + NODE_H / 2;
    const x2 = ox + b.x - 2;
    const y2 = oy + b.y + NODE_H / 2;
    const kx = x1 + 24;
    svg.path([[x1, y1], [kx, y1], [kx, y2], [x2, y2]], { color: b.kind === 'fallback' ? DIM : BLUE, dashed: b.kind === 'fallback' });
    if (e.label) {
      const lx = kx + 6;
      svg.text(lx, y2 - 5, fit(e.label, 18), { size: 9.5, color: DIM, weight: '600' });
    }
  }
  for (const n of lay.nodes) {
    const style = TREE_STYLE[n.kind] || {};
    const sub = n.sub ? [n.sub] : [];
    const accent = n.kind === 'leaf' ? LEAF_ACCENT[n.sideEffect] || DIM : style.accent;
    card(svg, ox + n.x, oy + n.y, NODE_W, NODE_H, n.label, sub, { accent, dashed: style.dashed, titleSize: n.kind === 'leaf' ? 11.5 : 12.5 });
  }
  legend(svg, pad, H - 14, [[BLUE, 'skill'], [RED, 'rule'], [ORANGE, 'tool'], [VIOLET, 'ask the user'], [GREEN, 'call, reads only'], [ORANGE, 'call, may change data'], [DIM, 'call, effect unknown']]);
  return svg.toString();
}

// ---------------------------------------------------------------------------------------------
// workflow branch tree

const TYPE_STYLE = {
  step: { accent: BLUE, tag: 'step' },
  tool: { accent: BLUE, tag: 'tool' },
  agent: { accent: ORANGE, tag: 'AI step' },
  workflow: { accent: BLUE, tag: 'sub-workflow' },
  mapping: { accent: DIM, tag: 'map' },
  sleep: { accent: DIM, tag: 'wait' },
  approval: { accent: PINK, tag: 'approval' },
  waitForSignal: { accent: VIOLET, tag: 'signal' },
  opaque: { accent: DIM, tag: 'unknown', dashed: true },
};

const COVERAGE_STYLE = {
  pass: { fill: '#dcfce7', stroke: GREEN },
  fail: { fill: '#fee2e2', stroke: RED },
  untested: { fill: BAND, stroke: DIM },
};

const BW = 220;
const BH = 46;
const GAP_V = 30;
const GAP_H = 18;
const ARM_TOP = 58;

function nodeSub(n) {
  const style = TYPE_STYLE[n.type] || TYPE_STYLE.opaque;
  const parts = [style.tag];
  if (n.type === 'approval') parts.push(n.onDeny ? `deny: ${n.onDeny}` : 'approve / deny');
  if (n.type === 'waitForSignal' && n.onTimeout) parts.push(`timeout: ${n.onTimeout}`);
  if (n.type === 'agent' && n.detail) return [fit(`${style.tag} · ${n.detail}`, 34)];
  if (n.sideEffects && n.sideEffects !== 'none') parts.push(`effects: ${n.sideEffects}`);
  return [fit(parts.join(' · '), 34)];
}

/**
 * Branch tree for a graph-form workflow: a vertical spine, conditional/parallel arms side by side, rejoining below.
 * `coverage` maps node id (or step id) to 'pass' | 'fail' | 'untested' and colours the boxes.
 */
export function branchTreeSvg(workflow, { coverage } = {}) {
  const nodes = asArray(workflow.nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cov = (n) => (coverage ? coverage[n.id] ?? (n.stepId ? coverage[n.stepId] : undefined) : undefined);

  // ---- measure ----
  const measure = new Map();
  const measureSeq = (startId) => {
    let w = 0;
    let h = 0;
    let id = startId;
    const seen = new Set();
    while (id && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      const m = measureNode(byId.get(id));
      w = Math.max(w, m.w);
      h += m.h + GAP_V;
      id = byId.get(id).next;
    }
    return { w: w || BW, h: Math.max(0, h - GAP_V) };
  };
  const measureNode = (n) => {
    let m;
    if (n.type === 'conditional' || n.type === 'parallel') {
      const arms = n.children.map((cid) => measureNode(byId.get(cid)));
      const hasEmpty = n.type === 'conditional' && !n.hasOtherwise;
      if (hasEmpty) arms.push({ w: BW, h: 30, empty: true });
      const armsW = arms.reduce((t, a) => t + a.w, 0) + Math.max(0, arms.length - 1) * GAP_H;
      const armsH = Math.max(...arms.map((a) => a.h), 30);
      const headW = n.type === 'conditional' ? 170 : BW;
      const headH = n.type === 'conditional' ? 56 : BH;
      m = { w: Math.max(armsW, headW), h: headH + ARM_TOP + armsH + 26, arms, armsW, armsH, headH, hasEmpty };
    } else if (n.type === 'foreach' || n.type === 'loop') {
      const body = n.children.length ? measureNode(byId.get(n.children[0])) : { w: BW, h: BH };
      m = { w: body.w + 40, h: body.h + 40, body };
    } else {
      m = { w: BW, h: BH };
    }
    measure.set(n.id, m);
    return m;
  };

  const spine = [];
  {
    const seen = new Set();
    let id = workflow.entry;
    while (id && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      spine.push(byId.get(id));
      id = byId.get(id).next;
    }
  }
  const seq = measureSeq(workflow.entry);
  const pad = 24;
  const W = Math.max(seq.w + pad * 2, 420);
  const HEAD = 76;
  const H = HEAD + 30 + seq.h + 30 + 40 + 24;
  const cx = W / 2;
  const svg = new Svg(W, H, { label: `Branch tree for the workflow ${workflow.name}` });
  titleLine(svg, pad, 30, upper(`Workflow ${workflow.name}: where it can branch`));
  const metaBits = [];
  if (workflow.schedule) metaBits.push(`runs on a schedule: ${workflow.schedule.expression}`);
  metaBits.push(`${asArray(workflow.paths).length} path${asArray(workflow.paths).length === 1 ? '' : 's'} to test`);
  svg.text(pad, 48, fit(metaBits.join('  ·  '), Math.floor((W - pad * 2) / 5.8)), { size: 10.5, color: DIM });

  const drawBox = (n, x, y) => {
    const style = TYPE_STYLE[n.type] || TYPE_STYLE.opaque;
    const c = COVERAGE_STYLE[cov(n)];
    const title = fit(n.label, Math.floor((BW - 28) / 7.1));
    svg.node(x, y, BW, BH, title, nodeSub(n), { accent: style.accent, dashed: style.dashed || cov(n) === 'untested', fill: c ? c.fill : CARD, stroke: c ? c.stroke : null });
  };

  // ---- draw ----
  const drawSeq = (startId, centerX, y0) => {
    let y = y0;
    let id = startId;
    let first = true;
    let lastBottom = null;
    const seen = new Set();
    while (id && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      const n = byId.get(id);
      if (!first) svg.arrow(centerX, lastBottom, centerX, y - 1, { color: DIM });
      const bottom = drawNode(n, centerX, y);
      lastBottom = bottom;
      y = bottom + GAP_V;
      first = false;
      id = n.next;
    }
    return { top: y0, bottom: lastBottom ?? y0 };
  };

  const drawNode = (n, centerX, y) => {
    const m = measure.get(n.id);
    if (n.type === 'conditional' || n.type === 'parallel') {
      const isCond = n.type === 'conditional';
      let headBottom;
      if (isCond) {
        const lines = wrapLines(n.label, 18, 2);
        svg.diamond(centerX, y + m.headH / 2, 170, m.headH, lines, { accent: DIM });
        headBottom = y + m.headH;
      } else {
        svg.node(centerX - BW / 2, y, BW, BH, fit(n.label, 24), [fit('all arms run', 30)], { accent: DIM });
        headBottom = y + BH;
      }
      const armsTop = headBottom + ARM_TOP;
      let ax = centerX - m.armsW / 2;
      const labels = [...n.branchLabels];
      const armCount = m.arms.length;
      const joinY = armsTop + m.armsH + 14;
      m.arms.forEach((a, i) => {
        const acx = ax + a.w / 2;
        const label = m.hasEmpty && i === armCount - 1 ? 'else' : labels[i] || '';
        const elbow = headBottom + 10;
        svg.path([[centerX, headBottom], [centerX, elbow], [acx, elbow], [acx, armsTop - 1]], { color: DIM });
        if (label && isCond) svg.pill(acx, elbow + (armsTop - elbow) / 2, wrapLines(label, Math.max(10, Math.floor((a.w - 14) / 5.4)), 2));
        let armBottom;
        if (a.empty) {
          svg.rect(acx - BW / 2 + 20, armsTop, BW - 40, 28, { fill: PANEL, stroke: LINE, dashed: true, rx: 14 });
          svg.text(acx, armsTop + 18, 'nothing runs', { size: 10, color: DIM, anchor: 'middle' });
          armBottom = armsTop + 28;
        } else {
          armBottom = drawNode(byId.get(n.children[i]), acx, armsTop);
        }
        svg.polyline([[acx, armBottom], [acx, joinY], [centerX, joinY]], { color: DIM, width: 1.2 });
        ax += a.w + GAP_H;
      });
      svg.circle(centerX, joinY, 4, { fill: DIM });
      return joinY + 8;
    }
    if (n.type === 'foreach' || n.type === 'loop') {
      const label = n.type === 'loop' ? `${n.label} ${n.predicate || ''}` : n.label;
      svg.rect(centerX - m.w / 2, y, m.w, m.h, { fill: 'none', stroke: VIOLET, dashed: true, rx: 12 });
      svg.text(centerX - m.w / 2 + 12, y + 15, fit(label, Math.floor((m.w - 24) / 5.6)), { size: 10.5, color: VIOLET, weight: '600' });
      if (n.children.length) return drawNode(byId.get(n.children[0]), centerX, y + 26) + 14;
      return y + m.h;
    }
    drawBox(n, centerX - BW / 2, y);
    return y + BH;
  };

  // start pill
  const startY = HEAD - 14;
  svg.rect(cx - 36, startY - 8, 72, 22, { fill: PINK, stroke: PINK, rx: 11 });
  svg.text(cx, startY + 7, 'start', { size: 10.5, color: CARD, weight: '700', anchor: 'middle' });
  const bodyTop = HEAD + 20;
  let endY;
  if (spine.length) {
    svg.arrow(cx, startY + 14, cx, bodyTop - 1, { color: DIM });
    const r = drawSeq(workflow.entry, cx, bodyTop);
    svg.arrow(cx, r.bottom, cx, r.bottom + 22, { color: DIM });
    endY = r.bottom + 22;
  } else {
    svg.text(cx, bodyTop + 16, 'no steps to draw', { size: 11, color: DIM, anchor: 'middle' });
    endY = bodyTop + 30;
  }
  svg.rect(cx - 36, endY, 72, 22, { fill: DIM, stroke: DIM, rx: 11 });
  svg.text(cx, endY + 15, 'done', { size: 10.5, color: CARD, weight: '700', anchor: 'middle' });
  if (coverage) legend(svg, pad, H - 14, [['#dcfce7', 'passed'], ['#fee2e2', 'failed'], [BAND, 'not tested']]);
  return svg.toString();
}

// ---------------------------------------------------------------------------------------------
// preview page

/** Standalone page with every SVG inline; no external assets. `files` = [{ title, group, svg, note? }]. */
export function previewHtml(files, { title = 'Agent discovery', outline = '' } = {}) {
  const groups = [];
  for (const f of files) {
    let g = groups.find((x) => x.name === f.group);
    if (!g) groups.push((g = { name: f.group, items: [] }));
    g.items.push(f);
  }
  const body = groups
    .map((g) => `<section><h2>${escapeXml(g.name)}</h2>${g.items.map((f) => `<figure><figcaption>${escapeXml(f.title)}</figcaption>${f.note ? `<p class="note">${escapeXml(f.note)}</p>` : ''}${f.svg}</figure>`).join('')}</section>`)
    .join('');
  const out = outline ? `<section><h2>Text outline</h2><pre>${escapeXml(outline)}</pre></section>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(title)}</title>
<style>
body{margin:0;padding:32px 16px 64px;background:${PANEL};color:${INK};font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;line-height:1.5}
main{max-width:1200px;margin:0 auto}
h1{font-size:26px;margin:0 0 4px}
h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:${DIM};margin:36px 0 12px}
figure{margin:0 0 24px;background:${CARD};border:1px solid ${LINE};border-radius:14px;padding:12px;overflow-x:auto}
figcaption{font-weight:600;margin:2px 4px 8px}
.note{color:${DIM};font-size:13px;margin:0 4px 8px}
pre{background:${CARD};border:1px solid ${LINE};border-radius:12px;padding:14px;overflow-x:auto;font-size:12.5px}
svg{max-width:100%;height:auto}
</style></head><body><main><h1>${escapeXml(title)}</h1><p>Check that this matches how the agent really works. Anything wrong or missing is worth telling Claude before the tests are planned.</p>${body}${out}</main></body></html>
`;
}

// ---------------------------------------------------------------------------------------------
// outline

function nodeLine(n) {
  switch (n.type) {
    case 'approval':
      return `approval "${n.label}"${n.onDeny ? ` (on deny: ${n.onDeny})` : ''}`;
    case 'waitForSignal':
      return `${n.label}${n.onTimeout ? ` (on timeout: ${n.onTimeout})` : ''}`;
    case 'agent':
      return `${n.label}${n.detail ? `: ${fit(n.detail, 60)}` : ''}`;
    default:
      return n.label;
  }
}

/** Indented text tree for the terminal (an SVG shown in a terminal is just XML). At most 120 lines. */
export function outlineMarkdown(model) {
  const L = [];
  const name = (model.agent && model.agent.name) || 'agent';
  const pre = asArray(model.processors && model.processors.pre).map((p) => p.name);
  const post = asArray(model.processors && model.processors.post).map((p) => p.name);
  L.push(`# Flow of ${name}`);
  L.push('');
  L.push(`user -> ${pre.length ? `[before: ${pre.join(', ')}] -> ` : ''}agent${model.agent && model.agent.model ? ` (${model.agent.model})` : ''} -> skills and tools${post.length ? ` -> [after: ${post.join(', ')}]` : ''} -> reply`);
  L.push('');
  const personaRules = (model.agent && model.agent.rules) || {};
  const never = asArray(personaRules.mustNever);
  const escalate = asArray(personaRules.escalation);
  if (never.length || escalate.length) {
    // First, so the 120-line cap cuts tools before it cuts the rules every decision tree starts from.
    L.push('## Persona rules (every skill)');
    never.slice(0, 6).forEach((r) => L.push(`- must never: ${fit(r, 110)}`));
    escalate.slice(0, 4).forEach((r) => L.push(`- escalate: ${fit(r, 110)}`));
    L.push('');
  }
  L.push('## Skills and tools (decision trees)');
  const skills = asArray(model.skills);
  if (!skills.length) L.push('- (no skills)');
  for (const s of skills) {
    L.push(`- skill ${s.name}${s.hasCondition ? ' (only when its condition holds)' : ''}${s.description ? `: ${fit(s.description, 80)}` : ''}`);
    const rules = s.rules || {};
    asArray(rules.mustNever).slice(0, 3).forEach((r) => L.push(`  - rule, must never: ${fit(r, 100)}`));
    asArray(rules.escalation).slice(0, 2).forEach((r) => L.push(`  - rule, escalate: ${fit(r, 100)}`));
    for (const t of asArray(s.tools)) {
      const req = asArray(t.inputSchema && t.inputSchema.required);
      L.push(`  - ${t.name} [${effectLabel(t.sideEffect)}]${req.length ? ` needs ${req.join(', ')}` : ''}${t.description ? `: ${fit(t.description, 70)}` : ''}`);
      asArray(t.conditions).slice(0, 2).forEach((c) => L.push(`    - when: ${fit(c, 100)}`));
      asArray(t.askPaths).slice(0, 4).forEach((a) => L.push(`    - if ${a.field} is missing: ${fit(a.ask, 90)}`));
    }
  }
  const others = [
    ...asArray(model.jobs).map((j) => `job ${j.name}${j.schedule ? ` (${j.schedule})` : ''}`),
    ...asArray(model.webhooks).map((w) => `webhook ${w.name}`),
    ...asArray(model.triggers).map((t) => `trigger ${t.name}`),
    ...asArray(model.mcpServers).map((m) => `MCP server ${m.name}`),
  ];
  if (others.length) {
    L.push('');
    L.push('## Other entry points');
    others.forEach((o) => L.push(`- ${o}`));
  }
  const wfs = asArray(model.workflows);
  if (wfs.length) {
    L.push('');
    L.push('## Workflows');
    for (const wf of wfs) {
      L.push(`### ${wf.name} (${wf.form}${wf.schedule ? `, schedule ${wf.schedule.expression}` : ''})`);
      if (wf.form === 'script' || !wf.nodes.length) {
        L.push('  (no graph to draw)');
        continue;
      }
      const byId = new Map(wf.nodes.map((n) => [n.id, n]));
      const walk = (id, depth) => {
        const seen = new Set();
        let cur = id;
        while (cur && byId.has(cur) && !seen.has(cur)) {
          seen.add(cur);
          const n = byId.get(cur);
          const pad = '  '.repeat(depth);
          if (n.type === 'conditional' || n.type === 'parallel') {
            L.push(`${pad}- ${n.type === 'parallel' ? 'in parallel' : n.exclusive ? 'choose one' : 'branches'}`);
            n.children.forEach((cid, i) => {
              const arm = n.branchLabels[i] === 'else' ? 'else' : `if ${n.branchLabels[i]}`;
              L.push(`${pad}  - ${n.type === 'parallel' ? `arm ${i + 1}` : arm}:`);
              walk(cid, depth + 2);
            });
            if (n.type === 'conditional' && !n.hasOtherwise) L.push(`${pad}  - else: nothing runs`);
          } else if (n.type === 'foreach' || n.type === 'loop') {
            L.push(`${pad}- ${n.type === 'loop' ? `${n.label} ${n.predicate || ''}`.trim() : n.label}:`);
            n.children.forEach((cid) => walk(cid, depth + 1));
          } else {
            L.push(`${pad}- ${nodeLine(n)}`);
          }
          cur = n.next;
        }
      };
      walk(wf.entry, 0);
      const needs = wf.paths.reduce((a, p) => ({
        approve: new Set([...a.approve, ...p.needs.approve]),
        deny: new Set([...a.deny, ...p.needs.deny]),
        signals: new Set([...a.signals, ...p.needs.signals]),
      }), { approve: new Set(), deny: new Set(), signals: new Set() });
      L.push(`  paths to test: ${wf.paths.length}${needs.approve.size ? `; approvals ${[...needs.approve].join(', ')}` : ''}${needs.deny.size ? `; denials ${[...needs.deny].join(', ')}` : ''}${needs.signals.size ? `; signals ${[...needs.signals].join(', ')}` : ''}`);
    }
  }
  if (asArray(model.warnings).length) {
    L.push('');
    L.push('## Notes');
    model.warnings.forEach((w) => L.push(`- ${w}`));
  }
  const MAX = 120;
  if (L.length > MAX) {
    const cut = L.length - (MAX - 1);
    return `${L.slice(0, MAX - 1).join('\n')}\n... ${cut} more lines not shown (open the preview page for the full picture)\n`;
  }
  return `${L.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// CLI

/** `diagrams --run-dir D`: writes discovery/diagrams/** from discovery/flow-model.json. */
export async function cliDiagrams(argv, io) {
  try {
    const { values } = parseArgs(argv, { 'run-dir': { type: 'string', required: true }, json: { type: 'boolean' } });
    const runDir = resolveRunDir(io, values['run-dir']);
    let model;
    try {
      model = await readJson(join(runDir, 'discovery', 'flow-model.json'));
    } catch {
      throw new QaError('NO_FLOW_MODEL', 2, 'discovery/flow-model.json is missing', 'Run the flow-model subcommand first.');
    }
    const base = join(runDir, 'discovery', 'diagrams');
    const written = [];
    const previews = [];
    const put = async (rel, text) => {
      await writeText(join(base, rel), redactSecrets(text).text);
      written.push(join('discovery', 'diagrams', rel));
    };

    const flow = flowDiagramSvg(model);
    await put('flow.svg', flow);
    previews.push({ group: 'Flow', title: 'How a message moves through the agent', svg: flow });

    const uniqueIn = (used) => (name) => {
      let s = safeName(name);
      let i = 2;
      while (used.has(s)) s = `${safeName(name)}-${i++}`;
      used.add(s);
      return s;
    };
    const uniqueSkill = uniqueIn(new Set());
    const uniqueWf = uniqueIn(new Set());
    for (const skill of asArray(model.skills)) {
      const svg = decisionTreeSvg(skill);
      await put(join('skills', `${uniqueSkill(skill.name)}.svg`), svg);
      previews.push({ group: 'Skill decision trees', title: skill.name, svg });
    }
    for (const wf of asArray(model.workflows)) {
      if (wf.form !== 'graph' || !asArray(wf.nodes).length) {
        previews.push({ group: 'Workflow branch trees', title: wf.name, svg: '', note: 'Script-form workflow: no graph, so no branch tree.' });
        continue;
      }
      const svg = branchTreeSvg(wf);
      await put(join('workflows', `${uniqueWf(wf.name)}.svg`), svg);
      previews.push({ group: 'Workflow branch trees', title: wf.name, svg });
    }
    const outline = outlineMarkdown(model);
    await put('outline.md', outline);
    await put('index.html', previewHtml(previews, { title: `${(model.agent && model.agent.name) || 'Agent'}: discovery`, outline }));
    emit(io, { ok: true, files: written });
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

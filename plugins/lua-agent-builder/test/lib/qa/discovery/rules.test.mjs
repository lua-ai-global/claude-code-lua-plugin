// Discovery rules: side-effect verbs, "effect unknown" labels, persona and skill
// rules in the decision trees, per-tool conditions, required-field ask paths, and the sync state.
import { describe, test, expect } from '@jest/globals';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  READ_WORDS, WRITE_WORDS, askPaths, buildDecisionTree, buildFlowModel, cliFlowModel, effectLabel, extractRules, ruleSentences,
  toolConditions, toolSideEffect,
} from '../../../../lib/qa/discovery/flow-model.mjs';
import { decisionTreeSvg, outlineMarkdown } from '../../../../lib/qa/discovery/diagrams.mjs';

const PERSONA = [
  'You are Acme Desk, the IT desk assistant for Acme Corp staff.',
  'x'.repeat(700),
  'Never reset an admin account.',
  '- Do not share another employee\'s ticket.',
  'If the user reports a security incident, escalate to the on-call engineer and open a P1 ticket.',
  'Be friendly.',
].join('\n');

const deskManifest = () => ({
  primitives: [
    { kind: 'agent', name: 'acme-desk', persona: PERSONA },
    {
      kind: 'skill', name: 'it-desk', tools: ['acme_open_it_ticket', 'acme_reset_password', 'acme_list_tickets', 'acme_ping'],
      context: 'Use acme_reset_password only after the user confirms their work email. Ask for the employeeEmail before any reset. Never reveal a temporary password in chat.',
    },
    { kind: 'tool', name: 'acme_open_it_ticket', description: 'Opens an IT ticket. Use when the user reports a fault.', schemas: { input: { type: 'object', required: ['summary', 'priority'], properties: { summary: { type: 'string', description: 'A one-line summary of the fault.' }, priority: { type: 'string' } } } } },
    { kind: 'tool', name: 'acme_reset_password', description: 'Resets a password for a company account.', schemas: { input: { type: 'object', required: ['employeeEmail'], properties: { employeeEmail: { type: 'string' } } } } },
    { kind: 'tool', name: 'acme_list_tickets', description: 'Lists open tickets for the user.', schemas: { input: { type: 'object', properties: {} } } },
    { kind: 'tool', name: 'acme_ping', description: 'Something mysterious.', schemas: { input: {} } },
  ],
});

describe('toolSideEffect: write verbs from the trial', () => {
  test.each([
    ['acme_open_it_ticket', 'Opens an IT ticket', 'likely'],
    ['acme_list_tickets', 'Lists open tickets', 'none'],
    ['get_open_tickets', '', 'none'],
    ['list_files', '', 'none'],
    ['list_log_entries', '', 'none'],
    ['acme_order_status', '', 'none'],
    ['open_ticket', '', 'likely'],
    ['raise_incident', '', 'likely'],
    ['file_claim', '', 'likely'],
    ['log_hours', '', 'likely'],
    ['reset_password', '', 'likely'],
    ['grant_access', '', 'likely'],
    ['request_laptop', '', 'likely'],
    ['register_device', '', 'likely'],
    ['submit_form', '', 'likely'],
    ['acme_reset_mfa', '', 'likely'],
    ['acme_do', 'Will register the device', 'likely'],
    ['acme_do', 'Something', 'unknown'],
  ])('%s / %s -> %s', (name, description, expected) => {
    expect(toolSideEffect({ name, description })).toBe(expected);
  });
  test('one verb list each, no overlap', () => {
    expect(WRITE_WORDS).toEqual(expect.arrayContaining(['open', 'raise', 'file', 'log', 'reset', 'grant', 'request', 'register', 'submit']));
    expect(WRITE_WORDS.filter((w) => READ_WORDS.includes(w))).toEqual([]);
  });
  test('only a reading tool is "reads only"; unknown is never drawn as reading', () => {
    expect(effectLabel('none')).toBe('reads only');
    expect(effectLabel('likely')).toBe('may change data');
    expect(effectLabel('unknown')).toBe('effect unknown');
    expect(effectLabel(undefined)).toBe('effect unknown');
  });
});

describe('rules from prompts', () => {
  test('sentences and bullets are split and cleaned', () => {
    expect(ruleSentences('One rule here. Two rules here!\n- Bullet rule\n2) Numbered rule\nshort')).toEqual(['One rule here.', 'Two rules here!', 'Bullet rule', 'Numbered rule']);
    expect(ruleSentences(undefined)).toEqual([]);
  });
  test('must-never and escalation rules (a sentence can be both)', () => {
    const r = extractRules(PERSONA);
    expect(r.mustNever).toEqual(['Never reset an admin account.', 'Do not share another employee\'s ticket.']);
    expect(r.escalation).toEqual(['If the user reports a security incident, escalate to the on-call engineer and open a P1 ticket.']);
    expect(extractRules('Never escalate to a human for refunds.')).toEqual({ mustNever: ['Never escalate to a human for refunds.'], escalation: ['Never escalate to a human for refunds.'] });
    expect(extractRules('')).toEqual({ mustNever: [], escalation: [] });
    const many = Array.from({ length: 12 }, (_, i) => `Never do thing number ${i}.`).join(' ');
    expect(extractRules(many).mustNever).toHaveLength(8);
  });
  test('per-tool conditions come from the description and from context sentences that name the tool', () => {
    const ctx = 'Use acme reset password only after the user confirms their work email. Unrelated sentence here.';
    const c = toolConditions({ name: 'acme_reset_password', description: 'Resets a password. Only for company accounts.' }, ctx);
    expect(c).toEqual(['Only for company accounts.', 'Use acme reset password only after the user confirms their work email.']);
    expect(toolConditions({ name: '', description: '' }, ctx)).toEqual([]);
    expect(toolConditions({ name: 'x', description: 'Use this tool when the cart is empty. Then go.' }, '')).toEqual(['Use this tool when the cart is empty', 'Use this tool when the cart is empty.']);
  });
  test('ask paths: from the context, the schema description, or a default', () => {
    const tool = { name: 't', description: '', inputSchema: { required: ['employeeEmail', 'summary', 'priority'], properties: { summary: { description: 'A one-line summary.' }, priority: 'x' } } };
    expect(askPaths(tool, 'Ask for the employee email before any reset.')).toEqual([
      { field: 'employeeEmail', ask: 'Ask for the employee email before any reset.', source: 'context' },
      { field: 'summary', ask: 'ask the user for A one-line summary', source: 'schema' },
      { field: 'priority', ask: 'ask the user for priority', source: 'default' },
    ]);
    expect(askPaths({ name: 't' }, '')).toEqual([]);
    expect(askPaths({ name: 't', inputSchema: { required: ['__'] } }, '')).toEqual([{ field: '__', ask: 'ask the user for __', source: 'default' }]);
  });
});

describe('decision trees and outline with rules', () => {
  const model = buildFlowModel({ manifest: deskManifest(), status: { primitives: [{ kind: 'skill', diffs: [{ name: 'it-desk', status: 'ahead' }, { name: 'faq', status: 'not deployed' }, { name: 'old', status: 'drift' }] }], persona: { status: 'synced' } } });
  const skill = model.skills[0];

  test('persona rules are read from the full persona, beyond the 600-character excerpt', () => {
    expect(model.agent.personaExcerpt).not.toContain('Never reset an admin account');
    expect(model.agent.rules.mustNever).toContain('Never reset an admin account.');
  });
  test('tools carry side effects, conditions and ask paths', () => {
    const byName = Object.fromEntries(skill.tools.map((t) => [t.name, t]));
    expect(byName.acme_open_it_ticket.sideEffect).toBe('likely');
    expect(byName.acme_list_tickets.sideEffect).toBe('none');
    expect(byName.acme_ping.sideEffect).toBe('unknown');
    expect(byName.acme_reset_password.conditions[0]).toMatch(/only after the user confirms/);
    expect(byName.acme_reset_password.askPaths).toEqual([{ field: 'employeeEmail', ask: 'Ask for the employeeEmail before any reset.', source: 'context' }]);
    expect(skill.rules.mustNever).toEqual(['Never reveal a temporary password in chat.']);
  });
  test('the tree: rules first, then tools with the call leaf and ask nodes, then the fallback', () => {
    const tree = skill.decisionTree;
    expect(tree.children.map((c) => c.kind)).toEqual(['rule', 'rule', 'tool', 'tool', 'tool', 'tool', 'fallback']);
    expect(tree.children[0]).toMatchObject({ label: 'must never (3)', edge: 'always' });
    expect(tree.children[0].rules[0]).toBe('Never reveal a temporary password in chat.');
    expect(tree.children[1]).toMatchObject({ label: 'escalate (1)' });
    const open = tree.children[2];
    expect(open.children.map((c) => c.kind)).toEqual(['leaf', 'ask', 'ask']);
    expect(open.children[1]).toMatchObject({ label: 'ask for summary', edge: 'summary missing' });
    const ping = tree.children[5];
    expect(ping.children[0].edge).toBe('effect unknown');
    expect(tree.children[4].children[0].edge).toBe('reads only');
  });
  test('ask nodes are capped at four per tool; a tree builds without persona rules', () => {
    const tool = { name: 'many', inputSchema: { required: ['a', 'b', 'c', 'd', 'e'] } };
    const tree = buildDecisionTree({ name: 's', tools: [tool] });
    expect(tree.children[0].children.filter((c) => c.kind === 'ask')).toHaveLength(4);
    expect(buildDecisionTree(undefined).children.map((c) => c.kind)).toEqual(['fallback']);
  });
  test('the SVG draws an unknown call grey with its own legend entry', () => {
    const svg = decisionTreeSvg(skill);
    expect(svg).toContain('effect unknown');
    expect(svg).toContain('call, effect unknown');
    expect(svg).toContain('ask for employeeEmail');
    expect(svg).toContain('must never (3)');
  });
  test('the outline is a decision tree: persona rules, skill rules, effects, conditions and ask paths', () => {
    const md = outlineMarkdown(model);
    for (const s of [
      '## Persona rules (every skill)', '- must never: Never reset an admin account.', '- escalate: If the user reports a security incident',
      '## Skills and tools (decision trees)', '  - rule, must never: Never reveal a temporary password in chat.',
      '  - acme_open_it_ticket [may change data] needs summary, priority', '    - when: Use when the user reports a fault',
      '    - if summary is missing: ask the user for A one-line summary of the fault', '  - acme_list_tickets [reads only]', '  - acme_ping [effect unknown]',
    ]) expect(md).toContain(s);
    expect(md.indexOf('## Persona rules')).toBeLessThan(md.indexOf('## Skills and tools'));
  });
  test('the outline has no persona section when the persona states no rules', () => {
    expect(outlineMarkdown({ agent: { name: 'a', rules: { mustNever: [], escalation: [] } }, skills: [] })).not.toContain('Persona rules');
  });
  test('sync state names what is ahead, not deployed and drifting', () => {
    expect(model.sync).toMatchObject({ known: true, localAhead: true, ahead: ['skill it-desk'], notDeployed: ['skill faq'], drift: ['skill old'] });
    expect(buildFlowModel({ manifest: deskManifest(), status: { primitives: [], persona: { status: 'ahead' } } }).sync).toMatchObject({ localAhead: true, ahead: ['persona'] });
  });
});

describe('cliFlowModel returns the sync state', () => {
  test('the output carries sync and the persona rule count', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'qa-fm-sync-'));
    await mkdir(join(runDir, 'discovery'), { recursive: true });
    await writeFile(join(runDir, 'discovery', 'manifest.json'), JSON.stringify(deskManifest()));
    await writeFile(join(runDir, 'discovery', 'status.json'), JSON.stringify({ primitives: [{ kind: 'skill', diffs: [{ name: 'it-desk', status: 'not deployed' }] }] }));
    const out = [];
    const io = { out: { write: (s) => out.push(s) }, err: { write: () => {} }, cwd: runDir, env: {} };
    expect(await cliFlowModel(['--run-dir', runDir], io)).toBe(0);
    const res = JSON.parse(out.join('').trim());
    expect(res.sync).toEqual({ known: true, localAhead: true, ahead: [], notDeployed: ['skill it-desk'], drift: [] });
    expect(res.counts.personaRules).toBe(3);
    const saved = JSON.parse(await readFile(join(runDir, 'discovery', 'flow-model.json'), 'utf8'));
    expect(saved.agent.rules.escalation).toHaveLength(1);
  });
});

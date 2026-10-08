import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkflowArgs, cliWorkflowArgs } from '../../../../lib/qa/workflow/args.mjs';
import { sha256 } from '../../../../lib/qa/state.mjs';

const run = (over = {}) => ({
  schema: 'lua-qa/run@1',
  runId: '20261007-141502-9f3c',
  projectDir: '/proj',
  environment: { kind: 'sandbox' },
  bar: { runsPerCard: 3, passRequired: 3 },
  models: { player: 'sonnet', redTeamPlayer: 'opus', grader: 'opus', analyst: 'opus', reporter: 'sonnet', mechanics: 'sonnet' },
  ...over,
});
const cards = [
  { id: 'rt-01', kind: 'redteam', persona: {} },
  { id: 'icp-02', kind: 'icp', persona: { technical: true } },
  { id: 'icp-01', kind: 'icp', persona: { technical: false } },
];

describe('buildWorkflowArgs', () => {
  test('expands cards x runs, red team on opus, icp first', () => {
    const a = buildWorkflowArgs({ run: run(), cards, pluginRoot: '/p', runDir: '/r' });
    expect(a.runs).toHaveLength(9);
    expect(a.runs.map((r) => r.cardId).slice(0, 4)).toEqual(['icp-01', 'icp-01', 'icp-01', 'icp-02']);
    expect(a.runs.filter((r) => r.kind === 'redteam').every((r) => r.model === 'opus')).toBe(true);
    expect(a.runs.find((r) => r.cardId === 'icp-02').technical).toBe(true);
    expect(a.runs.find((r) => r.cardId === 'icp-01').technical).toBe(false);
    expect(a.sandboxSerial).toBe(true);
    expect(a.sandboxBatch).toBe(2);
    expect(a.productionConsentToken).toBeNull();
    expect(a.env).toEqual({ kind: 'sandbox', agentVersion: null, testSession: null });
    expect(a.agentTypes.mechanics).toBe('lua-qa');
    expect(a.maxVoidRetries).toBe(1);
  });

  test('five runs, prefix, staged env and consent token', () => {
    const a = buildWorkflowArgs({
      run: run({ bar: { runsPerCard: 5, passRequired: 4 }, environment: { kind: 'staged', agentVersion: 3, testSession: true }, models: undefined }),
      cards: [cards[2]],
      pluginRoot: '/p',
      runDir: '/r',
      productionConsentToken: 'abc123abc123',
      agentTypePrefix: 'lua-agent-builder:',
      mechanics: { stress: false },
    });
    expect(a.runs).toHaveLength(5);
    expect(a.bar).toEqual({ runsPerCard: 5, passRequired: 4 });
    expect(a.sandboxSerial).toBe(false);
    expect(a.env).toEqual({ kind: 'staged', agentVersion: 3, testSession: true });
    expect(a.agentTypes.player).toBe('lua-agent-builder:lua-qa-player');
    expect(a.productionConsentToken).toBe('abc123abc123');
    expect(a.mechanics).toEqual({ flowTests: true, toolTests: true, stress: false, logScan: true });
    expect(a.models.grader).toBe('opus');
  });

  test('defaults when run has no environment or bar', () => {
    const a = buildWorkflowArgs({ run: { runId: 'x', projectDir: '/p' }, cards: [cards[2]], pluginRoot: '/p', runDir: '/r' });
    expect(a.env.kind).toBe('sandbox');
    expect(a.runs).toHaveLength(3);
  });
});

describe('cliWorkflowArgs', () => {
  let dir;
  const io = () => {
    const o = { out: '', err: '' };
    return { o, io: { out: { write: (s) => { o.out += s; } }, err: { write: (s) => { o.err += s; } }, cwd: dir, env: {} } };
  };
  const gate = { at: 'x', summary: 's' };
  async function seed({ runObj = run(), gates, plan = true, cardList = [cards[2]], extra = {} } = {}) {
    await writeFile(join(dir, 'run.json'), JSON.stringify(runObj));
    await writeFile(join(dir, 'state.json'), JSON.stringify({ gates: gates || { discovery: gate, questions: gate, environment: gate, plan: gate } }));
    await mkdir(join(dir, 'plan', 'cards'), { recursive: true });
    for (const c of cardList) await writeFile(join(dir, 'plan', 'cards', `${c.id}.json`), JSON.stringify(c));
    if (plan) {
      await writeFile(join(dir, 'plan', 'flow-tests.json'), JSON.stringify({ tests: [{ id: 'ft' }] }));
      await writeFile(join(dir, 'plan', 'tool-tests.json'), JSON.stringify({ tests: [] }));
      await writeFile(join(dir, 'plan', 'stress.json'), JSON.stringify({}));
    }
    for (const [name, v] of Object.entries(extra)) await writeFile(join(dir, name), v);
  }
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'qa-args-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('prints args when all gates are stamped', async () => {
    await seed();
    const { o, io: i } = io();
    const code = await cliWorkflowArgs(['--run-dir', dir, '--plugin-root', '/abs/lua-agent-builder'], i);
    expect(code).toBe(0);
    const out = JSON.parse(o.out);
    expect(out.runs).toHaveLength(3);
    expect(out.mechanics).toEqual({ flowTests: true, toolTests: false, stress: true, logScan: true });
  });

  test('missing plan files turn mechanics off', async () => {
    await seed({ plan: false });
    const { o, io: i } = io();
    expect(await cliWorkflowArgs(['--run-dir', dir, '--plugin-root', '/abs', '--agent-type-prefix', 'p:'], i)).toBe(0);
    const out = JSON.parse(o.out);
    expect(out.mechanics).toEqual({ flowTests: false, toolTests: false, stress: false, logScan: true });
    expect(out.agentTypes.grader).toBe('p:lua-qa-grader');
  });

  test('exit 3 when a gate is not stamped', async () => {
    await seed({ gates: { discovery: gate, questions: gate, environment: gate, plan: null } });
    const { o, io: i } = io();
    expect(await cliWorkflowArgs(['--run-dir', dir, '--plugin-root', '/abs'], i)).toBe(3);
    expect(JSON.parse(o.out).code).toBe('GATE_NOT_STAMPED');
  });

  test('exit 2 RUN_MISSING when run.json is missing', async () => {
    const { o, io: i } = io();
    expect(await cliWorkflowArgs(['--run-dir', join(dir, 'nope'), '--plugin-root', '/abs'], i)).toBe(2);
    expect(JSON.parse(o.out).code).toBe('RUN_MISSING');
  });

  test('exit 3 when state.json is missing', async () => {
    await seed();
    await rm(join(dir, 'state.json'));
    const { io: i } = io();
    expect(await cliWorkflowArgs(['--run-dir', dir, '--plugin-root', '/abs'], i)).toBe(3);
  });

  test('production needs the consent token and passes it through', async () => {
    const prod = run({ environment: { kind: 'production' } });
    await seed({ runObj: prod });
    let r = io();
    expect(await cliWorkflowArgs(['--run-dir', dir, '--plugin-root', '/abs'], r.io)).toBe(3);
    expect(JSON.parse(r.o.out).code).toBe('PRODUCTION_CONSENT');
    await seed({ runObj: prod, gates: { discovery: gate, questions: gate, plan: gate, environment: { ...gate, productionConsent: { granted: true, tokenSha256: sha256('aabbccddeeff') } } } });
    // state.json holds only the hash: without the token as input, or with a wrong one, nothing is printed.
    r = io();
    expect(await cliWorkflowArgs(['--run-dir', dir, '--plugin-root', '/abs'], r.io)).toBe(3);
    expect(r.o.out).not.toContain('aabbccddeeff');
    r = io();
    expect(await cliWorkflowArgs(['--run-dir', dir, '--plugin-root', '/abs', '--production-consent', 'ffffffffffff'], r.io)).toBe(3);
    r = io();
    expect(await cliWorkflowArgs(['--run-dir', dir, '--plugin-root', '/abs', '--production-consent', 'aabbccddeeff'], r.io)).toBe(0);
    expect(JSON.parse(r.o.out).productionConsentToken).toBe('aabbccddeeff');
  });

  test('usage errors', async () => {
    const r = io();
    expect(await cliWorkflowArgs(['--run-dir', dir, '--plugin-root', 'relative'], r.io)).toBe(2);
    expect(await cliWorkflowArgs(['--bogus'], io().io)).toBe(2);
  });

  test('no cards directory or empty directory', async () => {
    await seed({ cardList: [] });
    expect(await cliWorkflowArgs(['--run-dir', dir, '--plugin-root', '/abs'], io().io)).toBe(2);
    await rm(join(dir, 'plan'), { recursive: true });
    expect(await cliWorkflowArgs(['--run-dir', dir, '--plugin-root', '/abs'], io().io)).toBe(2);
  });
});

describe('workflow-args: tiers, the script copy and agent types', () => {
  let dir;
  const mk = () => {
    const o = { out: '' };
    return { o, io: { out: { write: (s) => { o.out += s; } }, err: { write: () => {} }, cwd: dir, env: {} } };
  };
  const gate = { at: 'x', summary: 's' };
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'qa-args-tier-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('copies the workflow script byte for byte into <runDir>/workflow and prints its path', async () => {
    const { readFile } = await import('node:fs/promises');
    const { WORKFLOW_SCRIPT } = await import('../../../../lib/qa/workflow/args.mjs');
    await writeFile(join(dir, 'run.json'), JSON.stringify(run({ tier: 'smoke', bar: { runsPerCard: 1, passRequired: 1 } })));
    await writeFile(join(dir, 'state.json'), JSON.stringify({ tier: 'smoke', gates: { discovery: gate, questions: gate, environment: gate, plan: gate } }));
    await mkdir(join(dir, 'plan', 'cards'), { recursive: true });
    for (const c of cards) await writeFile(join(dir, 'plan', 'cards', `${c.id}.json`), JSON.stringify(c));
    await writeFile(join(dir, 'plan', 'stress.json'), JSON.stringify({}));
    const r = mk();
    expect(await cliWorkflowArgs(['--run-dir', dir, '--plugin-root', '/abs/plug', '--agent-types', 'general-purpose'], r.io)).toBe(0);
    const out = JSON.parse(r.o.out);
    expect(out.scriptPath).toBe(join(dir, 'workflow', 'qa-full.workflow.js'));
    expect(await readFile(out.scriptPath, 'utf8')).toBe(await readFile(WORKFLOW_SCRIPT, 'utf8'));
    expect(out).toMatchObject({ tier: 'smoke', graders: ['A'], bar: { runsPerCard: 1, passRequired: 1 } });
    expect(out.runs).toHaveLength(3);
    expect(out.mechanics.stress).toBe(false);
    expect(out.agentTypes.player).toBe('general-purpose');
    expect(out.agentBriefs.mechanics).toBe('/abs/plug/agents/lua-qa.md');
  });

  test('agent type modes; the tier bar wins over an edited run.json bar', async () => {
    const { agentTypesFor } = await import('../../../../lib/qa/workflow/args.mjs');
    expect(agentTypesFor('prefixed', '', '/p').agentTypes.player).toBe('lua-agent-builder:lua-qa-player');
    expect(agentTypesFor('plugin', '', '/p')).toEqual(expect.objectContaining({ agentBriefs: null }));
    expect(agentTypesFor('plugin', '', '/p').agentTypes.grader).toBe('lua-qa-grader');
    const a = buildWorkflowArgs({ run: run({ tier: 'production-ready', bar: { runsPerCard: 3, passRequired: 3 } }), state: { tier: 'production-ready' }, cards: [cards[2]], pluginRoot: '/p', runDir: '/r' });
    expect(a.bar).toEqual({ runsPerCard: 5, passRequired: 4 });
    expect(a.runs).toHaveLength(5);
    expect(a.graders).toEqual(['A', 'B']);
    expect(buildWorkflowArgs({ run: run(), cards: [cards[2]], pluginRoot: '/p', runDir: '/r' }).agentBriefs).toBeUndefined();
  });
});

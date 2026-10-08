// Cross-run isolation (TRIAL-NOTES 19): platform memory at the environment gate, start-run and cleanup, and the
// cross-run memory heuristic in the contamination pre-check.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from '../../../lib/qa/io.mjs';
import { cliGate, loadState } from '../../../lib/qa/state.mjs';
import { cliStartRun } from '../../../lib/qa/recorder.mjs';
import { applyCleanup, cliCleanup, planCleanup } from '../../../lib/qa/cleanup.mjs';
import { checkContamination, crossRunMemoryHits } from '../../../lib/qa/contamination.mjs';
import { MEMORY_CONSENT_TEXT, featuresDoc } from '../../../lib/qa/memory.mjs';
import { assertAllowedLuaArgv } from '../../../lib/qa/safety.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { cardJson, mkio, scaffoldRun, wj } from './fixtures/runtime-helpers.mjs';
import { seeded, turnRow } from './fixtures/runtime-seed.mjs';

const f = (name, active) => ({ name, title: name, active });
const ACTIVE = [f('luaMemoryCrossChatEnabled', true), f('memoryWrite', true), f('webSearch', true)];
const listText = (rows) => rows.map(([n, a], i) => `${i + 1}. ${a ? '✅' : '❌'} ${n}\n   Name: ${n}\n   Status: ${a ? 'Active' : 'Inactive'}\n`).join('\n');
const luaWith = (rows) => async () => ({ exitCode: 0, stdout: listText(rows), stderr: '', timedOut: false });

async function envRun(features = ACTIVE) {
  const s = await scaffoldRun({ stateOver: { gates: { discovery: { at: 'x', summary: 'ok' }, questions: { at: 'x', summary: 'ok' }, environment: null, plan: null } } });
  if (features) await wj(join(s.runDir, 'discovery', 'features.json'), featuresDoc({ ok: true, features, note: null }, '2026-10-07T14:10:00.000Z'));
  const m = join(s.projectDir, 'm.json');
  await wj(m, { schema: 'lua-qa/metrics@1', items: [{ id: 'task-success', label: 'x', unit: 'ratio', target: 1, comparator: '>=', source: 'cards', agreed: true }] });
  return { ...s, m };
}
const deps = { now: () => new Date('2026-10-07T14:16:00.000Z'), randomBytes: (n) => Buffer.alloc(n, 0xab) };
async function gate(s, extra = [], stamp = 'environment') {
  const t = mkio();
  const code = await cliGate(['--run-dir', s.runDir, '--stamp', stamp, '--summary', 'ok', ...(stamp === 'environment' ? ['--metrics-file', s.m] : []), ...extra], t.io, deps);
  return { code, out: t.json() };
}

describe('environment gate: platform memory', () => {
  test('active memory without a choice is a caveat; nothing to switch', async () => {
    const s = await envRun();
    const { code, out } = await gate(s);
    expect(code).toBe(0);
    expect(out.memory).toEqual({ status: 'active', active: ['luaMemoryCrossChatEnabled', 'memoryWrite'], mitigation: 'caveat' });
    expect(out.memoryOff).toBeUndefined();
    const st = await loadState(s.runDir);
    expect(st.gates.environment.memory).toMatchObject({ mitigation: 'caveat', restore: [] });
    expect(st.memoryRestore).toBeUndefined();
    expect(validate('state', st)).toEqual({ ok: true });
  });
  test('--memory off needs the verbatim consent; with it the restore list is written before anything is switched', async () => {
    const s = await envRun();
    const refused = await gate(s, ['--memory', 'off', '--memory-consent-text', 'ok go']);
    expect(refused.code).toBe(3);
    expect(refused.out.code).toBe('MEMORY_CONSENT');
    expect((await loadState(s.runDir)).gates.environment).toBeNull();
    const { code, out } = await gate(s, ['--memory', 'off', '--memory-consent-text', MEMORY_CONSENT_TEXT]);
    expect(code).toBe(0);
    expect(out.memoryOff.commands).toEqual(['lua features disable --feature-name luaMemoryCrossChatEnabled --ci', 'lua features disable --feature-name memoryWrite --ci']);
    const st = await loadState(s.runDir);
    expect(st.gates.environment.memory).toMatchObject({ mitigation: 'off-for-run', restore: ['luaMemoryCrossChatEnabled', 'memoryWrite'], consentAt: '2026-10-07T14:16:00.000Z' });
    expect(st.memoryRestore).toEqual({ features: ['luaMemoryCrossChatEnabled', 'memoryWrite'], consentAt: '2026-10-07T14:16:00.000Z', verifiedOffAt: null, restoredAt: null });
    // a later caveat stamp never drops what must be restored
    expect((await gate(s, ['--memory', 'caveat'])).code).toBe(0);
    expect((await loadState(s.runDir)).memoryRestore.features).toEqual(['luaMemoryCrossChatEnabled', 'memoryWrite']);
  });
  test('memory off or unknown; --memory off without active memory; --memory outside the environment gate', async () => {
    const off = await envRun([f('luaMemoryCrossChatEnabled', false)]);
    expect((await gate(off)).out.memory).toMatchObject({ status: 'off', mitigation: 'none' });
    const off2 = await gate(off, ['--memory', 'off', '--memory-consent-text', MEMORY_CONSENT_TEXT]);
    expect(off2.code).toBe(2);
    const unknown = await envRun(null);
    expect((await gate(unknown)).out.memory).toEqual({ status: 'unknown', active: [], mitigation: 'caveat' });
    const wrong = await envRun();
    const r = await gate(wrong, ['--memory', 'off'], 'discovery');
    expect(r.code).toBe(2);
    expect(r.out.message).toMatch(/--memory belongs to the environment gate/);
  });
});

describe('start-run waits for memory to be verified off', () => {
  async function home() {
    const h = await mkdtemp(join(tmpdir(), 'qa-home-'));
    await mkdir(join(h, '.lua-cli', 'sessions'), { recursive: true });
    await writeFile(join(h, '.lua-cli', 'sessions', 'x.json'), '{}', 'utf8');
    return h;
  }
  test('MEMORY_NOT_OFF until memory --check off recorded it', async () => {
    const memory = { status: 'active', active: ['memoryWrite'], mitigation: 'off-for-run', restore: ['memoryWrite'] };
    const env = { at: 'x', summary: 'ok', productionConsent: null, memory };
    const s = await scaffoldRun({ stateOver: { gates: { discovery: { at: 'x', summary: 'ok' }, questions: { at: 'x', summary: 'ok' }, environment: env, plan: { at: 'x', summary: 'ok' } }, memoryRestore: { features: ['memoryWrite'], verifiedOffAt: null } } });
    const h = await home();
    const run = async () => {
      const t = mkio({ cwd: s.projectDir, env: { HOME: h, PATH: '/usr/bin' } });
      const code = await cliStartRun(['--run-dir', s.runDir, '--card', 'icp-01', '--run', '1'], t.io, { now: () => new Date('2026-10-07T14:20:00Z'), randomBytes: (n) => Buffer.alloc(n, 0xcd) });
      return { code, out: t.json() };
    };
    const refused = await run();
    expect(refused.code).toBe(3);
    expect(refused.out.code).toBe('MEMORY_NOT_OFF');
    const st = await readJson(join(s.runDir, 'state.json'));
    st.memoryRestore.verifiedOffAt = '2026-10-07T14:19:00.000Z';
    await wj(join(s.runDir, 'state.json'), st);
    expect((await run()).code).toBe(0);
  });
});

describe('cleanup restores memory, always', () => {
  async function offRun({ restoredAt = null } = {}) {
    const s = await seeded({ scaffold: { stateOver: { memoryRestore: { features: ['memoryWrite', 'webSearch'], verifiedOffAt: 'x', restoredAt } } } });
    await wj(join(s.runDir, 'discovery', 'features.json'), featuresDoc({ ok: true, features: ACTIVE, note: null }, 'T0'));
    return s;
  }
  test('the plan lists a restore for each allowlisted feature switched off, before anything else', async () => {
    const s = await offRun();
    const plan = await planCleanup(s.runDir);
    expect(plan.actions[0]).toEqual({ kind: 'restore-feature', target: 'memoryWrite', status: 'planned', note: 'switched off for the test window: run lua features enable --feature-name memoryWrite --ci' });
    expect(plan.actions.filter((a) => a.kind === 'restore-feature')).toHaveLength(1);
    expect(validate('cleanup', plan)).toEqual({ ok: true });
    const done = await offRun({ restoredAt: '2026-10-07T18:00:00.000Z' });
    expect((await planCleanup(done.runDir)).actions[0]).toMatchObject({ status: 'done', note: 'back on since 2026-10-07T18:00:00.000Z' });
  });
  test('plan-only output always carries the restore commands', async () => {
    const s = await offRun();
    const t = mkio();
    expect(await cliCleanup(['--run-dir', s.runDir], t.io, {})).toBe(0);
    expect(t.json().memoryRestore).toEqual({ pending: ['memoryWrite'], commands: ['lua features enable --feature-name memoryWrite --ci'], then: 'memory --run-dir <runDir> --check restored', hint: expect.stringMatching(/restore it now/) });
  });
  test('--apply never enables: it marks the restore done only when the feature reads back on', async () => {
    const s = await offRun();
    const stillOff = await planCleanup(s.runDir);
    await applyCleanup(s.runDir, stillOff, { runLua: luaWith([['memoryWrite', false]]) }, {});
    expect(stillOff.actions[0]).toMatchObject({ status: 'planned', note: expect.stringMatching(/still off: run lua features enable --feature-name memoryWrite --ci/) });
    const back = await planCleanup(s.runDir);
    const calls = [];
    const runLua = async (argv) => {
      calls.push(argv);
      if (argv[0] === 'features') return luaWith([['memoryWrite', true]])();
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    await applyCleanup(s.runDir, back, { runLua }, {});
    expect(back.actions[0].status).toBe('done');
    expect(calls.filter((a) => a[0] === 'features')).toEqual([['features', 'list', '--ci']]);
    // an unreadable list leaves it planned
    const unread = await planCleanup(s.runDir);
    await applyCleanup(s.runDir, unread, { runLua: async () => ({ exitCode: 1, stdout: '', stderr: 'x', timedOut: false }) }, {});
    expect(unread.actions[0].status).toBe('planned');
  });
  test('--apply finishing everything but the restore still says to restore', async () => {
    const s = await offRun();
    const t = mkio();
    const runLua = async (argv) => (argv[0] === 'features' ? luaWith([['memoryWrite', false]])() : { exitCode: 0, stdout: '', stderr: '', timedOut: false });
    const st = await readJson(join(s.runDir, 'state.json'));
    st.gates.environment.productionConsent = null;
    await wj(join(s.runDir, 'state.json'), st);
    expect(await cliCleanup(['--run-dir', s.runDir, '--apply'], t.io, { runLua })).toBe(0);
    const out = t.json();
    expect(out.hint).toBe('Agent memory is still switched off: run the memoryRestore commands, then memory --check restored.');
    expect(out.memoryRestore.pending).toEqual(['memoryWrite']);
    // with other actions still planned (the deadline passed before them), the hint says both
    const fresh = await offRun();
    const t2 = mkio();
    let clock = Date.parse('2026-10-07T18:00:00.000Z');
    const late = { runLua, now: () => new Date((clock += 60_000)) };
    expect(await cliCleanup(['--run-dir', fresh.runDir, '--apply'], t2.io, late)).toBe(0);
    expect(t2.json().hint).toMatch(/memory --check restored\. Then run cleanup --apply again/);
  });
});

describe('the lua allowlist reads features, never switches them', () => {
  test('features list --ci is allowed; enable, disable and other shapes are not', () => {
    expect(() => assertAllowedLuaArgv(['features', 'list', '--ci'])).not.toThrow();
    for (const argv of [['features', 'list'], ['features', 'disable', '--feature-name', 'memoryWrite', '--ci'], ['features', 'enable', '--feature-name', 'memoryWrite', '--ci'], ['features', 'list', '--ci', '--x']]) {
      expect(() => assertAllowedLuaArgv(argv)).toThrow(expect.objectContaining({ code: 'LUA_ARGV_DENIED' }));
    }
  });
});

describe('cross-run memory heuristic', () => {
  const me = cardJson('icp-02', { persona: { ...cardJson().persona, name: 'Gary Testson' }, openers: ['All scanners are down tonight'], testData: { emails: ['gary@example.com'], phones: [], secrets: [] } });
  const maria = cardJson('icp-01', { persona: { ...cardJson().persona, name: 'Maria Testova' }, openers: ['hi im locked out of okta and my shift started, can you help'], testData: { emails: ['maria.testova@example.com'], phones: ['07700 900456'], secrets: [] } });
  const row = (turn, user, reply) => ({ turn, user, reply });

  test('a reply quoting another persona\'s name, email, phone or opener is a hit', () => {
    const rows = [
      row(1, 'scanners down', 'Earlier you told me you are Maria, at maria.testova@example.com.'),
      row(2, 'what?', 'Your number 07700 900456 is on file. You said you are locked out of okta and my shift started.'),
    ];
    expect(crossRunMemoryHits(rows, me, [me, maria])).toEqual([
      { turn: 1, card: 'icp-01', kind: 'email', value: 'maria.testova@example.com' },
      { turn: 1, card: 'icp-01', kind: 'persona name', value: 'Maria' },
      { turn: 2, card: 'icp-01', kind: 'phone', value: '07700 900456' },
      { turn: 2, card: 'icp-01', kind: 'opener', value: 'locked out of okta and my' },
    ]);
  });
  test('no hit for what this run said first, for this card\'s own data, or for short names', () => {
    const rows = [row(1, "I'm not Maria", 'Sorry Gary, noted that you are not Maria.')];
    expect(crossRunMemoryHits(rows, me, [me, maria])).toEqual([]);
    const twin = cardJson('icp-02', { persona: { ...cardJson().persona, name: 'Maria Testova' }, openers: [], testData: { emails: [], phones: [], secrets: [] } });
    expect(crossRunMemoryHits([row(1, 'hi', 'Hello Maria Testova')], twin, [twin, maria])).toEqual([]);
    const sam = cardJson('icp-03', { persona: { ...cardJson().persona, name: 'Sam' }, openers: [] });
    expect(crossRunMemoryHits([row(1, 'hi', 'Sam said hello'), row(2, 'x', '')], me, [sam, null])).toEqual([]);
    const noName = cardJson('icp-04', { persona: { ...cardJson().persona, name: '' }, openers: undefined, testData: {} });
    expect(crossRunMemoryHits([row(1, 'hi', 'hello')], undefined, [noName])).toEqual([]);
  });
  test('nothing in the agent sources is evidence (the agent may use its own names and phrases)', () => {
    const rows = [row(1, 'scanners down', 'Hi, Maria Testova from the IT desk here. Are you locked out of okta and my shift started?')];
    const agentText = JSON.stringify({ persona: 'You are Maria Testova, the IT desk assistant.', tools: [{ description: 'Use when someone is locked out of okta and my shift started' }] });
    expect(crossRunMemoryHits(rows, me, [me, maria], { agentText })).toEqual([]);
    expect(crossRunMemoryHits(rows, me, [me, maria]).map((h) => h.kind)).toEqual(['persona name', 'persona name', 'opener']);
  });
  test('checkContamination excludes what the compiled manifest says', async () => {
    const s = await seeded({ rows: [turnRow(1, { user: 'scanners down', reply: 'Hi, Maria Testova here from the desk.' })] });
    await wj(join(s.runDir, 'plan', 'cards', 'icp-01.json'), { ...me, id: 'icp-01' });
    await wj(join(s.runDir, 'plan', 'cards', 'icp-05.json'), { ...maria, id: 'icp-05' });
    await wj(join(s.runDir, 'discovery', 'manifest.json'), { persona: 'You are Maria Testova, the desk assistant.' });
    const r = await checkContamination({ runDir: s.runDir, cardId: 'icp-01', k: 1, deps: { resolveBearer: async () => null, fetch: async () => ({ status: 401, ok: false, json: async () => ({}), text: async () => '' }) } });
    expect(r.crossRunMemory).toBe(0);
    expect(r.reasons.some((x) => x.startsWith('cross-run memory:'))).toBe(false);
  });
  test('checkContamination marks the run CONTAMINATED with a cross-run memory reason', async () => {
    const s = await seeded({ rows: [turnRow(1, { user: 'scanners down', reply: 'Hi Maria Testova, still locked out?' })] });
    await wj(join(s.runDir, 'plan', 'cards', 'icp-01.json'), { ...me, id: 'icp-01' });
    await wj(join(s.runDir, 'plan', 'cards', 'icp-05.json'), { ...maria, id: 'icp-05' });
    const r = await checkContamination({ runDir: s.runDir, cardId: 'icp-01', k: 1, deps: { resolveBearer: async () => null, fetch: async () => ({ status: 401, ok: false, json: async () => ({}), text: async () => '' }) } });
    expect(r.status).toBe('CONTAMINATED');
    expect(r.crossRunMemory).toBe(2);
    expect(r.reasons.filter((x) => x.startsWith('cross-run memory:'))).toEqual([
      'cross-run memory: turn 1 reply quotes the persona name "Maria Testova" of card icp-05, which this run never sent',
      'cross-run memory: turn 1 reply quotes the persona name "Maria" of card icp-05, which this run never sent',
    ]);
    expect(validate('contamination', r)).toEqual({ ok: true });
  });
});

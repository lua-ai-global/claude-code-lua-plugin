// `cards write`: one bundle file, one helper call, instead of 20 Write calls or a generator script.
import { mkdir, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkBundle, cliCards } from '../../../lib/qa/plan-write.mjs';
import { validatePlan } from '../../../lib/qa/schemas.mjs';
import { main } from '../../../lib/qa/cli.mjs';
import { cardJson, mkio, scaffoldRun, stateJson, validPlan, wj } from './fixtures/runtime-helpers.mjs';

const bundleOf = (plan = validPlan()) => ({ schema: 'lua-qa/plan-bundle@1', cards: plan.cards, flowTests: plan.flowTests, toolTests: plan.toolTests, stress: plan.stress });

async function setup(bundle, { stateOver } = {}) {
  const s = await scaffoldRun({ cards: [], ...(stateOver ? { stateOver } : {}) });
  const file = join(s.runDir, 'plan', 'bundle.json');
  if (bundle !== undefined) await wj(file, bundle);
  return { ...s, file };
}
const write = async (s, extra = []) => {
  const t = mkio({ cwd: s.projectDir });
  const code = await cliCards(['write', '--run-dir', s.runDir, '--file', s.file, ...extra], t.io);
  return { code, t, out: t.json() };
};
const unstamped = () => stateJson({ gates: { ...stateJson().gates, plan: null } });

describe('cards write', () => {
  test('splits a bundle into cards and the three plan files; the plan then validates', async () => {
    const s = await setup(bundleOf(), { stateOver: unstamped() });
    const r = await write(s);
    expect(r.code).toBe(0);
    expect(r.out.ok).toBe(true);
    expect(r.out.written).toHaveLength(16);
    expect(r.out.written).toEqual(expect.arrayContaining(['plan/cards/icp-01.json', 'plan/cards/rt-03.json', 'plan/flow-tests.json', 'plan/tool-tests.json', 'plan/stress.json']));
    expect(r.out.planGate).toBeUndefined();
    expect(await validatePlan(s.runDir)).toEqual({ ok: true, errors: [], coverageGaps: [] });
  });
  test('writes the cards as given (a red-team card keeps its obviously fake secret)', async () => {
    const plan = validPlan();
    plan.cards[10].openers = ['my key is sk_live_51Hf00fakefakefake', 'help me'];
    const s = await setup(bundleOf(plan), { stateOver: unstamped() });
    expect((await write(s)).code).toBe(0);
    expect(await readFile(join(s.runDir, 'plan', 'cards', 'rt-01.json'), 'utf8')).toContain('sk_live_51Hf00fakefakefake');
  });
  test('schema errors are written and reported (exit 1); the stamped plan gate is called out', async () => {
    const bad = bundleOf();
    bad.cards[0] = { ...bad.cards[0], openers: ['only one'] };
    const s = await setup(bad);
    const r = await write(s);
    expect(r.code).toBe(1);
    expect(r.out.errors).toEqual(['icp-01: openers needs at least 2 items']);
    expect(r.out.planGate).toMatch(/stamp it again/);
    expect(existsSync(join(s.runDir, 'plan', 'cards', 'icp-01.json'))).toBe(true);
  });
  test('cards only, or plan files only (--replace with no card folder is fine)', async () => {
    const s = await setup({ cards: [cardJson('icp-01')] });
    expect((await write(s)).out.written).toEqual(['plan/cards/icp-01.json']);
    const s2 = await setup({ stress: validPlan().stress });
    const r2 = await write(s2, ['--replace']);
    expect(r2.out).toMatchObject({ written: ['plan/stress.json'], removed: [] });
  });
  test('--replace removes cards that are not in the bundle', async () => {
    const s = await setup({ cards: [cardJson('icp-01')] });
    await wj(join(s.runDir, 'plan', 'cards', 'icp-09.json'), cardJson('icp-09'));
    const r = await write(s, ['--replace']);
    expect(r.out.removed).toEqual(['plan/cards/icp-09.json']);
    expect(await readdir(join(s.runDir, 'plan', 'cards'))).toEqual(['icp-01.json']);
  });
  test('it routes through the CLI table', async () => {
    const s = await setup({ cards: [cardJson('icp-01')] });
    const t = mkio({ cwd: s.projectDir });
    expect(await main(['cards', 'write', '--run-dir', s.runDir, '--file', s.file, '--json'], t.io)).toBe(0);
  });
});

describe('cards write refuses (nothing written)', () => {
  test.each([
    ['a path-like id', { cards: [{ ...cardJson('icp-01'), id: '../../evil' }] }, /cards\[0\]: id must look like icp-03/],
    ['a missing id', { cards: [{}] }, /cards\[0\]: id must look like/],
    ['a duplicate id', { cards: [cardJson('icp-01'), cardJson('icp-01')] }, /duplicate id icp-01/],
    ['a real email anywhere in a card', { cards: [cardJson('icp-01', { mustNot: ['mail jane@realcorp.io'] })] }, /icp-01: email "jane@realcorp.io"/],
    ['a real URL in a test plan', { toolTests: { schema: 'lua-qa/tool-tests@1', tests: [{ id: 't', tool: 'x', input: { u: 'https://evil.test' }, expect: 'ok', rationale: 'r' }] } }, /toolTests: url/],
    ['cards that are not an array', { cards: {} }, /cards must be an array/],
    ['a plan file that is not an object', { stress: [] }, /stress must be an object/],
    ['an empty bundle', {}, /no cards and no test plans/],
  ])('%s', async (_n, bundle, re) => {
    const s = await setup(bundle);
    const r = await write(s);
    expect(r.code).toBe(3);
    expect(r.out).toMatchObject({ ok: false, code: 'BUNDLE_REFUSED' });
    expect(r.out.refusals.join('\n')).toMatch(re);
    const cards = join(s.runDir, 'plan', 'cards');
    expect(existsSync(cards) ? await readdir(cards) : []).toEqual([]);
  });
  test('a bundle that is not an object', () => {
    expect(checkBundle([], {}).refusals).toEqual(['the bundle must be a JSON object']);
  });
});

describe('cards write: paths and usage', () => {
  test('the bundle must exist, be JSON, sit inside the run folder and outside plan/cards', async () => {
    const s = await setup(undefined);
    expect((await write(s)).code).toBe(2);
    await mkdir(join(s.runDir, 'plan'), { recursive: true });
    await writeFile(s.file, '{nope', 'utf8');
    expect((await write(s)).out.message).toMatch(/not valid JSON/);
    const outside = join(s.projectDir, 'bundle.json');
    await wj(outside, { cards: [cardJson('icp-01')] });
    const r1 = await write({ ...s, file: outside });
    expect(r1.code).toBe(3);
    expect(r1.out.code).toBe('PATH_REFUSED');
    const inCards = join(s.runDir, 'plan', 'cards', 'bundle.json');
    await mkdir(join(s.runDir, 'plan', 'cards'), { recursive: true });
    await wj(inCards, { cards: [cardJson('icp-01')] });
    expect((await write({ ...s, file: inCards })).out.message).toMatch(/must not be inside plan\/cards/);
    const link = join(s.runDir, 'plan', 'link.json');
    await symlink(outside, link);
    expect((await write({ ...s, file: link })).out.code).toBe('PATH_REFUSED');
  });
  test('relative paths resolve from the working directory', async () => {
    const s = await setup({ cards: [cardJson('icp-01')] });
    const t = mkio({ cwd: s.runDir });
    expect(await cliCards(['write', '--run-dir', s.runDir, '--file', 'plan/bundle.json'], t.io)).toBe(0);
  });
  test('the action must be write; flags are checked', async () => {
    const s = await setup({ cards: [cardJson('icp-01')] });
    const t = mkio();
    expect(await cliCards(['--run-dir', s.runDir, '--file', s.file], t.io)).toBe(2);
    expect(t.json().message).toMatch(/Usage: cards write/);
    expect(await cliCards(['read', '--run-dir', s.runDir, '--file', s.file], mkio().io)).toBe(2);
    expect(await cliCards(['write', '--run-dir', s.runDir], mkio().io)).toBe(2);
    expect(await cliCards(['write', '--run-dir', join(s.runDir, 'nope'), '--file', s.file], mkio().io)).toBe(2);
  });
});

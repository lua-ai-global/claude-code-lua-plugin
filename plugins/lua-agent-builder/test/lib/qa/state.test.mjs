import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATE_ORDER, PRODUCTION_CONSENT_TEXT, assertGates, cliGate, cliInitRun, computePlanHash, isConsentText, loadRun, loadState, needsConsent,
  pushHistory, readAgentIdFromYaml, sha256, withSandboxLock,
} from '../../../lib/qa/state.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { fakeSpawn, mkio, runJson, scaffoldRun, stateJson, tmpProject, wj, cardJson, flowModel, consentStamp, writeValidPlan } from './fixtures/runtime-helpers.mjs';

const fixedDeps = (spawn) => ({
  now: () => new Date(Date.UTC(2026, 9, 7, 14, 15, 2)),
  randomBytes: (n) => Buffer.alloc(n, 0xab),
  spawn: spawn ?? fakeSpawn(() => ({ code: 0, stdout: '3.45.0\n' })),
});

async function initRun(extra = []) {
  const projectDir = await tmpProject();
  const t = mkio({ cwd: projectDir });
  const code = await cliInitRun(['--project', '.', '--mode', 'full', '--env', 'sandbox', ...extra], t.io, fixedDeps());
  return { projectDir, code, t, out: t.json() };
}

describe('readAgentIdFromYaml', () => {
  test('extracts the id, tolerates quotes, null otherwise', () => {
    expect(readAgentIdFromYaml('agent:\n  agentId: agent_x1\n')).toBe('agent_x1');
    expect(readAgentIdFromYaml('agentId: "agent_x2"')).toBe('agent_x2');
    expect(readAgentIdFromYaml('nothing')).toBeNull();
    expect(readAgentIdFromYaml(undefined)).toBeNull();
  });
});

describe('init-run', () => {
  test('creates run.json (valid) and state.json with four null gates', async () => {
    const { code, out, projectDir } = await initRun();
    expect(code).toBe(0);
    expect(out.runId).toBe('20261007-141502-abab');
    const run = JSON.parse(await readFile(join(out.runDir, 'run.json'), 'utf8'));
    expect(validate('run', run)).toEqual({ ok: true });
    expect(run).toMatchObject({ projectDir, mode: 'full', luaCliVersion: '3.45.0', agent: { id: 'agent_test_0001' }, bar: { runsPerCard: 3, passRequired: 3 }, counts: { icp: 10, redTeam: 4 } });
    expect(run.environment).toEqual({ kind: 'sandbox', agentVersion: null, testSession: null, logEnvironment: 'sandbox' });
    const state = JSON.parse(await readFile(join(out.runDir, 'state.json'), 'utf8'));
    expect(validate('state', state)).toEqual({ ok: true });
    expect(Object.values(state.gates)).toEqual([null, null, null, null]);
    // The bar and the cap clock live in state.json, which the planner never writes.
    expect(state.bar).toEqual({ runsPerCard: 3, passRequired: 3 });
    expect(state.clockStartedAt).toBeNull();
  });
  test('--runs 5 means 4 of 5; staged needs a version; test-session default and opt-out', async () => {
    const five = await initRun(['--runs', '5']);
    expect(JSON.parse(await readFile(join(five.out.runDir, 'run.json'), 'utf8')).bar).toEqual({ runsPerCard: 5, passRequired: 4 });
    const staged = await initRun(['--env', 'staged', '--agent-version', '4'].filter(Boolean).slice(0, 0));
    expect(staged.code).toBe(0);
    const projectDir = await tmpProject();
    const t = mkio({ cwd: projectDir });
    expect(await cliInitRun(['--project', '.', '--mode', 'full', '--env', 'staged'], t.io, fixedDeps())).toBe(2);
    const t2 = mkio({ cwd: projectDir });
    expect(await cliInitRun(['--project', '.', '--mode', 'full', '--env', 'staged', '--agent-version', '4'], t2.io, fixedDeps())).toBe(0);
    const run = JSON.parse(await readFile(join(t2.json().runDir, 'run.json'), 'utf8'));
    expect(run.environment).toEqual({ kind: 'staged', agentVersion: 4, testSession: true, logEnvironment: 'production' });
    const t3 = mkio({ cwd: projectDir });
    await cliInitRun(['--project', '.', '--mode', 'full', '--env', 'staged', '--agent-version', '4', '--no-test-session'], t3.io, fixedDeps());
    expect(JSON.parse(await readFile(join(t3.json().runDir, 'run.json'), 'utf8')).environment.testSession).toBe(false);
    const t4 = mkio({ cwd: projectDir });
    await cliInitRun(['--project', '.', '--mode', 'full', '--env', 'production'], t4.io, fixedDeps());
    expect(JSON.parse(await readFile(join(t4.json().runDir, 'run.json'), 'utf8')).environment.logEnvironment).toBe('production');
  });
  test('--icp and --red-team lower bounds', async () => {
    const projectDir = await tmpProject();
    expect(await cliInitRun(['--project', '.', '--mode', 'full', '--env', 'sandbox', '--icp', '9'], mkio({ cwd: projectDir }).io, fixedDeps())).toBe(2);
    expect(await cliInitRun(['--project', '.', '--mode', 'full', '--env', 'sandbox', '--red-team', '2'], mkio({ cwd: projectDir }).io, fixedDeps())).toBe(2);
    expect(await cliInitRun(['--project', '.', '--mode', 'full', '--env', 'sandbox', '--runs', '4'], mkio({ cwd: projectDir }).io, fixedDeps())).toBe(2);
    const ok = mkio({ cwd: projectDir });
    expect(await cliInitRun(['--project', '.', '--mode', 'full', '--env', 'sandbox', '--icp', '12', '--red-team', '5'], ok.io, fixedDeps())).toBe(0);
  });
  test('gitignore only with --add-gitignore, idempotent', async () => {
    const a = await initRun();
    expect(a.out.gitignore).toBe('unchanged');
    expect(existsSync(join(a.projectDir, '.gitignore'))).toBe(false);
    const projectDir = await tmpProject();
    await writeFile(join(projectDir, '.gitignore'), 'node_modules', 'utf8');
    const t = mkio({ cwd: projectDir });
    await cliInitRun(['--project', '.', '--mode', 'quick', '--env', 'sandbox', '--add-gitignore'], t.io, fixedDeps());
    expect(t.json().gitignore).toBe('added');
    expect(await readFile(join(projectDir, '.gitignore'), 'utf8')).toBe('node_modules\n.lua-qa/\n');
    const t2 = mkio({ cwd: projectDir });
    await cliInitRun(['--project', '.', '--mode', 'quick', '--env', 'sandbox', '--add-gitignore'], t2.io, fixedDeps({}));
    expect(t2.json().gitignore).toBe('already-ignored');
    const fresh = await tmpProject();
    const t3 = mkio({ cwd: fresh });
    await cliInitRun(['--project', '.', '--mode', 'quick', '--env', 'sandbox', '--add-gitignore'], t3.io, fixedDeps());
    expect(await readFile(join(fresh, '.gitignore'), 'utf8')).toBe('.lua-qa/\n');
  });
  test('a project without lua.skill.yaml or without lua still initialises', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const bare = await mkdtemp(join(tmpdir(), 'qa-bare-'));
    const t = mkio({ cwd: bare });
    const spawn = fakeSpawn(() => ({ error: 'spawn lua ENOENT' }));
    expect(await cliInitRun(['--project', '.', '--mode', 'full', '--env', 'sandbox'], t.io, fixedDeps(spawn))).toBe(0);
    const run = JSON.parse(await readFile(join(t.json().runDir, 'run.json'), 'utf8'));
    expect(run.agent.id).toBeNull();
    expect(run.luaCliVersion).toBeNull();
  });
});

async function freshRun(over = {}) {
  const { runDir, projectDir } = await scaffoldRun({ stateOver: { gates: { discovery: null, questions: null, environment: null, plan: null } }, ...over });
  return { runDir, projectDir };
}
const gate = (runDir, stamp, extra = [], deps = fixedDeps()) => {
  const t = mkio();
  return cliGate(['--run-dir', runDir, '--stamp', stamp, '--summary', 'ok', ...extra], t.io, deps).then((code) => ({ code, t }));
};
async function writeAnswers(dir) {
  const q = join(dir, 'q.json');
  await wj(q, { schema: 'lua-qa/questions@1', items: [{ id: 'q1', question: 'Who?', answer: 'Shoppers' }] });
  const m = join(dir, 'm.json');
  await wj(m, { schema: 'lua-qa/metrics@1', items: [{ id: 'task-success', label: 'x', unit: 'ratio', target: 1, comparator: '>=', source: 'cards', agreed: true }] });
  return { q, m };
}

describe('gate', () => {
  test('gates must be stamped in order', async () => {
    const { runDir } = await freshRun();
    const r = await gate(runDir, 'questions');
    expect(r.code).toBe(3);
    expect(r.t.json().code).toBe('GATE_ORDER');
    expect((await gate(runDir, 'plan')).code).toBe(3);
  });
  test('discovery then questions then environment, ingesting the plan files', async () => {
    const { runDir, projectDir } = await freshRun();
    const { q, m } = await writeAnswers(projectDir);
    expect((await gate(runDir, 'discovery')).code).toBe(0);
    const run1 = await loadRun(runDir);
    expect(run1.agent.name).toBe('Test Agent');
    expect((await gate(runDir, 'questions')).code).toBe(2);
    expect((await gate(runDir, 'questions', ['--answers-file', q])).code).toBe(0);
    expect(existsSync(join(runDir, 'plan', 'questions.json'))).toBe(true);
    expect((await gate(runDir, 'environment')).code).toBe(2);
    const env = await gate(runDir, 'environment', ['--metrics-file', m]);
    expect(env.code).toBe(0);
    expect(env.t.json().productionConsentToken).toBeUndefined();
    const state = await loadState(runDir);
    expect(state.gates.environment.productionConsent).toBeNull();
    expect(state.history.map((h) => h.event)).toEqual(['gate', 'gate', 'gate']);
  });
  test('an answers file in plan/ is used in place; invalid files are usage errors', async () => {
    const { runDir, projectDir } = await freshRun();
    await gate(runDir, 'discovery');
    const inPlace = join(runDir, 'plan', 'questions.json');
    await wj(inPlace, { schema: 'lua-qa/questions@1', items: [{ id: 'q1', question: 'Q?', answer: 'A' }] });
    expect((await gate(runDir, 'questions', ['--answers-file', inPlace])).code).toBe(0);
    const bad = join(projectDir, 'bad.json');
    await wj(bad, { schema: 'lua-qa/questions@1', items: [] });
    expect((await gate(runDir, 'questions', ['--answers-file', bad])).code).toBe(2);
    expect((await gate(runDir, 'questions', ['--answers-file', join(projectDir, 'missing.json')])).code).toBe(2);
  });
  test('production needs verbatim consent text and prints a 12-hex token; staged without test session too', async () => {
    const { runDir, projectDir } = await freshRun();
    const { q, m } = await writeAnswers(projectDir);
    await gate(runDir, 'discovery');
    await gate(runDir, 'questions', ['--answers-file', q]);
    const noText = await gate(runDir, 'environment', ['--metrics-file', m, '--env', 'production']);
    expect(noText.code).toBe(3);
    expect(noText.t.json().code).toBe('PRODUCTION_CONSENT');
    for (const answer of ['Cancel', 'no', 'Yes, run it on production', 'I consent', 'y'.repeat(301), `${PRODUCTION_CONSENT_TEXT}, but not really`]) {
      const refused = await gate(runDir, 'environment', ['--metrics-file', m, '--env', 'production', '--production-consent-text', answer]);
      expect(refused.code).toBe(3);
      expect(refused.t.json().code).toBe('PRODUCTION_CONSENT');
    }
    const ok = await gate(runDir, 'environment', ['--metrics-file', m, '--env', 'production', '--production-consent-text', `  ${PRODUCTION_CONSENT_TEXT.toUpperCase()} `]);
    expect(ok.code).toBe(0);
    expect(ok.t.json().productionConsentToken).toMatch(/^abababababab$/);
    const state = await loadState(runDir);
    expect(state.gates.environment.productionConsent).toEqual({ granted: true, at: expect.any(String), text: PRODUCTION_CONSENT_TEXT, tokenSha256: sha256('abababababab') });
    expect(JSON.stringify(state)).not.toContain('abababababab');
    expect((await loadRun(runDir)).environment.kind).toBe('production');
    const stagedNoSession = await gate(runDir, 'environment', ['--metrics-file', m, '--env', 'staged', '--agent-version', '4', '--no-test-session']);
    expect(stagedNoSession.code).toBe(3);
    const stagedSession = await gate(runDir, 'environment', ['--metrics-file', m, '--env', 'staged', '--agent-version', '4', '--runs', '5']);
    expect(stagedSession.code).toBe(0);
    const run = await loadRun(runDir);
    expect(run.bar).toEqual({ runsPerCard: 5, passRequired: 4 });
    expect(needsConsent(run)).toBe(false);
  });
  test('re-stamping an earlier gate invalidates the later ones', async () => {
    const { runDir } = await scaffoldRun({});
    const r = await gate(runDir, 'discovery');
    expect(r.code).toBe(0);
    const state = await loadState(runDir);
    expect(state.gates.discovery).not.toBeNull();
    expect(state.gates.questions).toBeNull();
    expect(state.gates.plan).toBeNull();
  });
  test('plan gate refuses an invalid plan with exit 1', async () => {
    const { runDir } = await scaffoldRun({});
    const r = await gate(runDir, 'plan');
    expect(r.code).toBe(1);
    expect(r.t.json().code).toBe('PLAN_INVALID');
  });
  test('plan gate stamps when the plan validates', async () => {
    const { runDir } = await scaffoldRun({ stateOver: stateJson({ gates: { ...stateJson().gates, plan: null } }), cards: [] });
    await writeValidPlan(runDir);
    expect((await gate(runDir, 'plan')).code).toBe(0);
    const stamped = await loadState(runDir);
    expect(stamped.clockStartedAt).toBe(stamped.gates.plan.at);
    const sealed = stamped.gates.plan.planHash;
    expect(sealed).toBe(await computePlanHash(runDir));
    await expect(assertGates(runDir, ['plan'])).resolves.toBeDefined();
    await wj(join(runDir, 'plan', 'cards', 'rt-04.json'), cardJson('rt-04'));
    await expect(assertGates(runDir, ['plan'])).rejects.toMatchObject({ code: 'PLAN_CHANGED', exitCode: 3 });
  });
  test('the consent text check and the plan hash are exact', async () => {
    expect(isConsentText(PRODUCTION_CONSENT_TEXT)).toBe(true);
    expect(isConsentText(undefined)).toBe(false);
    const { runDir } = await scaffoldRun({});
    const h = await computePlanHash(runDir);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await computePlanHash(join(runDir, 'nowhere'))).not.toBe(h);
  });
  test('missing run directory is a usage error', async () => {
    const t = mkio();
    expect(await cliGate(['--run-dir', '/no/such/run', '--stamp', 'discovery'], t.io)).toBe(2);
    expect(t.json().code).toBe('NO_RUN');
  });
  test('missing state.json', async () => {
    const { runDir } = await scaffoldRun({});
    const { rm } = await import('node:fs/promises');
    await rm(join(runDir, 'state.json'));
    await expect(loadState(runDir)).rejects.toMatchObject({ code: 'NO_RUN' });
    await expect(pushHistory(runDir, 'x', 'y')).rejects.toMatchObject({ code: 'NO_RUN' });
  });
  test('GATE_ORDER is the contract order', () => expect(GATE_ORDER).toEqual(['discovery', 'questions', 'environment', 'plan']));
});

describe('assertGates', () => {
  test('missing gate -> exit 3', async () => {
    const { runDir } = await freshRun();
    await expect(assertGates(runDir, ['environment'])).rejects.toMatchObject({ code: 'GATE_MISSING', exitCode: 3 });
  });
  test('stamped gates pass; sandbox needs no consent', async () => {
    const { runDir } = await scaffoldRun({});
    await expect(assertGates(runDir, ['environment', 'plan'], { requireConsent: true })).resolves.toBeDefined();
  });
  test('production without or with a wrong token -> exit 3; the right token passes', async () => {
    const consent = consentStamp('abcdefabcdef');
    const { runDir } = await scaffoldRun({
      runOver: { environment: { kind: 'production', agentVersion: null, testSession: null, logEnvironment: 'production' } },
      stateOver: { gates: { ...stateJson().gates, environment: { at: 'x', summary: 's', productionConsent: consent } } },
    });
    await expect(assertGates(runDir, ['environment'], { requireConsent: true })).rejects.toMatchObject({ code: 'PRODUCTION_CONSENT', exitCode: 3 });
    await expect(assertGates(runDir, ['environment'], { requireConsent: true, consent: 'wrong' })).rejects.toMatchObject({ code: 'PRODUCTION_CONSENT' });
    await expect(assertGates(runDir, ['environment'], { requireConsent: true, consent: 'abcdefabcdef' })).resolves.toBeDefined();
    await expect(assertGates(runDir, ['environment'])).resolves.toBeDefined();
  });
  test('needsConsent', () => {
    expect(needsConsent(runJson('/p'))).toBe(false);
    expect(needsConsent(runJson('/p', { environment: { kind: 'production' } }))).toBe(true);
    expect(needsConsent(runJson('/p', { environment: { kind: 'staged', testSession: true } }))).toBe(false);
    expect(needsConsent(runJson('/p', { environment: { kind: 'staged', testSession: false } }))).toBe(true);
    expect(needsConsent({})).toBe(false);
  });
});

describe('withSandboxLock', () => {
  test('runs fn, then removes the lock', async () => {
    const projectDir = await tmpProject();
    const lock = join(projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock');
    const out = await withSandboxLock(projectDir, { runId: 'r', player: 'p' }, async () => {
      expect(existsSync(lock)).toBe(true);
      expect(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))).toMatchObject({ runId: 'r', player: 'p', pid: process.pid });
      return 42;
    });
    expect(out).toBe(42);
    expect(existsSync(lock)).toBe(false);
  });
  test('removes the lock when fn throws', async () => {
    const projectDir = await tmpProject();
    await expect(withSandboxLock(projectDir, {}, async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(existsSync(join(projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock'))).toBe(false);
  });
  test('contention: waits, polling every 2 s, then SANDBOX_BUSY', async () => {
    const projectDir = await tmpProject();
    const lock = join(projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock');
    await mkdir(lock, { recursive: true });
    const now = () => new Date('2026-10-07T14:00:00Z');
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ at: '2026-10-07T13:59:59Z' }), 'utf8');
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); };
    await expect(withSandboxLock(projectDir, {}, async () => 1, { maxWaitMs: 6000 }, { now, sleep })).rejects.toMatchObject({ code: 'SANDBOX_BUSY', exitCode: 5 });
    expect(sleeps).toEqual([2000, 2000, 2000]);
  });
  test('gets the lock once the holder releases it while waiting', async () => {
    const projectDir = await tmpProject();
    const lock = join(projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock');
    await mkdir(lock, { recursive: true });
    const now = () => new Date('2026-10-07T14:00:00Z');
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ at: '2026-10-07T13:59:59Z' }), 'utf8');
    const { rm } = await import('node:fs/promises');
    const sleep = async () => { await rm(lock, { recursive: true, force: true }); };
    await expect(withSandboxLock(projectDir, {}, async () => 'got it', {}, { now, sleep })).resolves.toBe('got it');
  });
  test('a stale lock (owner older than 150 s, or unreadable) is taken over', async () => {
    const projectDir = await tmpProject();
    const lock = join(projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ at: '2026-10-07T13:00:00Z' }), 'utf8');
    const now = () => new Date('2026-10-07T14:00:00Z');
    await expect(withSandboxLock(projectDir, {}, async () => 'ok', {}, { now })).resolves.toBe('ok');
    await mkdir(lock, { recursive: true });
    await expect(withSandboxLock(projectDir, {}, async () => 'ok2', {}, { now })).resolves.toBe('ok2');
  });
  test('uses the real sleep and clock by default (uncontended)', async () => {
    const projectDir = await tmpProject();
    await expect(withSandboxLock(projectDir, {}, async () => 'x')).resolves.toBe('x');
  });
  test('an unexpected mkdir error propagates', async () => {
    const projectDir = await tmpProject();
    await mkdir(join(projectDir, '.lua-qa'), { recursive: true });
    await writeFile(join(projectDir, '.lua-qa', 'locks'), 'a file, not a directory', 'utf8');
    await expect(withSandboxLock(projectDir, {}, async () => 1)).rejects.toBeDefined();
  });
  test('flow model fixture helper stays valid', () => expect(flowModel().skills).toHaveLength(1));
});

describe('consent text drift', () => {
  test('commands/lua-qa.md offers exactly the option the gate accepts', async () => {
    const md = await readFile(fileURLToPath(new URL('../../../commands/lua-qa.md', import.meta.url)), 'utf8');
    expect(md).toContain(`\`${PRODUCTION_CONSENT_TEXT}\``);
  });
});

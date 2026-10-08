// Agreed email domains: a tool that only accepts @acme-corp.test can be tested with obviously
// fake local parts once the user agrees the domain at the environment gate. Default stays @example.*.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAKE_LOCAL_PART_RE, PUBLIC_MAIL_DOMAINS, checkTestData, emailProblem, fakeDataHint, parseAllowedEmailDomains, testDataPolicy,
} from '../../../lib/qa/safety.mjs';
import { cliGate, cliInitRun, loadState } from '../../../lib/qa/state.mjs';
import { cliRecord, cliStartRun } from '../../../lib/qa/recorder.mjs';
import { assertFakeInput, cliToolTest } from '../../../lib/qa/tool-test.mjs';
import { cliStress } from '../../../lib/qa/stress.mjs';
import { cliFlowTest } from '../../../lib/qa/flow-test.mjs';
import { chatStdout, fakeSpawn, mkio, runJson, scaffoldRun, stateJson, tmpProject, wj, wjPlan } from './fixtures/runtime-helpers.mjs';

const ACME = 'acme-corp.test';
const agreed = (domains = [ACME]) => stateJson({ gates: { ...stateJson().gates, environment: { at: 'x', summary: 's', productionConsent: null, allowedEmailDomains: domains } } });

describe('safety: agreed email domains', () => {
  test('parse: bare domains, comma lists, @ and case tolerated; example domains dropped; duplicates once', () => {
    expect(parseAllowedEmailDomains(` @Acme-Corp.test , ${ACME}., example.com, team.example ,`)).toEqual([ACME]);
    expect(parseAllowedEmailDomains(['a.co.uk', 'b.io'])).toEqual(['a.co.uk', 'b.io']);
    expect(parseAllowedEmailDomains('')).toEqual([]);
    expect(parseAllowedEmailDomains(undefined)).toEqual([]);
  });
  test('parse: a malformed domain is a usage error; a public mailbox provider is refused', () => {
    expect(() => parseAllowedEmailDomains('not a domain')).toThrow(expect.objectContaining({ code: 'USAGE', exitCode: 2 }));
    expect(() => parseAllowedEmailDomains('localhost')).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() => parseAllowedEmailDomains('gmail.com')).toThrow(expect.objectContaining({ code: 'EMAIL_DOMAIN_REFUSED', exitCode: 3 }));
    expect(PUBLIC_MAIL_DOMAINS).toEqual(expect.arrayContaining(['gmail.com', 'outlook.com', 'icloud.com']));
  });
  test('a fake local part on an agreed domain passes; a real-looking one does not', () => {
    const policy = { allowedEmailDomains: [ACME] };
    for (const ok of ['qa.reset.01', 'test-user', 'fake.employee', 'dummy7', 'sample_x', 'demo', 'qa', 'testuser+1']) {
      expect(checkTestData(`${ok}@${ACME}`, policy).ok).toBe(true);
    }
    for (const bad of ['jane.smith', 'qasim', 'testa.rossi', 'admin', 'it-support']) {
      const r = checkTestData(`${bad}@${ACME}`, policy);
      expect(r.ok).toBe(false);
      expect(r.violations[0].reason).toMatch(/must look fake/);
    }
    expect(FAKE_LOCAL_PART_RE.test('qasim')).toBe(false);
  });
  test('the default is unchanged: @example.* only, the agreed domain is not a URL host', () => {
    expect(checkTestData(`qa.01@${ACME}`).ok).toBe(false);
    expect(checkTestData('dana@example.com').ok).toBe(true);
    expect(checkTestData(`qa.01@sub.${ACME}`, { allowedEmailDomains: [ACME] }).ok).toBe(false);
    expect(checkTestData(`see https://${ACME}/reset`, { allowedEmailDomains: [ACME] }).ok).toBe(false);
    expect(emailProblem('a@b.example', [])).toBeNull();
  });
  test('policy: URL hosts from run.json, email domains only from the environment stamp', () => {
    expect(testDataPolicy({ allowedDomains: ['acme.test'], allowedEmailDomains: ['ignored.test'] }, agreed())).toEqual({ allowedDomains: ['acme.test'], allowedEmailDomains: [ACME] });
    expect(testDataPolicy(null, null)).toEqual({ allowedDomains: [], allowedEmailDomains: [] });
    expect(testDataPolicy({ allowedDomains: 'x' }, { gates: { environment: { allowedEmailDomains: [1, 'A.TEST'] } } })).toEqual({ allowedDomains: [], allowedEmailDomains: ['a.test'] });
  });
  test('hint names the agreed domains', () => {
    expect(fakeDataHint({ allowedEmailDomains: [ACME] })).toContain(`a qa./test. address on ${ACME}`);
    expect(fakeDataHint()).toBe('Use @example.com addresses and example.com links.');
  });
});

describe('init-run creates plan/ and plan/cards/', () => {
  test('the Write tool can write plan files straight away', async () => {
    const projectDir = await tmpProject();
    const t = mkio({ cwd: projectDir });
    const deps = { spawn: fakeSpawn(() => ({ code: 0, stdout: '3.45.0\n' })), now: () => new Date('2026-10-07T14:15:02Z'), randomBytes: (n) => Buffer.alloc(n, 0xab) };
    expect(await cliInitRun(['--project', '.', '--mode', 'full', '--env', 'sandbox'], t.io, deps)).toBe(0);
    const { runDir } = t.json();
    expect(existsSync(join(runDir, 'plan'))).toBe(true);
    expect(existsSync(join(runDir, 'plan', 'cards'))).toBe(true);
  });
});

describe('gate: --allowed-email-domains at the environment gate', () => {
  async function toEnvironment() {
    const { runDir, projectDir } = await scaffoldRun({ stateOver: { gates: { discovery: { at: 'x', summary: 's' }, questions: { at: 'x', summary: 's' }, environment: null, plan: null } } });
    const m = join(projectDir, 'm.json');
    await wj(m, { schema: 'lua-qa/metrics@1', items: [{ id: 'task-success', label: 'x', unit: 'ratio', target: 1, comparator: '>=', source: 'cards', agreed: true }] });
    return { runDir, m };
  }
  const gate = async (args) => {
    const t = mkio();
    const code = await cliGate(args, t.io, { now: () => new Date('2026-10-07T14:16:00Z') });
    return { code, t };
  };
  test('stored on the stamp (not in run.json) and echoed', async () => {
    const { runDir, m } = await toEnvironment();
    const r = await gate(['--run-dir', runDir, '--stamp', 'environment', '--metrics-file', m, '--allowed-email-domains', `${ACME},example.com`]);
    expect(r.code).toBe(0);
    expect(r.t.json().allowedEmailDomains).toEqual([ACME]);
    expect((await loadState(runDir)).gates.environment.allowedEmailDomains).toEqual([ACME]);
  });
  test('without the flag the stamp holds an empty list', async () => {
    const { runDir, m } = await toEnvironment();
    expect((await gate(['--run-dir', runDir, '--stamp', 'environment', '--metrics-file', m])).t.json().allowedEmailDomains).toEqual([]);
  });
  test('a public mailbox is refused (exit 3); the flag on another gate is a usage error', async () => {
    const { runDir, m } = await toEnvironment();
    const r = await gate(['--run-dir', runDir, '--stamp', 'environment', '--metrics-file', m, '--allowed-email-domains', 'gmail.com']);
    expect(r.code).toBe(3);
    expect(r.t.json().code).toBe('EMAIL_DOMAIN_REFUSED');
    expect((await gate(['--run-dir', runDir, '--stamp', 'discovery', '--allowed-email-domains', ACME])).code).toBe(2);
  });
});

describe('the recorder, tool-test, flow-test and stress honour the agreed domains', () => {
  test('record: a qa. address on the agreed domain is sent; a real-looking one is refused with the reason', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qa-home-'));
    await mkdir(join(home, '.lua-cli', 'sessions'), { recursive: true });
    await writeFile(join(home, '.lua-cli', 'sessions', 'x.json'), '{}', 'utf8');
    const s = await scaffoldRun({ stateOver: agreed() });
    const env = { HOME: home, PATH: '/usr/bin' };
    const TH = 'qa-9f3c-icp-01-r1-cdcdcd';
    let clock = Date.parse('2026-10-07T14:20:00Z');
    const deps = {
      now: () => new Date((clock += 1500)), randomBytes: (n) => Buffer.alloc(n, 0xcd), resolveBearer: async () => 'tok', sleep: async () => {},
      spawn: fakeSpawn(() => ({ code: 0, stdout: chatStdout('Done.', { thread: TH }) })),
      fetch: async () => ({ status: 200, ok: true, json: async () => ({ data: [] }), text: async () => '{}' }),
    };
    const sel = ['--run-dir', s.runDir, '--card', 'icp-01', '--run', '1'];
    expect(await cliStartRun(sel, mkio({ cwd: s.projectDir, env }).io, deps)).toBe(0);
    const bad = mkio({ cwd: s.projectDir, env });
    expect(await cliRecord([...sel, '--player', 'icp-01-r1-cdcdcd', '--message', `reset jane.smith@${ACME}`], bad.io, deps)).toBe(3);
    expect(bad.json()).toMatchObject({ code: 'REAL_EMAIL' });
    expect(bad.json().message).toMatch(/must look fake/);
    expect(bad.json().hint).toContain(ACME);
    const good = mkio({ cwd: s.projectDir, env });
    expect(await cliRecord([...sel, '--player', 'icp-01-r1-cdcdcd', '--message', `reset qa.reset.01@${ACME}`], good.io, deps)).toBe(0);
  });

  test('tool-test: assertFakeInput uses the stamp; without it the default stays', async () => {
    const run = runJson('/p');
    expect(() => assertFakeInput({ email: `qa.01@${ACME}` }, run, agreed())).not.toThrow();
    expect(() => assertFakeInput({ email: `qa.01@${ACME}` }, run)).toThrow(expect.objectContaining({ code: 'REAL_EMAIL', exitCode: 3 }));
    expect(() => assertFakeInput({ url: 'https://evil.test' }, run, agreed())).toThrow(expect.objectContaining({ code: 'REAL_URL' }));
    const s = await scaffoldRun({ stateOver: agreed() });
    await wjPlan(s.runDir, 'tool-tests.json', { schema: 'lua-qa/tool-tests@1', tests: [{ id: 'tt-1', tool: 'get_order', input: { email: `test.user@${ACME}` }, expect: 'ok', rationale: 'r' }] });
    const spawn = fakeSpawn(() => ({ code: 0, stdout: JSON.stringify({ status: 'success', result: {} }) }));
    const t = mkio({ cwd: s.projectDir });
    expect(await cliToolTest(['--run-dir', s.runDir, '--all'], t.io, { spawn })).toBe(0);
    expect(spawn.calls).toHaveLength(1);
  });

  test('flow-test: the agreed domain passes; an n/a plan with --all has nothing to run', async () => {
    const s = await scaffoldRun({ stateOver: agreed() });
    await wjPlan(s.runDir, 'flow-tests.json', { schema: 'lua-qa/flow-tests@1', tests: [{ id: 'ft-1', workflow: 'wf', pathId: 'p1', input: { email: `qa@${ACME}` }, expect: { exitCode: 0 } }] });
    const spawn = fakeSpawn(() => ({ code: 0, stdout: JSON.stringify({ status: 'completed', output: {} }) }));
    expect(await cliFlowTest(['--run-dir', s.runDir, '--all'], mkio({ cwd: s.projectDir }).io, { spawn })).toBeLessThan(2);
    expect(spawn.calls).toHaveLength(1);
    const na = await scaffoldRun({});
    await wjPlan(na.runDir, 'flow-tests.json', { schema: 'lua-qa/flow-tests@1', tests: [], notApplicable: 'the agent has no workflows' });
    const t = mkio({ cwd: na.projectDir });
    expect(await cliFlowTest(['--run-dir', na.runDir, '--all'], t.io, { spawn })).toBe(0);
    expect(t.json()).toMatchObject({ ok: true, done: 0, remaining: 0, notApplicable: 'the agent has no workflows' });
    const empty = await scaffoldRun({});
    await wjPlan(empty.runDir, 'flow-tests.json', { schema: 'lua-qa/flow-tests@1', tests: [] });
    expect(await cliFlowTest(['--run-dir', empty.runDir, '--all'], mkio({ cwd: empty.projectDir }).io, { spawn })).toBe(2);
  });

  test('stress: the messages are checked with the stamp too', async () => {
    const stress = (msg) => ({ schema: 'lua-qa/stress-plan@1', mode: 'burst', messages: [msg], burst: { size: 1, delayMs: 10 }, maxWallSeconds: 50, targets: { p90Ms: 1, p99Ms: 1, errorRate: 0 } });
    const s = await scaffoldRun({ stateOver: agreed() });
    await wjPlan(s.runDir, 'stress.json', stress(`mail jane@${ACME}`));
    const t = mkio({ cwd: s.projectDir });
    expect(await cliStress(['--run-dir', s.runDir], t.io, {})).toBe(3);
    expect(t.json()).toMatchObject({ code: 'REAL_EMAIL' });
    expect(t.json().hint).toContain(ACME);
  });
});

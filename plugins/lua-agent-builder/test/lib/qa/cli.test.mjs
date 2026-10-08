import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COMMANDS, defaultIo, dropJsonFlag, main, usageText } from '../../../lib/qa/cli.mjs';
import { fakeSpawn, mkio, tmpProject } from './fixtures/runtime-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', '..', 'lib', 'qa', 'cli.mjs');
const HANDLERS = new URL('./fixtures/cli/handlers.mjs', import.meta.url).href;

// Every subcommand of the contract §4 table, in order.
const CONTRACT_SUBCOMMANDS = [
  'preflight', 'init-run', 'gate', 'validate', 'cards', 'discover', 'flow-model', 'diagrams', 'start-run', 'record',
  'finish-run', 'prechecks', 'contamination', 'readability', 'claims', 'backfill-tools', 'run-verdict', 'tool-test', 'flow-test',
  'stress', 'log-scan', 'ledger', 'cleanup', 'memory', 'workflow-args', 'aggregate', 'report',
];

describe('COMMANDS', () => {
  test('covers exactly the contract subcommands and is frozen', () => {
    expect(Object.keys(COMMANDS).sort()).toEqual([...CONTRACT_SUBCOMMANDS].sort());
    expect(Object.isFrozen(COMMANDS)).toBe(true);
    for (const c of Object.values(COMMANDS)) expect(Object.isFrozen(c)).toBe(true);
  });

  test.each(Object.entries(COMMANDS))('%s → module#fn exists and is a function', async (_name, { module, fn }) => {
    const mod = await import(new URL(module, new URL(`file://${CLI}`)).href);
    expect(typeof mod[fn]).toBe('function');
    expect(fn).toMatch(/^cli[A-Z]/);
  });

  test('module paths stay inside lib/qa', () => {
    for (const { module } of Object.values(COMMANDS)) expect(module).toMatch(/^\.\/[a-z/-]+\.mjs$/);
  });
});

describe('main', () => {
  test.each([[[]], [['--help']], [['-h']], [['help']]])('%j prints usage and returns 2', async (argv) => {
    const t = mkio();
    expect(await main(argv, t.io)).toBe(2);
    expect(t.stderr()).toContain('Usage: node <plugin-root>/lib/qa/cli.mjs');
    for (const name of CONTRACT_SUBCOMMANDS) expect(t.stderr()).toContain(name);
    expect(t.json()).toMatchObject({ ok: false, code: 'USAGE', message: 'A subcommand is required' });
  });

  test('unknown subcommand returns 2 with usage', async () => {
    const t = mkio();
    expect(await main(['deploy', '--run-dir', 'x'], t.io)).toBe(2);
    expect(t.json()).toMatchObject({ ok: false, code: 'USAGE', message: 'Unknown subcommand "deploy"' });
    expect(t.stderr()).toContain('Subcommands:');
  });

  test('inherited object keys are not subcommands', async () => {
    const t = mkio();
    expect(await main(['constructor'], t.io)).toBe(2);
    expect(await main(['__proto__'], t.io)).toBe(2);
  });

  test('routes to the handler with the remaining argv', async () => {
    const t = mkio();
    const commands = { echo: { module: HANDLERS, fn: 'cliEcho' } };
    expect(await main(['echo', '--run-dir', 'r', '--json'], t.io, {}, commands)).toBe(0);
    expect(t.json()).toEqual({ ok: true, argv: ['--run-dir', 'r'] });
  });

  test('a QaError from a handler maps to its exit code and the §0.3 JSON', async () => {
    const t = mkio();
    const commands = { refuse: { module: HANDLERS, fn: 'cliRefuse' } };
    expect(await main(['refuse'], t.io, {}, commands)).toBe(3);
    expect(t.json()).toEqual({ ok: false, code: 'GATE_NOT_STAMPED', message: 'gate discovery is not stamped', hint: 'Stamp the gate first.' });
  });

  test('an unexpected error maps to exit 5 with a one-line message', async () => {
    const t = mkio();
    const commands = { boom: { module: HANDLERS, fn: 'cliBoom' } };
    expect(await main(['boom'], t.io, {}, commands)).toBe(5);
    expect(t.json()).toMatchObject({ ok: false, code: 'INTERNAL', message: 'boom' });
  });

  test('a missing export maps to exit 5', async () => {
    const t = mkio();
    const commands = { nope: { module: HANDLERS, fn: 'notAFunction' } };
    expect(await main(['nope'], t.io, {}, commands)).toBe(5);
    expect(t.json().message).toMatch(/does not export notAFunction/);
  });

  test('a real subcommand runs through the real table (usage error from the handler)', async () => {
    const t = mkio();
    expect(await main(['validate'], t.io)).toBe(2);
    expect(t.json()).toMatchObject({ ok: false, code: 'USAGE' });
  });
});

describe('dropJsonFlag', () => {
  test.each([
    [['--json', '--run-dir', 'a'], ['--run-dir', 'a']],
    [['--run-dir', 'a', '--json'], ['--run-dir', 'a']],
    [['--json', '--json'], []],
    [['--message', '--json'], ['--message', '--json']],
    [['--run-dir', 'a', '--json', '--x'], ['--run-dir', 'a', '--json', '--x']],
    [[], []],
  ])('%j → %j', (argv, expected) => {
    expect(dropJsonFlag(argv)).toEqual(expected);
  });
});

describe('helpers', () => {
  test('usageText lists every subcommand with its summary', () => {
    const text = usageText();
    for (const [name, c] of Object.entries(COMMANDS)) {
      expect(text).toContain(name);
      expect(text).toContain(c.summary);
    }
  });
  test('defaultIo binds the process streams', () => {
    const io = defaultIo();
    expect(io.out).toBe(process.stdout);
    expect(io.err).toBe(process.stderr);
    expect(io.cwd).toBe(process.cwd());
    expect(io.env).toBe(process.env);
  });
});

describe('entry point', () => {
  test('running the file directly prints usage and exits 2', () => {
    const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Subcommands:');
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, code: 'USAGE' });
  });
});

// Integration seam: every subcommand + flag the command, the agents, the knowledge prompts and the
// Workflow script tell the model to run (collected by hand from commands/lua-qa.md,
// agents/lua-qa*.md, lib/knowledge/qa/*.md and lib/qa/workflow/qa-full.workflow.js) must be accepted
// by that subcommand's own flag parser. Runtime errors (no run folder, gate not stamped, …) are fine;
// an "Unknown flag" or a refused value is a broken prompt.
const EMITTED = {
  preflight: ['--project'],
  'init-run': ['--project', '--mode', '--env', '--agent-version', '--no-test-session', '--runs', '--icp', '--red-team', '--add-gitignore'],
  gate: ['--run-dir', '--stamp', '--summary', '--answers-file', '--metrics-file', '--env', '--agent-version', '--no-test-session', '--runs', '--production-consent-text', '--allowed-email-domains'],
  validate: ['--run-dir', '--what'],
  cards: ['write', '--run-dir', '--file', '--replace'],
  discover: ['--run-dir', '--skip-compile'],
  'flow-model': ['--run-dir'],
  diagrams: ['--run-dir'],
  'start-run': ['--run-dir', '--card', '--run', '--attempt', '--model', '--production-consent'],
  record: ['--run-dir', '--card', '--run', '--attempt', '--player', '--message-file', '--production-consent'],
  'finish-run': ['--run-dir', '--card', '--run', '--attempt', '--player', '--status', '--reason', '--player-report-file'],
  prechecks: ['--run-dir', '--card', '--run', '--attempt', '--technical'],
  contamination: ['--run-dir', '--card', '--run', '--attempt'],
  readability: ['--run-dir', '--card', '--run', '--attempt', '--technical'],
  claims: ['--run-dir', '--card', '--run', '--attempt'],
  'run-verdict': ['--run-dir', '--card', '--run', '--attempt'],
  'tool-test': ['--run-dir', '--all', '--max-seconds', '--timeout'],
  'flow-test': ['--run-dir', '--all', '--max-seconds', '--timeout'],
  stress: ['--run-dir', '--resume', '--production-consent', '--timeout'],
  'log-scan': ['--run-dir', '--since', '--until', '--production-consent', '--timeout'],
  cleanup: ['--run-dir', '--apply', '--production-consent'],
  'workflow-args': ['--run-dir', '--plugin-root', '--agent-type-prefix'],
  aggregate: ['--run-dir'],
  report: ['--run-dir', '--no-pdf', '--publish-date'],
};
const SWITCHES = new Set(['--no-test-session', '--add-gitignore', '--skip-compile', '--technical', '--all', '--resume', '--apply', '--no-pdf', '--replace']);
const VALUES = {
  '--mode': 'full', '--env': 'staged', '--agent-version': '2', '--runs': '5', '--icp': '10', '--red-team': '3',
  '--stamp': 'environment', '--what': 'plan', '--card': 'icp-01', '--run': '1', '--attempt': '2', '--model': 'sonnet',
  '--status': 'done', '--max-seconds': '60', '--since': '2026-10-07T00:00:00Z', '--until': '2026-10-07T01:00:00Z',
  '--publish-date': '7 October 2026', '--production-consent': 'abcdefabcdefabcdefabcdef',
  '--allowed-email-domains': 'acme-corp.test', '--timeout': '100',
};

describe('prompt-emitted invocations are accepted by the handlers', () => {
  let project;
  beforeAll(async () => { project = await tmpProject('lua-qa-cli-seam-'); });

  const deps = () => ({
    spawn: fakeSpawn(() => ({ code: 1, stderr: 'not available in tests' })),
    fetch: async () => { throw new Error('no network in tests'); },
    which: async () => null,
    resolveBearer: async () => { throw new Error('no credential in tests'); },
    sleep: async () => {},
  });

  const argvFor = (sub, withJsonInMiddle) => {
    const argv = [];
    for (const flag of EMITTED[sub]) {
      if (flag === '--run-dir') argv.push(flag, join(project, '.lua-qa', 'runs', 'missing'));
      else if (flag === '--project') argv.push(flag, project);
      else if (flag === '--plugin-root') argv.push(flag, '/w/plugins/lua-agent-builder');
      else if (SWITCHES.has(flag)) argv.push(flag);
      else if (!flag.startsWith('--')) argv.push(flag);
      else argv.push(flag, VALUES[flag] ?? join(project, 'x.json'));
      if (withJsonInMiddle && argv.length === 2) argv.push('--json');
    }
    return argv;
  };

  test('every emitted subcommand exists', () => {
    for (const sub of Object.keys(EMITTED)) expect(COMMANDS).toHaveProperty([sub]);
  });

  test.each(Object.keys(EMITTED).flatMap((sub) => [[sub, false], [sub, true]]))('%s (--json in the middle: %s)', async (sub, mid) => {
    const t = mkio({ cwd: project });
    await main([sub, ...argvFor(sub, mid)], t.io, deps());
    const lines = t.stdout().trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (obj.ok === false && obj.code === 'USAGE') {
        expect(obj.message).not.toMatch(/Unknown flag|Unknown subcommand|needs a number|must be one of|is a switch/);
      }
    }
  });
});

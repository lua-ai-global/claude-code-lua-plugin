import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliPreflight, parseVersion, runPreflight, versionAtLeast } from '../../../lib/qa/preflight.mjs';
import { readJson } from '../../../lib/qa/io.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { fakeSpawn, mkio, tmpProject } from './fixtures/runtime-helpers.mjs';

const REPORT_OK = { pandoc: '/usr/bin/pandoc', weasyprint: '/usr/bin/weasyprint', pdf: true, install: { darwin: 'brew install pandoc weasyprint' } };
const REPORT_NONE = { pandoc: null, weasyprint: null, pdf: false, install: { darwin: 'brew install pandoc weasyprint' } };
const lua = (version = '3.45.0') => fakeSpawn(() => ({ code: 0, stdout: `${version}\n` }));

async function homeWith({ session = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'qa-pf-home-'));
  if (session) {
    await mkdir(join(home, '.lua-cli', 'sessions'), { recursive: true });
    await writeFile(join(home, '.lua-cli', 'sessions', 'x.json'), '{}', 'utf8');
  }
  return home;
}

describe('versions', () => {
  test('parse and compare', () => {
    expect(parseVersion('lua-cli 3.45.0 (build)')).toEqual([3, 45, 0]);
    expect(parseVersion('nope')).toBeNull();
    expect(versionAtLeast('3.45.0', '3.38.0')).toBe(true);
    expect(versionAtLeast('3.38.0', '3.38.0')).toBe(true);
    expect(versionAtLeast('3.37.9', '3.38.0')).toBe(false);
    expect(versionAtLeast('4.0.0', '3.99.99')).toBe(true);
    expect(versionAtLeast('3.44.9', '3.45.0')).toBe(false);
    expect(versionAtLeast(null, '3.0.0')).toBe(false);
    expect(versionAtLeast([3, 45, 0], [3, 45, 0])).toBe(true);
  });
});

describe('runPreflight', () => {
  test('a healthy setup: feature flags, key names only, no warnings except the gitignore', async () => {
    const projectDir = await tmpProject();
    await writeFile(join(projectDir, '.env'), 'OPENAI_API_KEY=sk-very-secret\n', 'utf8');
    const home = await homeWith();
    const r = await runPreflight({ projectDir, env: { HOME: home, PATH: '/bin' }, deps: { spawn: lua(), checkReportTools: async () => REPORT_OK } });
    expect(validate('preflight', r)).toEqual({ ok: true });
    expect(r.luaCli).toEqual({ found: true, version: '3.45.0', meetsMin: true, features: { logWindow: true, agentVersion: true, testSession: true } });
    expect(r.credential).toEqual({ source: 'session', envOnly: false });
    expect(r.dotenv).toEqual({ present: true, keys: ['OPENAI_API_KEY'], hasLuaApiKey: false });
    expect(r.project).toEqual({ hasSkillYaml: true, agentId: 'agent_test_0001' });
    expect(r.report.pdf).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/sk-very-secret/);
    expect(r.warnings.some((w) => /\.lua-qa\/ is not in \.gitignore/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /\.env defines 1 key/.test(w))).toBe(true);
  });
  test('gitignore recognised; env-only credential flagged; LUA_API_KEY in .env warned; old cli feature warnings', async () => {
    const projectDir = await tmpProject();
    await writeFile(join(projectDir, '.gitignore'), 'node_modules\n/.lua-qa/\n', 'utf8');
    await writeFile(join(projectDir, '.env'), 'LUA_API_KEY=api_x\n', 'utf8');
    const home = await homeWith({ session: false });
    const r = await runPreflight({ projectDir, env: { HOME: home, LUA_API_KEY: 'api_in_env' }, deps: { spawn: lua('3.40.0'), checkReportTools: async () => REPORT_NONE } });
    expect(r.gitignore.luaQaIgnored).toBe(true);
    expect(r.credential).toEqual({ source: 'env', envOnly: true });
    expect(r.luaCli.features).toEqual({ logWindow: true, agentVersion: false, testSession: false });
    const text = r.warnings.join('\n');
    expect(text).toMatch(/only credential is LUA_API_KEY/);
    expect(text).toMatch(/\.env holds LUA_API_KEY/);
    expect(text).toMatch(/older than 3\.44\.0/);
    expect(text).toMatch(/PDF output needs pandoc and weasyprint/);
    const r2 = await runPreflight({ projectDir, env: { HOME: home }, deps: { spawn: lua('3.44.2'), checkReportTools: async () => REPORT_OK } });
    expect(r2.warnings.join('\n')).toMatch(/older than 3\.45\.0/);
  });
  test('no lua project, no lua binary, unknown version', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'qa-bare-'));
    const r = await runPreflight({ projectDir: bare, env: { HOME: await homeWith() }, deps: { spawn: fakeSpawn(() => ({ error: 'spawn lua ENOENT' })), checkReportTools: async () => REPORT_OK } });
    expect(r.luaCli).toMatchObject({ found: false, version: null, meetsMin: false });
    expect(r.project).toEqual({ hasSkillYaml: false, agentId: null });
    expect(r.warnings.join('\n')).toMatch(/No lua\.skill\.yaml/);
    const r2 = await runPreflight({ projectDir: bare, env: { HOME: await homeWith() }, deps: { spawn: fakeSpawn(() => ({ code: 0, stdout: 'weird output' })), checkReportTools: async () => REPORT_OK } });
    expect(r2.luaCli).toMatchObject({ found: true, version: null, meetsMin: false });
  });
  test('report tools come from the report module when not injected, and fall back when it is missing', async () => {
    const projectDir = await tmpProject();
    const r = await runPreflight({ projectDir, env: { HOME: await homeWith() }, deps: { spawn: lua() } });
    expect(typeof r.report.pdf).toBe('boolean');
    expect(r.report.install).toBeTruthy();
  });
});

describe('cliPreflight', () => {
  const deps = (over = {}) => ({ spawn: lua(), checkReportTools: async () => REPORT_OK, ...over });
  test('ok -> exit 0 and the result; --run-dir writes preflight.json', async () => {
    const projectDir = await tmpProject();
    const home = await homeWith();
    const runDir = join(projectDir, '.lua-qa', 'runs', 'r1');
    const t = mkio({ cwd: projectDir, env: { HOME: home, PATH: '/bin' } });
    expect(await cliPreflight(['--project', '.', '--run-dir', runDir], t.io, deps())).toBe(0);
    expect(t.json()).toMatchObject({ ok: true, schema: 'lua-qa/preflight@1' });
    expect((await readJson(join(runDir, 'preflight.json'))).luaCli.version).toBe('3.45.0');
  });
  test('missing lua, too old, no credential -> exit 4 with the result attached', async () => {
    const projectDir = await tmpProject();
    const home = await homeWith();
    const t1 = mkio({ cwd: projectDir, env: { HOME: home } });
    expect(await cliPreflight(['--project', projectDir], t1.io, deps({ spawn: fakeSpawn(() => ({ error: 'spawn lua ENOENT' })) }))).toBe(4);
    expect(t1.json()).toMatchObject({ ok: false, code: 'LUA_MISSING' });
    const t2 = mkio({ cwd: projectDir, env: { HOME: home } });
    expect(await cliPreflight(['--project', projectDir], t2.io, deps({ spawn: lua('3.30.0') }))).toBe(4);
    expect(t2.json()).toMatchObject({ code: 'LUA_TOO_OLD', preflight: { luaCli: { version: '3.30.0' } } });
    const t2b = mkio({ cwd: projectDir, env: { HOME: home } });
    expect(await cliPreflight(['--project', projectDir], t2b.io, deps({ spawn: fakeSpawn(() => ({ code: 0, stdout: '?' })) }))).toBe(4);
    expect(t2b.json().message).toMatch(/unknown version/);
    const t3 = mkio({ cwd: projectDir, env: { HOME: await homeWith({ session: false }) } });
    expect(await cliPreflight(['--project', projectDir], t3.io, deps())).toBe(4);
    expect(t3.json().code).toBe('NO_CREDENTIAL');
  });
  test('usage', async () => {
    expect(await cliPreflight([], mkio().io)).toBe(2);
  });
});

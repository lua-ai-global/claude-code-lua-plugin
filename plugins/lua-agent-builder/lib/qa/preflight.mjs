// preflight subcommand: environment facts the command needs before it asks the user anything.
// Reports .env KEY NAMES only, never values. Exit 4 when lua-cli is missing or too old, or no credential resolves.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { QaError, emit, fail, parseArgs, resolveRunDir, writeJson } from './io.mjs';
import { credentialRisk } from './safety.mjs';
import { runLua } from './spawn.mjs';
import { detectCredential } from './api.mjs';
import { readAgentIdFromYaml } from './state.mjs';

export const MIN_VERSIONS = Object.freeze({ base: '3.38.0', logWindow: '3.38.0', agentVersion: '3.44.0', testSession: '3.45.0' });

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** true when version a >= b (both x.y.z strings or arrays). */
export function versionAtLeast(a, b) {
  const x = Array.isArray(a) ? a : parseVersion(a);
  const y = Array.isArray(b) ? b : parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return true;
}

const NO_REPORT_TOOLS = {
  pandoc: null, weasyprint: null, pdf: false,
  install: { darwin: 'brew install pandoc weasyprint', linux: 'sudo apt-get install -y pandoc && python3 -m pip install --user weasyprint', win32: 'winget install --id JohnMacFarlane.Pandoc -e  (then: py -m pip install weasyprint)' },
};

async function reportTools(deps) {
  if (deps.checkReportTools) return deps.checkReportTools(deps);
  try {
    const mod = await import('./report/build.mjs');
    return await mod.checkReportTools(deps);
  } catch {
    return NO_REPORT_TOOLS;
  }
}

export async function runPreflight({ projectDir, env = process.env, deps = {} }) {
  const warnings = [];
  const luaVersion = await (async () => {
    try {
      const r = await runLua(['--version'], { cwd: projectDir, timeoutMs: 15_000, deps });
      if (r.exitCode === -1 && /ENOENT/.test(r.stderr)) return { found: false, version: null };
      const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout} ${r.stderr}`);
      return { found: true, version: m ? m[1] : null };
    } catch {
      return { found: false, version: null };
    }
  })();
  const v = luaVersion.version;
  const luaCli = {
    found: luaVersion.found, version: v,
    meetsMin: !!v && versionAtLeast(v, MIN_VERSIONS.base),
    features: {
      logWindow: !!v && versionAtLeast(v, MIN_VERSIONS.logWindow),
      agentVersion: !!v && versionAtLeast(v, MIN_VERSIONS.agentVersion),
      testSession: !!v && versionAtLeast(v, MIN_VERSIONS.testSession),
    },
  };
  const cred = await detectCredential({ env, cwd: projectDir, home: env.HOME });
  const risk = credentialRisk({ credentialSource: cred.source, dotenvKeys: cred.dotenvKeys, hasStoredCredential: cred.hasStoredCredential });
  warnings.push(...risk.warnings);
  let gitignored = false;
  try {
    gitignored = (await readFile(join(projectDir, '.gitignore'), 'utf8')).split('\n').some((l) => ['.lua-qa/', '.lua-qa', '/.lua-qa/', '/.lua-qa'].includes(l.trim()));
  } catch { /* none */ }
  if (!gitignored) warnings.push('.lua-qa/ is not in .gitignore: run outputs (transcripts) could be committed. The command offers to add it.');
  let agentId = null;
  let hasSkillYaml = false;
  try {
    agentId = readAgentIdFromYaml(await readFile(join(projectDir, 'lua.skill.yaml'), 'utf8'));
    hasSkillYaml = true;
  } catch { /* not a lua project */ }
  if (!hasSkillYaml) warnings.push('No lua.skill.yaml in the project directory: run this from the agent project root.');
  const report = await reportTools(deps);
  if (!report.pdf) warnings.push('PDF output needs pandoc and weasyprint; without them the report is HTML and JSON only.');
  if (luaCli.found && !luaCli.features.agentVersion) warnings.push('lua-cli is older than 3.44.0: staged versions (--agent-version) are not available.');
  else if (luaCli.found && !luaCli.features.testSession) warnings.push('lua-cli is older than 3.45.0: test sessions are not available; staged runs would send real side effects.');
  return {
    schema: 'lua-qa/preflight@1',
    node: process.version,
    luaCli,
    credential: { source: cred.source, envOnly: risk.envOnly },
    dotenv: { present: cred.dotenvKeys.length > 0, keys: cred.dotenvKeys, hasLuaApiKey: cred.hasLuaApiKeyInDotenv },
    gitignore: { luaQaIgnored: gitignored },
    report: { pandoc: report.pandoc ?? null, weasyprint: report.weasyprint ?? null, pdf: !!report.pdf, install: report.install },
    project: { hasSkillYaml, agentId },
    warnings,
  };
}

export async function cliPreflight(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, { project: { type: 'string', required: true }, 'run-dir': { type: 'string' }, json: { type: 'boolean' } });
    const projectDir = resolve(io.cwd, v.project);
    const result = await runPreflight({ projectDir, env: io.env, deps });
    if (v['run-dir']) await writeJson(join(resolveRunDir(io, v['run-dir']), 'preflight.json'), result);
    let err = null;
    if (!result.luaCli.found) err = new QaError('LUA_MISSING', 4, 'lua-cli is not installed or not on PATH', 'Install it with /lua-update or npm install -g lua-cli.');
    else if (!result.luaCli.meetsMin) err = new QaError('LUA_TOO_OLD', 4, `lua-cli ${result.luaCli.version ?? '(unknown version)'} is older than ${MIN_VERSIONS.base}`, 'Update it with /lua-update.');
    else if (result.credential.source === 'none') err = new QaError('NO_CREDENTIAL', 4, 'No lua credential found', 'Log in from your own terminal (lua auth), or run /lua-auth.');
    if (err) {
      emit(io, { ok: false, code: err.code, message: err.message, hint: err.hint, preflight: result });
      return 4;
    }
    emit(io, { ok: true, ...result });
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

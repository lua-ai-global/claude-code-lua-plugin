// Discovery: the read-only lua-cli calls that describe the agent, snapshotted into <runDir>/discovery/.
// Every lua call goes through runLua (spawn.mjs),
// so the argv allowlist and the scrubbed env apply. Nothing here needs a gate: discovery runs before gate 1.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QaError, readJson, writeJson, writeText, emit, fail, parseArgs, resolveRunDir } from '../io.mjs';
import { redactSecrets } from '../safety.mjs';
import { safeName } from './flow-model.mjs';
import { featuresDoc, parseFeaturesList } from '../memory.mjs';

const MAX_VIEWS = 20;

async function loadSpawn(deps) {
  if (deps.runLua) return { runLua: deps.runLua, classifyLuaExit: deps.classifyLuaExit ?? null };
  const mod = await import('../spawn.mjs');
  return { runLua: mod.runLua, classifyLuaExit: deps.classifyLuaExit ?? mod.classifyLuaExit ?? null };
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    // lua-cli may print a banner before the JSON; take from the first brace or bracket
    const i = text.search(/[[{]/);
    if (i > 0) {
      try {
        return JSON.parse(text.slice(i));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** `agentId: abc` from lua.skill.yaml, without a yaml library. Quotes are stripped. */
export function agentIdFromYaml(text) {
  const m = /^\s*agentId:\s*(\S+)/m.exec(String(text ?? ''));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
}

/**
 * Run the discovery reads and write discovery/*.json.
 * @returns {Promise<{ manifest: any, status: any, versions: any, workflows: any, views: Record<string, any>, log: any[], agentId: string|null }>}
 */
export async function discover({ runDir, projectDir, skipCompile = false, deps = {} }) {
  const { runLua, classifyLuaExit } = await loadSpawn(deps);
  const dir = join(runDir, 'discovery');
  const log = [];

  const call = async (argv, { timeoutMs = 100_000 } = {}) => {
    let result;
    try {
      result = await runLua(argv, { cwd: projectDir, timeoutMs, deps });
    } catch (err) {
      log.push({ argv, exit: null, ms: 0, ok: false, note: String(err && err.message ? err.message : err).split('\n')[0].slice(0, 200) });
      return { exitCode: null, stdout: '', stderr: '', denied: err };
    }
    const entry = { argv: result.argvRedacted ?? argv, exit: result.exitCode, ms: result.ms ?? 0, ok: result.exitCode === 0 && !result.timedOut };
    if (result.timedOut) entry.note = 'timed out';
    else if (result.exitCode !== 0) entry.note = String(result.stderr || result.stdout || '').split('\n')[0].slice(0, 200);
    log.push(entry);
    return result;
  };

  // 1. compile (fatal on failure), then read the manifest
  if (!skipCompile) {
    const r = await call(['compile', '--ci'], { timeoutMs: 100_000 });
    if (r.denied) throw r.denied;
    if (r.timedOut || r.exitCode !== 0) {
      const classified = classifyLuaExit ? classifyLuaExit(r) : null;
      if (classified) throw classified;
      throw new QaError('COMPILE_FAILED', 5, `lua compile failed (exit ${r.exitCode})`, 'Fix the compile errors, then run discovery again.');
    }
  }
  let manifestText;
  try {
    manifestText = await readFile(join(projectDir, 'dist-v2', 'manifest.json'), 'utf8');
  } catch {
    throw new QaError('NO_MANIFEST', 2, 'dist-v2/manifest.json not found', 'Run discovery without --skip-compile so the project is compiled first.');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new QaError('NO_MANIFEST', 2, 'dist-v2/manifest.json is not valid JSON', 'Recompile the project.');
  }
  // A byte copy, with any secret-shaped string redacted (identical when there is nothing to redact).
  await writeText(join(dir, 'manifest.json'), redactSecrets(manifestText).text);

  let agentId = null;
  try {
    agentId = agentIdFromYaml(await readFile(join(projectDir, 'lua.skill.yaml'), 'utf8'));
  } catch {
    agentId = null;
  }

  // 2 to 4. read-only snapshots; a failure only nulls the field
  const snap = async (argv, file) => {
    const r = await call(argv);
    const clean = !r.denied && r.exitCode === 0 && !r.timedOut;
    const parsed = clean ? tryParse(r.stdout) : null;
    if (clean && parsed === null) {
      const entry = log[log.length - 1];
      entry.ok = false;
      entry.note = 'output was not JSON';
    }
    await writeJson(join(dir, file), parsed);
    return parsed;
  };
  const status = await snap(['status', '--json', '--ci'], 'status.json');
  const versions = await snap(['version', 'list', '--json', '--ci'], 'versions.json');
  const workflows = await snap(['workflows', 'list', '--json', '--ci'], 'workflows.json');

  // 5. one view per workflow in the manifest (capped)
  const views = {};
  const wfNames = (Array.isArray(manifest.primitives) ? manifest.primitives : []).filter((p) => p && p.kind === 'workflow').map((p) => String(p.name));
  for (const name of wfNames.slice(0, MAX_VIEWS)) {
    views[name] = await snap(['workflows', 'view', name, '--json', '--ci'], join('workflows', `${safeName(name)}.json`));
  }
  for (const name of wfNames.slice(MAX_VIEWS)) {
    log.push({ argv: ['workflows', 'view', name, '--json', '--ci'], exit: null, ms: 0, ok: false, note: `skipped: more than ${MAX_VIEWS} workflows` });
  }

  // 6. features: does the agent keep memory across chats? Every player is the same signed-in user, so memory that
  // outlives a thread lets one run recall another persona (memory.mjs). Plain text: unknown on any failure, never off.
  const fr = await call(['features', 'list', '--ci'], { timeoutMs: 60_000 });
  const clean = !fr.denied && fr.exitCode === 0 && !fr.timedOut;
  const parsed = clean ? parseFeaturesList(fr.stdout) : null;
  if (clean && parsed === null) {
    const entry = log[log.length - 1];
    entry.ok = false;
    entry.note = 'output had no feature list';
  }
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const features = featuresDoc({ ok: parsed !== null, features: parsed, note: parsed === null ? (log[log.length - 1].note ?? 'lua features list failed') : null }, at);
  await writeJson(join(dir, 'features.json'), features);

  await writeJson(join(dir, 'discover.log.json'), log);
  return { manifest, status, versions, workflows, views, log, agentId, features };
}

/** `discover --run-dir D [--skip-compile]` */
export async function cliDiscover(argv, io, deps = {}) {
  try {
    const { values } = parseArgs(argv, {
      'run-dir': { type: 'string', required: true },
      'skip-compile': { type: 'boolean' },
      json: { type: 'boolean' },
    });
    const runDir = resolveRunDir(io, values['run-dir']);
    let run;
    try {
      run = await readJson(join(runDir, 'run.json'));
    } catch {
      throw new QaError('NO_RUN', 2, 'run.json not found in the run dir', 'Create the run with init-run first.');
    }
    if (!run || typeof run.projectDir !== 'string' || !run.projectDir) {
      throw new QaError('NO_RUN', 2, 'run.json has no projectDir', 'Re-create the run with init-run.');
    }
    const out = await discover({ runDir, projectDir: run.projectDir, skipCompile: Boolean(values['skip-compile']), deps });
    const prims = Array.isArray(out.manifest.primitives) ? out.manifest.primitives : [];
    const count = (kind) => prims.filter((p) => p && p.kind === kind).length;
    emit(io, {
      ok: true,
      agentId: out.agentId,
      counts: { skills: count('skill'), tools: count('tool'), workflows: count('workflow'), jobs: count('job'), webhooks: count('webhook') },
      snapshots: { status: out.status !== null, versions: out.versions !== null, workflows: out.workflows !== null, features: out.features.ok },
      memory: { status: out.features.memory.status, active: out.features.memory.active },
      failedCalls: out.log.filter((l) => !l.ok).length,
      files: ['manifest.json', 'status.json', 'versions.json', 'workflows.json', 'features.json', 'discover.log.json'].map((f) => join('discovery', f)),
    });
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

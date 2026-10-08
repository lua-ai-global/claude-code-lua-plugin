import { describe, test, expect } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { discover, cliDiscover, agentIdFromYaml } from '../../../../lib/qa/discovery/discover.mjs';
import { QaError } from '../../../../lib/qa/io.mjs';

const fxText = (name) => readFileSync(fileURLToPath(new URL(`../fixtures/manifests/${name}`, import.meta.url)), 'utf8');

async function project({ manifest = fxText('full.json'), yaml = 'agent:\n  agentId: agent-test-1\n' } = {}) {
  const proj = await mkdtemp(join(tmpdir(), 'qa-disc-proj-'));
  if (manifest !== null) {
    await mkdir(join(proj, 'dist-v2'), { recursive: true });
    await writeFile(join(proj, 'dist-v2', 'manifest.json'), manifest);
  }
  if (yaml !== null) await writeFile(join(proj, 'lua.skill.yaml'), yaml);
  const runDir = await mkdtemp(join(tmpdir(), 'qa-disc-run-'));
  return { proj, runDir };
}

/** A fake runLua that answers by argv and records every call. */

// `lua features list --ci` as lua-cli 3.45.0 prints it (src/commands/features.ts displayFeaturesCore).
const FEATURES_TEXT = [
  '', '='.repeat(60), '🎯 Agent Features', '='.repeat(60), '',
  '1. ✅ Web Search', '   Name: webSearch', '   Status: Active', '',
  '2. ✅ Lua Cross-Chat Memory', '   Name: luaMemoryCrossChatEnabled', '   Status: Active', '',
  '3. ✅ Lua Immediate Memory: Profile Read', '   Name: luaMemoryProfileRead', '   Status: Active', '',
  '4. ❌ Org Memory Write (memory statements)', '   Name: memoryWrite', '   Status: Inactive', '',
  '='.repeat(60),
].join('\n');

function fakeLua(overrides = {}) {
  const calls = [];
  const runLua = async (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd });
    const key = argv.join(' ');
    if (overrides[key] instanceof Error) throw overrides[key];
    const hit = overrides[key];
    if (hit) return { stdout: '', stderr: '', timedOut: false, ms: 5, argvRedacted: argv, ...hit };
    const body = {
      'compile --ci': '',
      'status --json --ci': fxText('status.json'),
      'version list --json --ci': fxText('versions.json'),
      'workflows list --json --ci': fxText('workflows-list.json'),
      'features list --ci': FEATURES_TEXT,
    }[key];
    if (body !== undefined) return { exitCode: 0, stdout: body, stderr: '', timedOut: false, ms: 5, argvRedacted: argv };
    if (argv[0] === 'workflows' && argv[1] === 'view') return { exitCode: 0, stdout: JSON.stringify({ name: argv[2] }), stderr: '', timedOut: false, ms: 5, argvRedacted: argv };
    return { exitCode: 1, stdout: '', stderr: 'unexpected', timedOut: false, ms: 1, argvRedacted: argv };
  };
  return { runLua, calls };
}

function makeIo() {
  const out = [];
  return { io: { out: { write: (s) => out.push(s) }, err: { write() {} }, cwd: '/', env: {} }, json: () => JSON.parse(out.join('').trim().split('\n').pop()) };
}

describe('agentIdFromYaml', () => {
  test('reads the id with or without quotes', () => {
    expect(agentIdFromYaml('agent:\n  agentId: abc-123\n')).toBe('abc-123');
    expect(agentIdFromYaml('agentId: "q-1"')).toBe('q-1');
    expect(agentIdFromYaml("agentId: 'q-2'")).toBe('q-2');
    expect(agentIdFromYaml('name: x')).toBeNull();
    expect(agentIdFromYaml(undefined)).toBeNull();
  });
});

describe('discover', () => {
  test('runs the reads in order, writes every snapshot, and sends only allowed argv', async () => {
    const { proj, runDir } = await project();
    const { runLua, calls } = fakeLua();
    const out = await discover({ runDir, projectDir: proj, deps: { runLua, classifyLuaExit: () => null } });
    expect(calls.map((c) => c.argv.join(' '))).toEqual([
      'compile --ci',
      'status --json --ci',
      'version list --json --ci',
      'workflows list --json --ci',
      'workflows view refund-review --json --ci',
      'workflows view weekly-digest --json --ci',
      'workflows view view-only --json --ci',
      'workflows view non-exclusive --json --ci',
      'features list --ci',
    ]);
    expect(calls.every((c) => c.cwd === proj)).toBe(true);
    expect(out.agentId).toBe('agent-test-1');
    expect(out.manifest.primitives.length).toBeGreaterThan(10);
    expect(out.views['view-only']).toEqual({ name: 'view-only' });
    const files = await readdir(join(runDir, 'discovery'));
    expect(files.sort()).toEqual(['discover.log.json', 'features.json', 'manifest.json', 'status.json', 'versions.json', 'workflows', 'workflows.json']);
    expect((await readdir(join(runDir, 'discovery', 'workflows'))).sort()).toEqual(['non-exclusive.json', 'refund-review.json', 'view-only.json', 'weekly-digest.json']);
    expect(await readFile(join(runDir, 'discovery', 'manifest.json'), 'utf8')).toBe(fxText('full.json'));
    const log = JSON.parse(await readFile(join(runDir, 'discovery', 'discover.log.json'), 'utf8'));
    expect(log).toHaveLength(9);
    expect(log.every((l) => l.ok)).toBe(true);
  });

  test('skip-compile does not call compile', async () => {
    const { proj, runDir } = await project();
    const { runLua, calls } = fakeLua();
    await discover({ runDir, projectDir: proj, skipCompile: true, deps: { runLua, classifyLuaExit: () => null } });
    expect(calls.some((c) => c.argv[0] === 'compile')).toBe(false);
  });

  test('a failing read nulls the field and is logged; it is not fatal', async () => {
    const { proj, runDir } = await project();
    const { runLua } = fakeLua({
      'status --json --ci': { exitCode: 9, stderr: 'auth\nmore' },
      'version list --json --ci': { exitCode: 0, stdout: 'not json at all' },
      'workflows list --json --ci': { exitCode: 0, timedOut: true },
      'workflows view refund-review --json --ci': new QaError('LUA_ARGV_DENIED', 3, 'denied'),
    });
    const out = await discover({ runDir, projectDir: proj, deps: { runLua, classifyLuaExit: () => null } });
    expect(out.status).toBeNull();
    expect(out.versions).toBeNull();
    expect(out.workflows).toBeNull();
    expect(out.views['refund-review']).toBeNull();
    const log = JSON.parse(await readFile(join(runDir, 'discovery', 'discover.log.json'), 'utf8'));
    expect(log.filter((l) => !l.ok).length).toBe(4);
    expect(log.find((l) => l.exit === 9).note).toBe('auth');
    expect(log.find((l) => l.note === 'timed out')).toBeTruthy();
    expect(log.find((l) => l.exit === null).note).toBe('denied');
    expect(JSON.parse(await readFile(join(runDir, 'discovery', 'status.json'), 'utf8'))).toBeNull();
  });

  test('JSON after a banner line is still parsed', async () => {
    const { proj, runDir } = await project();
    const { runLua } = fakeLua({ 'status --json --ci': { exitCode: 0, stdout: `Checking...\n${JSON.stringify({ ok: 1 })}` }, 'version list --json --ci': { exitCode: 0, stdout: 'banner {broken' } });
    const out = await discover({ runDir, projectDir: proj, deps: { runLua, classifyLuaExit: () => null } });
    expect(out.status).toEqual({ ok: 1 });
    expect(out.versions).toBeNull();
  });

  test('compile failure is fatal: classified error first, else COMPILE_FAILED', async () => {
    const { proj, runDir } = await project();
    const bad = fakeLua({ 'compile --ci': { exitCode: 1, stderr: 'TS2304' } });
    await expect(discover({ runDir, projectDir: proj, deps: { runLua: bad.runLua, classifyLuaExit: () => null } })).rejects.toMatchObject({ code: 'COMPILE_FAILED', exitCode: 5 });
    const classified = new QaError('LUA_AUTH', 5, 'auth');
    await expect(discover({ runDir, projectDir: proj, deps: { runLua: bad.runLua, classifyLuaExit: () => classified } })).rejects.toBe(classified);
    const timeout = fakeLua({ 'compile --ci': { exitCode: 0, timedOut: true } });
    await expect(discover({ runDir, projectDir: proj, deps: { runLua: timeout.runLua } })).rejects.toBeInstanceOf(QaError);
    const denied = fakeLua({ 'compile --ci': new QaError('LUA_ARGV_DENIED', 3, 'no') });
    await expect(discover({ runDir, projectDir: proj, deps: { runLua: denied.runLua } })).rejects.toMatchObject({ code: 'LUA_ARGV_DENIED' });
  });

  test('a missing or broken manifest is NO_MANIFEST (exit 2)', async () => {
    const none = await project({ manifest: null });
    const { runLua } = fakeLua();
    await expect(discover({ runDir: none.runDir, projectDir: none.proj, skipCompile: true, deps: { runLua } })).rejects.toMatchObject({ code: 'NO_MANIFEST', exitCode: 2 });
    const broken = await project({ manifest: '{nope' });
    await expect(discover({ runDir: broken.runDir, projectDir: broken.proj, skipCompile: true, deps: { runLua } })).rejects.toMatchObject({ code: 'NO_MANIFEST', exitCode: 2 });
  });

  test('a missing lua.skill.yaml leaves the agent id null', async () => {
    const { proj, runDir } = await project({ yaml: null });
    const { runLua } = fakeLua();
    const out = await discover({ runDir, projectDir: proj, deps: { runLua, classifyLuaExit: () => null } });
    expect(out.agentId).toBeNull();
  });

  test('views are capped at 20 and the rest is logged as skipped', async () => {
    const m = JSON.parse(fxText('full.json'));
    m.primitives = Array.from({ length: 23 }, (_, i) => ({ kind: 'workflow', name: `wf${i}`, form: 'script' }));
    const { proj, runDir } = await project({ manifest: JSON.stringify(m) });
    const { runLua, calls } = fakeLua();
    await discover({ runDir, projectDir: proj, deps: { runLua, classifyLuaExit: () => null } });
    expect(calls.filter((c) => c.argv[1] === 'view')).toHaveLength(20);
    const log = JSON.parse(await readFile(join(runDir, 'discovery', 'discover.log.json'), 'utf8'));
    expect(log.filter((l) => String(l.note).startsWith('skipped'))).toHaveLength(3);
  });

  test('a manifest with no primitives array is fine', async () => {
    const { proj, runDir } = await project({ manifest: '{}' });
    const { runLua } = fakeLua();
    const out = await discover({ runDir, projectDir: proj, deps: { runLua, classifyLuaExit: () => null } });
    expect(out.views).toEqual({});
  });

  test('a secret-shaped string in the manifest is redacted in the snapshot', async () => {
    const m = JSON.parse(fxText('full.json'));
    m.primitives[0].persona = 'key is sk_live_abcdefgh12345678 ok';
    const { proj, runDir } = await project({ manifest: JSON.stringify(m) });
    const { runLua } = fakeLua();
    await discover({ runDir, projectDir: proj, skipCompile: true, deps: { runLua, classifyLuaExit: () => null } });
    const saved = await readFile(join(runDir, 'discovery', 'manifest.json'), 'utf8');
    expect(saved).not.toContain('sk_live_abcdefgh12345678');
    expect(saved).toContain('[REDACTED:');
  });
});

describe('discover through the real runLua', () => {
  test('without an injected runLua it uses spawn.mjs, whose allowlist accepts every discovery call', async () => {
    const { proj, runDir } = await project();
    const seen = [];
    const spawn = (bin, argv, opts) => {
      seen.push({ bin, argv, env: opts.env });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        const key = argv.join(' ');
        const body = { 'status --json --ci': fxText('status.json'), 'version list --json --ci': fxText('versions.json'), 'workflows list --json --ci': fxText('workflows-list.json'), 'features list --ci': FEATURES_TEXT }[key] ?? '{}';
        child.stdout.emit('data', Buffer.from(body));
        child.emit('exit', 0);
      });
      return child;
    };
    const out = await discover({ runDir, projectDir: proj, deps: { spawn } });
    expect(seen.length).toBe(9);
    expect(out.features.memory.status).toBe('active');
    expect(seen.every((c) => c.bin === 'lua')).toBe(true);
    expect(out.log.every((l) => l.ok)).toBe(true);
    expect(out.versions.versions).toHaveLength(3);
  });
});

describe('cliDiscover', () => {
  async function runWith(projDeps = {}) {
    const { proj, runDir } = await project(projDeps);
    await writeFile(join(runDir, 'run.json'), JSON.stringify({ schema: 'lua-qa/run@1', projectDir: proj }));
    return { proj, runDir };
  }

  test('prints a summary and writes the snapshots', async () => {
    const { runDir } = await runWith();
    const { runLua } = fakeLua();
    const t = makeIo();
    expect(await cliDiscover(['--run-dir', runDir], t.io, { runLua, classifyLuaExit: () => null })).toBe(0);
    const res = t.json();
    expect(res).toMatchObject({ ok: true, agentId: 'agent-test-1', failedCalls: 0, snapshots: { status: true, versions: true, workflows: true } });
    expect(res.counts).toMatchObject({ skills: 3, tools: 8, workflows: 4, jobs: 3, webhooks: 1 });
    expect(res.files).toContain(join('discovery', 'manifest.json'));
    expect(res.files).toContain(join('discovery', 'features.json'));
    expect(res.memory).toEqual({ status: 'active', active: ['luaMemoryCrossChatEnabled', 'luaMemoryProfileRead'] });
    const doc = JSON.parse(await readFile(join(runDir, 'discovery', 'features.json'), 'utf8'));
    expect(doc).toMatchObject({ schema: 'lua-qa/features@1', ok: true, note: null, memory: { status: 'active', personal: ['luaMemoryCrossChatEnabled', 'luaMemoryProfileRead'], org: [] } });
    expect(doc.features).toHaveLength(4);
  });

  test('features that cannot be read are unknown, never off, and count as a failed call', async () => {
    for (const [hit, note] of [[{ exitCode: 1, stderr: 'boom' }, /boom/], [{ exitCode: 0, stdout: 'banner only' }, /no feature list/], [new Error('LUA_ARGV_DENIED'), /LUA_ARGV_DENIED/]]) {
      const { runDir } = await runWith();
      const { runLua } = fakeLua({ 'features list --ci': hit });
      const t = makeIo();
      expect(await cliDiscover(['--run-dir', runDir], t.io, { runLua, classifyLuaExit: () => null })).toBe(0);
      expect(t.json()).toMatchObject({ failedCalls: 1, snapshots: { features: false }, memory: { status: 'unknown', active: [] } });
      const doc = JSON.parse(await readFile(join(runDir, 'discovery', 'features.json'), 'utf8'));
      expect(doc.ok).toBe(false);
      expect(doc.note).toMatch(note);
    }
  });

  test('--skip-compile is honoured', async () => {
    const { runDir } = await runWith();
    const { runLua, calls } = fakeLua();
    expect(await cliDiscover(['--run-dir', runDir, '--skip-compile'], makeIo().io, { runLua, classifyLuaExit: () => null })).toBe(0);
    expect(calls.some((c) => c.argv[0] === 'compile')).toBe(false);
  });

  test('exit codes: no run.json 2, no projectDir 2, no manifest 2, compile failure 5', async () => {
    const { runLua } = fakeLua({ 'compile --ci': { exitCode: 1, stderr: 'x' } });
    const empty = await mkdtemp(join(tmpdir(), 'qa-disc-run-'));
    const t1 = makeIo();
    expect(await cliDiscover(['--run-dir', empty], t1.io, { runLua })).toBe(2);
    expect(t1.json().code).toBe('NO_RUN');
    await writeFile(join(empty, 'run.json'), '{}');
    expect(await cliDiscover(['--run-dir', empty], makeIo().io, { runLua })).toBe(2);
    const { runDir } = await runWith({ manifest: null });
    expect(await cliDiscover(['--run-dir', runDir, '--skip-compile'], makeIo().io, { runLua })).toBe(2);
    const ok = await runWith();
    const t2 = makeIo();
    expect(await cliDiscover(['--run-dir', ok.runDir], t2.io, { runLua, classifyLuaExit: () => null })).toBe(5);
    expect(t2.json().code).toBe('COMPILE_FAILED');
    expect(await cliDiscover([], makeIo().io, {})).toBe(2);
  });

  test('a manifest that is not an object with primitives still summarises', async () => {
    const { runDir } = await runWith({ manifest: '{"primitives":[null,{"kind":"skill","name":"s"}]}' });
    const { runLua } = fakeLua();
    const t = makeIo();
    expect(await cliDiscover(['--run-dir', runDir], t.io, { runLua, classifyLuaExit: () => null })).toBe(0);
    expect(t.json().counts.skills).toBe(1);
  });
});

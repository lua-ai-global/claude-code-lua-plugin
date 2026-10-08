import { join } from 'node:path';
import { readJson } from '../../../lib/qa/io.mjs';
import {
  CROSS_RUN_MEMORY_FEATURES, MEMORY_CONSENT_TEXT, cliMemory, disableCommand, enableCommand, featuresDoc, isMemoryConsentText,
  memoryFromFeatures, memoryStamp, parseFeaturesList, readFeatures, restorableFeatures,
} from '../../../lib/qa/memory.mjs';
import { fakeSpawn, mkio, scaffoldRun, stateJson, wj } from './fixtures/runtime-helpers.mjs';

// `lua features list --ci` as lua-cli 3.45.0 prints it (src/commands/features.ts displayFeaturesCore).
function featuresText(rows) {
  const out = ['', '='.repeat(60), '🎯 Agent Features', '='.repeat(60), ''];
  rows.forEach(([name, active, title = name], i) => out.push(`${i + 1}. ${active ? '✅' : '❌'} ${title}`, `   Name: ${name}`, `   Status: ${active ? 'Active' : 'Inactive'}`, ''));
  out.push('='.repeat(60));
  return out.join('\n');
}

const f = (name, active) => ({ name, title: name, active });

describe('parseFeaturesList', () => {
  test('reads name, title and status from the plain-text list', () => {
    const text = featuresText([['webSearch', true, 'Web Search'], ['luaMemoryCrossChatEnabled', false, 'Lua Cross-Chat Memory']]);
    expect(parseFeaturesList(text)).toEqual([
      { name: 'webSearch', title: 'Web Search', active: true },
      { name: 'luaMemoryCrossChatEnabled', title: 'Lua Cross-Chat Memory', active: false },
    ]);
  });
  test('no features is an empty list; anything else without a feature block is unknown (null)', () => {
    expect(parseFeaturesList('\nℹ️  No features available for this agent.\n')).toEqual([]);
    expect(parseFeaturesList('❌ Error loading features')).toBeNull();
    expect(parseFeaturesList('')).toBeNull();
    expect(parseFeaturesList(undefined)).toBeNull();
    // a block without a status, or with an odd name, is dropped
    expect(parseFeaturesList('1. ✅ Odd\n   Name: bad name here\n   Status: Active\n2. ✅ Half\n   Name: half')).toBeNull();
    // name/status lines before any block are ignored
    expect(parseFeaturesList('Name: x\nStatus: Active\n1. ✅ Real\n   Name: rag\n   Status: inactive')).toEqual([{ name: 'rag', title: 'Real', active: false }]);
  });
});

describe('memoryFromFeatures', () => {
  test('unknown when the list could not be read', () => {
    expect(memoryFromFeatures(null)).toEqual({ status: 'unknown', active: [], personal: [], org: [], dormant: [] });
  });
  test('personal memory counts only with the master gate on; org memory counts on its own', () => {
    const on = memoryFromFeatures([f('luaMemoryCrossChatEnabled', true), f('luaMemoryProfileRead', true), f('memoryWrite', true), f('observationalMemory', true), f('webSearch', true)]);
    expect(on).toEqual({ status: 'active', active: ['luaMemoryCrossChatEnabled', 'luaMemoryProfileRead', 'memoryWrite'], personal: ['luaMemoryCrossChatEnabled', 'luaMemoryProfileRead'], org: ['memoryWrite'], dormant: [] });
    const dormant = memoryFromFeatures([f('luaMemoryCrossChatEnabled', false), f('luaMemoryProfileRead', true), f('observationalMemory', true)]);
    expect(dormant).toMatchObject({ status: 'off', active: [], dormant: ['luaMemoryProfileRead'] });
    expect(memoryFromFeatures([]).status).toBe('off');
    expect(memoryFromFeatures([null, f('memoryRecall', true)]).active).toEqual(['memoryRecall']);
  });
});

describe('consent, stamp and restore list', () => {
  const doc = featuresDoc({ ok: true, features: [f('luaMemoryCrossChatEnabled', true), f('memoryRecall', true)], note: null }, '2026-10-07T10:00:00.000Z');
  test('the consent text matches verbatim (case and spacing aside), nothing else', () => {
    expect(isMemoryConsentText(MEMORY_CONSENT_TEXT)).toBe(true);
    expect(isMemoryConsentText(`  ${MEMORY_CONSENT_TEXT.toUpperCase().replace(/ /g, '  ')} `)).toBe(true);
    expect(isMemoryConsentText('yes')).toBe(false);
    expect(isMemoryConsentText(null)).toBe(false);
  });
  test('off needs active memory and the consent; it lists exactly the active memory features to restore', () => {
    const s = memoryStamp(doc, { mode: 'off', consentText: MEMORY_CONSENT_TEXT, at: 'T' });
    expect(s).toEqual({ status: 'active', active: ['luaMemoryCrossChatEnabled', 'memoryRecall'], checkedAt: '2026-10-07T10:00:00.000Z', mitigation: 'off-for-run', restore: ['luaMemoryCrossChatEnabled', 'memoryRecall'], consentAt: 'T' });
    expect(() => memoryStamp(doc, { mode: 'off', consentText: 'sure', at: 'T' })).toThrow(expect.objectContaining({ code: 'MEMORY_CONSENT', exitCode: 3 }));
    const offDoc = featuresDoc({ ok: true, features: [], note: null }, 'T0');
    expect(() => memoryStamp(offDoc, { mode: 'off', consentText: MEMORY_CONSENT_TEXT, at: 'T' })).toThrow(expect.objectContaining({ code: 'USAGE' }));
  });
  test('without off: none when memory is off, otherwise a caveat (also when discovery never read it)', () => {
    expect(memoryStamp(featuresDoc({ ok: true, features: [], note: null }, 'T0'), { at: 'T' })).toMatchObject({ status: 'off', mitigation: 'none', restore: [] });
    expect(memoryStamp(doc, { mode: 'caveat', at: 'T' })).toMatchObject({ status: 'active', mitigation: 'caveat', restore: [] });
    expect(memoryStamp(null, { at: 'T' })).toEqual({ status: 'unknown', active: [], checkedAt: null, mitigation: 'caveat', restore: [] });
  });
  test('cleanup restores only allowlisted features that discovery saw active (a tampered state adds none)', () => {
    const state = { memoryRestore: { features: ['memoryRecall', 'webSearch', 'luaMemoryProfileWrite', 'memoryRecall'] } };
    expect(restorableFeatures(state, doc)).toEqual(['memoryRecall']);
    expect(restorableFeatures({}, doc)).toEqual([]);
    expect(restorableFeatures(state, null)).toEqual([]);
    expect(CROSS_RUN_MEMORY_FEATURES).not.toContain('observationalMemory');
  });
  test('commands', () => {
    expect(disableCommand('memoryRecall')).toBe('lua features disable --feature-name memoryRecall --ci');
    expect(enableCommand('memoryRecall')).toBe('lua features enable --feature-name memoryRecall --ci');
  });
});

describe('readFeatures', () => {
  const lua = (r) => async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...r });
  test('parses a good list and reports every failure as unknown', async () => {
    expect(await readFeatures({ projectDir: '/p', deps: { runLua: lua({ stdout: featuresText([['memoryWrite', true]]) }) } })).toEqual({ ok: true, features: [f('memoryWrite', true)], note: null });
    expect(await readFeatures({ projectDir: '/p', deps: { runLua: lua({ exitCode: 9, stderr: 'auth\nnot logged in' }) } })).toMatchObject({ ok: false, features: null, note: 'lua features list exit 9: not logged in' });
    expect(await readFeatures({ projectDir: '/p', deps: { runLua: lua({ exitCode: 1 }) } })).toMatchObject({ ok: false, note: 'lua features list exit 1:' });
    expect(await readFeatures({ projectDir: '/p', deps: { runLua: lua({ timedOut: true }) } })).toMatchObject({ ok: false, note: 'lua features list timed out' });
    expect(await readFeatures({ projectDir: '/p', deps: { runLua: lua({ stdout: 'nothing' }) } })).toMatchObject({ ok: false, note: 'lua features list printed no feature list' });
    expect(await readFeatures({ projectDir: '/p', deps: { runLua: async () => { throw new Error('denied\nmore'); } } })).toMatchObject({ ok: false, note: 'denied' });
  });
  test('without an injected runLua it goes through spawn.mjs (the allowlist accepts features list)', async () => {
    const spawn = fakeSpawn(() => ({ stdout: featuresText([['luaMemoryCrossChatEnabled', true]]) }));
    const r = await readFeatures({ projectDir: '/p', deps: { spawn } });
    expect(r.ok).toBe(true);
    expect(spawn.calls[0].argv).toEqual(['features', 'list', '--ci']);
  });
});

describe('cliMemory', () => {
  async function setup({ restore = ['luaMemoryCrossChatEnabled'], discovered = [f('luaMemoryCrossChatEnabled', true)] } = {}) {
    const s = await scaffoldRun({ stateOver: { memoryRestore: { features: restore, consentAt: 'T', verifiedOffAt: null, restoredAt: null } } });
    await wj(join(s.runDir, 'discovery', 'features.json'), featuresDoc({ ok: true, features: discovered, note: null }, 'T0'));
    return s;
  }
  const withList = (rows) => ({ runLua: async () => ({ exitCode: 0, stdout: featuresText(rows), stderr: '', timedOut: false }), now: () => new Date('2026-10-07T12:00:00.000Z') });

  test('--check off: lists what is still on (exit 1), records the verification once all is off', async () => {
    const s = await setup();
    const t1 = mkio();
    expect(await cliMemory(['--run-dir', s.runDir, '--check', 'off'], t1.io, withList([['luaMemoryCrossChatEnabled', true]]))).toBe(1);
    expect(t1.json()).toMatchObject({ ok: false, stillOn: ['luaMemoryCrossChatEnabled'], commands: ['lua features disable --feature-name luaMemoryCrossChatEnabled --ci'] });
    expect((await readJson(join(s.runDir, 'state.json'))).memoryRestore.verifiedOffAt).toBeNull();
    const t2 = mkio();
    expect(await cliMemory(['--run-dir', s.runDir, '--check', 'off'], t2.io, withList([['luaMemoryCrossChatEnabled', false]]))).toBe(0);
    expect(t2.json()).toMatchObject({ ok: true, verifiedOffAt: '2026-10-07T12:00:00.000Z' });
    expect((await readJson(join(s.runDir, 'state.json'))).memoryRestore.verifiedOffAt).toBe('2026-10-07T12:00:00.000Z');
  });
  test('--check restored: lists what is still off, records the restore once all is back on', async () => {
    const s = await setup();
    const t1 = mkio();
    expect(await cliMemory(['--run-dir', s.runDir, '--check', 'restored'], t1.io, withList([['luaMemoryCrossChatEnabled', false]]))).toBe(1);
    expect(t1.json()).toMatchObject({ stillOff: ['luaMemoryCrossChatEnabled'], commands: ['lua features enable --feature-name luaMemoryCrossChatEnabled --ci'] });
    const t2 = mkio();
    expect(await cliMemory(['--run-dir', s.runDir, '--check', 'restored'], t2.io, withList([['luaMemoryCrossChatEnabled', true]]))).toBe(0);
    expect((await readJson(join(s.runDir, 'state.json'))).memoryRestore.restoredAt).toBe('2026-10-07T12:00:00.000Z');
  });
  test('--check status reports without recording; unreadable features and nothing to check are errors', async () => {
    const s = await setup();
    const t = mkio();
    expect(await cliMemory(['--run-dir', s.runDir, '--check', 'status'], t.io, withList([['memoryWrite', true]]))).toBe(0);
    expect(t.json()).toMatchObject({ ok: true, memory: { status: 'active', active: ['memoryWrite'] }, restorable: ['luaMemoryCrossChatEnabled'] });
    const bad = { runLua: async () => ({ exitCode: 10, stdout: '', stderr: 'auth', timedOut: false }) };
    const t1 = mkio();
    expect(await cliMemory(['--run-dir', s.runDir, '--check', 'status'], t1.io, bad)).toBe(0);
    expect(t1.json()).toMatchObject({ ok: false, memory: { status: 'unknown' }, note: 'lua features list exit 10: auth' });
    const t2 = mkio();
    expect(await cliMemory(['--run-dir', s.runDir, '--check', 'off'], t2.io, bad)).toBe(5);
    expect(t2.json().code).toBe('FEATURES_UNREADABLE');
    const none = await setup({ restore: [] });
    const t3 = mkio();
    expect(await cliMemory(['--run-dir', none.runDir, '--check', 'restored'], t3.io, withList([]))).toBe(2);
    expect(t3.json().code).toBe('USAGE');
    const t4 = mkio();
    expect(await cliMemory(['--run-dir', s.runDir, '--check', 'nope'], t4.io, withList([]))).toBe(2);
  });
  test('the default deps (real clock) work too', async () => {
    const s = await setup();
    const t = mkio();
    const runLua = async () => ({ exitCode: 0, stdout: featuresText([['luaMemoryCrossChatEnabled', false]]), stderr: '', timedOut: false });
    expect(await cliMemory(['--run-dir', s.runDir, '--check', 'off'], t.io, { runLua })).toBe(0);
    expect(typeof t.json().verifiedOffAt).toBe('string');
    expect(stateJson().memoryRestore).toBeUndefined();
  });
});

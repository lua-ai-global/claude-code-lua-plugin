import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cliFinishRun, cliRecord, cliStartRun, loadRecord, parseBatchStdout, parseChatStdout, parseTestSessionStdout,
  renderTranscriptTurn, selectorPaths, testSessionApi,
} from '../../../lib/qa/recorder.mjs';
import { readJson, readJsonl } from '../../../lib/qa/io.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { RUN_ID, chatStdout, fakeSpawn, mkio, runJson, scaffoldRun, stateJson, wj, flowModel, consentStamp } from './fixtures/runtime-helpers.mjs';

async function homeWithSession() {
  const home = await mkdtemp(join(tmpdir(), 'qa-home-'));
  await mkdir(join(home, '.lua-cli', 'sessions'), { recursive: true });
  await writeFile(join(home, '.lua-cli', 'sessions', 'x.json'), '{}', 'utf8');
  return home;
}

const resp = (body, status = 200) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) });
let clock;
const baseDeps = (extra = {}) => {
  clock = Date.parse('2026-10-07T14:20:00Z');
  return {
    now: () => new Date((clock += 1500)),
    randomBytes: (n) => Buffer.alloc(n, 0xcd),
    resolveBearer: async () => 'tok',
    sleep: async () => {},
    ...extra,
  };
};
const START = (runDir, extra = []) => ['--run-dir', runDir, '--card', 'icp-01', '--run', '1', ...extra];
const TH = 'qa-9f3c-icp-01-r1-cdcdcd';
const PLAYER = 'icp-01-r1-cdcdcd';

async function ready(opts = {}) {
  const home = await homeWithSession();
  const s = await scaffoldRun(opts);
  const env = { HOME: home, PATH: '/usr/bin', ...(opts.env ?? {}) };
  return { ...s, env, home };
}
async function start(s, deps, extra = []) {
  const t = mkio({ cwd: s.projectDir, env: s.env });
  const code = await cliStartRun(START(s.runDir, extra), t.io, deps);
  return { code, t };
}

describe('parseChatStdout', () => {
  test('reply after the banner, thread echoed, banner noise before it ignored', () => {
    const r = parseChatStdout(chatStdout('Your order shipped.', { thread: 'qa-x' }));
    expect(r).toMatchObject({ reply: 'Your order shipped.', streamed: null, postprocessed: false, preprocessorBlocked: false, threadEcho: 'qa-x' });
  });
  test('post-processed text wins and the streamed text is kept', () => {
    const r = parseChatStdout(chatStdout('raw draft', { post: 'clean final' }));
    expect(r).toMatchObject({ postprocessed: true, streamed: 'raw draft', reply: 'clean final' });
  });
  test('preprocessor block', () => {
    const out = '\u{1F319} Response:\nThread: qa-x\n\n\u{1F6AB} Message blocked: not allowed here\n';
    expect(parseChatStdout(out)).toMatchObject({ preprocessorBlocked: true, reply: 'not allowed here' });
    expect(parseChatStdout('\u{1F319} Response:\n\n\u{1F6AB} Message blocked — no reply sent\n').preprocessorBlocked).toBe(true);
  });
  test('hint blocks after the reply are cut', () => {
    const r = parseChatStdout(`\u{1F319} Response:\nThread: t\n\nHello there\n\n\u{1F4A1} Next: check logs\n`);
    expect(r.reply).toBe('Hello there');
  });
  test('tip and error-probe lines lua-cli prints after the reply are cut', () => {
    for (const tail of ['\u2728 Tip: run `lua logs`', '\u{1F4A1} Diagnose: run `lua logs`', '\u26A0\uFE0F  2 new agent error(s) during this turn \u2014 run `lua logs` to inspect.']) {
      expect(parseChatStdout(`\u{1F319} Response:\nThread: t\n\nHello there\n\n${tail}\n`).reply).toBe('Hello there');
    }
    expect(parseChatStdout('\u{1F319} Response:\nThread: t\n\nCareful: \u26A0\uFE0F this is a warning in the reply\n').reply).toMatch(/warning in the reply/);
  });
  test('no banner -> empty reply; batch markers noted', () => {
    expect(parseChatStdout('boom', 'err').reply).toBe('');
    expect(parseChatStdout('Batch handled: x').batchHandled).toBe(true);
    expect(parseChatStdout('Batched/absorbed: x').batchAborted).toBe(true);
    expect(parseChatStdout('\u{1F319} Response:\nBatch handled: x\nBatched/absorbed').batchHandled).toBe(true);
    expect(parseChatStdout().reply).toBe('');
  });
});

describe('parseBatchStdout / parseTestSessionStdout / renderTranscriptTurn', () => {
  test('batch counts', () => {
    const out = [
      'Sending msg 1: "a"', 'Sending msg 2: "b"', 'Sending msg 3: "c"', 'Sending msg 4: "d"',
      '[msg 1] Responded: hi', '[msg 2] Batch handled: x', '[msg 3] Batched/absorbed: y', '[msg 4] Error: z',
    ].join('\n');
    expect(parseBatchStdout(out)).toEqual({ sent: 4, replies: 1, batchHandled: 1, batchAborted: 1, errors: 1 });
    expect(parseBatchStdout()).toEqual({ sent: 0, replies: 0, batchHandled: 0, batchAborted: 0, errors: 0 });
    // lua-cli prints per-message errors with console.error (stderr); the stdout summary line ends with "K errors".
    expect(parseBatchStdout('Sending msg 1: "a"', '\u274C [msg 1] Error: socket hang up\n').errors).toBe(1);
    expect(parseBatchStdout('   0 responded \u00B7 0 batched/handled \u00B7 2 errors').errors).toBe(2);
    expect(parseBatchStdout('[msg 1] Error: x\n   0 responded \u00B7 0 batched/handled \u00B7 1 errors', '[msg 1] Error: x').errors).toBe(2);
  });
  test('test-session stdout: session id, replies with tools, effects', () => {
    const out = [
      '\u{1F9EA} Test session sess_1 on agent version v4 (effects recorded, never sent)',
      '', '\u{1F916} Your order is on its way.', 'It should arrive Friday.', '   tools: get_order, notify',
      '\u{1F916} Anything else?',
      'Recorded 2 effect(s) instead of executing them:', '  #1 email.send (tool, prim_1)', '  #2 db.write (workflow)',
    ].join('\n');
    const r = parseTestSessionStdout(out);
    expect(r.sessionId).toBe('sess_1');
    expect(r.replies).toEqual([{ text: 'Your order is on its way.\nIt should arrive Friday.', tools: ['get_order', 'notify'] }, { text: 'Anything else?', tools: [] }]);
    expect(r.effects).toEqual([{ seq: 1, kind: 'email.send', site: 'tool', primitiveId: 'prim_1' }, { seq: 2, kind: 'db.write', site: 'workflow', primitiveId: null }]);
    expect(parseTestSessionStdout()).toEqual({ replies: [], effects: [], sessionId: null });
  });
  test('transcript markdown', () => {
    const base = { at: '2026-10-07T14:20:00Z', thread: 'qa-x', player: 'p', user: 'hi', seconds: 6.6, reply: 'hello', toolCalls: null, error: null };
    expect(renderTranscriptTurn(base)).toBe('### User\n<!-- at 2026-10-07T14:20:00Z thread qa-x player p -->\nhi\n\n### Agent (7s)\nhello\n\n');
    const md = renderTranscriptTurn({ ...base, toolCalls: [{ name: 'a' }], error: { code: 'LUA_EXIT_1', message: 'bad' } });
    expect(md).toMatch(/<details><summary>tool calls/);
    expect(md).toMatch(/> error: LUA_EXIT_1 bad/);
  });
});

describe('testSessionApi', () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (url.endsWith('/sessions')) return resp({ success: true, data: { id: 'sess_9' } });
    if (url.endsWith('/chat')) return resp({ data: { text: 'hello', toolsUsed: ['a', 'b'] } });
    if (url.endsWith('/effects')) return resp({ data: { effects: [{ seq: 1, kind: 'k', site: 's' }] } });
    return resp({ success: true });
  };
  const deps = { resolveBearer: async () => 't', fetch };
  test('open, chat, effects, close hit the documented routes', async () => {
    expect(await testSessionApi.open('agent_x', 4, deps)).toBe('sess_9');
    expect(await testSessionApi.chat('agent_x', 4, 'sess_9', 'hi', 'qa-t', deps)).toEqual({ text: 'hello', toolsUsed: ['a', 'b'] });
    expect(await testSessionApi.effects('agent_x', 4, 'sess_9', deps)).toHaveLength(1);
    await testSessionApi.close('agent_x', 4, 'sess_9', deps);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /developer/agents/agent_x/versions/4/sessions',
      'POST /developer/agents/agent_x/versions/4/sessions/sess_9/chat',
      'GET /developer/agents/agent_x/versions/4/sessions/sess_9/effects',
      'POST /developer/agents/agent_x/versions/4/sessions/sess_9/close',
    ]);
    expect(JSON.parse(calls[0].body)).toEqual({ testTraffic: true });
    expect(JSON.parse(calls[1].body)).toEqual({ prompt: 'hi', threadId: 'qa-t' });
  });
  test('missing id, empty bodies and no thread', async () => {
    await expect(testSessionApi.open('a', 1, { resolveBearer: async () => 't', fetch: async () => resp({ data: {} }) })).rejects.toMatchObject({ code: 'PLATFORM' });
    const empty = { resolveBearer: async () => 't', fetch: async () => resp({}) };
    expect(await testSessionApi.chat('a', 1, 's', 'p', null, empty)).toEqual({ text: '', toolsUsed: [] });
    expect(await testSessionApi.effects('a', 1, 's', empty)).toEqual([]);
  });
});

describe('start-run', () => {
  test('refuses before the gates are stamped', async () => {
    const s = await ready({ stateOver: { gates: { discovery: null, questions: null, environment: null, plan: null } } });
    const { code, t } = await start(s, baseDeps());
    expect(code).toBe(3);
    expect(t.json().code).toBe('GATE_MISSING');
  });
  test('creates a valid run record with a thread and a player', async () => {
    const s = await ready();
    const { code, t } = await start(s, baseDeps());
    expect(code).toBe(0);
    expect(t.json()).toMatchObject({ ok: true, folder: join('runs', 'icp-01', 'r1'), thread: TH, player: PLAYER, testSessionId: null });
    const rec = await readJson(join(s.runDir, 'runs', 'icp-01', 'r1', 'run-record.json'));
    expect(validate('run-record', rec)).toEqual({ ok: true });
    expect(rec).toMatchObject({ model: 'sonnet', kind: 'icp', status: 'running', turns: 0 });
    expect((await readJson(join(s.runDir, 'state.json'))).history.at(-1).event).toBe('start-run');
  });
  test('a second start for the same run is refused (a second writer is contamination)', async () => {
    const s = await ready();
    await start(s, baseDeps());
    const again = await start(s, baseDeps());
    expect(again.code).toBe(3);
    expect(again.t.json().code).toBe('RUN_EXISTS');
    const attempt2 = await start(s, baseDeps(), ['--attempt', '2']);
    expect(attempt2.code).toBe(0);
    expect(attempt2.t.json().thread).toBe('qa-9f3c-icp-01-r1-a2-cdcdcd');
  });
  test('unknown card is a usage error; red team defaults to opus', async () => {
    const s = await ready({ cards: ['icp-01', 'rt-01'] });
    const t = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliStartRun(['--run-dir', s.runDir, '--card', 'icp-77', '--run', '1'], t.io, baseDeps())).toBe(2);
    const t2 = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliStartRun(['--run-dir', s.runDir, '--card', 'rt-01', '--run', '1'], t2.io, baseDeps())).toBe(0);
    expect((await loadRecord(s.runDir, { card: 'rt-01', run: 1 })).rec.model).toBe('opus');
    const t3 = mkio({ cwd: s.projectDir, env: s.env });
    await cliStartRun(['--run-dir', s.runDir, '--card', 'icp-01', '--run', '2', '--model', 'opus'], t3.io, baseDeps());
    expect((await loadRecord(s.runDir, { card: 'icp-01', run: 2 })).rec.model).toBe('opus');
  });
  test('production needs the consent token', async () => {
    const consent = consentStamp('abcdefabcdef');
    const s = await ready({
      runOver: { environment: { kind: 'production', agentVersion: null, testSession: null, logEnvironment: 'production' } },
      stateOver: { gates: { ...stateJson().gates, environment: { at: 'x', summary: 's', productionConsent: consent } } },
    });
    expect((await start(s, baseDeps())).code).toBe(3);
    expect((await start(s, baseDeps(), ['--production-consent', 'wrongwrongwr'])).code).toBe(3);
    expect((await start(s, baseDeps(), ['--production-consent', 'abcdefabcdef'])).code).toBe(0);
  });
  test('staged: opens a test session; falls back to per-turn sessions when open fails', async () => {
    const env = { kind: 'staged', agentVersion: 4, testSession: true, logEnvironment: 'production' };
    const s = await ready({ runOver: { environment: env } });
    const okFetch = async () => resp({ data: { id: 'sess_77' } });
    const a = await start(s, baseDeps({ fetch: okFetch }));
    expect(a.t.json().testSessionId).toBe('sess_77');
    const s2 = await ready({ runOver: { environment: env } });
    const bad = await start(s2, baseDeps({ fetch: async () => resp({ message: 'no' }, 500) }));
    expect(bad.code).toBe(0);
    expect(bad.t.json().testSessionId).toBeNull();
    expect((await loadRecord(s2.runDir, { card: 'icp-01', run: 1 })).rec.notes).toMatch(/continuity unverified/);
    expect(bad.t.stderr()).toMatch(/falling back/);
  });
});

describe('record: sandbox', () => {
  const chat = (reply, extra = {}) => fakeSpawn(() => ({ code: 0, stdout: chatStdout(reply, { thread: TH, ...extra }) }));
  const histFetch = (calls = [{ name: 'get_order' }]) => async () => resp({ data: [
    { role: 'user', threadId: TH, content: [{ type: 'text', text: 'Where is order 1042?' }] },
    { role: 'assistant', threadId: TH, content: calls.map((c, i) => ({ type: 'tool-call', toolCallId: `c${i}`, toolName: c.name, input: {}, output: { status: 'shipped' } })) },
    { role: 'assistant', threadId: TH, content: 'Shipped.' },
  ] });

  test('sends one scrubbed turn, records turns.jsonl + transcript, tool calls from history', async () => {
    const s = await ready({ env: { LUA_API_KEY: 'api_super_secret', SECRET_X: 'shh' } });
    const spawn = chat('Your order shipped.');
    const deps = baseDeps({ spawn, fetch: histFetch() });
    await start(s, deps);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    const code = await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'Where is order 1042?'], t.io, deps);
    expect(code).toBe(0);
    expect(t.json()).toMatchObject({ ok: true, turn: 1, reply: 'Your order shipped.', toolCalls: 1, exitCode: 0 });
    const call = spawn.calls[0];
    expect(call.argv).toEqual(['chat', '--ci', '-e', 'sandbox', '-m', 'Where is order 1042?', '-t', TH]);
    expect(call.opts.env.LUA_API_KEY).toBeUndefined();
    expect(call.opts.env.SECRET_X).toBeUndefined();
    const rows = await readJsonl(join(s.runDir, 'runs', 'icp-01', 'r1', 'turns.jsonl'));
    expect(validate('turn', rows[0])).toEqual({ ok: true });
    expect(rows[0]).toMatchObject({ turn: 1, player: PLAYER, thread: TH, toolCallSource: 'history', env: { kind: 'sandbox' } });
    expect(rows[0].toolCalls[0].name).toBe('get_order');
    // the chat process window (inside the lock) is stored for the logs attribution
    expect(Date.parse(rows[0].chatAt)).toBeGreaterThanOrEqual(Date.parse(rows[0].at));
    expect(Date.parse(rows[0].chatEndedAt)).toBeLessThanOrEqual(Date.parse(rows[0].endedAt));
    expect(await readFile(join(s.runDir, 'runs', 'icp-01', 'r1', 'transcript.md'), 'utf8')).toMatch(/### User[\s\S]*Where is order 1042\?[\s\S]*### Agent/);
    expect((await loadRecord(s.runDir, { card: 'icp-01', run: 1 })).rec.turns).toBe(1);
    // the lock was released
    expect(await readFile(join(s.runDir, 'run.json'), 'utf8')).toContain(RUN_ID);
  });

  test('an unscoped history (no thread ids) is not trusted for tool calls', async () => {
    const s = await ready();
    const deps = baseDeps({ spawn: chat('ok'), fetch: async () => resp({ data: [{ role: 'user', content: 'Where is order 1042?' }, { role: 'assistant', content: [{ type: 'tool-call', toolName: 'get_order', output: { a: 1 } }] }] }) });
    await start(s, deps);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'Where is order 1042?'], t.io, deps);
    const row = (await readJsonl(join(s.runDir, 'runs', 'icp-01', 'r1', 'turns.jsonl')))[0];
    expect(row).toMatchObject({ toolCallSource: 'unavailable', toolCalls: null });
  });

  test('the history fetch is skipped when the CLI deadline is nearly spent; chat timeouts are clamped', async () => {
    const s = await ready();
    let clock = Date.parse('2026-10-07T14:20:00Z');
    const spawn = fakeSpawn(() => { clock += 106_000; return { code: 0, stdout: chatStdout('slow but fine', { thread: TH }) }; });
    const fetched = [];
    const deps = baseDeps({ spawn, now: () => new Date(clock), fetch: async (url) => { fetched.push(url); return resp({ data: [] }); } });
    await start(s, deps);
    fetched.length = 0;
    const t = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'hi'], t.io, deps)).toBe(0);
    expect(fetched).toEqual([]);
    expect((await readJsonl(join(s.runDir, 'runs', 'icp-01', 'r1', 'turns.jsonl')))[0].toolCallSource).toBe('unavailable');
  });

  test('turn numbers increase; message-file works; history unavailable leaves toolCallSource unavailable', async () => {
    const s = await ready();
    const deps = baseDeps({ spawn: chat('ok'), fetch: async () => resp({ message: 'no' }, 404) });
    await start(s, deps);
    await writeFile(join(s.projectDir, 'm.txt'), 'second message\n', 'utf8');
    const t1 = mkio({ cwd: s.projectDir, env: s.env });
    await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'first'], t1.io, deps);
    const t2 = mkio({ cwd: s.projectDir, env: s.env });
    await cliRecord([...START(s.runDir), '--player', PLAYER, '--message-file', 'm.txt'], t2.io, deps);
    expect(t2.json().turn).toBe(2);
    const rows = await readJsonl(join(s.runDir, 'runs', 'icp-01', 'r1', 'turns.jsonl'));
    expect(rows[1].user).toBe('second message');
    expect(rows[1].toolCallSource).toBe('unavailable');
    expect(rows[1].toolCalls).toBeNull();
  });

  test('player mismatch -> exit 3 and nothing is sent', async () => {
    const s = await ready();
    const spawn = chat('x');
    const deps = baseDeps({ spawn });
    await start(s, deps);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', 'someone-else', '--message', 'hi'], t.io, deps)).toBe(3);
    expect(t.json().code).toBe('PLAYER_MISMATCH');
    expect(spawn.calls).toHaveLength(0);
  });

  test('a real email or URL is refused with exit 3; fake data and phone warnings pass', async () => {
    const s = await ready();
    const spawn = chat('ok');
    const deps = baseDeps({ spawn, fetch: async () => resp({ data: [] }) });
    await start(s, deps);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'mail me at dana@gmail.com'], t.io, deps)).toBe(3);
    expect(t.json().code).toBe('REAL_EMAIL');
    const t2 = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'see https://evil.test/x'], t2.io, deps)).toBe(3);
    expect(t2.json().code).toBe('REAL_URL');
    expect(spawn.calls).toHaveLength(0);
    const t3 = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'mail dana@example.com or call 020 7946 0958'], t3.io, deps)).toBe(0);
    expect(t3.json().warnings).toEqual([{ kind: 'phone', value: '020 7946 0958' }]);
    const rows = await readJsonl(join(s.runDir, 'runs', 'icp-01', 'r1', 'turns.jsonl'));
    expect(rows[0].phoneWarnings).toEqual(['020 7946 0958']);
  });

  test('sandbox with LUA_API_KEY as the only credential is refused (exit 3)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qa-home-empty-'));
    const s = await scaffoldRun({});
    const env = { HOME: home, PATH: '/usr/bin', LUA_API_KEY: 'api_only_in_env' };
    const spawn = chat('x');
    const deps = baseDeps({ spawn });
    const t0 = mkio({ cwd: s.projectDir, env });
    await cliStartRun(START(s.runDir), t0.io, deps);
    const t = mkio({ cwd: s.projectDir, env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'hi'], t.io, deps)).toBe(3);
    expect(t.json().code).toBe('CREDENTIAL_ENV_ONLY');
    expect(spawn.calls).toHaveLength(0);
  });

  test('lock contention: SANDBOX_BUSY (exit 5), the turn is not sent and not recorded', async () => {
    const s = await ready();
    const spawn = chat('x');
    const deps = baseDeps({ spawn });
    await start(s, deps);
    const lock = join(s.projectDir, '.lua-qa', 'locks', 'sandbox-chat.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ at: new Date(clock).toISOString() }), 'utf8');
    const t = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'hi'], t.io, deps)).toBe(5);
    expect(t.json().code).toBe('SANDBOX_BUSY');
    expect(spawn.calls).toHaveLength(0);
    expect(await readJsonl(join(s.runDir, 'runs', 'icp-01', 'r1', 'turns.jsonl'))).toEqual([]);
  });

  test('secrets in the message and reply are redacted in the stored copies only', async () => {
    const s = await ready();
    const spawn = fakeSpawn(() => ({ code: 0, stdout: chatStdout('Your key sk_live_51Hf00fakefakefake is noted.', { thread: TH }) }));
    const deps = baseDeps({ spawn, fetch: async () => resp({ data: [] }) });
    await start(s, deps);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'my key is sk_live_51Hf00fakefakefake'], t.io, deps);
    expect(spawn.calls[0].argv[5]).toBe('my key is sk_live_51Hf00fakefakefake');
    const row = (await readJsonl(join(s.runDir, 'runs', 'icp-01', 'r1', 'turns.jsonl')))[0];
    expect(row.user).toBe('my key is [REDACTED:stripe-key]');
    expect(row.reply).toMatch(/\[REDACTED:stripe-key\]/);
    expect(row.redactions.map((x) => x.field).sort()).toEqual(['reply', 'user']);
    expect(t.stdout()).not.toMatch(/sk_live/);
  });

  test('exit 12 twice in a row sets stop; auth failure sets stop; a failed turn exits 5 but is recorded', async () => {
    const s = await ready();
    const spawn = fakeSpawn(() => ({ code: 12, stdout: '', stderr: 'provider refused' }));
    const deps = baseDeps({ spawn });
    await start(s, deps);
    const t1 = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'hi'], t1.io, deps)).toBe(5);
    expect(t1.json()).toMatchObject({ ok: false, code: 'LUA_PROVIDER_REFUSED', exitCode: 12, turn: 1 });
    expect(t1.json().stop).toBeUndefined();
    const t2 = mkio({ cwd: s.projectDir, env: s.env });
    await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'hi again'], t2.io, deps);
    expect(t2.json().stop).toMatch(/refused twice/);
    const spawn9 = fakeSpawn(() => ({ code: 9 }));
    const s2 = await ready();
    const d2 = baseDeps({ spawn: spawn9 });
    await start(s2, d2);
    const t3 = mkio({ cwd: s2.projectDir, env: s2.env });
    expect(await cliRecord([...START(s2.runDir), '--player', PLAYER, '--message', 'hi'], t3.io, d2)).toBe(5);
    expect(t3.json().stop).toMatch(/auth failure/);
    const spawn1 = fakeSpawn(() => ({ code: 1 }));
    const s3 = await ready();
    const d3 = baseDeps({ spawn: spawn1 });
    await start(s3, d3);
    const t4 = mkio({ cwd: s3.projectDir, env: s3.env });
    await cliRecord([...START(s3.runDir), '--player', PLAYER, '--message', 'hi'], t4.io, d3);
    expect(t4.json().code).toBe('LUA_EXIT_1');
  });

  test('tool calls with a side effect are added to the ledger and the run record', async () => {
    const s = await ready();
    const deps = baseDeps({ spawn: chat('Cancelled.'), fetch: async () => resp({ data: [
      { role: 'user', threadId: TH, content: 'Cancel order 1042' },
      { role: 'assistant', threadId: TH, content: [{ type: 'tool-call', toolName: 'cancel_order', input: {}, output: { ok: true } }, { type: 'tool-call', toolName: 'get_order', input: {}, output: {} }, { type: 'tool-call', toolName: 'mystery_tool', input: {}, output: {} }] },
    ] }) });
    await start(s, deps);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'Cancel order 1042'], t.io, deps);
    const ledger = await readJsonl(join(s.runDir, 'ledger.jsonl'));
    expect(ledger.map((r) => r.kind)).toEqual(['cancel_order']);
    expect(ledger[0]).toMatchObject({ source: 'tool-call', cleanup: 'manual' });
    expect((await loadRecord(s.runDir, { card: 'icp-01', run: 1 })).rec.sideEffectRefs).toHaveLength(1);
  });

  test('a closed run refuses more turns; usage errors for message flags', async () => {
    const s = await ready();
    const deps = baseDeps({ spawn: chat('x'), fetch: async () => resp({ data: [] }) });
    await start(s, deps);
    const t0 = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER], t0.io, deps)).toBe(2);
    const t00 = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'a', '--message-file', 'b'], t00.io, deps)).toBe(2);
    const t01 = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message-file', 'missing.txt'], t01.io, deps)).toBe(2);
    await cliFinishRun([...START(s.runDir), '--player', PLAYER], mkio({ cwd: s.projectDir }).io, deps);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'late'], t.io, deps)).toBe(3);
    expect(t.json().code).toBe('RUN_CLOSED');
  });

  test('post-processed replies are recorded with the streamed draft', async () => {
    const s = await ready();
    const deps = baseDeps({ spawn: chat('raw draft', { post: 'final text' }), fetch: async () => resp({ data: [] }) });
    await start(s, deps);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'hi'], t.io, deps);
    const row = (await readJsonl(join(s.runDir, 'runs', 'icp-01', 'r1', 'turns.jsonl')))[0];
    expect(row).toMatchObject({ reply: 'final text', streamed: 'raw draft', postprocessed: true });
  });
});

describe('record: production, staged and the fallback paths', () => {
  const consent = consentStamp('abcdefabcdef');
  const prodOver = (envOver) => ({
    runOver: { environment: { kind: 'production', agentVersion: null, testSession: null, logEnvironment: 'production', ...envOver } },
    stateOver: { gates: { ...stateJson().gates, environment: { at: 'x', summary: 's', productionConsent: consent } } },
  });

  test('production: -e production, no lock, token required on every call', async () => {
    const s = await ready(prodOver());
    const spawn = fakeSpawn(() => ({ code: 0, stdout: chatStdout('hello', { thread: TH }) }));
    const deps = baseDeps({ spawn, fetch: async () => resp({ data: [] }) });
    await start(s, deps, ['--production-consent', 'abcdefabcdef']);
    const t0 = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'hi'], t0.io, deps)).toBe(3);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'hi', '--production-consent', 'abcdefabcdef'], t.io, deps)).toBe(0);
    expect(spawn.calls[0].argv.slice(0, 4)).toEqual(['chat', '--ci', '-e', 'production']);
  });

  test('staged + test session over REST: effects go to the ledger, tool names only', async () => {
    const env = { kind: 'staged', agentVersion: 4, testSession: true, logEnvironment: 'production' };
    const s = await ready({ runOver: { environment: env } });
    const seenEffects = [[{ seq: 1, kind: 'email.send', site: 'tool', primitiveId: 'p1' }], [{ seq: 1, kind: 'email.send', site: 'tool', primitiveId: 'p1' }, { seq: 2, kind: 'db.write', site: 'workflow' }]];
    let effectCall = 0;
    const fetch = async (url) => {
      if (url.endsWith('/sessions')) return resp({ data: { id: 'sess_5' } });
      if (url.endsWith('/chat')) return resp({ data: { text: 'sent it', toolsUsed: ['cancel_order'] } });
      if (url.endsWith('/effects')) return resp({ data: { effects: seenEffects[effectCall++] } });
      return resp({ success: true });
    };
    const deps = baseDeps({ fetch });
    await start(s, deps);
    const t1 = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'do it'], t1.io, deps)).toBe(0);
    const t2 = mkio({ cwd: s.projectDir, env: s.env });
    await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'and more'], t2.io, deps);
    const rows = await readJsonl(join(s.runDir, 'runs', 'icp-01', 'r1', 'turns.jsonl'));
    expect(rows[0]).toMatchObject({ toolCallSource: 'test-session', env: { kind: 'staged', testSession: true } });
    expect(rows[0].effects).toHaveLength(1);
    expect(rows[1].effects).toEqual([{ seq: 2, kind: 'db.write', site: 'workflow', primitiveId: null }]);
    const ledger = await readJsonl(join(s.runDir, 'ledger.jsonl'));
    expect(ledger.filter((r) => r.source === 'test-session-effect').map((r) => r.kind)).toEqual(['email.send', 'db.write']);
    expect(ledger.filter((r) => r.source === 'tool-call')).toHaveLength(2);
    expect(ledger.find((r) => r.source === 'tool-call').cleanup).toBe('none');
  });

  test('staged: with almost no time left the effects call is skipped, not hung', async () => {
    const env = { kind: 'staged', agentVersion: 4, testSession: true, logEnvironment: 'production' };
    const s = await ready({ runOver: { environment: env } });
    let clock = Date.parse('2026-10-07T14:20:00Z');
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      if (url.endsWith('/sessions')) return resp({ data: { id: 'sess_5' } });
      if (url.endsWith('/chat')) { clock += 108_000; return resp({ data: { text: 'late reply' } }); }
      return resp({});
    };
    const deps = baseDeps({ fetch, now: () => new Date(clock) });
    await start(s, deps);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'x'], t.io, deps)).toBe(0);
    expect(urls.some((u) => u.endsWith('/effects'))).toBe(false);
  });

  test('staged: effects endpoint failure is tolerated', async () => {
    const env = { kind: 'staged', agentVersion: 4, testSession: true, logEnvironment: 'production' };
    const s = await ready({ runOver: { environment: env } });
    const fetch = async (url) => {
      if (url.endsWith('/sessions')) return resp({ data: { id: 'sess_5' } });
      if (url.endsWith('/chat')) return resp({ data: { text: 'hi' } });
      return resp({ message: 'no' }, 403);
    };
    const deps = baseDeps({ fetch });
    await start(s, deps);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'x'], t.io, deps)).toBe(0);
    expect((await readJsonl(join(s.runDir, 'runs', 'icp-01', 'r1', 'turns.jsonl')))[0].effects).toEqual([]);
  });

  test('staged fallback: lua chat --agent-version --test-session per turn', async () => {
    const env = { kind: 'staged', agentVersion: 4, testSession: true, logEnvironment: 'production' };
    const s = await ready({ runOver: { environment: env } });
    const spawn = fakeSpawn(() => ({ code: 0, stdout: '\u{1F9EA} Test session s1 on agent version v4\n\n\u{1F916} Done.\n   tools: cancel_order\nRecorded 1 effect(s):\n  #1 email.send (tool, p1)\n' }));
    const deps = baseDeps({ spawn, fetch: async () => resp({ message: 'down' }, 500) });
    await start(s, deps);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'x'], t.io, deps)).toBe(0);
    expect(spawn.calls[0].argv).toEqual(['chat', '--ci', '--agent-version', '4', '--test-session', '-m', 'x', '-t', TH]);
    const row = (await readJsonl(join(s.runDir, 'runs', 'icp-01', 'r1', 'turns.jsonl')))[0];
    expect(row).toMatchObject({ reply: 'Done.', toolCallSource: 'test-session' });
    expect(row.effects).toHaveLength(1);
  });

  test('staged without a test session: real chat with --agent-version, needs the token', async () => {
    const env = { kind: 'staged', agentVersion: 4, testSession: false, logEnvironment: 'production' };
    const s = await ready({ ...prodOver(), runOver: { environment: env } });
    const spawn = fakeSpawn(() => ({ code: 0, stdout: chatStdout('real reply', { thread: TH }) }));
    const deps = baseDeps({ spawn, fetch: async () => resp({ data: [] }) });
    await start(s, deps, ['--production-consent', 'abcdefabcdef']);
    const t = mkio({ cwd: s.projectDir, env: s.env });
    await cliRecord([...START(s.runDir), '--player', PLAYER, '--message', 'x', '--production-consent', 'abcdefabcdef'], t.io, deps);
    expect(spawn.calls[0].argv).toEqual(['chat', '--ci', '--agent-version', '4', '-m', 'x', '-t', TH]);
  });
});

describe('finish-run', () => {
  test('closes the record, ingests the player report into the ledger, closes the session', async () => {
    const env = { kind: 'staged', agentVersion: 4, testSession: true, logEnvironment: 'production' };
    const s = await ready({ runOver: { environment: env } });
    const closes = [];
    const fetch = async (url) => {
      if (url.endsWith('/sessions')) return resp({ data: { id: 'sess_5' } });
      if (url.endsWith('/close')) { closes.push(url); return resp({ success: true }); }
      return resp({});
    };
    const deps = baseDeps({ fetch });
    await start(s, deps);
    await writeFile(join(s.projectDir, 'report.json'), JSON.stringify([{ turn: 2, kind: 'email-claimed', detail: 'agent said it emailed the customer' }, { nope: 1 }, null]), 'utf8');
    const t = mkio({ cwd: s.projectDir, env: s.env });
    expect(await cliFinishRun([...START(s.runDir), '--player', PLAYER, '--player-report-file', 'report.json'], t.io, deps)).toBe(0);
    expect(t.json()).toMatchObject({ status: 'done', sessionClosed: true, playerReportItems: 1 });
    expect(closes).toHaveLength(1);
    const { rec } = await loadRecord(s.runDir, { card: 'icp-01', run: 1 });
    expect(rec).toMatchObject({ status: 'done', abortReason: null });
    expect(rec.endedAt).toBeTruthy();
    expect(rec.sideEffectRefs).toEqual(['L-0001']);
    expect((await readJsonl(join(s.runDir, 'ledger.jsonl')))[0]).toMatchObject({ source: 'player-report', cleanup: 'manual', turn: 2 });
  });
  test('aborted with a reason; unknown reasons become player-stopped; bad report ignored; close failure noted', async () => {
    const env = { kind: 'staged', agentVersion: 4, testSession: true, logEnvironment: 'production' };
    const s = await ready({ runOver: { environment: env } });
    const fetch = async (url) => (url.endsWith('/sessions') ? resp({ data: { id: 's' } }) : resp({ message: 'no' }, 500));
    const deps = baseDeps({ fetch });
    await start(s, deps);
    await writeFile(join(s.projectDir, 'report.json'), '{not an array}', 'utf8');
    const t = mkio({ cwd: s.projectDir, env: s.env });
    await cliFinishRun([...START(s.runDir), '--player', PLAYER, '--status', 'aborted', '--reason', 'safety-refusal', '--player-report-file', 'report.json'], t.io, deps);
    expect(t.json()).toMatchObject({ status: 'aborted', sessionClosed: false });
    expect(t.stderr()).toMatch(/ignored/);
    expect((await loadRecord(s.runDir, { card: 'icp-01', run: 1 })).rec.abortReason).toBe('safety-refusal');
    const s2 = await ready();
    await start(s2, baseDeps());
    await cliFinishRun([...START(s2.runDir), '--player', PLAYER, '--status', 'aborted', '--reason', 'whatever'], mkio({ cwd: s2.projectDir }).io, baseDeps());
    expect((await loadRecord(s2.runDir, { card: 'icp-01', run: 1 })).rec.abortReason).toBe('player-stopped');
  });
  test('wrong player and unknown run are refused', async () => {
    const s = await ready();
    await start(s, baseDeps());
    const t = mkio({ cwd: s.projectDir });
    expect(await cliFinishRun([...START(s.runDir), '--player', 'nope'], t.io, baseDeps())).toBe(3);
    const t2 = mkio({ cwd: s.projectDir });
    expect(await cliFinishRun(['--run-dir', s.runDir, '--card', 'icp-09', '--run', '1', '--player', 'x'], t2.io, baseDeps())).toBe(2);
    expect(t2.json().code).toBe('NO_RUN_RECORD');
  });
  test('selectorPaths names attempt folders', () => {
    expect(selectorPaths('/r', { card: 'icp-01', run: 2, attempt: 2 }).dir).toBe(join('/r', 'runs', 'icp-01', 'r2-a2'));
    expect(runJson('/p').runId).toBe(RUN_ID);
    expect(wj).toBeDefined();
    expect(flowModel().skills).toHaveLength(1);
  });
});

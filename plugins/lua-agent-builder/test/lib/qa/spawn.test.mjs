import { classifyLuaExit, envPolicyFor, runLua } from '../../../lib/qa/spawn.mjs';
import { fakeSpawn } from './fixtures/runtime-helpers.mjs';

const THREAD = 'qa-9f3c-icp-03-r2-1a2b3c';
const SECRET_ENV = { PATH: '/usr/bin', HOME: '/home/qa', LUA_API_KEY: 'api_secret_value', SECRET_X: 'shh', OPENAI_API_KEY: 'sk-x' };

describe('runLua', () => {
  test('chat runs with a scrubbed env that never carries LUA_API_KEY', async () => {
    const spawn = fakeSpawn(() => ({ code: 0, stdout: 'hi' }));
    const res = await runLua(['chat', '--ci', '-e', 'sandbox', '-m', 'hello', '-t', THREAD], { cwd: '/p', env: SECRET_ENV, deps: { spawn } });
    expect(res).toMatchObject({ exitCode: 0, stdout: 'hi', timedOut: false, env: 'scrub' });
    const call = spawn.calls[0];
    expect(call.cmd).toBe('lua');
    expect(call.opts.env).toEqual({ PATH: '/usr/bin', HOME: '/home/qa', LUA_NO_HINTS: '1' });
    expect(call.opts.shell).toBe(false);
    expect(call.opts.cwd).toBe('/p');
  });

  test.each([
    [['compile', '--ci']],
    [['status', '--json', '--ci']],
    [['version', 'list', '--json', '--ci']],
    [['workflows', 'list', '--json', '--ci']],
    [['--version']],
  ])('%j is scrubbed too', async (argv) => {
    const spawn = fakeSpawn(() => ({ code: 0 }));
    await runLua(argv, { env: SECRET_ENV, deps: { spawn } });
    expect(spawn.calls[0].opts.env.LUA_API_KEY).toBeUndefined();
    expect(spawn.calls[0].opts.env.SECRET_X).toBeUndefined();
  });

  test('lua test keeps the full env (tools may need shell-held secrets)', async () => {
    const spawn = fakeSpawn(() => ({ code: 0 }));
    const res = await runLua(['test', '--ci', 'skill', '--name', 'get_order', '--input', '{}', '--json'], { env: SECRET_ENV, deps: { spawn } });
    expect(res.env).toBe('passthrough');
    expect(spawn.calls[0].opts.env.SECRET_X).toBe('shh');
  });

  test('a denied argv never reaches spawn', async () => {
    const spawn = fakeSpawn(() => ({ code: 0 }));
    await expect(runLua(['deploy'], { deps: { spawn } })).rejects.toMatchObject({ code: 'LUA_ARGV_DENIED', exitCode: 3 });
    expect(spawn.calls).toHaveLength(0);
  });

  test('redacts and truncates the logged argv; measures ms with the injected clock', async () => {
    const spawn = fakeSpawn(() => ({ code: 0 }));
    let t = 1000;
    const now = () => new Date((t += 250));
    const long = `${'a'.repeat(300)}`;
    const res = await runLua(['chat', '--ci', '-e', 'sandbox', '-m', `${long} sk_live_abcdefgh1234`, '-t', THREAD], { deps: { spawn, now } });
    expect(res.argvRedacted[5].length).toBeLessThan(210);
    expect(res.ms).toBe(250);
    expect([res.startedAt, res.endedAt]).toEqual([new Date(1250).toISOString(), new Date(1500).toISOString()]);
  });

  test('timeouts are reported without throwing', async () => {
    const spawn = fakeSpawn(() => ({ hang: true }));
    const res = await runLua(['status', '--json', '--ci'], { timeoutMs: 20, deps: { spawn } });
    expect(res.timedOut).toBe(true);
  });
});

describe('hints are silenced without leaking the parent env', () => {
  test('LUA_NO_HINTS is a fixed constant for scrubbed runs and absent for lua test', async () => {
    const spawn = fakeSpawn(() => ({ code: 0 }));
    await runLua(['status', '--json', '--ci'], { env: { PATH: '/bin', LUA_NO_HINTS: '0' }, deps: { spawn } });
    expect(spawn.calls[0].opts.env.LUA_NO_HINTS).toBe('1');
    await runLua(['test', '--ci', 'skill', '--name', 'x', '--input', '{}', '--json'], { env: { PATH: '/bin' }, deps: { spawn } });
    expect(spawn.calls[1].opts.env.LUA_NO_HINTS).toBeUndefined();
  });
});

describe('envPolicyFor', () => {
  test('only test passes the env through', () => {
    expect(envPolicyFor(['test', '--ci'])).toBe('passthrough');
    expect(envPolicyFor(['chat'])).toBe('scrub');
    expect(envPolicyFor(['logs'])).toBe('scrub');
  });
});

describe('classifyLuaExit', () => {
  test.each([
    [{ timedOut: true }, 'LUA_TIMEOUT', 5],
    [{ exitCode: -1, stderr: 'spawn lua ENOENT' }, 'LUA_MISSING', 4],
    [{ exitCode: 9 }, 'LUA_AUTH', 5],
    [{ exitCode: 10 }, 'LUA_AUTH', 5],
    [{ exitCode: 11 }, 'LUA_AUTH', 5],
    [{ exitCode: 12 }, 'LUA_PROVIDER_REFUSED', 5],
  ])('%j', (result, code, exit) => {
    expect(classifyLuaExit(result)).toMatchObject({ code, exitCode: exit });
  });
  test('ordinary exits are not classified', () => {
    expect(classifyLuaExit({ exitCode: 0 })).toBeNull();
    expect(classifyLuaExit({ exitCode: 1 })).toBeNull();
    expect(classifyLuaExit({ exitCode: -1 })).toBeNull();
  });
});

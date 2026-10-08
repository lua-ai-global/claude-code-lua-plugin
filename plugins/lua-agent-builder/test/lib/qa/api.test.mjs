import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_VERSION, detectCredential, qaApiRequest, resolveBearer } from '../../../lib/qa/api.mjs';

const resp = (status, body, text) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => text ?? JSON.stringify(body) });
const deps = (fetch) => ({ resolveBearer: async () => 'bearer-token-value', fetch });

describe('qaApiRequest', () => {
  test('sends bearer, client header, query and JSON body; returns the parsed body', async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, init }); return resp(200, { data: [1] }); };
    const out = await qaApiRequest('/chat/history/agent_x', { method: 'POST', body: { a: 1 }, query: { threadId: 'qa-1' }, deps: deps(fetch), baseUrl: 'https://api.example.com/' });
    expect(out).toEqual({ data: [1] });
    expect(calls[0].url).toBe('https://api.example.com/chat/history/agent_x?threadId=qa-1');
    expect(calls[0].init.headers.Authorization).toBe('Bearer bearer-token-value');
    expect(calls[0].init.headers['X-Lua-Client']).toBe(`claude-plugin-qa/${PLUGIN_VERSION}`);
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
  test('a GET has no body; default base URL', async () => {
    let seen;
    const fetch = async (url, init) => { seen = { url, init }; return resp(200, {}); };
    await qaApiRequest('/x', { deps: deps(fetch) });
    expect(seen.init.body).toBeUndefined();
    expect(seen.url).toMatch(/^https:\/\/api\.heylua\.ai\/x$|\/x$/);
  });
  test.each([
    [401, 'AUTH_STALE'],
    [403, 'FORBIDDEN'],
    [500, 'PLATFORM'],
    [404, 'API_404'],
  ])('status %i -> %s (exit 5)', async (status, code) => {
    const fetch = async () => resp(status, { error: { message: 'nope' } });
    await expect(qaApiRequest('/x', { deps: deps(fetch) })).rejects.toMatchObject({ code, exitCode: 5 });
  });
  test('error bodies: structured, plain text', async () => {
    await expect(qaApiRequest('/x', { deps: deps(async () => resp(400, { message: 'bad thing' })) })).rejects.toMatchObject({ message: expect.stringMatching(/bad thing/), status: 400 });
    await expect(qaApiRequest('/x', { deps: deps(async () => resp(502, null, '<html>bad gateway</html>')) })).rejects.toMatchObject({ code: 'PLATFORM' });
  });
  test('network errors and timeouts become PLATFORM errors', async () => {
    await expect(qaApiRequest('/x', { deps: deps(async () => { throw new Error('socket hang up'); }) })).rejects.toMatchObject({ code: 'PLATFORM', message: expect.stringMatching(/network error/) });
    const slow = (_u, init) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
    await expect(qaApiRequest('/x', { deps: deps(slow), timeoutMs: 10 })).rejects.toMatchObject({ code: 'PLATFORM', message: expect.stringMatching(/did not respond/) });
  });
});

describe('resolveBearer', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  test('uses the credential chain; a stray LUA_API_KEY resolves', async () => {
    process.env.LUA_API_KEY = 'api_from_env';
    expect(await resolveBearer()).toBe('api_from_env');
  });
  test('no credential -> NO_CREDENTIAL (exit 4)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qa-nocred-'));
    process.env = { PATH: process.env.PATH, HOME: home, LUA_CREDENTIALS_PATH: join(home, 'none'), LUA_SESSIONS_DIR: join(home, 'none-s') };
    const cwd = process.cwd();
    process.chdir(home);
    try {
      await expect(resolveBearer()).rejects.toMatchObject({ code: 'NO_CREDENTIAL', exitCode: 4 });
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('detectCredential', () => {
  const mk = async () => {
    const home = await mkdtemp(join(tmpdir(), 'qa-cred-'));
    const cwd = await mkdtemp(join(tmpdir(), 'qa-cwd-'));
    return { home, cwd };
  };
  test('none', async () => {
    const { home, cwd } = await mk();
    expect(await detectCredential({ env: {}, cwd, home })).toMatchObject({ source: 'none', hasStoredCredential: false, dotenvKeys: [] });
  });
  test('env wins; stored credential is noticed separately', async () => {
    const { home, cwd } = await mk();
    expect(await detectCredential({ env: { LUA_API_KEY: ' api_x ' }, cwd, home })).toMatchObject({ source: 'env', hasStoredCredential: false });
    await mkdir(join(home, '.lua-cli', 'sessions'), { recursive: true });
    await writeFile(join(home, '.lua-cli', 'sessions', 'abc.json'), '{}', 'utf8');
    expect(await detectCredential({ env: { LUA_API_KEY: 'k' }, cwd, home })).toMatchObject({ source: 'env', hasStoredCredential: true });
    expect(await detectCredential({ env: {}, cwd, home })).toMatchObject({ source: 'session', hasStoredCredential: true });
  });
  test('credentials file', async () => {
    const { home, cwd } = await mk();
    await mkdir(join(home, '.lua-cli'), { recursive: true });
    await writeFile(join(home, '.lua-cli', 'credentials'), 'api_x', 'utf8');
    expect(await detectCredential({ env: {}, cwd, home })).toMatchObject({ source: 'credentials-file', hasStoredCredential: true });
  });
  test('.env: key names only, LUA_API_KEY detected', async () => {
    const { home, cwd } = await mk();
    await writeFile(join(cwd, '.env'), 'OPENAI_API_KEY=sk-abc\nexport LUA_API_KEY=api_x\n# comment\n  FOO = bar\n', 'utf8');
    const r = await detectCredential({ env: {}, cwd, home });
    expect(r.source).toBe('dotenv');
    expect(r.dotenvKeys.sort()).toEqual(['FOO', 'LUA_API_KEY', 'OPENAI_API_KEY']);
    expect(r.hasLuaApiKeyInDotenv).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/sk-abc/);
  });
  test('LUA_CREDENTIALS_PATH and LUA_SESSIONS_DIR are honoured', async () => {
    const { home, cwd } = await mk();
    const sess = join(home, 's');
    await mkdir(sess, { recursive: true });
    await writeFile(join(sess, 'x.json'), '{}', 'utf8');
    expect((await detectCredential({ env: { LUA_CREDENTIALS_PATH: join(home, 'nope'), LUA_SESSIONS_DIR: sess }, cwd, home })).source).toBe('session');
  });
  test('defaults to process.cwd and the real home without throwing', async () => {
    const r = await detectCredential({ env: {} });
    expect(['none', 'session', 'credentials-file', 'dotenv']).toContain(r.source);
  });
});

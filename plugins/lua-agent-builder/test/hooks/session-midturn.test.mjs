// 1.20.10 — mid-turn delivery (LUA_BS_MIDTURN=1). The hook posts the finished tool call's id, with the take route's
// current secret (read fresh from the 0600 file the pod names; never in the env), to the pod's loopback route and
// hands Claude what the pod answers as PostToolUse context. Off unless every switch is set; silent on any failure
// (the message then reaches Claude as its next turn).

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decide,
  midturnSecret,
  midturnTakeUrl,
  MIDTURN_SECRET_HEADER,
  MIDTURN_TAKE_TIMEOUT_MS,
} from '../../hooks/session-midturn.mjs';
import { runHook } from '../helpers/run-hook.mjs';

const URL_OK = 'http://127.0.0.1:4100/midturn/take';
const SECRET = 'a'.repeat(64);
const SECRET_FILE = '/workspace/.session/midturn-secret';
const ON = { LUA_BUILD_SESSION: '1', LUA_BS_MIDTURN: '1', LUA_BS_MIDTURN_URL: URL_OK, LUA_BS_MIDTURN_SECRET_FILE: SECRET_FILE };
const readOk = () => `${SECRET}\n`;
const FENCED = 'The user sent this message while you were working:\n<lua-user-message-midturn>\nadd D\n</lua-user-message-midturn>';

const answer = (status, body) => async () => ({ status, json: async () => body });

describe('session-midturn: when it is on', () => {
  test('only with LUA_BUILD_SESSION, LUA_BS_MIDTURN=1 and a loopback take URL', () => {
    expect(midturnTakeUrl(ON)).toBe(URL_OK);
    for (const env of [
      {},
      { ...ON, LUA_BUILD_SESSION: '' },
      { ...ON, LUA_BS_MIDTURN: 'true' },
      { ...ON, LUA_BS_MIDTURN: '0' },
      { ...ON, LUA_BS_MIDTURN_URL: '' },
      { LUA_BUILD_SESSION: '1', LUA_BS_MIDTURN: '1' },
      { ...ON, LUA_BS_MIDTURN_URL: 'http://evil.example/midturn/take' },
      { ...ON, LUA_BS_MIDTURN_URL: 'https://127.0.0.1:4100/midturn/take' },
      { ...ON, LUA_BS_MIDTURN_URL: 'http://localhost:4100/midturn/take' },
      { ...ON, LUA_BS_MIDTURN_URL: 'http://127.0.0.1:4100/other' },
      { ...ON, LUA_BS_MIDTURN_URL: 'not a url' },
    ]) {
      expect(midturnTakeUrl(env)).toBeNull();
    }
  });

  test('the secret: read fresh from an absolute file path, hex only, never from the env itself', () => {
    expect(midturnSecret(ON, readOk)).toBe(SECRET);
    expect(midturnSecret({ ...ON, LUA_BS_MIDTURN_SECRET_FILE: '' }, readOk)).toBeNull();
    expect(midturnSecret({ LUA_BUILD_SESSION: '1' }, readOk)).toBeNull();
    expect(midturnSecret({ ...ON, LUA_BS_MIDTURN_SECRET_FILE: 'relative/secret' }, readOk)).toBeNull();
    expect(midturnSecret(ON, () => 'not hex!')).toBeNull();
    expect(midturnSecret(ON, () => 'abc')).toBeNull();
    expect(
      midturnSecret(ON, () => {
        throw new Error('ENOENT');
      })
    ).toBeNull();
  });

  test('the default reader reads the real file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'midturn-')), 'midturn-secret');
    writeFileSync(file, `${SECRET}\n`, { mode: 0o600 });
    expect(midturnSecret({ ...ON, LUA_BS_MIDTURN_SECRET_FILE: file })).toBe(SECRET);
  });

  test('off: never calls anything', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return { status: 200, json: async () => ({ context: 'x' }) };
    };
    expect(await decide({ tool_use_id: 'toolu_1' }, {}, fetchFn, readOk)).toBeNull();
    expect(await decide({ tool_use_id: 'toolu_1' }, { LUA_BUILD_SESSION: '1' }, fetchFn, readOk)).toBeNull();
    // On, but no readable secret: nothing is sent.
    expect(await decide({ tool_use_id: 'toolu_1' }, ON, fetchFn, () => '')).toBeNull();
    expect(calls).toBe(0);
  });

  test('defaults: reads process.env (no switches here: off) and never needs a fetch', async () => {
    const saved = { ...process.env };
    try {
      for (const k of ['LUA_BUILD_SESSION', 'LUA_BS_MIDTURN', 'LUA_BS_MIDTURN_URL', 'LUA_BS_MIDTURN_SECRET_FILE'])
        delete process.env[k];
      expect(midturnTakeUrl()).toBeNull();
      expect(midturnSecret()).toBeNull();
      expect(await decide({ tool_use_id: 'toolu_1' })).toBeNull();
    } finally {
      process.env = saved;
    }
  });
});

describe('session-midturn: decide', () => {
  test('posts the tool id with the secret header and hands Claude the fenced messages', async () => {
    const seen = [];
    const fetchFn = async (url, init) => {
      seen.push({ url, init });
      return { status: 200, json: async () => ({ context: FENCED }) };
    };
    expect(await decide({ tool_use_id: 'toolu_1' }, ON, fetchFn, readOk)).toEqual({ warn: FENCED });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(URL_OK);
    expect(seen[0].url).not.toContain(SECRET);
    expect(seen[0].init.method).toBe('POST');
    expect(seen[0].init.headers[MIDTURN_SECRET_HEADER]).toBe(SECRET);
    expect(JSON.parse(seen[0].init.body)).toEqual({ toolUseId: 'toolu_1' });
  });

  test('nothing queued, refused, no tool id, an error or a bad answer: silent', async () => {
    expect(await decide({ tool_use_id: 'toolu_1' }, ON, answer(204), readOk)).toBeNull();
    expect(await decide({ tool_use_id: 'toolu_1' }, ON, answer(401), readOk)).toBeNull();
    expect(await decide({}, ON, answer(200, { context: FENCED }), readOk)).toBeNull();
    expect(await decide(null, ON, answer(200, { context: FENCED }), readOk)).toBeNull();
    expect(await decide({ tool_use_id: 'toolu_1' }, ON, answer(500, { context: FENCED }), readOk)).toBeNull();
    expect(await decide({ tool_use_id: 'toolu_1' }, ON, answer(200, { context: 7 }), readOk)).toBeNull();
    expect(await decide({ tool_use_id: 'toolu_1' }, ON, answer(200, { context: 'x'.repeat(200_001) }), readOk)).toBeNull();
    const throws = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await decide({ tool_use_id: 'toolu_1' }, ON, throws, readOk)).toBeNull();
  });

  test('gives up inside its timeout when the pod does not answer', async () => {
    const hang = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const t0 = Date.now();
    expect(await decide({ tool_use_id: 'toolu_1' }, ON, hang, readOk)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(MIDTURN_TAKE_TIMEOUT_MS + 1000);
  }, 10_000);
});

describe('session-midturn: as Claude Code runs it', () => {
  let server;
  let url;
  let secretFile;
  const bodies = [];
  beforeAll(async () => {
    secretFile = join(mkdtempSync(join(tmpdir(), 'midturn-')), 'midturn-secret');
    writeFileSync(secretFile, SECRET, { mode: 0o600 });
    server = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        if (req.headers[MIDTURN_SECRET_HEADER] !== SECRET) {
          res.writeHead(401);
          res.end();
          return;
        }
        bodies.push(JSON.parse(b));
        if (JSON.parse(b).toolUseId === 'toolu_1') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ context: FENCED }));
        } else {
          res.writeHead(204);
          res.end();
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}/midturn/take`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const env = () => ({
    LUA_BUILD_SESSION: '1',
    LUA_BS_MIDTURN: '1',
    LUA_BS_MIDTURN_URL: url,
    LUA_BS_MIDTURN_SECRET_FILE: secretFile,
  });

  test('prints the PostToolUse additionalContext envelope, exit 0, and never the secret', async () => {
    const r = await runHook(
      'session-midturn.mjs',
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'ls' } },
      { env: env() }
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: FENCED },
    });
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });

  test('nothing to hand over: no output, exit 0', async () => {
    const r = await runHook(
      'session-midturn.mjs',
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_2', tool_input: {} },
      { env: env() }
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(bodies.map((b) => b.toolUseId)).toEqual(['toolu_1', 'toolu_2']);
  });
});

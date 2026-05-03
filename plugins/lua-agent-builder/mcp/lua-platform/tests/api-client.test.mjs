// Tests for apiRequest — the HTTP wrapper every MCP tool depends on.
// Verifies auth header format, timeout via AbortController, structured error
// parsing (lua-api's { success: false, error: { message } } envelope),
// 401 / 403 / generic-error paths, and query-string handling.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { apiRequest } from '../src/api-client.mjs';

function mockFetch(scripted) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (typeof scripted === 'function') return scripted({ url, init });
    return scripted;
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function textResponse(text, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { throw new Error('not json'); },
    async text() { return text; },
  };
}

describe('apiRequest', () => {
  beforeEach(() => { process.env.LUA_API_KEY = 'lk_test_key'; });
  afterEach(() => { delete process.env.LUA_API_KEY; });

  test('sends Bearer token in Authorization header', async () => {
    const fetchFn = mockFetch(jsonResponse({ ok: true }));
    await apiRequest('/agents', { fetchFn });
    expect(fetchFn.calls[0].init.headers.Authorization).toBe('Bearer lk_test_key');
  });

  test('sets Content-Type: application/json', async () => {
    const fetchFn = mockFetch(jsonResponse({ ok: true }));
    await apiRequest('/agents', { fetchFn });
    expect(fetchFn.calls[0].init.headers['Content-Type']).toBe('application/json');
  });

  test('uses LUA_API_URL env override when set', async () => {
    process.env.LUA_API_URL = 'https://api-staging.heylua.ai';
    const fetchFn = mockFetch(jsonResponse({ ok: true }));
    try {
      await apiRequest('/agents', { fetchFn });
      expect(fetchFn.calls[0].url).toMatch(/^https:\/\/api-staging\.heylua\.ai/);
    } finally {
      delete process.env.LUA_API_URL;
    }
  });

  test('appends query string parameters', async () => {
    const fetchFn = mockFetch(jsonResponse({ ok: true }));
    await apiRequest('/agents/abc/logs', {
      fetchFn,
      query: { type: 'skill', limit: 50 },
    });
    expect(fetchFn.calls[0].url).toMatch(/\?type=skill&limit=50$/);
  });

  test('serialises body as JSON for POST', async () => {
    const fetchFn = mockFetch(jsonResponse({ ok: true }));
    await apiRequest('/agents', {
      method: 'POST',
      body: { name: 'foo' },
      fetchFn,
    });
    expect(fetchFn.calls[0].init.body).toBe('{"name":"foo"}');
  });

  test('throws MCP_AUTH_STALE on 401', async () => {
    const fetchFn = mockFetch(jsonResponse({ error: 'unauthorized' }, { status: 401 }));
    await expect(apiRequest('/agents', { fetchFn })).rejects.toThrow(/MCP_AUTH_STALE/);
    await expect(apiRequest('/agents', { fetchFn })).rejects.toThrow(/Re-run \/lua-doctor/);
  });

  test('throws MCP_FORBIDDEN on 403 with helpful message', async () => {
    const fetchFn = mockFetch(jsonResponse({ error: 'forbidden' }, { status: 403 }));
    await expect(apiRequest('/agents/wrong-id', { fetchFn })).rejects.toThrow(/MCP_FORBIDDEN/);
    await expect(apiRequest('/agents/wrong-id', { fetchFn })).rejects.toThrow(/different agent or org/);
  });

  test('extracts friendly message from lua-api error envelope', async () => {
    const fetchFn = mockFetch(jsonResponse({
      success: false,
      error: { message: 'Skill not found', statusCode: 404 },
    }, { status: 404 }));
    await expect(apiRequest('/skills/missing', { fetchFn }))
      .rejects.toThrow(/lua-api 404: Skill not found/);
  });

  test('extracts top-level "message" field if no nested error envelope', async () => {
    const fetchFn = mockFetch(jsonResponse({ message: 'Bad request' }, { status: 400 }));
    await expect(apiRequest('/x', { fetchFn })).rejects.toThrow(/lua-api 400: Bad request/);
  });

  test('falls back to raw text when error response is not JSON', async () => {
    const fetchFn = mockFetch(textResponse('<html>502 Bad Gateway</html>', { status: 502 }));
    await expect(apiRequest('/x', { fetchFn })).rejects.toThrow(/lua-api 502: <html>502 Bad Gateway<\/html>/);
  });

  test('throws MCP_TIMEOUT when fetch is aborted', async () => {
    const fetchFn = async (_url, init) => {
      // Wait for the AbortController to abort, then reject like fetch does
      await new Promise((_resolveP, reject) => {
        if (init.signal.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
        );
      });
    };
    await expect(apiRequest('/agents', { fetchFn, timeoutMs: 50 }))
      .rejects.toThrow(/MCP_TIMEOUT/);
    await expect(apiRequest('/agents', { fetchFn, timeoutMs: 50 }))
      .rejects.toThrow(/did not respond in 50ms/);
  });

  test('returns parsed JSON on success', async () => {
    const fetchFn = mockFetch(jsonResponse({ id: 'abc', name: 'agent-one' }));
    const result = await apiRequest('/agents/abc', { fetchFn });
    expect(result).toEqual({ id: 'abc', name: 'agent-one' });
  });

  test('throws auth error when no key resolvable', async () => {
    delete process.env.LUA_API_KEY;
    process.env.LUA_CREDENTIALS_PATH = '/nonexistent';
    const fetchFn = mockFetch(jsonResponse({ ok: true }));
    try {
      await expect(apiRequest('/agents', { fetchFn })).rejects.toThrow(/MCP_AUTH_STALE/);
    } finally {
      delete process.env.LUA_CREDENTIALS_PATH;
    }
  });
});

// Tests for apiRequest — the HTTP wrapper every MCP tool depends on.
// Verifies auth header format, timeout via AbortController, structured error
// parsing (lua-api's { success: false, error: { message } } envelope),
// 401 / 403 / generic-error paths, and query-string handling.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRequest, ROUTE_SCOPES } from '../src/api-client.mjs';

const SOURCE_DIRECTORY = fileURLToPath(new URL('../src/', import.meta.url));
const PLUGIN_PACKAGE = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

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

  test('identifies direct requests as the versioned Claude plugin', async () => {
    const fetchFn = mockFetch(jsonResponse({ ok: true }));
    await apiRequest('/agents', { fetchFn });
    expect(fetchFn.calls[0].init.headers['X-Lua-Client']).toBe(`claude-plugin/${PLUGIN_PACKAGE.version}`);
  });

  test('keeps every direct Lua API call behind the identified wrapper', () => {
    // auth.mjs is the one other caller — it talks to Google's securetoken
    // endpoint to refresh a lua-cli session, never to the Lua API.
    const directCallers = sourceFiles(SOURCE_DIRECTORY)
      .filter((path) => path.endsWith('.mjs'))
      .filter((path) => /\b(?:fetch|fetchFn)\s*\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SOURCE_DIRECTORY, path))
      .sort();

    expect(directCallers).toEqual(['api-client.mjs', 'auth.mjs']);
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

  // `new URL(path, base)` treats a leading-slash path as host-absolute and
  // silently drops a base path prefix — a proxy-mounted LUA_API_URL such as
  // https://host/api would have every call land on https://host/developer/…
  test('preserves a path prefix on LUA_API_URL instead of resolving against the host root', async () => {
    process.env.LUA_API_URL = 'https://proxy.example.com/api';
    const fetchFn = mockFetch(jsonResponse({ ok: true }));
    try {
      await apiRequest('/developer/agents/a1/logs', { fetchFn, query: { limit: 5 } });
      expect(fetchFn.calls[0].url).toBe('https://proxy.example.com/api/developer/agents/a1/logs?limit=5');
    } finally {
      delete process.env.LUA_API_URL;
    }
  });

  test('tolerates a trailing slash on the base URL without doubling the separator', async () => {
    const fetchFn = mockFetch(jsonResponse({ ok: true }));
    await apiRequest('/developer/skills/a1', { fetchFn, baseUrl: 'https://api-staging.heylua.ai/' });
    expect(fetchFn.calls[0].url).toBe('https://api-staging.heylua.ai/developer/skills/a1');

    await apiRequest('/developer/skills/a1', { fetchFn, baseUrl: 'https://proxy.example.com/api/' });
    expect(fetchFn.calls[1].url).toBe('https://proxy.example.com/api/developer/skills/a1');
  });

  test('appends query string parameters', async () => {
    const fetchFn = mockFetch(jsonResponse({ ok: true }));
    await apiRequest('/agents/abc/logs', {
      fetchFn,
      query: { logSource: 'skill', limit: 50 },
    });
    expect(fetchFn.calls[0].url).toMatch(/\?logSource=skill&limit=50$/);
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

  test('throws MCP_AUTH_STALE on 401 with the lua auth configure remedy', async () => {
    const fetchFn = mockFetch(jsonResponse({ error: 'unauthorized' }, { status: 401 }));
    await expect(apiRequest('/agents', { fetchFn })).rejects.toThrow(/MCP_AUTH_STALE/);
    await expect(apiRequest('/agents', { fetchFn })).rejects.toThrow(/lua auth configure/);
    await expect(apiRequest('/agents', { fetchFn })).rejects.toThrow(/\/lua-doctor/);
  });

  // Scopes come from the @RequireScope decorators in lua-api
  // packages/lua-api/src/controllers/developer/**/base.controller.ts —
  // workflows have their own workflows:read, NOT automations:read.
  test('throws MCP_FORBIDDEN on 403 naming the correct scope per route family', async () => {
    const fetchFn = mockFetch(jsonResponse({ error: 'forbidden' }, { status: 403 }));
    const rejection = expect(apiRequest('/agents/wrong-id', { fetchFn })).rejects;
    await rejection.toThrow(/MCP_FORBIDDEN/);
    await expect(apiRequest('/agents/wrong-id', { fetchFn })).rejects.toThrow(/\/agents\/wrong-id/);
    await expect(apiRequest('/agents/wrong-id', { fetchFn })).rejects.toThrow(
      /skills\/webhooks\/jobs\/triggers\/preprocessors\/postprocessors need automations:read/
    );
    await expect(apiRequest('/agents/wrong-id', { fetchFn })).rejects.toThrow(/workflows need workflows:read/);
    await expect(apiRequest('/agents/wrong-id', { fetchFn })).rejects.toThrow(/persona needs agents:read/);
    await expect(apiRequest('/agents/wrong-id', { fetchFn })).rejects.toThrow(/logs need knowledge:read/);
  });

  test('403 message never files workflows under automations:read', async () => {
    const fetchFn = mockFetch(jsonResponse({ error: 'forbidden' }, { status: 403 }));
    let message = '';
    try { await apiRequest('/developer/workflows/a1', { fetchFn }); } catch (err) { message = err.message; }
    expect(message).toMatch(/MCP_FORBIDDEN/);
    // Within the scope clause, the family list in front of "automations:read"
    // must not include workflows (the request path before it legitimately does).
    const clauseStart = message.indexOf('the route scope (');
    expect(clauseStart).toBeGreaterThan(-1);
    const automationsFamilies = message.slice(clauseStart, message.indexOf('automations:read'));
    expect(automationsFamilies).not.toMatch(/workflows/);
    expect(automationsFamilies).toMatch(/skills\/webhooks\/jobs\/triggers\/preprocessors\/postprocessors/);
  });

  test('ROUTE_SCOPES mirrors the lua-api @RequireScope decorators per family', () => {
    expect(ROUTE_SCOPES).toEqual({
      skills: 'automations:read',
      webhooks: 'automations:read',
      jobs: 'automations:read',
      triggers: 'automations:read',
      preprocessors: 'automations:read',
      postprocessors: 'automations:read',
      workflows: 'workflows:read',
      persona: 'agents:read',
      logs: 'knowledge:read',
    });
    expect(Object.isFrozen(ROUTE_SCOPES)).toBe(true);
  });

  test('extracts friendly message from lua-api error envelope', async () => {
    const fetchFn = mockFetch(jsonResponse({
      success: false,
      error: { message: 'Skill not found', statusCode: 404 },
    }, { status: 404 }));
    await expect(apiRequest('/skills/missing', { fetchFn }))
      .rejects.toThrow(/lua-api 404: Skill not found/);
  });

  test('prefixes the typed error code when the envelope carries one', async () => {
    const fetchFn = mockFetch(jsonResponse({
      success: false,
      error: { code: 'WORKFLOW_DYNAMIC', statusCode: 409, message: 'composed by chat' },
    }, { status: 409 }));
    await expect(apiRequest('/x', { fetchFn })).rejects.toThrow(/lua-api 409: WORKFLOW_DYNAMIC: composed by chat/);
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
    process.env.LUA_CREDENTIALS_PATH = '/nonexistent/credentials';
    const fetchFn = mockFetch(jsonResponse({ ok: true }));
    try {
      await expect(apiRequest('/agents', { fetchFn })).rejects.toThrow(/MCP_AUTH_STALE/);
    } finally {
      delete process.env.LUA_CREDENTIALS_PATH;
    }
  });
});

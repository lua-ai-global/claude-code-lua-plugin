import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { tailLogs } from '../../src/tools/tail-logs.mjs';

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
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

describe('tailLogs tool', () => {
  beforeEach(() => { process.env.LUA_API_KEY = 'lk_test_key'; });
  afterEach(() => { delete process.env.LUA_API_KEY; });

  test('spec is well-formed MCP schema', () => {
    expect(tailLogs.spec.name).toBe('tail_logs');
    expect(tailLogs.spec.inputSchema.required).toEqual(['agentId']);
  });

  // Iteration-13 audit (bug 61): the schema's `limit` cap was 500, but
  // lua-api silently caps at 100. Lock the schema to 100.
  test('limit schema cap matches the lua-api server cap (100, not 500)', () => {
    expect(tailLogs.spec.inputSchema.properties.limit.maximum).toBe(100);
  });

  test('rejects when agentId is missing', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await expect(tailLogs.handler({}, { fetchFn })).rejects.toThrow(/agentId is required/);
  });

  test('rejects invalid type', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await expect(
      tailLogs.handler({ agentId: 'a1', type: 'bogus' }, { fetchFn })
    ).rejects.toThrow(/Invalid type/);
  });

  test('rejects limit > 100 with a clear message (matches lua-api cap)', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await expect(
      tailLogs.handler({ agentId: 'a1', limit: 200 }, { fetchFn })
    ).rejects.toThrow(/lua-api caps logs at 100/);
  });

  // Iteration-13 audit (bug 27): lua-api expects `primitiveType` /
  // `primitiveName` query params (NOT `type`/`name`). Verifies both the
  // param-name mapping and the `type === 'all'` sentinel that means
  // "no filter".
  test('omits primitiveType when type === "all" (the MCP-side sentinel)', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await tailLogs.handler({ agentId: 'a1', type: 'all', limit: 10 }, { fetchFn });
    const url = fetchFn.calls[0].url;
    expect(url).not.toContain('primitiveType');
    expect(url).toContain('limit=10');
  });

  test('forwards primitiveType (NOT type) to lua-api when set to a real type', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await tailLogs.handler({ agentId: 'a1', type: 'skill', limit: 5 }, { fetchFn });
    const url = fetchFn.calls[0].url;
    expect(url).toContain('primitiveType=skill');
    expect(url).not.toMatch(/[?&]type=/);
  });

  test('forwards primitiveName (NOT name) when name is set', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await tailLogs.handler({ agentId: 'a1', type: 'skill', name: 'weather' }, { fetchFn });
    const url = fetchFn.calls[0].url;
    expect(url).toContain('primitiveName=weather');
    expect(url).not.toMatch(/[?&]name=/);
  });

  test('encodes the agentId in the path', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await tailLogs.handler({ agentId: 'agent/with/slash', limit: 5 }, { fetchFn });
    expect(fetchFn.calls[0].url).toContain('/developer/agents/agent%2Fwith%2Fslash/logs');
  });

  test('returns the API response as content text', async () => {
    const payload = {
      logs: [{ id: 'l1', subType: 'error', timestamp: '2026-05-02T12:00:00Z', message: 'boom' }],
      pagination: { currentPage: 1, totalPages: 1, totalCount: 1, limit: 50, hasNextPage: false, hasPrevPage: false, nextPage: null, prevPage: null },
    };
    const fetchFn = mockFetch(() => jsonResponse(payload));
    const result = await tailLogs.handler({ agentId: 'a1' }, { fetchFn });
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
  });
});

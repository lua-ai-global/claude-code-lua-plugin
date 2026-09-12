import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { tailLogs, LOG_SOURCES, LOG_TYPES } from '../../src/tools/tail-logs.mjs';

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

  test('type enum is `all` + the server AGENT_LOG_SOURCES (no `mastra`)', () => {
    const values = tailLogs.spec.inputSchema.properties.type.enum;
    expect(values[0]).toBe('all');
    expect(values).toEqual(['all', ...LOG_SOURCES]);
    expect(values).not.toContain('mastra');
    for (const s of ['trigger', 'agent_error', 'runtime', 'rag', 'device', 'device-trigger', 'model-resolver', 'workflow-step', 'workflow-script', 'workflow']) {
      expect(values).toContain(s);
    }
  });

  // lua-api silently caps at 100 — lock the schema to the server cap.
  test('limit schema cap matches the lua-api server cap (100, not 500)', () => {
    expect(tailLogs.spec.inputSchema.properties.limit.maximum).toBe(100);
  });

  test('rejects when agentId is missing', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await expect(tailLogs.handler({}, { fetchFn })).rejects.toThrow(/agentId is required/);
  });

  test('rejects invalid type (incl. the retired `mastra`)', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await expect(
      tailLogs.handler({ agentId: 'a1', type: 'bogus' }, { fetchFn })
    ).rejects.toThrow(/Invalid type/);
    await expect(
      tailLogs.handler({ agentId: 'a1', type: 'mastra' }, { fetchFn })
    ).rejects.toThrow(/Invalid type/);
  });

  test('rejects limit > 100 with a clear message (matches lua-api cap)', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await expect(
      tailLogs.handler({ agentId: 'a1', limit: 200 }, { fetchFn })
    ).rejects.toThrow(/lua-api caps logs at 100/);
  });

  // lua-api reads `logSource` / `primitiveName` (controllers/developer/
  // base.controller.ts @Query decorators). A `primitiveType` or `type`
  // param is silently ignored → unfiltered logs.
  test('omits logSource when type === "all" (the MCP-side sentinel)', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await tailLogs.handler({ agentId: 'a1', type: 'all', limit: 10 }, { fetchFn });
    const url = fetchFn.calls[0].url;
    expect(url).not.toContain('logSource');
    expect(url).not.toContain('primitiveType');
    expect(url).toContain('limit=10');
  });

  test('forwards logSource (NOT primitiveType / type) when set to a real source', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await tailLogs.handler({ agentId: 'a1', type: 'skill', limit: 5 }, { fetchFn });
    const url = fetchFn.calls[0].url;
    expect(url).toContain('logSource=skill');
    expect(url).not.toContain('primitiveType');
    expect(url).not.toMatch(/[?&]type=/);
  });

  test('forwards primitiveName (NOT name) when name is set', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await tailLogs.handler({ agentId: 'a1', type: 'skill', name: 'weather' }, { fetchFn });
    const url = fetchFn.calls[0].url;
    expect(url).toContain('primitiveName=weather');
    expect(url).not.toMatch(/[?&]name=/);
  });

  // `logType` is applied server-side as `filter.subType = logType`
  // (services/developer.service.ts getAgentLogs), so the accepted values are
  // the VmExecutionLog subType enum (shared-schemas vmExecutionLogs.schema.ts).
  test('logType enum is exactly the VmExecutionLog subType set', () => {
    const { logType } = tailLogs.spec.inputSchema.properties;
    expect(logType.type).toBe('string');
    expect([...logType.enum].sort()).toEqual(['complete', 'debug', 'error', 'info', 'start', 'warn']);
    expect(logType.enum).toEqual(LOG_TYPES);
    expect(tailLogs.spec.inputSchema.required).not.toContain('logType');
    expect(tailLogs.spec.description).toMatch(/logType/);
  });

  test('forwards logType as the `logType` query param when set', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await tailLogs.handler({ agentId: 'a1', logType: 'error', limit: 5 }, { fetchFn });
    const url = new URL(fetchFn.calls[0].url);
    expect(url.searchParams.get('logType')).toBe('error');
    expect(url.searchParams.has('subType')).toBe(false);
  });

  test('omits logType from the query when not provided', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await tailLogs.handler({ agentId: 'a1', type: 'skill', name: 'weather' }, { fetchFn });
    expect(fetchFn.calls[0].url).not.toContain('logType');
  });

  test('combines logType with logSource and primitiveName filters', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await tailLogs.handler({ agentId: 'a1', type: 'webhook', name: 'stripe', logType: 'warn', limit: 7 }, { fetchFn });
    const params = new URL(fetchFn.calls[0].url).searchParams;
    expect(params.get('logSource')).toBe('webhook');
    expect(params.get('primitiveName')).toBe('stripe');
    expect(params.get('logType')).toBe('warn');
    expect(params.get('limit')).toBe('7');
  });

  test('rejects a logType outside the subType enum before calling the API', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await expect(tailLogs.handler({ agentId: 'a1', logType: 'fatal' }, { fetchFn })).rejects.toThrow(/Invalid logType: fatal/);
    await expect(tailLogs.handler({ agentId: 'a1', logType: 'ERROR' }, { fetchFn })).rejects.toThrow(/Invalid logType/);
    expect(fetchFn.calls).toHaveLength(0);
  });

  test('forwards page when set', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await tailLogs.handler({ agentId: 'a1', page: 3 }, { fetchFn });
    expect(fetchFn.calls[0].url).toContain('page=3');
  });

  test('encodes the agentId in the path', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ logs: [] }));
    await tailLogs.handler({ agentId: 'agent/with/slash', limit: 5 }, { fetchFn });
    expect(fetchFn.calls[0].url).toContain('/developer/agents/agent%2Fwith%2Fslash/logs');
  });

  test('returns the API response as content text', async () => {
    const payload = {
      logs: [{ id: 'l1', subType: 'error', timestamp: '2026-05-02T12:00:00Z', message: 'boom', metadata: { logSource: 'skill', primitiveName: 'weather' } }],
      pagination: { currentPage: 1, totalPages: 1, totalCount: 1, limit: 50, hasNextPage: false, hasPrevPage: false, nextPage: null, prevPage: null },
    };
    const fetchFn = mockFetch(() => jsonResponse(payload));
    const result = await tailLogs.handler({ agentId: 'a1' }, { fetchFn });
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
  });
});

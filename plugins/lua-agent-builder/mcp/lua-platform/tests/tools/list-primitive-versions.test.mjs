import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { listPrimitiveVersions } from '../../src/tools/list-primitive-versions.mjs';

function mockFetch(routes) {
  // routes: { 'GET /developer/skills/agentX': () => responseObj, ... }
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const key = `${init.method ?? 'GET'} ${u.pathname}`;
    const handler = routes[key];
    if (!handler) {
      throw new Error(`Unmocked route: ${key}`);
    }
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

beforeEach(() => { process.env.LUA_API_KEY = 'lk_test_key'; });
afterEach(() => { delete process.env.LUA_API_KEY; });

describe('listPrimitiveVersions tool', () => {
  test('spec is well-formed MCP schema', () => {
    expect(listPrimitiveVersions.spec.name).toBe('list_primitive_versions');
    expect(listPrimitiveVersions.spec.inputSchema.required).toEqual(['agentId', 'type']);
  });

  test('rejects missing agentId or type', async () => {
    const fetchFn = mockFetch({});
    await expect(listPrimitiveVersions.handler({ type: 'skill' }, { fetchFn })).rejects.toThrow(/required/);
    await expect(listPrimitiveVersions.handler({ agentId: 'a' }, { fetchFn })).rejects.toThrow(/required/);
  });

  test('rejects invalid primitive type', async () => {
    const fetchFn = mockFetch({});
    await expect(
      listPrimitiveVersions.handler({ agentId: 'a', type: 'bogus' }, { fetchFn })
    ).rejects.toThrow(/Invalid type/);
  });

  test('requires name for non-persona types', async () => {
    const fetchFn = mockFetch({});
    await expect(
      listPrimitiveVersions.handler({ agentId: 'a', type: 'skill' }, { fetchFn })
    ).rejects.toThrow(/name is required/);
  });

  // Iteration-13 audit (bug 28): the previous implementation passed `name`
  // into the URL slot where lua-api expects `:skillId` etc. — every call
  // 404'd. The fix resolves name → id by listing first.
  test('resolves name → id by listing first, then queries the versions endpoint by id', async () => {
    const fetchFn = mockFetch({
      'GET /developer/skills/agentX': () => jsonResponse({
        skills: [
          { id: 'sk_real_id', name: 'weather' },
          { id: 'sk_other', name: 'calculator' },
        ],
      }),
      'GET /developer/skills/agentX/sk_real_id/versions': () => jsonResponse({
        versions: [
          { version: '1.0.0', deployedAt: '2026-05-02T00:00:00Z', createdAt: '2026-05-01T00:00:00Z', sourceHash: 'abc' },
          { version: '0.9.0', deployedAt: null,                  createdAt: '2026-04-01T00:00:00Z' },
        ],
      }),
    });
    const result = await listPrimitiveVersions.handler(
      { agentId: 'agentX', type: 'skill', name: 'weather' },
      { fetchFn }
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      version: '1.0.0',
      deployed: true,
      createdAt: '2026-05-01T00:00:00Z',
      sourceHash: 'abc',
    });
    expect(parsed[1].deployed).toBe(false);
    expect(parsed[1].sourceHash).toBeNull();
  });

  test('throws a discoverable error when the named primitive does not exist', async () => {
    const fetchFn = mockFetch({
      'GET /developer/skills/agentX': () => jsonResponse({
        skills: [{ id: 'sk1', name: 'calculator' }],
      }),
    });
    await expect(
      listPrimitiveVersions.handler(
        { agentId: 'agentX', type: 'skill', name: 'nope' },
        { fetchFn }
      )
    ).rejects.toThrow(/no skill named "nope".*Available: calculator/);
  });

  // Persona is special-cased: the URL is /developer/agents/:agentId/persona/versions
  // (no per-name dispatch since each agent has at most one persona).
  test('persona uses the special-case URL with no name lookup', async () => {
    const fetchFn = mockFetch({
      'GET /developer/agents/agentY/persona/versions': () => jsonResponse({
        versions: [
          { version: 1, deployedAt: '2026-05-01T00:00:00Z', createdAt: '2026-05-01T00:00:00Z' },
        ],
      }),
    });
    const result = await listPrimitiveVersions.handler(
      { agentId: 'agentY', type: 'persona' },
      { fetchFn }
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].deployed).toBe(true);
    // No GET against /developer/persona/<id>/versions or similar.
    expect(fetchFn.calls).toHaveLength(1);
  });
});

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { getDeploymentStatus } from '../../src/tools/get-deployment-status.mjs';

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const key = `${init.method ?? 'GET'} ${u.pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unmocked route: ${key}`);
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

describe('getDeploymentStatus tool', () => {
  test('spec is well-formed MCP schema', () => {
    expect(getDeploymentStatus.spec.name).toBe('get_deployment_status');
    expect(getDeploymentStatus.spec.inputSchema.required).toEqual(['agentId']);
  });

  test('rejects missing agentId', async () => {
    const fetchFn = mockFetch({});
    await expect(getDeploymentStatus.handler({}, { fetchFn })).rejects.toThrow(/required/);
  });

  // Iteration-13 audit (bug 28): the previous implementation passed
  // `p.name` into the URL slot where lua-api expects `:skillId` etc. —
  // every versions call 404'd. The fix uses `p.id` (or `p._id`) instead.
  test('uses primitive id (NOT name) in the versions URL slot', async () => {
    const fetchFn = mockFetch({
      // List endpoints, returning items with both id AND name (id is the
      // server's PK; name is the user-facing handle). Tool MUST use id.
      'GET /developer/skills/agentX':         () => jsonResponse({ skills:        [{ id: 'sk_1', name: 'weather' }] }),
      'GET /developer/webhooks/agentX':       () => jsonResponse({ data: { webhooks:        [] } }),
      'GET /developer/jobs/agentX':           () => jsonResponse({ data: { jobs:            [] } }),
      'GET /developer/preprocessors/agentX':  () => jsonResponse({ data: { preprocessors:   [] } }),
      'GET /developer/postprocessors/agentX': () => jsonResponse({ data: { postprocessors:  [] } }),
      // The tool must hit this versions URL using the ID, not the name.
      'GET /developer/skills/agentX/sk_1/versions': () => jsonResponse({
        versions: [
          { version: '2.0.0', deployedAt: '2026-05-02T12:00:00Z' },
          { version: '1.0.0', deployedAt: '2026-04-01T00:00:00Z' },
        ],
      }),
    });
    const result = await getDeploymentStatus.handler({ agentId: 'agentX' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);

    // The skill entry should reflect the most-recent deployed version.
    const skillEntry = parsed.primitives.skill[0];
    expect(skillEntry.name).toBe('weather');
    expect(skillEntry.deployedVersion).toBe('2.0.0');
    expect(skillEntry.deployedAt).toBe('2026-05-02T12:00:00Z');

    // CRITICAL: verify the URL went to /sk_1/versions, NOT /weather/versions.
    const urls = fetchFn.calls.map((c) => c.url);
    expect(urls.some((u) => u.endsWith('/sk_1/versions'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/weather/versions'))).toBe(false);
  });

  test('reports primitives with no deployed version as deployedVersion: null', async () => {
    const fetchFn = mockFetch({
      'GET /developer/skills/agentY':         () => jsonResponse({ skills: [{ id: 'sk_undeployed', name: 'draft' }] }),
      'GET /developer/webhooks/agentY':       () => jsonResponse({ data: { webhooks: [] } }),
      'GET /developer/jobs/agentY':           () => jsonResponse({ data: { jobs: [] } }),
      'GET /developer/preprocessors/agentY':  () => jsonResponse({ data: { preprocessors: [] } }),
      'GET /developer/postprocessors/agentY': () => jsonResponse({ data: { postprocessors: [] } }),
      'GET /developer/skills/agentY/sk_undeployed/versions': () => jsonResponse({
        versions: [{ version: '0.1.0', deployedAt: null, createdAt: '2026-05-02T00:00:00Z' }],
      }),
    });
    const result = await getDeploymentStatus.handler({ agentId: 'agentY' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.primitives.skill[0]).toEqual({
      name: 'draft',
      deployedVersion: null,
      deployedAt: null,
    });
  });

  test('records the per-type error when a list endpoint fails (does not abort the rest)', async () => {
    const fetchFn = mockFetch({
      'GET /developer/skills/agentZ':         () => jsonResponse({ error: 'denied' }, { status: 403 }),
      'GET /developer/webhooks/agentZ':       () => jsonResponse({ data: { webhooks: [] } }),
      'GET /developer/jobs/agentZ':           () => jsonResponse({ data: { jobs: [] } }),
      'GET /developer/preprocessors/agentZ':  () => jsonResponse({ data: { preprocessors: [] } }),
      'GET /developer/postprocessors/agentZ': () => jsonResponse({ data: { postprocessors: [] } }),
    });
    const result = await getDeploymentStatus.handler({ agentId: 'agentZ' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.primitives.skill).toEqual({ error: expect.stringMatching(/MCP_FORBIDDEN/) });
    // Other types still report empty arrays (not aborted).
    expect(parsed.primitives.webhook).toEqual([]);
    expect(parsed.primitives.job).toEqual([]);
  });

  test('encodes the agentId in the URL', async () => {
    const fetchFn = mockFetch({
      'GET /developer/skills/agent%2Ftricky':         () => jsonResponse({ skills: [] }),
      'GET /developer/webhooks/agent%2Ftricky':       () => jsonResponse({ data: { webhooks: [] } }),
      'GET /developer/jobs/agent%2Ftricky':           () => jsonResponse({ data: { jobs: [] } }),
      'GET /developer/preprocessors/agent%2Ftricky':  () => jsonResponse({ data: { preprocessors: [] } }),
      'GET /developer/postprocessors/agent%2Ftricky': () => jsonResponse({ data: { postprocessors: [] } }),
    });
    const result = await getDeploymentStatus.handler({ agentId: 'agent/tricky' }, { fetchFn });
    expect(result.content[0].text).toContain('"agentId": "agent/tricky"');
  });
});

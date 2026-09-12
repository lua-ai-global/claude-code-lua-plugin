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
  test('spec is well-formed MCP schema and lists every versioned family', () => {
    expect(listPrimitiveVersions.spec.name).toBe('list_primitive_versions');
    expect(listPrimitiveVersions.spec.inputSchema.required).toEqual(['agentId', 'type']);
    expect(listPrimitiveVersions.spec.inputSchema.properties.type.enum).toEqual([
      'skill', 'webhook', 'job', 'trigger', 'preprocessor', 'postprocessor', 'workflow', 'persona',
    ]);
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

  // The URL slot is the server id (:skillId etc.), never the name — resolve
  // name → id by listing first. Skill versions carry isCurrent + createdDate
  // (SkillVersionDto), never deployedAt.
  test('skill: resolves name → id, then reports isCurrent as `active` and createdDate as createdAt', async () => {
    const fetchFn = mockFetch({
      'GET /developer/skills/agentX': () => jsonResponse({
        skills: [
          { id: 'sk_real_id', name: 'weather' },
          { id: 'sk_other', name: 'calculator' },
        ],
      }),
      'GET /developer/skills/agentX/sk_real_id/versions': () => jsonResponse({
        versions: [
          { version: '1.0.0', createdDate: '2026-05-01T00:00:00Z', createdBy: 'u1', isCurrent: true },
          { version: '0.9.0', createdDate: '2026-04-01T00:00:00Z', createdBy: 'u1', isCurrent: false },
        ],
      }),
    });
    const result = await listPrimitiveVersions.handler(
      { agentId: 'agentX', type: 'skill', name: 'weather' },
      { fetchFn }
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.type).toBe('skill');
    expect(parsed.name).toBe('weather');
    expect(parsed.versions).toHaveLength(2);
    expect(parsed.versions[0]).toEqual({
      version: '1.0.0',
      versionId: null,
      active: true,
      createdAt: '2026-05-01T00:00:00Z',
    });
    expect(parsed.versions[1].active).toBe(false);
    // Verify the URL went to /sk_real_id/versions, NOT /weather/versions.
    const urls = fetchFn.calls.map((c) => c.url);
    expect(urls.some((u) => u.endsWith('/sk_real_id/versions'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/weather/versions'))).toBe(false);
  });

  test('trigger: uses /developer/triggers and the isActive / activeVersionId flags', async () => {
    const fetchFn = mockFetch({
      'GET /developer/triggers/agentX': () => jsonResponse({ success: true, data: { triggers: [{ id: 'tr_1', name: 'stripe-payments' }] } }),
      'GET /developer/triggers/agentX/tr_1/versions': () => jsonResponse({
        success: true,
        data: {
          versions: [
            { version: '1.1.0', versionId: 'tv_2', createdAt: '2026-06-01T00:00:00Z', isActive: true },
            { version: '1.0.0', versionId: 'tv_1', createdAt: '2026-05-01T00:00:00Z', isActive: false },
          ],
          activeVersionId: 'tv_2',
        },
      }),
    });
    const result = await listPrimitiveVersions.handler({ agentId: 'agentX', type: 'trigger', name: 'stripe-payments' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.activeVersionId).toBe('tv_2');
    expect(parsed.versions[0]).toEqual({ version: '1.1.0', versionId: 'tv_2', active: true, createdAt: '2026-06-01T00:00:00Z' });
    expect(parsed.versions[1].active).toBe(false);
  });

  // developer.webhook.service.ts getWebhookVersions maps each row to
  // { version, webhookId: v.id, createdAt, isActive } — no versionId/id key,
  // so versionId is null; the live row id is only on the envelope.
  test('webhook: versionId is null per entry (route carries no per-entry id); activeVersionId comes from the envelope', async () => {
    const fetchFn = mockFetch({
      'GET /developer/webhooks/agentX': () => jsonResponse({ success: true, data: { webhooks: [{ id: 'wh_1', name: 'stripe', active: true, activeVersionId: 'whv_2' }] } }),
      'GET /developer/webhooks/agentX/wh_1/versions': () => jsonResponse({
        success: true,
        data: {
          versions: [
            { version: '1.1.0', webhookId: 'whv_2', createdAt: '2026-06-01T00:00:00Z', isActive: true },
            { version: '1.0.0', webhookId: 'whv_1', createdAt: '2026-05-01T00:00:00Z', isActive: false },
          ],
          activeVersionId: 'whv_2',
        },
      }),
    });
    const result = await listPrimitiveVersions.handler({ agentId: 'agentX', type: 'webhook', name: 'stripe' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.activeVersionId).toBe('whv_2');
    expect(parsed.versions).toEqual([
      { version: '1.1.0', versionId: null, active: true, createdAt: '2026-06-01T00:00:00Z' },
      { version: '1.0.0', versionId: null, active: false, createdAt: '2026-05-01T00:00:00Z' },
    ]);
  });

  test('description documents exactly which families return versionId: null', () => {
    const { description } = listPrimitiveVersions.spec;
    expect(description).toMatch(/`versionId` is null for .*skill, persona and webhook/);
    expect(description).toMatch(/top-level `activeVersionId`/);
    // Triggers and processors DO carry versionId (verified in lua-api) — they must not be listed as null.
    const nullClause = description.slice(description.indexOf('`versionId` is null'), description.indexOf('`activeVersionId` is populated'));
    expect(nullClause).not.toMatch(/trigger|preprocessor|postprocessor|job|workflow/);
  });

  test('workflow: uses /developer/workflows and the WorkflowVersion `active` flag (array under data)', async () => {
    const fetchFn = mockFetch({
      'GET /developer/workflows/agentX': () => jsonResponse({ success: true, data: { workflows: [{ id: 'wf_1', name: 'outreach' }] } }),
      'GET /developer/workflows/agentX/wf_1/versions': () => jsonResponse({
        success: true,
        data: [
          { id: 'wfv_2', workflowId: 'wf_1', name: 'outreach', version: '2.0.0', active: true, form: 'graph', graphHash: 'h2', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
          { id: 'wfv_1', workflowId: 'wf_1', name: 'outreach', version: '1.0.0', active: false, form: 'graph', graphHash: 'h1', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' },
        ],
      }),
    });
    const result = await listPrimitiveVersions.handler({ agentId: 'agentX', type: 'workflow', name: 'outreach' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.versions).toEqual([
      { version: '2.0.0', versionId: 'wfv_2', active: true, createdAt: '2026-09-01T00:00:00Z' },
      { version: '1.0.0', versionId: 'wfv_1', active: false, createdAt: '2026-08-01T00:00:00Z' },
    ]);
  });

  test('job: array directly under data, `active` flag', async () => {
    const fetchFn = mockFetch({
      'GET /developer/jobs/agentX': () => jsonResponse({ success: true, data: { jobs: [{ id: 'job_1', name: 'nightly' }] } }),
      'GET /developer/jobs/agentX/job_1/versions': () => jsonResponse({ success: true, data: [{ id: 'jv_1', version: '1.0.0', active: true, createdAt: '2026-05-01T00:00:00Z' }] }),
    });
    const result = await listPrimitiveVersions.handler({ agentId: 'agentX', type: 'job', name: 'nightly' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.versions[0]).toEqual({ version: '1.0.0', versionId: 'jv_1', active: true, createdAt: '2026-05-01T00:00:00Z' });
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
  // (no per-name dispatch since each agent has at most one persona). Its
  // rows are { version: number, createdDate: epoch-ms, isCurrent, persona }.
  test('persona uses the special-case URL with no name lookup, normalising createdDate', async () => {
    const fetchFn = mockFetch({
      'GET /developer/agents/agentY/persona/versions': () => jsonResponse({
        status: 'success',
        message: 'ok',
        versions: [
          { version: 2, createdDate: 1777593600000, createdBy: 'u1', isCurrent: true, persona: 'You are…' },
          { version: 1, createdDate: 1777507200000, createdBy: 'u1', isCurrent: false, persona: 'Old' },
        ],
      }),
    });
    const result = await listPrimitiveVersions.handler(
      { agentId: 'agentY', type: 'persona' },
      { fetchFn }
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBeNull();
    expect(parsed.versions).toHaveLength(2);
    expect(parsed.versions[0]).toEqual({ version: 2, versionId: null, active: true, createdAt: '2026-05-01T00:00:00.000Z' });
    expect(parsed.versions[1].active).toBe(false);
    // No GET against a list route.
    expect(fetchFn.calls).toHaveLength(1);
  });
});

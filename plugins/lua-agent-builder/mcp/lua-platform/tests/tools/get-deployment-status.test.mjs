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

/** Every list route for `agent`, empty unless overridden. */
function emptyLists(agent, overrides = {}) {
  return {
    [`GET /developer/agents/${agent}/persona/versions`]: () => jsonResponse({ status: 'success', message: 'ok', versions: [] }),
    [`GET /developer/skills/${agent}`]:         () => jsonResponse({ skills: [] }),
    [`GET /developer/webhooks/${agent}`]:       () => jsonResponse({ success: true, data: { webhooks: [] } }),
    [`GET /developer/jobs/${agent}`]:           () => jsonResponse({ success: true, data: { jobs: [] } }),
    [`GET /developer/triggers/${agent}`]:       () => jsonResponse({ success: true, data: { triggers: [] } }),
    [`GET /developer/preprocessors/${agent}`]:  () => jsonResponse({ success: true, data: { preprocessors: [] } }),
    [`GET /developer/postprocessors/${agent}`]: () => jsonResponse({ success: true, data: { postprocessors: [] } }),
    [`GET /developer/workflows/${agent}`]:      () => jsonResponse({ success: true, data: { workflows: [] } }),
    ...overrides,
  };
}

/**
 * A fetch mock whose responses block until the test releases them, so the
 * test can observe how many requests are in flight at once and in what order
 * they were started. `release()` resolves every currently-pending request.
 */
function gatedFetch(routes) {
  const inner = mockFetch(routes);
  const pending = [];
  const started = [];
  let maxInFlight = 0;
  const fn = async (url, init) => {
    started.push(new URL(url).pathname);
    maxInFlight = Math.max(maxInFlight, pending.length + 1);
    await new Promise((resolve) => pending.push(resolve));
    return inner(url, init);
  };
  fn.calls = inner.calls;
  fn.started = started;
  fn.pendingCount = () => pending.length;
  fn.maxInFlight = () => maxInFlight;
  fn.release = () => { const batch = pending.splice(0); for (const r of batch) r(); };
  return fn;
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  test('covers all seven primitive families plus persona', async () => {
    const fetchFn = mockFetch(emptyLists('agentE'));
    const result = await getDeploymentStatus.handler({ agentId: 'agentE' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(Object.keys(parsed.primitives)).toEqual(['skill', 'webhook', 'job', 'trigger', 'preprocessor', 'postprocessor', 'workflow']);
    expect(parsed.persona).toEqual({ activeVersion: null, activeVersionCreatedAt: null, versionCount: 0 });
    const paths = fetchFn.calls.map((c) => new URL(c.url).pathname);
    expect(paths).toContain('/developer/triggers/agentE');
    expect(paths).toContain('/developer/workflows/agentE');
    // Nothing was cut short, so no partial marker.
    expect(parsed.partial).toBeUndefined();
    expect(parsed.partialReason).toBeUndefined();
  });

  test('phase 1: persona and all seven list calls are issued concurrently, before any versions call', async () => {
    const fetchFn = gatedFetch(emptyLists('agentC', {
      'GET /developer/skills/agentC': () => jsonResponse({ skills: [{ id: 'sk_1', name: 'one' }] }),
      'GET /developer/skills/agentC/sk_1/versions': () => jsonResponse({ versions: [{ version: '1.0.0', createdDate: '2026-01-01T00:00:00Z', isCurrent: true }] }),
    }));
    const done = getDeploymentStatus.handler({ agentId: 'agentC' }, { fetchFn });

    await waitFor(() => fetchFn.pendingCount() === 8, 'eight phase-1 requests in flight');
    expect(fetchFn.started.slice(0, 8).sort()).toEqual([
      '/developer/agents/agentC/persona/versions',
      '/developer/jobs/agentC',
      '/developer/postprocessors/agentC',
      '/developer/preprocessors/agentC',
      '/developer/skills/agentC',
      '/developer/triggers/agentC',
      '/developer/webhooks/agentC',
      '/developer/workflows/agentC',
    ]);
    // No versions lookup has started while the lists are still pending.
    expect(fetchFn.started.some((p) => p.endsWith('/sk_1/versions'))).toBe(false);
    fetchFn.release();

    await waitFor(() => fetchFn.pendingCount() === 1, 'the single versions lookup');
    expect(fetchFn.started[8]).toBe('/developer/skills/agentC/sk_1/versions');
    fetchFn.release();

    const parsed = JSON.parse((await done).content[0].text);
    expect(fetchFn.maxInFlight()).toBe(8);
    expect(parsed.primitives.skill[0]).toMatchObject({ name: 'one', activeVersion: '1.0.0' });
  });

  test('phase 2: version lookups run in chunks of 5 per type and keep list order in the output', async () => {
    const skills = Array.from({ length: 7 }, (_, i) => ({ id: `sk_${i}`, name: `skill-${i}` }));
    const routes = emptyLists('agentK', {
      'GET /developer/skills/agentK': () => jsonResponse({ skills }),
      'GET /developer/jobs/agentK': () => jsonResponse({ success: true, data: { jobs: [{ id: 'job_1', name: 'nightly' }] } }),
      'GET /developer/jobs/agentK/job_1/versions': () => jsonResponse({ success: true, data: [{ id: 'jv_1', version: '1.0.0', active: true, createdAt: '2026-05-01T00:00:00Z' }] }),
    });
    for (const s of skills) {
      routes[`GET /developer/skills/agentK/${s.id}/versions`] = () => jsonResponse({
        versions: [{ version: `${s.id}-v`, createdDate: '2026-01-01T00:00:00Z', isCurrent: true }],
      });
    }
    const fetchFn = gatedFetch(routes);
    const done = getDeploymentStatus.handler({ agentId: 'agentK' }, { fetchFn });

    await waitFor(() => fetchFn.pendingCount() === 8, 'phase 1');
    fetchFn.release();

    // First chunk: five skill lookups together, and only skills (types are sequential).
    await waitFor(() => fetchFn.pendingCount() === 5, 'first chunk of five');
    expect(fetchFn.started.slice(8, 13)).toEqual(['sk_0', 'sk_1', 'sk_2', 'sk_3', 'sk_4'].map((s) => `/developer/skills/agentK/${s}/versions`));
    expect(fetchFn.started.some((p) => p.includes('/jobs/agentK/'))).toBe(false);
    // Resolve the chunk out of order to prove output order does not depend on completion order.
    fetchFn.release();

    await waitFor(() => fetchFn.pendingCount() === 2, 'second chunk of two');
    expect(fetchFn.started.slice(13, 15)).toEqual(['sk_5', 'sk_6'].map((s) => `/developer/skills/agentK/${s}/versions`));
    fetchFn.release();

    await waitFor(() => fetchFn.pendingCount() === 1, 'job lookup after skills finished');
    expect(fetchFn.started[15]).toBe('/developer/jobs/agentK/job_1/versions');
    fetchFn.release();

    const parsed = JSON.parse((await done).content[0].text);
    expect(parsed.primitives.skill.map((e) => e.name)).toEqual(skills.map((s) => s.name));
    expect(parsed.primitives.skill.map((e) => e.activeVersion)).toEqual(skills.map((s) => `${s.id}-v`));
    expect(parsed.primitives.job[0]).toMatchObject({ name: 'nightly', activeVersion: '1.0.0', activeVersionId: 'jv_1' });
    expect(parsed.partial).toBeUndefined();
  });

  test('output order is by list order even when a later item resolves first', async () => {
    const fetchFn = mockFetch(emptyLists('agentO', {
      'GET /developer/skills/agentO': () => jsonResponse({ skills: [{ id: 'sk_slow', name: 'slow' }, { id: 'sk_fast', name: 'fast' }] }),
      'GET /developer/skills/agentO/sk_slow/versions': async () => { await sleep(20); return jsonResponse({ versions: [{ version: 'S', createdDate: '2026-01-01T00:00:00Z', isCurrent: true }] }); },
      'GET /developer/skills/agentO/sk_fast/versions': () => jsonResponse({ versions: [{ version: 'F', createdDate: '2026-01-01T00:00:00Z', isCurrent: true }] }),
    }));
    const parsed = JSON.parse((await getDeploymentStatus.handler({ agentId: 'agentO' }, { fetchFn })).content[0].text);
    expect(parsed.primitives.skill.map((e) => [e.name, e.activeVersion])).toEqual([['slow', 'S'], ['fast', 'F']]);
  });

  test('budget guard: once the wall-clock budget is exceeded no further version lookups are issued and the result is marked partial', async () => {
    const skills = [{ id: 'sk_a', name: 'a' }, { id: 'sk_b', name: 'b' }];
    const fetchFn = mockFetch(emptyLists('agentB', {
      // Every list call takes 15ms; with a 1ms budget phase 1 alone exhausts it.
      'GET /developer/skills/agentB': async () => { await sleep(15); return jsonResponse({ skills }); },
      'GET /developer/jobs/agentB': () => jsonResponse({ success: true, data: { jobs: [{ id: 'job_1', name: 'nightly' }] } }),
      'GET /developer/skills/agentB/sk_a/versions': () => { throw new Error('must not be called'); },
      'GET /developer/skills/agentB/sk_b/versions': () => { throw new Error('must not be called'); },
      'GET /developer/jobs/agentB/job_1/versions': () => { throw new Error('must not be called'); },
    }));
    const result = await getDeploymentStatus.handler({ agentId: 'agentB' }, { fetchFn, budgetMs: 1 });
    const parsed = JSON.parse(result.content[0].text);

    const versionCalls = fetchFn.calls.map((c) => new URL(c.url).pathname).filter((p) => /\/(skills|jobs)\/agentB\/.+\/versions$/.test(p));
    expect(versionCalls).toEqual([]);
    expect(parsed.partial).toBe(true);
    expect(parsed.partialReason).toMatch(/budget of 1ms exceeded/);
    expect(parsed.partialReason).toMatch(/3 of 3 version lookups were not issued/);
    // Items are still listed, with a skipped error, in list order.
    expect(parsed.primitives.skill).toEqual([
      { name: 'a', id: 'sk_a', error: expect.stringMatching(/^skipped: wall-clock budget of 1ms/) },
      { name: 'b', id: 'sk_b', error: expect.stringMatching(/^skipped: wall-clock budget/) },
    ]);
    expect(parsed.primitives.job).toEqual([{ name: 'nightly', id: 'job_1', error: expect.stringMatching(/^skipped:/) }]);
    // Persona and the other empty types are unaffected.
    expect(parsed.persona).toEqual({ activeVersion: null, activeVersionCreatedAt: null, versionCount: 0 });
    expect(parsed.primitives.webhook).toEqual([]);
  });

  test('budget guard: a chunk already issued completes; only later chunks are skipped', async () => {
    const skills = Array.from({ length: 6 }, (_, i) => ({ id: `sk_${i}`, name: `s${i}` }));
    const routes = emptyLists('agentG', {
      'GET /developer/skills/agentG': () => jsonResponse({ skills }),
    });
    for (const s of skills) {
      // The first chunk of five is slow enough to blow a 10ms budget.
      routes[`GET /developer/skills/agentG/${s.id}/versions`] = async () => {
        await sleep(25);
        return jsonResponse({ versions: [{ version: '1.0.0', createdDate: '2026-01-01T00:00:00Z', isCurrent: true }] });
      };
    }
    const fetchFn = mockFetch(routes);
    const parsed = JSON.parse((await getDeploymentStatus.handler({ agentId: 'agentG' }, { fetchFn, budgetMs: 10 })).content[0].text);

    const versionCalls = fetchFn.calls.map((c) => new URL(c.url).pathname).filter((p) => p.endsWith('/versions') && p.includes('/skills/'));
    expect(versionCalls).toHaveLength(5);
    expect(parsed.primitives.skill.slice(0, 5).every((e) => e.activeVersion === '1.0.0')).toBe(true);
    expect(parsed.primitives.skill[5]).toEqual({ name: 's5', id: 'sk_5', error: expect.stringMatching(/^skipped:/) });
    expect(parsed.partial).toBe(true);
    expect(parsed.partialReason).toMatch(/1 of 6 version lookups were not issued/);
  });

  test('a per-item versions failure inside a chunk does not affect its siblings', async () => {
    const fetchFn = mockFetch(emptyLists('agentS', {
      'GET /developer/skills/agentS': () => jsonResponse({ skills: [{ id: 'sk_ok', name: 'ok' }, { id: 'sk_bad', name: 'bad' }, { id: 'sk_ok2', name: 'ok2' }] }),
      'GET /developer/skills/agentS/sk_ok/versions': () => jsonResponse({ versions: [{ version: '1.0.0', createdDate: '2026-01-01T00:00:00Z', isCurrent: true }] }),
      'GET /developer/skills/agentS/sk_bad/versions': () => jsonResponse({ success: false, error: { message: 'boom' } }, { status: 500 }),
      'GET /developer/skills/agentS/sk_ok2/versions': () => jsonResponse({ versions: [{ version: '2.0.0', createdDate: '2026-01-01T00:00:00Z', isCurrent: true }] }),
    }));
    const parsed = JSON.parse((await getDeploymentStatus.handler({ agentId: 'agentS' }, { fetchFn })).content[0].text);
    expect(parsed.primitives.skill.map((e) => e.name)).toEqual(['ok', 'bad', 'ok2']);
    expect(parsed.primitives.skill[0].activeVersion).toBe('1.0.0');
    expect(parsed.primitives.skill[1]).toEqual({ name: 'bad', id: 'sk_bad', error: expect.stringMatching(/lua-api 500: boom/) });
    expect(parsed.primitives.skill[2].activeVersion).toBe('2.0.0');
    expect(parsed.partial).toBeUndefined();
  });

  // The URL slot is the server id (:skillId etc.), never the name. The live
  // version is the one flagged isCurrent (skill) — there is no deployedAt.
  test('skill: uses primitive id in the versions URL and reports the isCurrent version as active', async () => {
    const fetchFn = mockFetch(emptyLists('agentX', {
      'GET /developer/skills/agentX': () => jsonResponse({ skills: [{ id: 'sk_1', name: 'weather' }] }),
      'GET /developer/skills/agentX/sk_1/versions': () => jsonResponse({
        versions: [
          { version: '2.0.0', createdDate: '2026-05-02T12:00:00Z', isCurrent: false },
          { version: '1.0.0', createdDate: '2026-04-01T00:00:00Z', isCurrent: true },
        ],
      }),
    }));
    const result = await getDeploymentStatus.handler({ agentId: 'agentX' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.primitives.skill[0]).toEqual({
      name: 'weather',
      id: 'sk_1',
      activeVersion: '1.0.0',
      activeVersionId: null,
      activeVersionCreatedAt: '2026-04-01T00:00:00Z',
      versionCount: 2,
    });

    const urls = fetchFn.calls.map((c) => c.url);
    expect(urls.some((u) => u.endsWith('/sk_1/versions'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/weather/versions'))).toBe(false);
  });

  test('webhook / trigger: isActive or activeVersionId decide; record-level `active` is reported as enabled', async () => {
    const fetchFn = mockFetch(emptyLists('agentW', {
      'GET /developer/webhooks/agentW': () => jsonResponse({ success: true, data: { webhooks: [{ id: 'wh_1', name: 'stripe', active: true }] } }),
      'GET /developer/webhooks/agentW/wh_1/versions': () => jsonResponse({
        success: true,
        data: { versions: [{ version: '1.2.0', webhookId: 'wh_1', createdAt: '2026-06-01T00:00:00Z', isActive: true }], activeVersionId: 'whv_9' },
      }),
      'GET /developer/triggers/agentW': () => jsonResponse({ success: true, data: { triggers: [{ id: 'tr_1', name: 'linear-ready', active: false, activeVersionId: 'tv_1' }] } }),
      'GET /developer/triggers/agentW/tr_1/versions': () => jsonResponse({
        success: true,
        data: { versions: [{ version: '1.0.0', versionId: 'tv_1', createdAt: '2026-06-02T00:00:00Z', isActive: false }], activeVersionId: 'tv_1' },
      }),
    }));
    const result = await getDeploymentStatus.handler({ agentId: 'agentW' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.primitives.webhook[0]).toMatchObject({ name: 'stripe', activeVersion: '1.2.0', enabled: true });
    // isActive:false but activeVersionId points at it → active by envelope
    expect(parsed.primitives.trigger[0]).toMatchObject({ name: 'linear-ready', activeVersion: '1.0.0', activeVersionId: 'tv_1', enabled: false });
  });

  test('workflow: `active` flag on the WorkflowVersion array; dynamic flag surfaced', async () => {
    const fetchFn = mockFetch(emptyLists('agentF', {
      'GET /developer/workflows/agentF': () => jsonResponse({ success: true, data: { workflows: [{ id: 'wf_1', name: 'outreach', active: true, dynamic: false, activeVersionId: 'wfv_2' }] } }),
      'GET /developer/workflows/agentF/wf_1/versions': () => jsonResponse({
        success: true,
        data: [
          { id: 'wfv_2', version: '2.0.0', active: true, createdAt: '2026-09-01T00:00:00Z' },
          { id: 'wfv_1', version: '1.0.0', active: false, createdAt: '2026-08-01T00:00:00Z' },
        ],
      }),
    }));
    const result = await getDeploymentStatus.handler({ agentId: 'agentF' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.primitives.workflow[0]).toEqual({
      name: 'outreach', id: 'wf_1', activeVersion: '2.0.0', activeVersionId: 'wfv_2',
      activeVersionCreatedAt: '2026-09-01T00:00:00Z', versionCount: 2, enabled: true, dynamic: false,
    });
  });

  test('persona: the isCurrent row is the active persona version', async () => {
    const fetchFn = mockFetch(emptyLists('agentP', {
      'GET /developer/agents/agentP/persona/versions': () => jsonResponse({
        status: 'success', message: 'ok',
        versions: [
          { version: 3, createdDate: 1777593600000, isCurrent: true, persona: 'v3' },
          { version: 2, createdDate: 1777507200000, isCurrent: false, persona: 'v2' },
        ],
      }),
    }));
    const result = await getDeploymentStatus.handler({ agentId: 'agentP' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.persona).toEqual({ activeVersion: 3, activeVersionCreatedAt: '2026-05-01T00:00:00.000Z', versionCount: 2 });
  });

  test('reports primitives with no active version as activeVersion: null', async () => {
    const fetchFn = mockFetch(emptyLists('agentY', {
      'GET /developer/skills/agentY': () => jsonResponse({ skills: [{ id: 'sk_undeployed', name: 'draft' }] }),
      'GET /developer/skills/agentY/sk_undeployed/versions': () => jsonResponse({
        versions: [{ version: '0.1.0', createdDate: '2026-05-02T00:00:00Z', isCurrent: false }],
      }),
    }));
    const result = await getDeploymentStatus.handler({ agentId: 'agentY' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.primitives.skill[0]).toEqual({
      name: 'draft',
      id: 'sk_undeployed',
      activeVersion: null,
      activeVersionId: null,
      activeVersionCreatedAt: null,
      versionCount: 1,
    });
  });

  test('records the per-type error when a list endpoint fails (does not abort the rest)', async () => {
    const fetchFn = mockFetch(emptyLists('agentZ', {
      'GET /developer/skills/agentZ': () => jsonResponse({ error: 'denied' }, { status: 403 }),
      'GET /developer/agents/agentZ/persona/versions': () => jsonResponse({ error: 'denied' }, { status: 403 }),
    }));
    const result = await getDeploymentStatus.handler({ agentId: 'agentZ' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.primitives.skill).toEqual({ error: expect.stringMatching(/MCP_FORBIDDEN/) });
    expect(parsed.persona).toEqual({ error: expect.stringMatching(/MCP_FORBIDDEN/) });
    // Other types still report empty arrays (not aborted).
    expect(parsed.primitives.webhook).toEqual([]);
    expect(parsed.primitives.job).toEqual([]);
    expect(parsed.primitives.workflow).toEqual([]);
  });

  test('records a per-item error when one versions call fails', async () => {
    const fetchFn = mockFetch(emptyLists('agentV', {
      'GET /developer/jobs/agentV': () => jsonResponse({ success: true, data: { jobs: [{ id: 'job_1', name: 'nightly' }] } }),
      'GET /developer/jobs/agentV/job_1/versions': () => jsonResponse({ success: false, error: { message: 'boom' } }, { status: 500 }),
    }));
    const result = await getDeploymentStatus.handler({ agentId: 'agentV' }, { fetchFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.primitives.job[0]).toEqual({ name: 'nightly', id: 'job_1', error: expect.stringMatching(/lua-api 500/) });
  });

  test('encodes the agentId in the URL', async () => {
    const fetchFn = mockFetch(emptyLists('agent%2Ftricky'));
    const result = await getDeploymentStatus.handler({ agentId: 'agent/tricky' }, { fetchFn });
    expect(result.content[0].text).toContain('"agentId": "agent/tricky"');
  });
});

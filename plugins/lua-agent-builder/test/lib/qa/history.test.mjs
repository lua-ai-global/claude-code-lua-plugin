import { fetchThreadHistory, normaliseHistory, threadMatches, toolCallsForTurn, userTextMatches } from '../../../lib/qa/history.mjs';

const T = 'qa-9f3c-icp-01-r1-aaaaaa';
const resp = (body, status = 200) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) });
const depsFor = (fetch) => ({ resolveBearer: async () => 'tok', fetch });

// Synthetic payload shapes (ids replaced). Both stored thread forms appear.
const payload = {
  success: true,
  data: [
    { role: 'user', threadId: `u1-agent_x:${T}`, content: [{ type: 'text', text: 'Where is order 1042?' }], createdAt: '2026-10-07T14:00:00Z' },
    { role: 'assistant', threadId: `u1-agent_x:${T}`, content: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'get_order', input: { id: 1042 } },
      { type: 'text', text: 'Let me look.' },
    ] },
    { role: 'tool', threadId: `u1-agent_x:${T}`, content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'get_order', output: { status: 'shipped', items: 3 } }] },
    { role: 'assistant', threadId: `u1-agent_x:${T}`, content: 'It shipped with 3 items.' },
    { role: 'user', threadId: `u1-agent_x:${T}`, content: [{ type: 'text', text: 'Cancel it' }] },
    { role: 'assistant', threadId: `u1-agent_x:${T}`, content: [{ type: 'tool-invocation', toolInvocation: { toolName: 'cancel_order', args: { id: 1042 }, result: { error: 'too late' }, state: 'result' } }] },
    { role: 'user', threadId: 'other-thread', content: [{ type: 'text', text: 'someone else' }] },
  ],
};

describe('threadMatches', () => {
  test('bare and prefixed forms', () => {
    expect(threadMatches(T, T)).toBe(true);
    expect(threadMatches(`u-a:${T}`, T)).toBe(true);
    expect(threadMatches('u-a:other', T)).toBe(false);
    expect(threadMatches(null, T)).toBe(false);
  });
});

describe('normaliseHistory', () => {
  const msgs = normaliseHistory(payload, { thread: T });
  test('filters to the thread client-side and keeps both stored forms', () => {
    expect(msgs).toHaveLength(6);
    expect(msgs.every((m) => m.threadId.endsWith(T))).toBe(true);
    expect(normaliseHistory({ data: [{ role: 'user', threadId: T, content: 'x' }] }, { thread: T })).toHaveLength(1);
  });
  test('merges tool results into the calls by id and keeps text', () => {
    const asst = msgs[1];
    expect(asst.toolCalls).toEqual([{ name: 'get_order', input: { id: 1042 }, output: { status: 'shipped', items: 3 }, status: 'ok' }]);
    expect(asst.text).toBe('Let me look.');
    expect(msgs[3].text).toBe('It shipped with 3 items.');
  });
  test('tool-invocation parts and error outputs', () => {
    expect(msgs[5].toolCalls).toEqual([{ name: 'cancel_order', input: { id: 1042 }, output: { error: 'too late' }, status: 'error' }]);
  });
  test('without thread ids nothing is filtered', () => {
    const noThread = normaliseHistory([{ role: 'user', content: 'a' }, { role: 'ai', content: 'b' }], { thread: T });
    expect(noThread.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
  test('unknown roles, shapes, unmatched results and alternative payload wrappers', () => {
    const out = normaliseHistory({ messages: [
      { role: 'weird', content: [{ type: 'text', text: 's' }] },
      { role: 'function', parts: [{ type: 'tool-result', toolName: 't', result: 'plain', isError: true }] },
      { role: 'human', text: 'q' },
      { role: 'assistant', content: { type: 'text', text: 'obj' } },
      { role: 'assistant', content: [{ type: 'tool', name: 'n', args: { a: 1 } }, 'bare string', null, { type: 'step-start' }] },
      { role: 'assistant', content: 42 },
    ] });
    expect(out[0].role).toBe('system');
    expect(out[1].toolCalls[0]).toMatchObject({ name: 't', output: 'plain', status: 'error' });
    expect(out[2]).toMatchObject({ role: 'user', text: 'q' });
    expect(out[3].text).toBe('obj');
    expect(out[4].toolCalls[0]).toMatchObject({ name: 'n', status: 'unknown' });
    expect(out[4].text).toBe('bare string');
    expect(normaliseHistory({ data: { messages: [{ role: 'user', content: 'a' }] } })).toHaveLength(1);
    expect(normaliseHistory('garbage')).toEqual([]);
    expect(normaliseHistory({ data: [{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'a', output: { status: 'error' } }] }] })[0].toolCalls[0].status).toBe('error');
  });
});

describe('userTextMatches / toolCallsForTurn', () => {
  test('whitespace and 300-char cut; placeholder prefix rule', () => {
    expect(userTextMatches('  hello   world ', 'hello world')).toBe(true);
    expect(userTextMatches('x'.repeat(400), 'x'.repeat(300))).toBe(true);
    expect(userTextMatches('my key [a secret you pasted: hidden]', 'my key sk_live_x')).toBe(true);
    expect(userTextMatches('other', 'hello')).toBe(false);
    expect(userTextMatches('', 'hello')).toBe(false);
  });
  const msgs = normaliseHistory(payload, { thread: T });
  test('tool calls between the matching user message and the next', () => {
    expect(toolCallsForTurn(msgs, { userText: 'Where is order 1042?' }).map((c) => c.name)).toEqual(['get_order']);
    expect(toolCallsForTurn(msgs, { userText: 'Cancel it' }).map((c) => c.name)).toEqual(['cancel_order']);
    expect(toolCallsForTurn(msgs, { userText: 'never sent' })).toBeNull();
  });
  test('system-injected bracket messages do not end the turn when nextUserText is given', () => {
    const m = normaliseHistory([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'a' }] },
      { role: 'user', content: '[Inbox answer] yes' },
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'b' }] },
      { role: 'user', content: 'thanks' },
    ]);
    expect(toolCallsForTurn(m, { userText: 'go', nextUserText: 'thanks' }).map((c) => c.name)).toEqual(['a', 'b']);
    expect(toolCallsForTurn(m, { userText: 'go' }).map((c) => c.name)).toEqual(['a']);
    expect(toolCallsForTurn(m, { userText: 'go', nextUserText: 'zzz' }).map((c) => c.name)).toEqual(['a', 'b']);
  });
});

describe('fetchThreadHistory', () => {
  test('scoped when messages carry thread ids; sends ?threadId=', async () => {
    let url;
    const r = await fetchThreadHistory({ agentId: 'agent_x', thread: T, deps: depsFor(async (u) => { url = u; return resp(payload); }) });
    expect(url).toMatch(/\/chat\/history\/agent_x\?threadId=qa-9f3c/);
    expect(r).toMatchObject({ source: 'history', scoped: true });
    expect(r.messages).toHaveLength(6);
  });
  test('unscoped when the payload has no thread ids', async () => {
    const r = await fetchThreadHistory({ agentId: 'agent_x', thread: T, deps: depsFor(async () => resp([{ role: 'user', content: 'a' }])) });
    expect(r).toMatchObject({ source: 'history', scoped: false });
  });
  test('route errors and a missing agent id are unavailable', async () => {
    const r = await fetchThreadHistory({ agentId: 'agent_x', thread: T, deps: depsFor(async () => resp({ message: 'no' }, 404)) });
    expect(r).toMatchObject({ source: 'unavailable', scoped: false });
    expect(r.error).toMatch(/API_404/);
    expect(await fetchThreadHistory({ agentId: null, thread: T })).toMatchObject({ source: 'unavailable', error: 'no agent id' });
    const r2 = await fetchThreadHistory({ agentId: 'a', thread: T, deps: { resolveBearer: async () => { throw Object.assign(new Error('x'), {}); }, fetch: async () => resp({}) } });
    expect(r2.source).toBe('unavailable');
  });
});

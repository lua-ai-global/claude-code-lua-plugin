import { join } from 'node:path';
import {
  CAP_RE, analyze, auditPhrases, auditRefs, auditRun, auditTurn, canon, claimsForRun, cliClaims, factsFromToolCalls, normNumber, referencesIn, stem,
} from '../../../lib/qa/claims.mjs';
import { readJson } from '../../../lib/qa/io.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { flowModel, mkio } from './fixtures/runtime-helpers.mjs';
import { seeded, turnRow } from './fixtures/runtime-seed.mjs';

// Facts are what the tools returned: the python selftest facts rewritten as tool outputs.
const call = (output, name = 'health_scan') => ({ name, input: {}, output, status: 'ok' });
const facts = (...outputs) => factsFromToolCalls(outputs.map((o) => call(o)));
const F8w = { id: 'health.warnings', kind: 'count', value: 8, unit: 'warnings', source: 'health scan' };
const F7l = { id: 'health.failedLookups', kind: 'count', value: 7, unit: 'failed lookups', source: 'health scan' };

describe('auditTurn (port of the source selftest)', () => {
  test('a number must match the unit it is read with', () => {
    const f = facts(F8w, F7l);
    const r = auditTurn('There are 7 warnings this week.', '', f);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/^7 warning \(facts have 7 as: failed lookup/);
    expect(r[0]).toContain('warning is 8');
    expect(auditTurn('There are 8 warnings.', '', f)).toEqual([]);
    expect(auditTurn('I found 7 failed lookups.', '', f)).toEqual([]);
    expect(auditTurn('7 errors', '', facts({ kind: 'count', value: 7, unit: 'warnings' }))).not.toEqual([]);
  });
  test('a 7-day window backs "7 days", not "7 warnings"', () => {
    for (const W of [{ id: 'w', kind: 'window', value: '7-day', window: { covers: 'last 7 days' } },
      { id: 'w', kind: 'window', value: 7, unit: 'days', window: { covers: 'last 7 days' } }]) {
      const f = facts(W);
      const r = auditTurn('You had 7 warnings.', '', f);
      expect(r).toHaveLength(1);
      expect(r[0]).toContain('(facts have 7 as:');
      expect(auditTurn('Over the last 7 days, nothing broke.', '', f)).toEqual([]);
      expect(auditTurn('This is the 7-day window.', '', f)).toEqual([]);
    }
  });
  test('a bare number is backed by any fact or the user message', () => {
    const f = facts({ kind: 'count', value: 52, unit: 'messages' });
    expect(auditTurn('The total is 52.', '', f)).toEqual([]);
    expect(auditTurn('The total is 53.', '', f)).toEqual(['53']);
  });
  test('echoes from the user message', () => {
    expect(auditTurn('Yes, 12 times it is.', 'I count 12 times', [])).toEqual([]);
    expect(auditTurn('12 warnings', 'I count 12 times', [])).toEqual(['12 warning']);
    expect(auditTurn('It was 12.', 'I count 12 times', [])).toEqual([]);
    expect(auditTurn('12 warnings', 'what about 12?', [])).toEqual(['12 warning']);
  });
  test('ids, times, versions and dates are ignored', () => {
    expect(auditTurn('Ticket BT-1043 at 09:29 on version 1.0.3, see 2026-10-02.', '', [])).toEqual([]);
  });
  test('numbers inside a fact text', () => {
    const f = facts({ id: 'ia', kind: 'count', value: 11, unit: 'attempts', source: '11 instruction attempts (9 messages + 2 order records)' });
    expect(auditTurn('11 instruction attempts so far.', '', f)).toEqual([]);
    expect(auditTurn('That includes 9 messages.', '', f)).toEqual([]);
    expect(auditTurn('and 2 order records', '', f)).toEqual([]);
    const r = auditTurn('9 tickets', '', f);
    expect(r[0]).toMatch(/^9 ticket \(facts have 9 as: message/);
  });
  test('synonyms, stemming, percent, list numbering, number words, short units', () => {
    expect(auditTurn('3 failures', '', facts({ kind: 'count', value: 3, unit: 'errors' }))).toEqual([]);
    expect(auditTurn('40% of runs', '', facts({ kind: 'rate', value: 40, unit: 'percent' }))).toEqual([]);
    expect(auditTurn('40 percent', '', facts({ kind: 'rate', value: 40, unit: '%' }))).toEqual([]);
    expect(auditTurn('1. first\n2. second', '', [])).toEqual([]);
    expect(auditTurn('seven warnings', '', facts(F8w))).toEqual(['7 warning']);
    expect(auditTurn('24h ago', '', facts({ kind: 'window', value: 24, unit: 'hours' }))).toEqual([]);
  });
  test('filler is skipped when choosing the unit', () => {
    expect(analyze('7 of the failed lookups').occ).toEqual([{ n: '7', units: ['failed', 'lookup'] }]);
  });
  test('the number 1 is always fine', () => {
    expect(auditTurn('I found 1 thing.', '', [])).toEqual([]);
  });
  test('a bare number with no facts is unbacked; decimals and thousands separators normalise', () => {
    expect(auditTurn('Total 1,250.', '', [])).toEqual(['1250']);
    expect(auditTurn('Total 4.5 hours', '', facts({ hours: 4.5 }))).toEqual([]);
    expect(normNumber('1,250')).toBe('1250');
    expect(normNumber('x')).toBe('x');
  });
});

describe('analyze / stem / canon', () => {
  test('stems', () => {
    expect(['batches', 'ties', 'statuses', 'hrs', 'mins', 'cats', 'glass', "agent's", '%'].map(stem)).toEqual(['batch', 'tie', 'statuse', 'hr', 'min', 'cat', 'glass', 'agent', 'percent']);
    expect([...canon(['failure', 'time', 'hr'])].sort()).toEqual(['attempt', 'error', 'hour']);
  });
  test('residual words are the non-unit words', () => {
    expect(analyze('There are 3 open tickets today').residual).toEqual(['there', 'today']);
  });
});

describe('factsFromToolCalls', () => {
  test('walks nested outputs, numeric strings, JSON-string outputs; ignores errors without output', () => {
    const f = factsFromToolCalls([
      call({ summary: { openTickets: 3, label: 'Queue', items: [{ unit: 'minutes', value: 12 }] }, note: 'resolved 4 cases', code: '17' }),
      { name: 'x', output: JSON.stringify({ failedLookups: 2 }) },
      { name: 'y', output: '{broken' },
      { name: 'z', output: null },
    ]);
    const have = (n) => f.filter((o) => o.n === n);
    expect(have('3')[0].ctx.has('ticket')).toBe(true);
    expect(have('12')[0].label).toBe('minute');
    expect(have('4')[0].ctx.has('ticket')).toBe(true); // case is a synonym of ticket
    expect(have('17').length).toBeGreaterThanOrEqual(1);
    expect(have('2')[0].ctx.has('lookup')).toBe(true);
    expect(factsFromToolCalls(undefined)).toEqual([]);
  });
});

describe('capability phrases', () => {
  test('CAP_RE', () => {
    const m = (s) => [...s.matchAll(CAP_RE)].map((x) => x[0]);
    expect(m("I've sent it. I have booked a slot. I can't help. It is now live.")).toEqual(["I've sent", 'I have booked', "I can't", 'is now live']);
    expect(m('Nothing to see.')).toEqual([]);
  });
  const model = flowModel();
  test('an action phrase needs a tool with a side effect in the same turn', () => {
    const none = [call({}, 'get_order')];
    const effect = [call({}, 'cancel_order')];
    expect(auditPhrases("I've cancelled it.", none, model, { verifiable: true })).toEqual(["I've cancelled"]);
    expect(auditPhrases("I've updated your order.", none, model, { verifiable: true })).toEqual(["I've updated"]);
    expect(auditPhrases("I've updated your order.", effect, model, { verifiable: true })).toEqual([]);
    expect(auditPhrases("I've updated your order.", [{ name: 'cancel_order', status: 'error' }], model, { verifiable: true })).toEqual(["I've updated"]);
    expect(auditPhrases("I've updated your order.", [{ name: 'unknown_tool', status: 'ok' }], model, { verifiable: true })).toEqual([]);
    expect(auditPhrases("I've updated it.", [{ name: 'x', status: 'ok' }], null, { verifiable: true })).toEqual([]);
  });
  test('an inability phrase is a candidate unless a tool returned an error that turn', () => {
    expect(auditPhrases("I can't do that.", [call({}, 'get_order')], model, { verifiable: true })).toEqual(["I can't"]);
    expect(auditPhrases("I can't do that.", [{ name: 'get_order', status: 'error' }], model, { verifiable: true })).toEqual([]);
    expect(auditPhrases('I am unable to help.', undefined, model, { verifiable: true })).toEqual(['I am unable to']);
  });
  test('unverifiable turns report every phrase as a candidate', () => {
    expect(auditPhrases("I've sent it and I can't undo it.", [], model, { verifiable: false })).toEqual(["I can't", "I've sent"]);
  });
});

describe('auditRun', () => {
  test('verifiable turns: only unbacked items count', () => {
    const rows = [
      turnRow(1, { user: 'orders?', reply: 'You have 3 open tickets.', toolCalls: [call({ openTickets: 3 })] }),
      turnRow(2, { user: 'and?', reply: 'You have 5 open tickets.', toolCalls: [call({ openTickets: 3 })] }),
      turnRow(3, { user: 'cancel', reply: "I've cancelled it.", toolCalls: [call({}, 'get_order')] }),
    ];
    const r = auditRun(rows, flowModel());
    expect(r).toMatchObject({ status: 'ok', total: 2 });
    expect(r.turns[0]).toMatchObject({ turn: 1, unbackedNumbers: [], unbackedPhrases: [] });
    expect(r.turns[1].unbackedNumbers[0]).toMatch(/^5 open ticket|^5 open/);
    expect(r.turns[2].unbackedPhrases).toEqual(["I've cancelled"]);
    expect(validate('claims', r)).toEqual({ ok: true });
  });
  test('unavailable tool calls make the run unverifiable and every number a candidate', () => {
    const rows = [turnRow(1, { user: 'hi', reply: 'You have 5 open tickets.', toolCalls: null, toolCallSource: 'unavailable' })];
    const r = auditRun(rows);
    expect(r.status).toBe('unverifiable');
    expect(r.total).toBe(1);
  });
  test('test-session turns (names only) are unverifiable too', () => {
    const rows = [turnRow(1, { reply: 'Fine.', toolCalls: [{ name: 'a', input: null, output: null, status: 'unknown' }], toolCallSource: 'test-session' })];
    expect(auditRun(rows, flowModel()).status).toBe('unverifiable');
  });
});

describe('cliClaims', () => {
  test('writes checks/claims.json; exit 1 when anything is unbacked', async () => {
    const s = await seeded({ rows: [turnRow(1, { user: 'hi', reply: 'You have 9 open tickets.', toolCalls: [call({ openTickets: 3 })] })] });
    const t = mkio();
    expect(await cliClaims(['--run-dir', s.runDir, '--card', 'icp-01', '--run', '1'], t.io)).toBe(1);
    expect(t.json()).toMatchObject({ ok: false, total: 1, status: 'ok' });
    expect((await readJson(join(s.dir, 'checks', 'claims.json'))).total).toBe(1);
    const clean = await seeded({ rows: [turnRow(1, { user: 'hi', reply: 'Hello.', toolCalls: [] })] });
    expect(await cliClaims(['--run-dir', clean.runDir, '--card', 'icp-01', '--run', '1'], mkio().io)).toBe(0);
    expect((await claimsForRun({ runDir: clean.runDir, cardId: 'icp-01', k: 1 })).result.total).toBe(0);
  });
  test('usage', async () => {
    expect(await cliClaims([], mkio().io)).toBe(2);
  });
});

describe('reference claims (tickets and links) and logged tool calls', () => {
  const model = flowModel();
  test('referencesIn finds ticket ids and links, skipping standards and de-duplicating', () => {
    expect(referencesIn('Your ticket number is ITD-1042 (ITD-1042). Read https://help.example.com/reset. Case #55123, SHA-256 and ISO-8601.')).toEqual([
      { kind: 'ticket', ref: '55123' }, { kind: 'ticket', ref: 'ITD-1042' }, { kind: 'link', ref: 'https://help.example.com/reset' },
    ]);
    expect(referencesIn(undefined)).toEqual([]);
  });
  test('auditRefs: backed by tool input/output or the user, confirmed when no tool ran', () => {
    const calls = [{ name: 'open_ticket', input: { link: 'https://portal.example.com/x' }, output: { ticketId: 'ITD-1042' }, status: 'ok' }];
    expect(auditRefs('Ticket ITD-1042, see https://portal.example.com/x', '', calls, { verifiable: true })).toEqual([]);
    expect(auditRefs('Ticket ITD-9999 is open.', '', calls, { verifiable: true })).toEqual([{ kind: 'ticket', ref: 'ITD-9999', confirmed: false }]);
    expect(auditRefs('Ticket ITD-1042 is open.', 'what about ITD-1042?', [], { verifiable: true })).toEqual([]);
    expect(auditRefs('I raised ticket ITD-1042.', 'help', [], { verifiable: true })).toEqual([{ kind: 'ticket', ref: 'ITD-1042', confirmed: true }]);
    expect(auditRefs('I raised ticket ITD-1042.', 'help', undefined, { verifiable: true })[0].confirmed).toBe(true);
    expect(auditRefs('Ticket ITD-1042.', '', calls, { verifiable: false })).toEqual([{ kind: 'ticket', ref: 'ITD-1042', confirmed: false }]);
  });
  test('CAP_RE covers raised/opened/reset and passive ticket phrasing', () => {
    const m = (s) => [...s.matchAll(CAP_RE)].map((x) => x[0]);
    expect(m("I've raised it. I have reset your password. Your ticket has been created.")).toEqual(["I've raised", 'I have reset', 'ticket has been created']);
  });
  test('logs-window turns are verifiable: zero calls confirms the action and the ticket; a {sent:false} call backs nothing', () => {
    const rows = [
      turnRow(1, { user: 'my VPN is down', reply: "I've raised ticket ITD-1042 for you.", toolCalls: [], toolCallSource: 'logs-window' }),
      turnRow(2, { user: 'reset please', reply: "I've sent the reset link.", toolCallSource: 'logs-window',
        toolCalls: [{ name: 'cancel_order', input: { workEmail: 'dana@example.com' }, output: { sent: false }, status: 'error', executionId: 'e1' }] }),
      turnRow(3, { user: 'thanks', reply: "I can't help with that.", toolCalls: [], toolCallSource: 'logs-runid' }),
    ];
    const r = auditRun(rows, model);
    expect(r.status).toBe('ok');
    expect(r.turns[0]).toMatchObject({ toolCallSource: 'logs-window', toolCalls: 0, unbackedPhrases: ["I've raised"], unbackedRefs: [{ kind: 'ticket', ref: 'ITD-1042', confirmed: true }], confirmed: ["I've raised", 'ticket ITD-1042'] });
    expect(r.turns[1]).toMatchObject({ unbackedPhrases: ["I've sent"], confirmed: [] });
    expect(r.turns[2]).toMatchObject({ unbackedPhrases: ["I can't"], confirmed: [] });
    expect(r.confirmedUnbacked).toBe(2);
    expect(r.total).toBe(4);
    expect(validate('claims', r)).toEqual({ ok: true });
  });
  test('cliClaims prints confirmedUnbacked', async () => {
    const s = await seeded({ rows: [turnRow(1, { user: 'hi', reply: "I've raised ticket ITD-1042.", toolCalls: [], toolCallSource: 'logs-window' })] });
    const t = mkio();
    expect(await cliClaims(['--run-dir', s.runDir, '--card', 'icp-01', '--run', '1'], t.io)).toBe(1);
    expect(t.json()).toMatchObject({ total: 2, confirmedUnbacked: 2, status: 'ok' });
  });
});

describe('confirmation across turns', () => {
  const model = flowModel();
  const L = (n, over) => turnRow(n, { toolCallSource: 'logs-window', toolCalls: [], ...over });
  test('a recap of a ticket a tool returned earlier is backed; a repeat of an unbacked id is not confirmed twice', () => {
    const rows = [
      L(1, { user: 'VPN down', reply: "I've created ticket ITD-1042.", toolCalls: [{ name: 'cancel_order', input: {}, output: { ticketId: 'ITD-1042' }, status: 'ok', executionId: 'e1' }] }),
      L(2, { user: 'thanks', reply: 'Anything else?' }),
      L(3, { user: 'status?', reply: 'Your ticket ITD-1042 is still open, and I\'ve updated it.' }),
    ];
    const r = auditRun(rows, model);
    expect(r.turns[2]).toMatchObject({ unbackedRefs: [], unbackedPhrases: ["I've updated"], confirmed: [] });
    expect(r.confirmedUnbacked).toBe(0);
    const repeat = auditRun([L(1, { user: 'hi', reply: 'Ticket ITD-7 is ITD-2001.' }), L(2, { user: 'and?', reply: 'Again: ITD-2001.' })], model);
    expect(repeat.turns[0].confirmed).toEqual(['ticket ITD-2001']);
    expect(repeat.turns[1]).toMatchObject({ unbackedRefs: [{ kind: 'ticket', ref: 'ITD-2001', confirmed: false }], confirmed: [] });
  });
  test('an earlier unverifiable turn, a stray call near the window, or a link: never confirmed', () => {
    const after = auditRun([turnRow(1, { toolCalls: null, toolCallSource: 'unavailable', reply: 'ok' }), L(2, { user: 'x', reply: "I've raised ticket ITD-3001." })], model);
    expect(after.turns[1]).toMatchObject({ unbackedPhrases: ["I've raised"], confirmed: [] });
    const stray = auditRun([L(1, { user: 'x', reply: "I've raised ticket ITD-3001.", toolCallWindow: { unattributed: 1 } })], model);
    expect(stray.confirmedUnbacked).toBe(0);
    const link = auditRun([L(1, { user: 'x', reply: 'See https://help.example.com/vpn' })], model);
    expect(link.turns[0]).toMatchObject({ unbackedRefs: [{ kind: 'link', confirmed: false }], confirmed: [] });
  });
});

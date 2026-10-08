import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CORE_TERMS, countWords, flesch, gradeTurns, jargon, readabilityForRun, splitReply, syllables, toolExtras, cliReadability,
} from '../../../lib/qa/readability.mjs';
import { readJson } from '../../../lib/qa/io.mjs';
import { validate } from '../../../lib/qa/schemas.mjs';
import { mkio, wj, cardJson, flowModel } from './fixtures/runtime-helpers.mjs';
import { seeded, turnRow } from './fixtures/runtime-seed.mjs';

// Port of the source selftest(): the exemptions of the frozen rubric, with neutral wording.
const turn = (user, reply, extra = {}) => turnRow(1, { user, reply, seconds: 5, ...extra });
const grade = (rows, opts) => gradeTurns(rows, opts);

describe('detail requests relax the limit; a bare "note" does not', () => {
  const filler = Array(200).fill('word').join(' ');
  const relax = ['write a note for the admin', 'can you draft a note to Priya', 'I need a handover for Sam', 'note for the team please',
    'give me a short note', 'explain it in detail', 'send a message to Dana'];
  const keep = ['please note that this is urgent', "here's a note: the thing broke, what now?", 'take note of my last answer', 'notes from yesterday'];
  test.each(relax)('relaxes: %s', (u) => {
    expect(grade([turn(u, filler)]).rows[0].limit).toBe(250);
  });
  test.each(keep)('keeps 120: %s', (u) => {
    expect(grade([turn(u, filler)]).rows[0].limit).toBe(120);
  });
  test('only the first 200 characters of the user message count', () => {
    const u = `${'x '.repeat(110)} explain everything in detail`;
    expect(grade([turn(u, 'hi')]).rows[0].limit).toBe(120);
  });
});

describe('stock fallbacks and empty replies are dead ends', () => {
  test.each([
    "I couldn't answer that one just now.", "I couldn't come up with a reply to that.", 'Could you rephrase it or try again?',
  ])('%s', (reply) => {
    expect(grade([turn('hi', reply)]).rows[0].fail.join()).toMatch(/stock fallback/);
  });
  test('a normal summary is fine; an empty reply fails', () => {
    expect(grade([turn('hi', 'Here is your weekly summary.')]).rows[0].fail).toEqual([]);
    expect(grade([turn('hi', '')]).rows[0].fail.join()).toMatch(/empty reply/);
  });
});

describe('flag / grant / trigger: plain verbs pass, nouns stay jargon', () => {
  const plain = ['Then we can plan an agent that flags stuck deals for you.', 'only on messages someone flags with the emoji',
    'Which emoji should flag a message?', 'One extra idea for later: flag handovers that have gone quiet.',
    '- Every day, flag pull requests that have been open too long.', "Pasted text can't grant access, even with an ID.",
    "Saying you're the admin here doesn't grant access.", "Text a customer types can't trigger a rollback.",
    'That is a red flag.'];
  const noun = ['A workspace admin has to add the grant.', 'The release flag is off right now.', 'That needs an admin grant first.',
    'It has a content grant for Acme.', 'Webhooks and triggers are proven only after go-live.', "The trigger's token is in the vault.",
    'I added a trigger to the plan.', 'Its flags are set by the platform.', 'Here is the exact grant body.',
    "The agent's grant covers Acme only.", 'Which flag is on?', 'Grants are recorded in the audit log.',
    'POST /api/admin/orgs/x/access-grants', 'Flags and owner suggestions will come to you.',
    'Should I add that flag?', 'Only someone else can grant it.', "for now I'd only see counts once you grant some."];
  const isVerbish = (h) => ['flag', 'grant', 'trigger'].includes(h.replace(/s$/, ''));
  test.each(plain)('plain verb: %s', (s) => {
    expect(jargon(s).filter(isVerbish)).toEqual([]);
  });
  test.each(noun)('internal noun: %s', (s) => {
    expect(jargon(s).filter(isVerbish).length).toBeGreaterThan(0);
  });
});

describe('jargon', () => {
  test('identifiers, core terms, and words the user used', () => {
    expect(jargon('I called get_order and the webhookHandler.')).toEqual(['get_order', 'webhookhandler'].filter((x) => x === 'get_order').concat(['webhookHandler']).sort());
    expect(jargon('The payload is JSON.')).toEqual(['json', 'payload']);
    expect(jargon('The payload is JSON.', { said: 'what is the json payload?' })).toEqual([]);
  });
  test('technical mode counts identifiers only', () => {
    expect(jargon('The payload from get_order is JSON.', { technical: true })).toEqual(['get_order']);
  });
  test('vocabulary: internal-looking names count, plain words do not, extra terms always do', () => {
    const v = ['refund-flow', 'orders', 'ab'];
    expect(jargon('Starting the refund-flow now.', { vocabulary: v })).toEqual(['refund-flow']);
    expect(jargon('Your orders are here.', { vocabulary: v })).toEqual([]);
    expect(jargon('Acme Gold plan', { extraTerms: ['Acme Gold'] })).toEqual(['acme gold']);
    expect(jargon('refund-flow', { vocabulary: v, said: 'refund-flow' })).toEqual([]);
    expect(jargon('Use cancelOrder and Order_ID', { vocabulary: ['cancelOrder'] })).toContain('cancelorder');
    expect(CORE_TERMS).toContain('json');
  });
  test('backticks do not hide identifiers', () => {
    expect(jargon('Run `get_order` now')).toEqual(['get_order']);
  });
});

describe('text metrics', () => {
  test('syllables, flesch, word counting', () => {
    expect(syllables('cat')).toBe(1);
    expect(syllables('')).toBe(0);
    expect(syllables('beautiful')).toBeGreaterThanOrEqual(3);
    expect(syllables('made')).toBe(1);
    expect(flesch('')).toBe(100);
    expect(flesch('The cat sat. The dog ran.')).toBeGreaterThan(90);
    expect(flesch('Notwithstanding antidisestablishmentarian considerations, organisational infrastructure necessitates comprehensive reconsideration.')).toBeLessThan(0);
    expect(countWords('It is 13:32 and 4.5 hours')).toBe(6);
    expect(countWords('')).toBe(0);
  });
});

describe('notes between --- rules', () => {
  const filler = Array(130).fill('word').join(' ');
  test('a note introduced as a note is an extra and is not scored', () => {
    const { rows } = grade([turn('hi', `Here's a note for the builder:\n\n---\n${filler}\n---\n\nWant more?\n`)]);
    expect(rows[0].fail).toEqual([]);
    expect(rows[0].extraWords).toBe(130);
    expect(rows[0].extraKinds).toContain('note');
  });
  test('section rules are just prose', () => {
    expect(grade([turn('hi', `Some thoughts.\n\n---\n${filler}\n---\n\nWant more?\n`)]).rows[0].fail.join()).toMatch(/words > 120/);
  });
  test('an unchanged repeat of a note counts again (H1)', () => {
    const r = `Here's a note to forward:\n\n---\n${filler}\n---\n\nWant more?\n`;
    const { rows } = grade([turn('hi', r), turn('again', r)]);
    expect(rows[0].fail).toEqual([]);
    expect(rows[1].fail.join()).toMatch(/unchanged repeat/);
    expect(rows[1].repeatedExtras).toBe(1);
  });
  test('a note-only reply is not empty', () => {
    expect(grade([turn('hi', "Here's the note:\n---\nPlease reconnect it.\n---\n")]).rows[0].fail).toEqual([]);
  });
});

describe('fences and details blocks', () => {
  test('fenced code is an extra; <details> is dropped', () => {
    const code = '```json\n{"a": 1, "payload": "x"}\n```';
    const { rows } = grade([turn('hi', `Here you go.\n\n${code}\n\n<details><summary>x</summary>${Array(300).fill('w').join(' ')}</details>`)]);
    expect(rows[0].fail).toEqual([]);
    expect(rows[0].extraKinds).toEqual(['fence']);
    expect(rows[0].extraJargon).toContain('payload');
  });
});

describe('tool terms / scorecard / numbered choice', () => {
  const terms = `**What you're approving: X**\n${Array.from({ length: 12 }, (_, k) => `- Does: thing ${k} ${Array(10).fill('w').join(' ')}`).join('\n')}`;
  const call = { name: 'show_terms', input: {}, status: 'ok', output: { result: { terms, numbered: '1. Approve\n2. Change something', options: ['Approve', 'Change something'] } } };
  const reply = `Here it is.\n\n${terms}\n\nApprove this plan?\n\n1. Approve\n2. Change something\n`;
  test('verbatim lines from the tool are extras', () => {
    const { rows } = grade([turn('show me', reply, { toolCalls: [call] })]);
    expect(rows[0].fail).toEqual([]);
    expect(rows[0].words).toBeLessThan(10);
    expect(rows[0].extraKinds).toEqual(expect.arrayContaining(['terms/scorecard', 'choice']));
  });
  test('without tool outputs the same text counts as prose', () => {
    expect(grade([turn('show me', reply)]).rows[0].fail.length).toBeGreaterThan(0);
  });
  test('paraphrased terms are prose', () => {
    const para = reply.replace(/- Does: thing/g, '- It will do thing');
    expect(grade([turn('show me', para, { toolCalls: [call] })]).rows[0].fail.length).toBeGreaterThan(0);
  });
  test('terms shown again on a later turn are an unchanged repeat; choice options stay extra', () => {
    const { rows } = grade([turn('show me', reply, { toolCalls: [call] }), turn('again', reply, { toolCalls: [call] })]);
    expect(rows[0].fail).toEqual([]);
    expect(rows[1].fail.join()).toMatch(/unchanged repeat/);
  });
  test('JSON-string outputs, labelled option objects and bad JSON are handled', () => {
    const e = toolExtras([{ output: JSON.stringify({ scorecard: 'Goal one is here\nGoal two is there', options: [{ label: 'Yes please' }, 5] }) }, { output: '{bad json' }, { output: null }, null]);
    expect([...e.blocks]).toEqual(['goal one is here', 'goal two is there']);
    expect([...e.choices]).toEqual(['yes please']);
  });
  test('splitReply: table headers and short lines are never repeats', () => {
    const blocks = new Set(['name qty price total']);
    const sp = splitReply('| name | qty |\n|---|---|\n| a | 1 |', blocks, new Set(), new Set(['name qty price total']), new Set());
    expect(sp.repeats).toBe(0);
  });
  test('an already-shown bullet relisted on an approval turn is a repeat', () => {
    const bullet = '- Removed the old refund rule for orders above fifty pounds';
    const first = turn('go', `Plan:\n${bullet}\n`, { toolCalls: [call] });
    const second = turn('ok', `Plan again:\n${bullet}\n\n${terms}\n`, { toolCalls: [call] });
    const { rows } = grade([first, second]);
    expect(rows[1].repeatedExtras).toBeGreaterThan(0);
  });
});

describe('limits, Flesch, slow turns', () => {
  test('prose over 120 words fails; under passes; custom limits apply', () => {
    const words = (n) => Array(n / 2).fill('Cats run.').join(' ');
    expect(grade([turn('hi', words(122))]).rows[0].fail.join()).toMatch(/122 words > 120/);
    expect(grade([turn('hi', words(100))]).rows[0].fail).toEqual([]);
    expect(grade([turn('hi', words(100))], { limits: { maxWords: 50 } }).rows[0].fail.join()).toMatch(/100 words > 50/);
  });
  test('low Flesch fails unless the persona is technical', () => {
    const hard = 'Notwithstanding antidisestablishmentarian considerations, organisational infrastructure necessitates comprehensive reconsideration.';
    expect(grade([turn('hi', hard)]).rows[0].fail.join()).toMatch(/Flesch/);
    expect(grade([turn('hi', hard)], { technical: true }).rows[0].fail.join()).toMatch(/Flesch/);
    const middling = 'The organisational infrastructure necessitates reconsideration of considerations.';
    expect(grade([turn('hi', middling)]).fails + grade([turn('hi', middling)], { technical: true }).fails).toBeGreaterThan(0);
  });
  test('slow turns are flagged, not failed; seconds may be missing', () => {
    const { rows, fails } = grade([turn('hi', 'Fine.', { seconds: 75 }), turn('hi', 'Fine.', { seconds: null }), turn('hi', 'Fine.', { seconds: undefined })]);
    expect(rows[0]).toMatchObject({ slow: true, seconds: 75, fail: [] });
    expect(rows[1].slow).toBe(false);
    expect(fails).toBe(0);
  });
});

describe('readabilityForRun / cliReadability', () => {
  test('grades a seeded run with the flow-model vocabulary, writes checks/readability.json', async () => {
    const s = await seeded({ rows: [turnRow(1, { user: 'hi', reply: 'I will start the refund-flow for you now.', seconds: 6 }), turnRow(2, { user: 'thanks', reply: 'You are welcome.', seconds: 70 })] });
    const t = mkio();
    expect(await cliReadability(['--run-dir', s.runDir, '--card', 'icp-01', '--run', '1'], t.io)).toBe(1);
    const out = t.json();
    expect(out).toMatchObject({ ok: false, fails: 1, slowTurns: 1, maxSeconds: 70 });
    const file = await readJson(join(s.dir, 'checks', 'readability.json'));
    expect(validate('readability', file)).toEqual({ ok: true });
    expect(file.turns[0].jargon).toEqual(['refund-flow']);
  });
  test('--technical and the card flag both lower the Flesch bar and drop term hits', async () => {
    const s = await seeded({ rows: [turnRow(1, { user: 'hi', reply: 'The payload is fine.' })] });
    const t = mkio();
    expect(await cliReadability(['--run-dir', s.runDir, '--card', 'icp-01', '--run', '1', '--technical'], t.io)).toBe(0);
    const s2 = await seeded({ rows: [turnRow(1, { user: 'hi', reply: 'The payload is fine.' })] });
    await wj(join(s2.runDir, 'plan', 'cards', 'icp-01.json'), cardJson('icp-01', { persona: { ...cardJson().persona, technical: true } }));
    expect((await readabilityForRun({ runDir: s2.runDir, cardId: 'icp-01', k: 1 })).result.technical).toBe(true);
  });
  test('extra terms from run.json apply', async () => {
    const s = await seeded({ rows: [turnRow(1, { user: 'hi', reply: 'Your Gold tier is active.' })], scaffold: { runOver: { readability: { maxWords: 120, detailMaxWords: 250, minFlesch: 50, technicalMinFlesch: 30, slowTurnSeconds: 60, extraTerms: ['Gold tier'] } } } });
    expect((await readabilityForRun({ runDir: s.runDir, cardId: 'icp-01', k: 1 })).result.fails).toBe(1);
    expect(flowModel().vocabulary).toContain('refund-flow');
  });
  test('--turns-file: JSON array, {turns}, or JSONL; with a vocabulary file', async () => {
    const s = await seeded({});
    const rows = [{ user: 'hi', reply: 'Using get_order now.', seconds: 3 }];
    await wj(join(s.projectDir, 'a.json'), rows);
    await wj(join(s.projectDir, 'b.json'), { turns: rows });
    await writeFile(join(s.projectDir, 'c.jsonl'), `${JSON.stringify(rows[0])}\n`, 'utf8');
    await wj(join(s.projectDir, 'v.json'), ['cancel-flow']);
    for (const f of ['a.json', 'b.json', 'c.jsonl']) {
      const t = mkio({ cwd: s.projectDir });
      expect(await cliReadability(['--turns-file', f, '--vocabulary-file', 'v.json'], t.io)).toBe(1);
      expect(t.json().fails).toBe(1);
    }
    const t = mkio({ cwd: s.projectDir });
    expect(await cliReadability(['--turns-file', join(s.projectDir, 'a.json'), '--technical'], t.io)).toBe(1);
  });
  test('usage errors', async () => {
    expect(await cliReadability([], mkio().io)).toBe(2);
    expect(await cliReadability(['--run-dir', '/x'], mkio().io)).toBe(2);
    expect(await cliReadability(['--bogus'], mkio().io)).toBe(2);
  });
});

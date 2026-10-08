import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QaError, appendJsonl, appendText, emit, fail, hex, newRunId, parseArgs, playerId, readJson, readJsonOr, readJsonl,
  resolveRunDir, runFolder, runFolderRel, threadId, writeJson, writeText,
} from '../../../lib/qa/io.mjs';
import { mkio } from './fixtures/runtime-helpers.mjs';

const SPEC = {
  name: { type: 'string', required: true },
  count: { type: 'number' },
  flag: { type: 'boolean' },
  tag: { type: 'string[]' },
  mode: { type: 'string', choices: ['a', 'b'] },
  'run-dir': { type: 'string' },
};

describe('parseArgs', () => {
  test('parses strings, numbers, switches, repeats, kebab and camel aliases', () => {
    const { values, positionals } = parseArgs(['--name', 'x', '--count=3', '--flag', '--tag', 'a', '--tag', 'b', '--run-dir', '/r', 'pos'], SPEC);
    expect(values).toMatchObject({ name: 'x', count: 3, flag: true, tag: ['a', 'b'], 'run-dir': '/r', runDir: '/r' });
    expect(positionals).toEqual(['pos']);
  });
  test('boolean with explicit value', () => {
    expect(parseArgs(['--name', 'x', '--flag=false'], SPEC).values.flag).toBe(false);
    expect(() => parseArgs(['--name', 'x', '--flag=maybe'], SPEC)).toThrow(/switch/);
  });
  test.each([
    [['--name'], /needs a value/],
    [['--name', 'x', '--count', 'abc'], /needs a number/],
    [['--name', 'x', '--count', ''], /needs a number/],
    [['--name', 'x', '--bogus'], /Unknown flag/],
    [['--name', 'x', '--mode', 'c'], /must be one of/],
    [[], /--name is required/],
  ])('usage error %j', (argv, re) => {
    expect(() => parseArgs(argv, SPEC)).toThrow(expect.objectContaining({ code: 'USAGE', exitCode: 2, message: expect.stringMatching(re) }));
  });
  test('a bare -- and non-flag tokens are positionals', () => {
    expect(parseArgs(['--name', 'x', '--', 'y'], SPEC).positionals).toEqual(['--', 'y']);
  });
  test('works with no spec', () => {
    expect(parseArgs(['a']).positionals).toEqual(['a']);
  });
});

describe('emit / fail', () => {
  test('emit writes redacted JSON and a newline', () => {
    const t = mkio();
    emit(t.io, { a: 'sk_live_abcdefgh12345', n: 1 });
    expect(t.stdout()).toBe('{"a":"[REDACTED:stripe-key]","n":1}\n');
  });
  test('fail renders a QaError with its exit code and hint', () => {
    const t = mkio();
    const code = fail(t.io, new QaError('SOME_CODE', 3, 'nope', 'try this'));
    expect(code).toBe(3);
    expect(t.json()).toEqual({ ok: false, code: 'SOME_CODE', message: 'nope', hint: 'try this' });
    expect(t.stderr()).toMatch(/try this/);
  });
  test('fail without a hint writes nothing to stderr', () => {
    const t = mkio();
    expect(fail(t.io, new QaError('X', 2, 'm'))).toBe(2);
    expect(t.stderr()).toBe('');
  });
  test('fail maps other errors to INTERNAL exit 5 and never leaks a stack', () => {
    const t = mkio();
    const err = new Error('boom\n    at secret.js:1:1');
    expect(fail(t.io, err)).toBe(5);
    expect(t.json().code).toBe('INTERNAL');
    expect(t.stdout()).not.toMatch(/secret\.js/);
    expect(fail(mkio().io, 'plain string')).toBe(5);
  });
});

describe('files', () => {
  test('writeJson is atomic, 2-space, redacted; readJson/readJsonOr read it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-io-'));
    const p = join(dir, 'a', 'b.json');
    await writeJson(p, { k: 'password: hunter2', n: [1] });
    expect(await readFile(p, 'utf8')).toBe('{\n  "k": "[REDACTED:password-assign]",\n  "n": [\n    1\n  ]\n}\n');
    expect((await readJson(p)).n).toEqual([1]);
    expect(await readJsonOr(join(dir, 'missing.json'), 'fb')).toBe('fb');
    expect(await readJsonOr(join(dir, 'missing.json'))).toBeNull();
  });
  test('jsonl append/read skips blank and invalid lines; missing file is empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-io-'));
    const p = join(dir, 'x', 'rows.jsonl');
    expect(await readJsonl(p)).toEqual([]);
    await appendJsonl(p, { a: 1 });
    await appendJsonl(p, { a: 'sk_test_abcdefghij' });
    await writeFile(p, `${await readFile(p, 'utf8')}\nnot json\n\n`, 'utf8');
    expect(await readJsonl(p)).toEqual([{ a: 1 }, { a: '[REDACTED:stripe-key]' }]);
  });
  test('text helpers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-io-'));
    await writeText(join(dir, 'd', 't.txt'), 'a');
    await appendText(join(dir, 'd', 't.txt'), 'b');
    expect(await readFile(join(dir, 'd', 't.txt'), 'utf8')).toBe('ab');
  });
});

describe('ids and paths', () => {
  const fixed = { now: () => new Date(Date.UTC(2026, 9, 7, 14, 15, 2)), randomBytes: (n) => Buffer.alloc(n, 0xab) };
  test('newRunId and hex', () => {
    expect(newRunId(fixed)).toBe('20261007-141502-abab');
    expect(hex(6, fixed)).toBe('ababab');
    expect(hex(5, fixed)).toBe('ababa');
    expect(newRunId()).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(hex(6)).toMatch(/^[0-9a-f]{6}$/);
  });
  test('thread and player ids match the contract and the thread regex', () => {
    const t = threadId({ runId: '20261007-141502-9f3c', cardId: 'icp-03', k: 2, hex6: '1a2b3c' });
    expect(t).toBe('qa-9f3c-icp-03-r2-1a2b3c');
    expect(threadId({ runId: '20261007-141502-9f3c', cardId: 'icp-03', k: 2, attempt: 2, hex6: '1a2b3c' })).toBe('qa-9f3c-icp-03-r2-a2-1a2b3c');
    expect(t).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(playerId({ cardId: 'icp-03', k: 2, hex6: '1a2b3c' })).toBe('icp-03-r2-1a2b3c');
    expect(playerId({ cardId: 'rt-01', k: 1, attempt: 3, hex6: 'ffffff' })).toBe('rt-01-r1-a3-ffffff');
  });
  test('run folders', () => {
    expect(runFolder('/r', 'icp-01', 2)).toBe(join('/r', 'runs', 'icp-01', 'r2'));
    expect(runFolder('/r', 'icp-01', 2, 2)).toBe(join('/r', 'runs', 'icp-01', 'r2-a2'));
    expect(runFolderRel('icp-01', 1)).toBe(join('runs', 'icp-01', 'r1'));
  });
  test('resolveRunDir', () => {
    expect(resolveRunDir({ cwd: '/work' }, 'x/y')).toBe(join('/work', 'x', 'y'));
    expect(resolveRunDir({ cwd: '/work' }, '/abs')).toBe('/abs');
    expect(() => resolveRunDir({ cwd: '/work' }, '')).toThrow(/--run-dir/);
  });
});

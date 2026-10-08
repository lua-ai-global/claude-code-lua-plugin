import { describe, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, genuineHelper } from '../../hooks/guard-qa-helper.mjs';
import { runHook } from '../helpers/run-hook.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL = genuineHelper();
const cmd = (command, cwd = '/') => ({ tool_input: { command }, cwd });

describe('guard-qa-helper decide()', () => {
  test('the genuine helper resolves inside this plugin', () => {
    expect(REAL.endsWith(join('lib', 'qa', 'cli.mjs'))).toBe(true);
  });

  test.each([
    `node ${REAL} record --run-dir /r`,
    `node "${REAL}" gate --run-dir /r --stamp plan`,
    `node '${REAL}' aggregate --run-dir /r`,
    `/usr/local/bin/node ${REAL} report --run-dir /r`,
    `cd /tmp && node ${REAL} discover --run-dir /r`,
    `node ${REAL} a && node ${REAL} b`,
  ])('allows %s', (command) => {
    expect(decide(cmd(command))).toBeNull();
  });

  test('a relative path is blocked even when it would resolve to the helper (a cd can change its meaning)', () => {
    expect(decide(cmd('node lib/qa/cli.mjs x', ROOT))?.block).toBe(true);
    expect(decide(cmd('cd sub && node ../lib/qa/cli.mjs x', ROOT))?.block).toBe(true);
    expect(decide({ tool_input: { command: 'node lib/qa/cli.mjs x' } }, {}, { genuine: () => 'lib/qa/cli.mjs', realpath: (p) => p })?.block).toBe(true);
  });

  test.each([
    (r) => `node --no-warnings ${r} x`,
    (r) => `node --require=/tmp/x.js ${r} x`,
    (r) => `node --import=/tmp/x.mjs ${r} x`,
    (r) => `node --eval=1 ${r} x`,
    (r) => `node -r /tmp/x.js ${r} x`,
    (r) => `NODE_OPTIONS=--require=/tmp/x.js node ${r} x`,
    (r) => `export NODE_OPTIONS=--require=/tmp/x.js; node ${r} x`,
  ])('blocks node flags and NODE_OPTIONS in front of the genuine helper (%#)', (make) => {
    const r = decide(cmd(make(REAL)));
    expect(r?.block).toBe(true);
    expect(r.reason).toContain('QA_HELPER_DENIED');
  });

  test('${CLAUDE_PLUGIN_ROOT} expands from the environment; an unexpanded variable is blocked', () => {
    expect(decide(cmd('node ${CLAUDE_PLUGIN_ROOT}/lib/qa/cli.mjs x'), { CLAUDE_PLUGIN_ROOT: ROOT })).toBeNull();
    expect(decide(cmd('node $CLAUDE_PLUGIN_ROOT/lib/qa/cli.mjs x'), { CLAUDE_PLUGIN_ROOT: ROOT })).toBeNull();
    expect(decide(cmd('node ${CLAUDE_PLUGIN_ROOT}/lib/qa/cli.mjs x'), {})?.block).toBe(true);
    expect(decide(cmd('node $HOME/lua-agent-builder/lib/qa/cli.mjs x'), { CLAUDE_PLUGIN_ROOT: ROOT })?.block).toBe(true);
  });

  test.each([
    'node /tmp/evil/lua-agent-builder/lib/qa/cli.mjs x',
    'node /tmp/e/.claude/plugins/cache/a/lua-agent-builder/1/lib/qa/cli.mjs x',
    'node ./lua-agent-builder/lib/qa/cli.mjs x',
    'node "/tmp/a b/lua-agent-builder/lib/qa/cli.mjs" x',
    'node $(echo /tmp/x/lua-agent-builder/lib/qa/cli.mjs) x',
    'node `echo /tmp/x/lua-agent-builder/lib/qa/cli.mjs` x',
  ])('blocks the spoofed helper %s', (command) => {
    const r = decide(cmd(command));
    expect(r?.block).toBe(true);
    expect(r.reason).toContain('QA_HELPER_DENIED');
  });

  test('one genuine call does not excuse a spoofed one in the same command', () => {
    expect(decide(cmd(`node ${REAL} a; node /tmp/lua-agent-builder/lib/qa/cli.mjs b`))?.block).toBe(true);
  });

  test('a symlink to a different file is judged by its real path; a symlink to the helper passes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-guard-'));
    const fake = join(dir, 'fake.mjs');
    await writeFile(fake, '// not the helper\n');
    await mkdir(join(dir, 'lua-agent-builder', 'lib', 'qa'), { recursive: true });
    await symlink(fake, join(dir, 'lua-agent-builder', 'lib', 'qa', 'cli.mjs'));
    expect(decide(cmd(`node ${join(dir, 'lua-agent-builder', 'lib', 'qa', 'cli.mjs')} x`))?.block).toBe(true);
    await mkdir(join(dir, 'ok', 'lib', 'qa'), { recursive: true });
    await symlink(REAL, join(dir, 'ok', 'lib', 'qa', 'cli.mjs'));
    expect(decide(cmd(`node ${join(dir, 'ok', 'lib', 'qa', 'cli.mjs')} x`))).toBeNull();
  });

  test.each([
    '',
    'git status',
    'cat /tmp/x/lib/qa/cli.mjs',
    'node --version',
  ])('ignores %p', (command) => {
    expect(decide(cmd(command))).toBeNull();
  });

  test('null input and a missing file', () => {
    expect(decide(null)).toBeNull();
    expect(decide(cmd('node /nonexistent/lib/qa/cli.mjs x'))?.block).toBe(true);
  });
});

describe('guard-qa-helper script entry', () => {
  test('blocks a spoofed helper with exit 2', async () => {
    const r = await runHook('guard-qa-helper.mjs', { tool_input: { command: 'node /tmp/evil/lua-agent-builder/lib/qa/cli.mjs x' }, cwd: '/' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('QA_HELPER_DENIED');
  });
  test('allows the genuine helper', async () => {
    const r = await runHook('guard-qa-helper.mjs', { tool_input: { command: `node ${REAL} x` }, cwd: '/' });
    expect(r.exitCode).toBe(0);
  });
});

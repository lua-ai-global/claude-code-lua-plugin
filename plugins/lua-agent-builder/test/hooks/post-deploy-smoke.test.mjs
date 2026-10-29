import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, deployProjectDir } from '../../hooks/post-deploy-smoke.mjs';
import { luaWorkingDirs } from '../../lib/tokenizer.mjs';

// The smoke check runs in the agent project the deploy ran in (a folder with lua.skill.yaml): every test below starts
// in one, unless it says otherwise.
let root;
let project;
let startDir;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'smoke-'));
  project = join(root, 'agents', 'shop');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'lua.skill.yaml'), 'agent:\n  agentId: a1\n');
  startDir = process.cwd();
  process.chdir(project);
});
afterAll(() => {
  process.chdir(startDir);
  rmSync(root, { recursive: true, force: true });
});

function fakeSpawn(scripted) {
  let i = 0;
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    if (i >= scripted.length) throw new Error(`unexpected spawn ${i}: ${JSON.stringify(args)}`);
    return scripted[i++];
  };
  fn.calls = calls;
  return fn;
}

// Iteration-13 audit: `lua logs --json` outputs ONE JSON document
// `{ logs: LogEntry[], pagination: {...} }` — NOT NDJSON. Each LogEntry
// uses `subType: 'error' | 'warn' | …` (no `level` field). Earlier
// fixtures fed NDJSON with a non-existent `level` field, so the bug
// (silent miss of every error) wasn't visible to the test suite.
function logsResponse(logs) {
  return JSON.stringify({
    logs,
    pagination: { currentPage: 1, totalPages: 1, totalCount: logs.length, limit: 20, hasNextPage: false, hasPrevPage: false, nextPage: null, prevPage: null },
  });
}

describe('post-deploy-smoke decide()', () => {
  test('returns null when not a deploy command', async () => {
    const spawnLuaFn = fakeSpawn([]);
    const result = await decide({ tool_input: { command: 'lua test --ci' } }, { spawnLuaFn });
    expect(result).toBeNull();
  });

  // Architect review I2: the old DEPLOY_PATTERN only matched `lua deploy`, so
  // hooks.json's `*lua version promote*` registration never produced a smoke
  // check. Now every SMOKE_LABELS verb (and its alias/binary spellings) does.
  test.each([
    'LUA_DEPLOY_CONFIRMED=1 lua version promote 3',
    'LUA_DEPLOY_CONFIRMED=1 lua workflows deploy outreach -v latest',
    'LUA_DEPLOY_CONFIRMED=1 lua workflows publish outreach -v latest',
    'LUA_DEPLOY_CONFIRMED=1 lua persona production deploy --persona-version latest --force',
    'LUA_DEPLOY_CONFIRMED=1 lua persona prod publish --persona-version 5',
    'LUA_DEPLOY_CONFIRMED=1 lua skills publish --skill-name x --skill-version latest',
    'LUA_DEPLOY_CONFIRMED=1 lua jobs deploy -i x -v latest',
    'LUA_DEPLOY_CONFIRMED=1 lua mcp activate fs',
    'LUA_DEPLOY_CONFIRMED=1 heylua deploy all --force',
  ])('runs the smoke check after %s', async (command) => {
    const spawnLuaFn = fakeSpawn([
      { exitCode: 1, stdout: '', stderr: 'connection refused', timedOut: false },
    ]);
    const result = await decide({ tool_input: { command } }, { spawnLuaFn });
    expect(result?.warn).toContain('the ping to the agent failed (exit=1): connection refused');
    expect(spawnLuaFn.calls).toHaveLength(1);
  });

  test.each([
    'LUA_DEPLOY_CONFIRMED=1 lua workflows activate outreach',
    'LUA_DEPLOY_CONFIRMED=1 lua marketplace template publish --template-id t',
    'LUA_DEPLOY_CONFIRMED=1 lua marketplace template apply --template-id t --all-installed --force',
    'lua push all --ci --force',
    'lua version create --name v2',
    'lua chat --ci -m hi',
  ])('does not ping the agent after %s (gated, but nothing newly live — or not gated at all)', async (command) => {
    const spawnLuaFn = fakeSpawn([]);
    expect(await decide({ tool_input: { command } }, { spawnLuaFn })).toBeNull();
    expect(spawnLuaFn.calls).toHaveLength(0);
  });

  test('names the verb in the warning', async () => {
    const spawnLuaFn = fakeSpawn([{ exitCode: 1, stdout: '', stderr: '', timedOut: false }]);
    const result = await decide({ tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua version promote 3' } }, { spawnLuaFn });
    expect(result?.warn).toContain('(lua version promote)');
  });

  test('returns null when tool_response.success is false', async () => {
    const spawnLuaFn = fakeSpawn([]);
    const result = await decide(
      {
        tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' },
        tool_response: { success: false },
      },
      { spawnLuaFn }
    );
    expect(result).toBeNull();
  });

  test('warns when agent ping fails', async () => {
    const spawnLuaFn = fakeSpawn([
      { exitCode: 1, stdout: '', stderr: 'connection refused', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    expect(result?.warn).toContain('the ping to the agent failed');
    expect(result?.warn).toContain('exit=1');
  });

  test('warns when fresh error logs exist', async () => {
    const now = new Date().toISOString();
    const stdout = logsResponse([
      { subType: 'error', timestamp: now, message: 'boom', metadata: {} },
      { subType: 'info',  timestamp: now, message: 'fine', metadata: {} },
    ]);
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout, stderr: '', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'env LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    expect(result?.warn).toContain('1 error log entry');
  });

  test('counts multiple fresh errors', async () => {
    const now = new Date().toISOString();
    const stdout = logsResponse([
      { subType: 'error', timestamp: now, metadata: {} },
      { subType: 'error', timestamp: now, metadata: {} },
      { subType: 'error', timestamp: now, metadata: {} },
    ]);
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout, stderr: '', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy all --force' } },
      { spawnLuaFn }
    );
    expect(result?.warn).toContain('3 error log entry');
  });

  // PRO-1896: the window comes from the ROUTE (`--since 1m`). On a lua-cli
  // older than 3.38.0 that option does not exist and commander exits 1, so the
  // hook falls back to the pre-3.38.0 shape — a page plus this machine's clock
  // — rather than reporting nothing. These two tests drive that fallback.
  test('falls back to the local-clock filter below 3.38.0 and ignores stale errors', async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    const stdout = logsResponse([{ subType: 'error', timestamp: old, metadata: {} }]);
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 1, stdout: '', stderr: "error: unknown option '--since'", timedOut: false },
      { exitCode: 0, stdout, stderr: '', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    expect(result).toBeNull();
  });

  test('returns null when ping succeeds and no errors', async () => {
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout: logsResponse([]), stderr: '', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    expect(result).toBeNull();
  });

  test('returns null when the logs command fails both windowed and unwindowed', async () => {
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 1, stdout: '', stderr: 'logs error', timedOut: false },
      { exitCode: 1, stdout: '', stderr: 'logs error', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    expect(result).toBeNull();
  });

  test('returns null on malformed JSON output (not NDJSON)', async () => {
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout: 'this is not json', stderr: '', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    expect(result).toBeNull();
  });

  // Iteration-13 audit: covers the `: []` fallback path in
   //   entries = Array.isArray(parsed?.logs) ? parsed.logs
   //           : (Array.isArray(parsed) ? parsed : []);
  // i.e., when stdout is JSON-parseable but neither {logs: [...]} nor a
  // bare array. Previously uncovered because the broken check-coverage
  // (bug 72) silently passed.
  test('handles parseable-but-unrecognized JSON shape (e.g. null) — falls to []', async () => {
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout: 'null', stderr: '', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    expect(result).toBeNull();
  });

  // Iteration-13 audit: covers the `!entry` branch in the filter callback.
  // Without this, no test passes a null/undefined entry through the array,
  // and the defensive `!entry` short-circuit goes uncovered (which the
  // newly-fixed check-coverage now flags).
  test('skips null/undefined entries in the logs array (defensive filter)', async () => {
    const now = new Date().toISOString();
    const stdout = JSON.stringify({
      logs: [null, { subType: 'error', timestamp: now }],
      pagination: {},
    });
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout, stderr: '', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    // Only 1 valid error entry (the null was filtered out).
    expect(result?.warn).toContain('1 error log entry');
  });

  test('handles bare-array logs response (forward-compat)', async () => {
    const now = new Date().toISOString();
    const stdout = JSON.stringify([{ subType: 'error', timestamp: now }]);
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout, stderr: '', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    expect(result?.warn).toContain('1 error log entry');
  });

  test('handles missing input', async () => {
    expect(await decide(null, { spawnLuaFn: fakeSpawn([]) })).toBeNull();
  });

  test('handles missing opts (default = {})', async () => {
    const result = await decide({ tool_input: { command: 'lua test --ci' } });
    expect(result).toBeNull();
  });

  // Iteration-13 audit (bug 75): the smoke-test ping must use a dedicated
  // per-deploy thread, never the agent's default thread — otherwise every
  // deploy adds a "ping" message to the production conversation.
  test('smoke-test ping uses an isolated per-deploy thread (-t flag)', async () => {
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout: logsResponse([]), stderr: '', timedOut: false },
    ]);
    await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    const pingArgs = spawnLuaFn.calls[0][0];
    expect(pingArgs).toContain('-t');
    const tIndex = pingArgs.indexOf('-t');
    const threadId = pingArgs[tIndex + 1];
    expect(threadId).toMatch(/^lua-plugin-smoke-\d+$/);
  });

  test('below 3.38.0, treats log entries without timestamp as stale (counts 0)', async () => {
    const stdout = logsResponse([{ subType: 'error', message: 'no ts' }]);
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 1, stdout: '', stderr: "error: unknown option '--since'", timedOut: false },
      { exitCode: 0, stdout, stderr: '', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    expect(result).toBeNull();
  });

  // PRO-1896 / PRO-1838 (A5): the scan asks the ROUTE for its window. A
  // relative bound is resolved by the SERVER's clock, which is the whole point
  // — so a row the LOCAL clock would call stale must still be counted when the
  // route returned it. `--environment` is deliberately absent: the step-1 ping
  // goes through `lua chat`, whose rows may be stamped `sandbox`.
  test('asks the route for the window with --since, and not for an environment', async () => {
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout: logsResponse([]), stderr: '', timedOut: false },
    ]);
    await decide({ tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } }, { spawnLuaFn });
    expect(spawnLuaFn.calls).toHaveLength(2);
    const logsArgs = spawnLuaFn.calls[1][0];
    expect(logsArgs).toEqual(['logs', '--ci', '--type', 'all', '--since', '1m', '--limit', '20', '--json']);
    expect(logsArgs).not.toContain('--environment');
    expect(logsArgs).not.toContain('--page');
  });

  test('trusts the server window: a row the local clock calls stale still counts', async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    const stdout = logsResponse([{ subType: 'error', timestamp: old, metadata: {} }]);
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout, stderr: '', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    expect(result?.warn).toContain('1 error log entry');
    expect(spawnLuaFn.calls).toHaveLength(2);
  });

  // The deploy ran in an agent folder below the shell's directory (`cd agents/shop && lua version promote 3`). Claude
  // Code runs the hook elsewhere, so `lua chat` there exited 2 ("No lua.skill.yaml found") and every promote was
  // reported as "agent did not respond" while the agent answered.
  test('runs the ping and the log scan in the project the deploy ran in, not the hook process folder', async () => {
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout: logsResponse([]), stderr: '', timedOut: false },
    ]);
    const result = await decide(
      { cwd: root, tool_input: { command: 'cd agents/shop && LUA_DEPLOY_CONFIRMED=1 lua version promote 3' } },
      { spawnLuaFn }
    );
    expect(result).toBeNull();
    expect(spawnLuaFn.calls.map(([, opts]) => opts.cwd)).toEqual([project, project]);
  });

  test('a command run from a subfolder of the project finds it above', async () => {
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout: logsResponse([]), stderr: '', timedOut: false },
    ]);
    await decide({ cwd: join(project, 'src'), tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy all' } }, { spawnLuaFn });
    expect(spawnLuaFn.calls[0][1].cwd).toBe(project);
  });

  test('no project there or above: says the check was skipped and pings nothing', async () => {
    const spawnLuaFn = fakeSpawn([]);
    const result = await decide(
      { cwd: root, tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua version promote 3' } },
      { spawnLuaFn }
    );
    expect(result?.warn).toContain('skipped: could not tell which agent project');
    expect(result?.warn).not.toContain('did not');
    expect(spawnLuaFn.calls).toHaveLength(0);
  });

  test("a failed ping names the CLI's own reason", async () => {
    const spawnLuaFn = fakeSpawn([
      {
        exitCode: 2,
        stdout: '',
        stderr: '\n✖ usage: No lua.skill.yaml found — run this command from a Lua project directory.\n',
        timedOut: false,
      },
    ]);
    const result = await decide({ tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua version promote 3' } }, { spawnLuaFn });
    expect(result?.warn).toContain('(exit=2): ✖ usage: No lua.skill.yaml found');
  });

  test('a ping that times out says the agent did not answer', async () => {
    const spawnLuaFn = fakeSpawn([{ exitCode: null, stdout: '', stderr: '', timedOut: true }]);
    const result = await decide({ tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua version promote 3' } }, { spawnLuaFn });
    expect(result?.warn).toContain('agent did not answer within 20 s');
  });

  test('deployProjectDir: a computed or `cd -` target is unknown, never guessed', () => {
    expect(deployProjectDir('cd "$AGENT" && lua deploy all', root)).toBeNull();
    expect(deployProjectDir('cd - && lua deploy all', root)).toBeNull();
    expect(deployProjectDir('cd agents/shop && lua deploy all', root)).toBe(project);
  });
});

describe('luaWorkingDirs', () => {
  test.each([
    ['lua deploy all', []],
    ['cd a && lua deploy all', ['a']],
    ['cd a && cd b; lua version promote 3', ['a', 'b']],
    ["cd 'my agent' && lua deploy all", ['my agent']],
    ['cd a && lua deploy all && cd b', ['a']],
    ['cd && lua deploy all', ['~']],
    ['cd $X && lua deploy all', null],
    ['cd a b && lua deploy all', null],
  ])('%s → %j', (command, dirs) => {
    expect(luaWorkingDirs(command)).toEqual(dirs);
  });
});

import { describe, test, expect } from '@jest/globals';
import { decide } from '../../hooks/post-deploy-smoke.mjs';

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
    expect(result?.warn).toContain('agent did not respond');
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
    expect(result?.warn).toContain('agent did not respond');
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
});

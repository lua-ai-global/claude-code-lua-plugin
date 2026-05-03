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

  test('ignores stale errors (older than 60s)', async () => {
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

  test('returns null when logs command itself fails', async () => {
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
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

  test('treats log entries without timestamp as stale (counts 0)', async () => {
    const stdout = logsResponse([{ subType: 'error', message: 'no ts' }]);
    const spawnLuaFn = fakeSpawn([
      { exitCode: 0, stdout: 'pong', stderr: '', timedOut: false },
      { exitCode: 0, stdout, stderr: '', timedOut: false },
    ]);
    const result = await decide(
      { tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } },
      { spawnLuaFn }
    );
    expect(result).toBeNull();
  });
});

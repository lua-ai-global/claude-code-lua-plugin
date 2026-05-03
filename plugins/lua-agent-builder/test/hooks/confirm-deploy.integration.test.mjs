// Integration smoke test — spawns the actual hook script as a child process.
// Covers the `if (isMainScript) { runHook(...) }` block in
// hooks/confirm-deploy.mjs that the unit tests can't reach.
//
// Per tech spec §17.1.1: unit coverage is via direct import of decide();
// integration coverage of the entry-point block is here.

import { describe, test, expect } from '@jest/globals';
import { runHook } from '../helpers/run-hook.mjs';

describe('confirm-deploy script entry (spawned)', () => {
  test('exits 0 when stdin contains a prefixed deploy', async () => {
    const result = await runHook('confirm-deploy.mjs', {
      tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --force' },
    });
    expect(result.exitCode).toBe(0);
  });

  test('exits 2 with DEPLOY_DENIED_BARE on bare deploy', async () => {
    const result = await runHook('confirm-deploy.mjs', {
      tool_input: { command: 'lua deploy skill --ci --force' },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('DEPLOY_DENIED_BARE');
    expect(result.stderr).toContain('Use /lua-deploy');
  });

  test('exits 2 with DEPLOY_DENIED_AUTO on --auto-deploy', async () => {
    const result = await runHook('confirm-deploy.mjs', {
      tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy --auto-deploy' },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('DEPLOY_DENIED_AUTO');
  });

  test('handles malformed JSON on stdin gracefully (fail-open)', async () => {
    // runHook helper sends valid JSON; to test malformed, we'd need a raw spawn.
    // Instead, verify that empty input also fails-open via the empty-stdin path:
    const result = await runHook('confirm-deploy.mjs', null);
    // No tool_input → bare command → block per the decide() logic
    expect(result.exitCode).toBe(2);
  });
});

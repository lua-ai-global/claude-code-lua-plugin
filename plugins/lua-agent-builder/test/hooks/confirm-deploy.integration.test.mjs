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

  test('empty stdin passes through (nothing to classify → allow)', async () => {
    // The hook now runs on EVERY Bash call (no `if` glob in hooks.json), so an
    // empty / unclassifiable payload must not block unrelated commands.
    const result = await runHook('confirm-deploy.mjs', null);
    expect(result.exitCode).toBe(0);
  });

  test('exits 0 for an unrelated Bash command (the every-call registration must be cheap and silent)', async () => {
    const result = await runHook('confirm-deploy.mjs', { tool_input: { command: 'git status --short' } });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  test.each([
    'lua skills publish --skill-name x --skill-version latest',
    'lua workflows on outreach',
    'heylua version promote 3',
    'lua marketplace template rollout --template-id t --all-installed --force',
  ])('exits 2 on the alias/binary spelling %s', async (command) => {
    const result = await runHook('confirm-deploy.mjs', { tool_input: { command } });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('DEPLOY_DENIED_BARE');
  });
});

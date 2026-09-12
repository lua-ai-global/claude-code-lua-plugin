import { describe, test, expect } from '@jest/globals';
import { decide } from '../../hooks/confirm-deploy.mjs';

describe('confirm-deploy decide()', () => {
  test('allows env-var-prefixed deploy', () => {
    const result = decide({
      tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --name foo --set-version 1.2.3 --force' }
    });
    expect(result).toBeNull();
  });

  test('allows env-form prefix', () => {
    const result = decide({
      tool_input: { command: 'env LUA_DEPLOY_CONFIRMED=1 lua deploy webhook' }
    });
    expect(result).toBeNull();
  });

  test('allows leading-whitespace prefix', () => {
    const result = decide({
      tool_input: { command: '   LUA_DEPLOY_CONFIRMED=1 lua deploy job' }
    });
    expect(result).toBeNull();
  });

  test.each([
    'LUA_DEPLOY_CONFIRMED=1 lua workflows deploy outreach -v latest',
    'LUA_DEPLOY_CONFIRMED=1 lua workflows activate outreach',
    'LUA_DEPLOY_CONFIRMED=1 lua version promote 3',
    'LUA_DEPLOY_CONFIRMED=1 lua persona production deploy --persona-version latest --force',
    'LUA_DEPLOY_CONFIRMED=1 lua mcp activate --server-name fs',
    'LUA_DEPLOY_CONFIRMED=1 lua marketplace template apply --template-id t --all-installed --force',
  ])('allows the prefixed form of every gated verb: %s', (command) => {
    expect(decide({ tool_input: { command } })).toBeNull();
  });

  test('blocks bare lua deploy', () => {
    const result = decide({
      tool_input: { command: 'lua deploy skill --ci --force' }
    });
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('DEPLOY_DENIED_BARE'),
    });
    expect(result.reason).toContain('`lua deploy`');
    expect(result.reason).toContain('Use /lua-deploy');
  });

  test.each([
    ['lua workflows deploy outreach -v latest', 'lua workflows deploy', '/lua-deploy'],
    ['lua workflows activate outreach -v 2.0.0', 'lua workflows activate', '/lua-deploy'],
    ['lua version promote v3', 'lua version promote', '/lua-deploy'],
    ['lua skills deploy --skill-name x --skill-version latest', 'lua skills deploy', '/lua-deploy'],
    ['lua jobs deploy -i x -v latest', 'lua jobs deploy', '/lua-deploy'],
    ['lua persona production deploy --persona-version 5', 'lua persona production deploy', '/lua-deploy'],
    ['lua mcp activate filesystem', 'lua mcp activate', '/lua-deploy'],
    ['lua marketplace template publish --template-id t', 'lua marketplace template publish', '/lua-template'],
    ['lua marketplace template apply --template-id t --agents a --force', 'lua marketplace template apply', '/lua-template'],
  ])('blocks the bare form of %s naming the verb and the right slash', (command, label, slash) => {
    const result = decide({ tool_input: { command } });
    expect(result?.block).toBe(true);
    expect(result.reason).toContain('DEPLOY_DENIED_BARE');
    expect(result.reason).toContain(`\`${label}\``);
    expect(result.reason).toContain(`Use ${slash}`);
  });

  test('blocks bash-wrapper invocation even with prefix', () => {
    const result = decide({
      tool_input: { command: 'bash -c "LUA_DEPLOY_CONFIRMED=1 lua deploy"' }
    });
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('DEPLOY_DENIED_BARE'),
    });
  });

  test('blocks pipe even with prefix', () => {
    const result = decide({
      tool_input: { command: 'echo y | LUA_DEPLOY_CONFIRMED=1 lua deploy' }
    });
    expect(result?.block).toBe(true);
  });

  test('blocks --auto-deploy in deploy form', () => {
    const result = decide({
      tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 lua deploy --auto-deploy' }
    });
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('DEPLOY_DENIED_AUTO'),
    });
  });

  test('blocks --auto-deploy in push form', () => {
    const result = decide({
      tool_input: { command: 'lua push all --auto-deploy' }
    });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('DEPLOY_DENIED_AUTO');
  });

  // Architect review I1: the hook is now registered for EVERY Bash call (no
  // `if` glob), so anything the tokenizer doesn't classify must pass through.
  test.each([
    'lua compile --ci',
    'lua push all --ci --force',
    'lua test --ci skill --name get_weather --input \'{"city":"London"}\'',
    'lua workflows deactivate outreach',
    'lua workflows run outreach --input @in.json --agents fake',
    'lua version create --name v2',
    'lua version list --json',
    'lua mcp deactivate fs',
    'lua persona production view',
    'git status --short',
    'ls -la',
    'npm test',
    'echo deploy',
  ])('allows non-production command: %s', (command) => {
    expect(decide({ tool_input: { command } })).toBeNull();
  });

  test('allows an empty or missing command (nothing to gate)', () => {
    expect(decide({})).toBeNull();
    expect(decide(null)).toBeNull();
    expect(decide({ tool_input: {} })).toBeNull();
    expect(decide({ tool_input: { command: '' } })).toBeNull();
  });

  // Architect review S1: alias spellings and alternative binaries are gated too.
  test.each([
    ['lua skills publish --skill-name x --skill-version latest', 'lua skills deploy'],
    ['lua persona prod deploy --persona-version 5', 'lua persona production deploy'],
    ['lua workflows publish outreach -v latest', 'lua workflows deploy'],
    ['lua workflows on outreach', 'lua workflows activate'],
    ['lua mcp enable fs', 'lua mcp activate'],
    ['lua marketplace template submit --template-id t', 'lua marketplace template publish'],
    ['lua marketplace template rollout --template-id t --all-installed --force', 'lua marketplace template apply'],
    ['heylua deploy all --force', 'lua deploy'],
    ['lua-ai version promote 3', 'lua version promote'],
  ])('blocks the alias/binary spelling %s (as %s)', (command, label) => {
    const result = decide({ tool_input: { command } });
    expect(result?.block).toBe(true);
    expect(result.reason).toContain(`\`${label}\``);
    expect(decide({ tool_input: { command: `LUA_DEPLOY_CONFIRMED=1 ${command}` } })).toBeNull();
  });
});

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

  test('blocks bare lua deploy', () => {
    const result = decide({
      tool_input: { command: 'lua deploy skill --ci --force' }
    });
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('DEPLOY_DENIED_BARE'),
    });
    expect(result.reason).toContain('Use /lua-deploy');
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

  test('handles missing tool_input gracefully', () => {
    const result = decide({});
    expect(result?.block).toBe(true);
  });

  test('handles null input gracefully', () => {
    const result = decide(null);
    expect(result?.block).toBe(true);
  });

  test('handles missing command field', () => {
    const result = decide({ tool_input: {} });
    expect(result?.block).toBe(true);
  });
});

import { describe, expect, test } from '@jest/globals';
import { decide } from '../../hooks/block-auth-configure.mjs';

describe('block-auth-configure decide()', () => {
  test.each([
    'lua auth configure',
    'lua auth configure --email person@example.com',
    'lua auth configure --api-key secret',
  ])('blocks %s', (command) => {
    const result = decide({ tool_input: { command } });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('AUTH_INPUT_DENIED');
    expect(result?.reason).toContain('private terminal');
  });

  test.each(['lua agents --json --ci', 'lua auth logout', 'lua auth configuration'])('allows %s', (command) => {
    expect(decide({ tool_input: { command } })).toBeNull();
  });

  test('allows missing input', () => {
    expect(decide(null)).toBeNull();
    expect(decide({})).toBeNull();
  });
});

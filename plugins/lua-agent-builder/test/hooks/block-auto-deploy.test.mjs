import { describe, test, expect } from '@jest/globals';
import { decide } from '../../hooks/block-auto-deploy.mjs';

describe('block-auto-deploy decide()', () => {
  test('blocks lua push --auto-deploy', () => {
    const result = decide({ tool_input: { command: 'lua push all --auto-deploy' } });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('DEPLOY_DENIED_AUTO');
  });

  test('blocks --auto-deploy with --force suffix', () => {
    const result = decide({ tool_input: { command: 'lua push all --auto-deploy --force' } });
    expect(result?.block).toBe(true);
  });

  test('blocks --auto-deploy=true variant', () => {
    const result = decide({ tool_input: { command: 'lua push --auto-deploy=true' } });
    expect(result?.block).toBe(true);
  });

  test('allows lua push without --auto-deploy', () => {
    expect(decide({ tool_input: { command: 'lua push all --force' } })).toBeNull();
  });

  // 1.7.1: only an argument of a lua invocation counts.
  test.each([
    'cd agent && lua push skill --name x --auto-deploy',
    "bash -c 'lua push all --auto-deploy'",
    'npx lua push all --auto-deploy',
  ])('blocks the flag on a lua invocation anywhere: %s', (command) => {
    expect(decide({ tool_input: { command } })?.reason).toContain('DEPLOY_DENIED_AUTO');
  });

  test.each([
    'git commit -m "never use --auto-deploy"',
    'echo "lua push --auto-deploy is blocked" | cat',
    "grep -rn -- '--auto-deploy' commands/ | head",
    'lua push --auto-deployment',
  ])('allows text that only mentions the flag: %s', (command) => {
    expect(decide({ tool_input: { command } })).toBeNull();
  });

  test('allows other commands', () => {
    expect(decide({ tool_input: { command: 'lua test --ci' } })).toBeNull();
  });

  test('handles missing input gracefully', () => {
    expect(decide(null)).toBeNull();
    expect(decide({})).toBeNull();
    expect(decide({ tool_input: {} })).toBeNull();
  });
});

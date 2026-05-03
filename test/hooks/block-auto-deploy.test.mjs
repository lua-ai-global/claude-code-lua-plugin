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

  test('allows other commands', () => {
    expect(decide({ tool_input: { command: 'lua test --ci' } })).toBeNull();
  });

  test('handles missing input gracefully', () => {
    expect(decide(null)).toBeNull();
    expect(decide({})).toBeNull();
    expect(decide({ tool_input: {} })).toBeNull();
  });
});

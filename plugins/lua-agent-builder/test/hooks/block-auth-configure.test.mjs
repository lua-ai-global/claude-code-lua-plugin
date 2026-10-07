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

  // 1.7.1: the actual command anywhere in a chain, string or launcher.
  test.each([
    'cd agent && lua auth configure',
    'npx lua auth configure',
    "bash -c 'lua auth configure'",
    'X=1 lua auth configure',
    'lua --ci auth configure',
    'heylua auth configure',
    '(lua auth configure)',
  ])('blocks the command form %s', (command) => {
    expect(decide({ tool_input: { command } })?.reason).toContain('AUTH_INPUT_DENIED');
  });

  // 1.7.1: text that only mentions it (1.7.0's unanchored regex blocked all of these).
  test.each([
    'echo "lua auth configure" | cat',
    'grep -rn "lua auth configure" README.md commands/',
    'git commit -m "docs: run lua auth configure in a private terminal"',
    "gh pr create --title x --body \"$(cat <<'EOF'\nRun lua auth configure yourself.\nEOF\n)\"",
  ])('allows text that mentions it: %s', (command) => {
    expect(decide({ tool_input: { command } })).toBeNull();
  });

  test.each(['lua agents --json --ci', 'lua auth logout', 'lua auth configuration'])('allows %s', (command) => {
    expect(decide({ tool_input: { command } })).toBeNull();
  });

  test('allows missing input', () => {
    expect(decide(null)).toBeNull();
    expect(decide({})).toBeNull();
  });
});

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

  // 1.7.1: false positives reported against 1.6.0/1.7.0 — data is not a command.
  test.each([
    'grep -rn "lua deploy" docs | head',
    'echo "the lua workflows on flag" | cat',
    "git commit -m \"$(cat <<'EOF'\nfix: never run lua deploy all or lua version promote bare\nEOF\n)\"",
    'git commit -m "never use --auto-deploy"',
    'ls /Users/me/lua deploy | head',
    'bash -c "echo lua deploy"',
    'bash scripts/x.sh "lua deploy notes"',
    "find . -name '*.md' | xargs grep -l 'lua deploy'",
    'npx jest -t "lua deploy all"',
    'node -e "console.log(\'lua deploy\')"',
    "cat > notes.md <<'EOF'\nlua deploy all\nEOF\nbash scripts/build.sh",
    'cd /Users/me/lua/repo && node "$SCRATCH/check.mjs" "$PWD" fp',
  ])('allows a command that only mentions a verb: %s', (command) => {
    expect(decide({ tool_input: { command } }, {})).toBeNull();
  });

  // 1.7.1: a verb anywhere in the command is gated; the prefix confirms only its own simple command.
  test.each([
    ['cd x && lua deploy skill', 'lua deploy'],
    ['foo; lua version promote 3', 'lua version promote'],
    ['(lua deploy)', 'lua deploy'],
    ['$(lua deploy)', 'lua deploy'],
    ["bash -euxo pipefail -c 'lua deploy all'", 'lua deploy'],
  ])('blocks the chained/nested verb in %s', (command, label) => {
    const result = decide({ tool_input: { command } }, {});
    expect(result?.reason).toContain('DEPLOY_DENIED_BARE');
    expect(result.reason).toContain(`\`${label}\``);
  });

  test('a chained verb is allowed only with the prefix on its own simple command', () => {
    expect(decide({ tool_input: { command: 'cd x && LUA_DEPLOY_CONFIRMED=1 lua deploy skill' } }, {})).toBeNull();
    expect(decide({ tool_input: { command: 'LUA_DEPLOY_CONFIRMED=1 cd x && lua deploy skill' } }, {})?.block).toBe(true);
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

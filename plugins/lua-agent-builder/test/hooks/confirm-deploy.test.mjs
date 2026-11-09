import { describe, test, expect, jest } from '@jest/globals';
import { decide, withAsk } from '../../hooks/confirm-deploy.mjs';

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

// 1.19.1 (F3): an unresolved binary with a literal verb and no lua token asks
// interactively; headless and build sessions, where nobody can answer, block.
describe('confirm-deploy: unresolved binary, no lua token (F3)', () => {
  const CMD = 'cd /x/lua/y && T=./s.sh; $T deploy all';

  test.each(['default', 'acceptEdits', 'plan'])('interactive, permission_mode %s → ask, not block', (mode) => {
    for (const command of [CMD, '$T deploy all']) {
      const r = decide({ tool_input: { command }, permission_mode: mode }, {});
      expect(r?.block).toBeUndefined();
      expect(r?.ask).toBe(true);
      expect(r.reason).toMatch(/^DEPLOY_ASK_UNRESOLVED:/);
    }
  });

  // Fail closed: a mode that may auto-accept an ask (`auto`: a classifier settles
  // prompts, and older Claude Code may let it approve a hook ask), an older Claude
  // Code that sends no permission_mode, or a value this hook does not know keeps
  // the pre-1.19.1 block.
  test.each([['bypassPermissions'], ['dontAsk'], ['auto'], [undefined], ['someFutureMode'], ['']])(
    'interactive, permission_mode %s → block (DEPLOY_DENIED_BARE)', (mode) => {
      const input = { tool_input: { command: '$T deploy all' } };
      if (mode !== undefined) input.permission_mode = mode;
      const r = decide(input, {});
      expect(r?.block).toBe(true);
      expect(r?.ask).toBeUndefined();
      expect(r.reason).toMatch(/^DEPLOY_DENIED_BARE:/);
    });

  test('bypassPermissions blocks every probe that asks under default', () => {
    for (const command of [
      '$T deploy all', '$LUA_BIN version promote 3', 'B=$(echo bHVh | base64 -d); $B deploy all',
      'sudo $T deploy all', 'env $T deploy all', 'xargs $T deploy all',
    ]) {
      expect(decide({ tool_input: { command }, permission_mode: 'default' }, {})?.ask).toBe(true);
      const r = decide({ tool_input: { command }, permission_mode: 'bypassPermissions' }, {});
      expect(r?.block).toBe(true);
      expect(r?.ask).toBeUndefined();
    }
  });

  // 1.20.1: the classifier expands variables it can read, so a program it can show IS lua is a block, not an ask.
  test.each(['a=l; b=ua; $a$b deploy all', 'L=lua; M=$L; $M deploy all'])('%s → block under default too', (command) => {
    const r = decide({ tool_input: { command }, permission_mode: 'default' }, {});
    expect(r?.block).toBe(true);
    expect(r.reason).toMatch(/^DEPLOY_DENIED_BARE: `lua deploy`/);
  });

  test.each([
    [{ LUA_PLUGIN_HEADLESS: '1' }, /^DEPLOY_DENIED_HEADLESS/],
    [{ LUA_BUILD_SESSION: '1', LUA_PLUGIN_HEADLESS: '1' }, /./],
    [{ LUA_BUILD_SESSION: '1' }, /./],
  ])('%o → block', (env, reason) => {
    const r = decide({ tool_input: { command: CMD }, permission_mode: 'default' }, env);
    expect(r?.block).toBe(true);
    expect(r?.ask).toBeUndefined();
    expect(r.reason).toMatch(reason);
  });

  test.each([
    'L=lua; $L deploy all',
    '$(printf lua) $(printf deploy)',
    'cd /x/lua && $L deploy all',
    'X=$(which lua); $X version promote 3',
    '"$DIR/lua" deploy all',
    'npx lua deploy all',
    'lua deploy all -- --help',
    'cd /x/lua/y && LUA_DEPLOY_CONFIRMED=1 lua version promote 2 2>&1 | tail -2',
  ])('interactive still blocks %s', (command) => {
    const r = decide({ tool_input: { command }, permission_mode: 'default' }, {});
    expect(r?.block).toBe(true);
    expect(r?.ask).toBeUndefined();
  });

  test.each([
    "cd /x/lua/y && T=./s.sh; $T $SID '{}'",
    "cd /Users/x/Documents/lua/builder-qa/fleets/01; python3 - <<'EOF'\nimport json\nprint($a, ${b})\nEOF",
  ])('allows %s', (command) => {
    expect(decide({ tool_input: { command } }, {})).toBeNull();
    expect(decide({ tool_input: { command } }, { LUA_PLUGIN_HEADLESS: '1' })).toBeNull();
  });

  test('withAsk writes the PreToolUse ask envelope and lets runHook exit 0', () => {
    const out = [];
    const r = withAsk((i) => decide(i, {}), (chunk) => out.push(chunk))({ tool_input: { command: 'T=./s.sh; $T deploy all' }, permission_mode: 'default' });
    expect(r).toBeNull();
    const env = JSON.parse(out.join(''));
    expect(env.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: expect.stringMatching(/^DEPLOY_ASK_UNRESOLVED/),
    });
    // Block and allow answers pass through untouched.
    const blocked = withAsk((i) => decide(i, {}), (chunk) => out.push(chunk))({ tool_input: { command: 'lua deploy all' } });
    expect(blocked?.block).toBe(true);
    expect(withAsk(decide, () => { throw new Error('no write'); })({ tool_input: { command: 'git status' } })).toBeNull();
  });

  test('withAsk writes to stdout by default', () => {
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(withAsk(() => ({ ask: true, reason: 'r' }))({})).toBeNull();
      expect(JSON.parse(spy.mock.calls[0][0]).hookSpecificOutput.permissionDecision).toBe('ask');
    } finally {
      spy.mockRestore();
    }
  });
});

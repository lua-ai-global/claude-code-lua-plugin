import { describe, test, expect } from '@jest/globals';
import {
  isPrefixedDeploy,
  hasAutoDeploy,
  hasAuthConfigure,
  classifyProductionCommand,
  PRODUCTION_COMMANDS,
  MAX_COMMAND_LENGTH,
  TIME_BUDGET_MS,
} from '../../lib/tokenizer.mjs';

describe('isPrefixedDeploy', () => {
  test.each([
    ['LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --name foo', true],
    ['env LUA_DEPLOY_CONFIRMED=1 lua deploy webhook', true],
    ['  LUA_DEPLOY_CONFIRMED=1 lua deploy job', true],
    ['\tLUA_DEPLOY_CONFIRMED=1 lua deploy all --force', true],
    ['LUA_DEPLOY_CONFIRMED=1  lua  deploy  skill', true],
    // Every other production verb accepts the same prefix.
    ['LUA_DEPLOY_CONFIRMED=1 lua workflows deploy outreach -v latest', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua workflows activate outreach', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua version promote 3', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua persona production deploy --persona-version latest --force', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua mcp activate filesystem', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua skills deploy --skill-name x --skill-version latest', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua jobs deploy -i x -v latest', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua marketplace template apply --template-id t --all-installed --force', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua marketplace template publish --template-id t', true],
  ])('allows %s', (cmd, expected) => {
    expect(isPrefixedDeploy(cmd)).toBe(expected);
  });

  test.each([
    ['lua deploy skill --ci', false],
    ['lua deploy', false],
    ['lua workflows deploy outreach -v latest', false],
    ['lua version promote 3', false],
    ['LUA_DEPLOY_CONFIRMED=0 lua deploy skill', false],
    ['LUA_DEPLOY_CONFIRMED=true lua deploy skill', false],
    ['LUA_DEPLOY_CONFIRMED=1 lua skill --ci', false],
    ['LUA_DEPLOY_CONFIRMED=1 lua deploycommand --ci', false],
    ['LUA_DEPLOY_CONFIRMED=1 lua compile --ci', false],        // prefix on a non-gated command is meaningless
    ['LUA_DEPLOY_CONFIRMED=1 lua workflows deactivate outreach', false],
    ['bash -c "LUA_DEPLOY_CONFIRMED=1 lua deploy"', false],
    ['sh -c "LUA_DEPLOY_CONFIRMED=1 lua deploy"', false],
    ['zsh -c "LUA_DEPLOY_CONFIRMED=1 lua deploy"', false],
    ['echo y | LUA_DEPLOY_CONFIRMED=1 lua deploy', false],
    ['LUA_DEPLOY_CONFIRMED=1 lua deploy | tee log', false],
    ['', false],
  ])('blocks %s', (cmd, expected) => {
    expect(isPrefixedDeploy(cmd)).toBe(expected);
  });

  test.each([
    [null],
    [undefined],
    [42],
    [{}],
    [['lua', 'deploy']],
  ])('returns false for non-string input %p', (cmd) => {
    expect(isPrefixedDeploy(cmd)).toBe(false);
  });
});

describe('classifyProductionCommand', () => {
  test('returns null for non-production commands', () => {
    expect(classifyProductionCommand('lua compile --ci')).toBeNull();
    expect(classifyProductionCommand('lua push skill --ci --force')).toBeNull();
    expect(classifyProductionCommand('lua workflows status run_1')).toBeNull();
    expect(classifyProductionCommand('lua workflows deactivate outreach')).toBeNull();
    expect(classifyProductionCommand('lua mcp deactivate x')).toBeNull();
    expect(classifyProductionCommand('lua version list')).toBeNull();
    expect(classifyProductionCommand('lua marketplace template view --template-id t')).toBeNull();
    expect(classifyProductionCommand(null)).toBeNull();
  });

  test.each([
    ['lua deploy skill --name x', 'lua deploy', '/lua-deploy'],
    ['lua skills deploy --skill-name x', 'lua skills deploy', '/lua-deploy'],
    ['lua webhooks deploy --webhook-name x', 'lua webhooks deploy', '/lua-deploy'],
    ['lua jobs deploy -i x -v latest', 'lua jobs deploy', '/lua-deploy'],
    ['lua preprocessors deploy --preprocessor-name x', 'lua preprocessors deploy', '/lua-deploy'],
    ['lua postprocessors deploy --postprocessor-name x', 'lua postprocessors deploy', '/lua-deploy'],
    ['lua persona production deploy --persona-version 5', 'lua persona production deploy', '/lua-deploy'],
    ['lua workflows deploy outreach -v latest', 'lua workflows deploy', '/lua-deploy'],
    ['lua workflows activate outreach', 'lua workflows activate', '/lua-deploy'],
    ['lua version promote v3', 'lua version promote', '/lua-deploy'],
    ['lua mcp activate --server-name fs', 'lua mcp activate', '/lua-deploy'],
    ['lua marketplace template publish --template-id t', 'lua marketplace template publish', '/lua-template'],
    ['lua marketplace template apply --template-id t --agents a,b --force', 'lua marketplace template apply', '/lua-template'],
  ])('classifies %s as %s (confirm via %s)', (cmd, label, slash) => {
    expect(classifyProductionCommand(cmd)).toEqual({ label, slash, prefixed: false });
    expect(classifyProductionCommand(`LUA_DEPLOY_CONFIRMED=1 ${cmd}`)).toEqual({ label, slash, prefixed: true });
    expect(classifyProductionCommand(`env LUA_DEPLOY_CONFIRMED=1 ${cmd}`)).toEqual({ label, slash, prefixed: true });
  });

  test('a wrapper or pipe is recognised but never counts as prefixed', () => {
    expect(classifyProductionCommand('bash -c "LUA_DEPLOY_CONFIRMED=1 lua deploy skill"'))
      .toEqual({ label: 'lua deploy', slash: '/lua-deploy', prefixed: false });
    expect(classifyProductionCommand('echo y | LUA_DEPLOY_CONFIRMED=1 lua version promote 3'))
      .toEqual({ label: 'lua version promote', slash: '/lua-deploy', prefixed: false });
  });

  test('every PRODUCTION_COMMANDS entry has a label, a binary-anchored regex and a slash', () => {
    for (const entry of PRODUCTION_COMMANDS) {
      expect(entry.label).toMatch(/^lua /);
      expect(entry.re.source.startsWith('^(?:lua|heylua|lua-ai)\\s+')).toBe(true);
      expect(entry.slash).toMatch(/^\/lua-/);
    }
  });

  // Architect review S1: lua-cli resolves action aliases at runtime
  // (src/utils/aliases.ts), so `lua skills publish` IS `lua skills deploy`.
  test.each([
    ['lua skills publish --skill-name x', 'lua skills deploy'],
    ['lua webhooks publish --webhook-name x', 'lua webhooks deploy'],
    ['lua jobs publish -i x -v latest', 'lua jobs deploy'],
    ['lua preprocessors publish --preprocessor-name x', 'lua preprocessors deploy'],
    ['lua postprocessors publish --postprocessor-name x', 'lua postprocessors deploy'],
    ['lua persona production publish --persona-version 5', 'lua persona production deploy'],
    ['lua persona prod deploy --persona-version 5', 'lua persona production deploy'],
    ['lua persona prd deploy --persona-version 5', 'lua persona production deploy'],
    ['lua persona live publish --persona-version 5', 'lua persona production deploy'],
    ['lua workflows publish outreach -v latest', 'lua workflows deploy'],
    ['lua workflows on outreach', 'lua workflows activate'],
    ['lua workflows enable outreach', 'lua workflows activate'],
    ['lua mcp on fs', 'lua mcp activate'],
    ['lua mcp enable fs', 'lua mcp activate'],
    ['lua marketplace template publish_version --template-id t', 'lua marketplace template publish'],
    ['lua marketplace template submit --template-id t', 'lua marketplace template publish'],
    ['lua marketplace template deploy --template-id t', 'lua marketplace template apply'],
    ['lua marketplace template fleet-apply --template-id t', 'lua marketplace template apply'],
    ['lua marketplace template rollout --template-id t', 'lua marketplace template apply'],
  ])('classifies the alias spelling %s as %s', (cmd, label) => {
    expect(classifyProductionCommand(cmd)?.label).toBe(label);
    expect(classifyProductionCommand(cmd)?.prefixed).toBe(false);
    expect(classifyProductionCommand(`LUA_DEPLOY_CONFIRMED=1 ${cmd}`)?.prefixed).toBe(true);
  });

  // lua-cli's package.json installs three binaries for the same entry point.
  test.each([
    ['heylua deploy skill', 'lua deploy'],
    ['lua-ai deploy all --force', 'lua deploy'],
    ['heylua version promote 3', 'lua version promote'],
    ['lua-ai workflows on outreach', 'lua workflows activate'],
  ])('classifies the alternative binary in %s as %s', (cmd, label) => {
    expect(classifyProductionCommand(cmd)?.label).toBe(label);
  });

  test('alias look-alikes that are NOT production verbs stay unclassified', () => {
    expect(classifyProductionCommand('lua workflows off outreach')).toBeNull();
    expect(classifyProductionCommand('lua workflows disable outreach')).toBeNull();
    expect(classifyProductionCommand('lua mcp off fs')).toBeNull();
    expect(classifyProductionCommand('lua persona production view')).toBeNull();
    expect(classifyProductionCommand('lua persona prod versions')).toBeNull();
    expect(classifyProductionCommand('lua marketplace skill publish --skill-name x')).toBeNull(); // marketplace skill publish is `ask`, not a production deploy of this agent
    expect(classifyProductionCommand('lua deployment')).toBeNull();
    expect(classifyProductionCommand('luadeploy')).toBeNull();
    expect(classifyProductionCommand('lua-cli deploy')).toBeNull();
  });
});

describe('hasAutoDeploy', () => {
  test.each([
    ['lua push all --auto-deploy', true],
    ['lua push skill --ci --auto-deploy --force', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua deploy --auto-deploy', true],
    ['lua push all --auto-deploy=true', true],   // = is non-word, \b matches; deny must catch all forms
    ['lua push --auto-deployment', false],        // -ment continues the word, no boundary
    ['lua push all', false],
    ['', false],
  ])('detects --auto-deploy in %s', (cmd, expected) => {
    expect(hasAutoDeploy(cmd)).toBe(expected);
  });

  test.each([
    'git commit -m "never use --auto-deploy"',
    'echo "x --auto-deploy" | grep auto',
    "grep -rn -- '--auto-deploy' plugins | head -3",
    "git commit -m \"$(cat <<'EOF'\nfix: block lua push --auto-deploy\nEOF\n)\"",
    'npm run release -- --auto-deploy',
    'lua push all --ci --force # never --auto-deploy',
  ])('text that only mentions the flag is not a lua argument: %j', (cmd) => {
    expect(hasAutoDeploy(cmd)).toBe(false);
  });

  test.each([
    'cd x && lua push skill --name y --auto-deploy=true',
    "bash -c 'lua push all --auto-deploy'",
    'echo $(lua push all --auto-deploy)',
    'npx lua-cli push skill --name x --auto-deploy',
    'lua${IFS}push${IFS}--auto-deploy',
    'heylua push all --AUTO-DEPLOY',
    'ssh host lua push all --auto-deploy',
    'lua push all --ci ' + '--force '.repeat(80) + '--auto-deploy',
    'lua push all "--auto-deploy',
    '$(which lua) push skill --auto-deploy',
    'L=lua; $L push all --auto-deploy',
    '"$LUA_BIN" push all --auto-deploy',
  ])('the flag as an argument of a lua invocation is found: %j', (cmd) => {
    expect(hasAutoDeploy(cmd)).toBe(true);
  });

  test('fails closed when the command cannot be analysed', () => {
    const boom = () => { throw new Error('classifier bug'); };
    expect(hasAutoDeploy('lua push all --auto-deploy', { analyze: boom })).toBe(true);
    expect(hasAutoDeploy('git commit -m "x --auto-deploy"', { analyze: boom })).toBe(false);
    expect(hasAutoDeploy('lua push all --auto-deploy', { budgetMs: -1 })).toBe(true);
    expect(hasAutoDeploy('lua push all --auto-deploy ' + 'x'.repeat(MAX_COMMAND_LENGTH))).toBe(true);
  });

  test('returns false for non-string', () => {
    expect(hasAutoDeploy(null)).toBe(false);
    expect(hasAutoDeploy(undefined)).toBe(false);
    expect(hasAutoDeploy(42)).toBe(false);
  });
});

// ── 1.7.1: the hook classifies what a command RUNS, never text it mentions ──

describe('false positives from 1.6.0: commands that deploy nothing are not classified', () => {
  test.each([
    // pipes, heredocs and commit messages
    'grep -rn "lua deploy" docs | head',
    'echo "set the lua workflows on flag later" | cat',
    "git log --oneline | grep 'lua version promote'",
    "git commit -m \"$(cat <<'EOF'\nfix: document lua deploy skill and lua version promote 3\nEOF\n)\"",
    "cat <<'EOF' | tee notes.md\nlua deploy all\nEOF",
    'ls /Users/me/lua deploy | head',
    'ls ~/lua/deploy | wc -l',
    // a shell's -c script is parsed; what it runs is grep/echo/git
    'bash -c "echo lua deploy"',
    'sh -c \'grep "lua deploy" notes.md\'',
    'bash -lc \'cd x && git commit -m "docs: lua deploy all"\'',
    'zsh -c \'echo "$(date)"; echo lua version promote 3\'',
    'bash -c \'npm test 2>&1 | grep "lua version promote"\'',
    "cat notes.md | sh -c 'grep lua deploy'",
    // a shell's script-file operand and its arguments are data
    'bash scripts/x.sh "lua deploy notes"',
    'sh ./release.sh --notes "run lua deploy all after merge"',
    // xargs and package runners pass argv to a program, not to a shell
    "find . -name '*.md' | xargs grep -l 'lua deploy'",
    'npx jest -t "lua deploy all"',
    'npm test -- -t "lua deploy" 2>&1 | tail',
    "npm test 2>&1 | grep 'lua deploy'",
    // runners that join argv: the joined string is parsed, not text-searched
    'ssh box \'grep "lua deploy" /var/log/agent.log\'',
    'watch -n 5 \'grep -c "lua deploy" deploy.log\'',
    // inline code that cannot start a process
    'node -e "console.log(\'lua deploy\')"',
    "python3 <<'EOF'\nprint('lua deploy all')\nEOF",
    // stdin that is data
    "node scripts/p.mjs <<'EOF'\nlua deploy all\nEOF",
    "cat > notes.md <<'EOF'\nlua deploy all\nEOF\nbash scripts/build.sh",
    "cat > notes.md <<'EOF'\nlua deploy all\nEOF\ncp notes.md docs/ && bash scripts/build.sh",
    'ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no box \'grep "lua deploy" log\'',
    // a shell name that is only a word
    "grep -rn 'lua deploy' docs | grep -v bash | head",
    // a computed path whose script name is literal
    'cd /Users/me/lua/repo && node "$SCRATCH/check.mjs" "$PWD" bypass',
    'node $S/check.mjs $P fp',
  ])('%j', (cmd) => {
    expect(classifyProductionCommand(cmd)).toBeNull();
  });
});

describe('false negatives: a verb anywhere in the command is classified and blocked unless prefixed', () => {
  test.each([
    ['cd x && lua deploy skill', 'lua deploy'],
    ['foo; lua version promote 3', 'lua version promote'],
    ['(lua deploy)', 'lua deploy'],
    ['$(lua deploy)', 'lua deploy'],
    ['echo $(lua deploy all)', 'lua deploy'],
    ['true || lua workflows on outreach', 'lua workflows activate'],
    ['echo `lua mcp activate fs`', 'lua mcp activate'],
  ])('%j → %s', (cmd, label) => {
    expect(classifyProductionCommand(cmd)).toEqual({ label, slash: '/lua-deploy', prefixed: false });
  });

  test('the prefix counts only on the simple command it precedes', () => {
    expect(isPrefixedDeploy('cd x && LUA_DEPLOY_CONFIRMED=1 lua deploy skill')).toBe(true);
    expect(isPrefixedDeploy('foo; LUA_DEPLOY_CONFIRMED=1 lua version promote 3')).toBe(true);
    expect(isPrefixedDeploy('LUA_DEPLOY_CONFIRMED=1 cd x && lua deploy skill')).toBe(false);
    expect(isPrefixedDeploy('(LUA_DEPLOY_CONFIRMED=1 lua deploy)')).toBe(false);
    expect(isPrefixedDeploy('$(LUA_DEPLOY_CONFIRMED=1 lua deploy)')).toBe(false);
  });
});

describe('strings a command really runs are still parsed (no new bypass)', () => {
  test.each([
    "bash -euxo pipefail -c 'lua deploy all'",
    "bash -o pipefail -c 'lua deploy all'",
    "bash -c -- 'lua deploy all'",
    "bash --login -c 'lua deploy all'",
    "bash --rcfile x.rc -c 'lua deploy all'",
    "fish --command='lua deploy all'",
    "fish -C 'lua deploy all'",
    'sh -c "$(echo lua deploy all)"',
    'sh -c \'"$@"\' _ lua deploy all',
    'echo lua deploy all | sudo bash',
    'echo lua deploy all | sudo -s',
    'echo lua deploy all | docker exec -i c sh',
    "echo 'lua deploy all' | xargs -I{} sh -c '{}'",
    "echo lua deploy all | bash -c 'bash'",
    'echo lua deploy all | sh -c "$(cat)"',
    "node <<EOF\nrequire('child_process').execSync('lua deploy all')\nEOF",
    "python3 - <<EOF\nimport os; os.system('lua deploy all')\nEOF",
    "node -p \"require('child_process').execSync('lua deploy all')+''\"",
    "perl -e 'qx(lua deploy all)'",
    "ruby -e '%x(lua deploy all)'",
    'ssh -i key host lua deploy all',
    'ssh host "$(echo lua deploy all)"',
    'watch "$(echo lua deploy all)"',
    'eval "$(echo lua deploy all)"',
    "su - me -c 'lua deploy all'",
    "script -q -c 'lua deploy all' /dev/null",
    "npm exec --call='lua deploy all'",
    "npm exec -c 'lua deploy all'",
    "npx -c \"$(echo lua deploy all)\"",
    "cat > /tmp/x.sh <<'EOF'\nlua deploy all\nEOF\nbash /tmp/x.sh",
    "cat >x.sh <<'EOF'\nlua deploy all\nEOF\nchmod +x x.sh && ./x.sh",
    "tee x.sh <<'EOF'\nlua deploy all\nEOF\nsource x.sh",
    "cat > \"$F\" <<'EOF'\nlua deploy all\nEOF\nbash \"$F\"",
    "cat > \"$F\" <<'EOF'\nlua deploy all\nEOF\nsh x.sh",
    "kubectl exec -i p -- sh <<EOF\nlua deploy all\nEOF",
    "env bash -c 'lua deploy all'",
    "time sh -c 'cd x; lua version promote 3'",
    'pwsh -Command "lua deploy all"',
    "cat > x.sh <<'EOF'\nlua deploy all\nEOF\ncp x.sh y.sh && bash y.sh",
    "cat > x.sh <<'EOF'\nlua deploy all\nEOF\nmv x.sh y.sh; sh y.sh",
    "ssh -o ProxyCommand='lua deploy all' host",
    "ssh -oLocalCommand='lua version promote 3' -o PermitLocalCommand=yes host",
    'ssh -o "RemoteCommand lua deploy all" host',
    '"$DIR/lua" deploy all',
    '$X/dist/index.js deploy all',
  ])('%j', (cmd) => {
    const c = classifyProductionCommand(cmd);
    expect(c).not.toBeNull();
    expect(c.prefixed).toBe(false);
  });

  test('`eval eval eval …` is parsed once per distinct string, inside the budget', () => {
    const t0 = performance.now();
    expect(classifyProductionCommand('eval ' + 'eval '.repeat(5000) + 'lua deploy all')?.prefixed).toBe(false);
    expect(performance.now() - t0).toBeLessThan(TIME_BUDGET_MS + 250);
  });
});

describe('hasAuthConfigure', () => {
  test.each([
    'lua auth configure',
    'lua auth configure --email person@example.com',
    'cd x && lua auth configure',
    'npx lua auth configure',
    "bash -c 'lua auth configure'",
    'X=1 lua auth configure',
    'lua --ci auth configure',
    'heylua AUTH Configure',
    '(lua auth configure)',
    'echo `lua auth configure`',
    "bash -c \"lua auth 'configure' --api-key k\"",
    'lua auth  configure',
    '$(which lua) auth configure',
  ])('detects %j', (cmd) => {
    expect(hasAuthConfigure(cmd)).toBe(true);
  });

  test.each([
    'echo "lua auth configure" | cat',
    'grep "lua auth configure" README.md',
    'git commit -m "docs: run lua auth configure in a private terminal"',
    'lua auth configuration',
    'lua auth logout',
    'lua configure',
    'git config --global user.name x',
    '',
  ])('ignores %j', (cmd) => {
    expect(hasAuthConfigure(cmd)).toBe(false);
  });

  test('fails closed when the command cannot be analysed', () => {
    const boom = () => { throw new Error('classifier bug'); };
    expect(hasAuthConfigure('lua auth configure', { analyze: boom })).toBe(true);
    expect(hasAuthConfigure('echo auth configure', { analyze: boom })).toBe(false);
    expect(hasAuthConfigure('lua auth configure', { budgetMs: -1 })).toBe(true);
  });

  test('returns false for non-string', () => {
    expect(hasAuthConfigure(null)).toBe(false);
    expect(hasAuthConfigure(42)).toBe(false);
  });
});

// EM-WS8 (1.6.0): the confirm-deploy parser bypasses from the Job-tier audit
// (finding 3; `lib/tokenizer.mjs:81-96` in 1.5.0) and the shell shapes that
// neighbour them. Every case here PASSED the 1.5.0 regex classifier.

import { describe, test, expect } from '@jest/globals';
import { classifyProductionCommand, isPrefixedDeploy, lex, UNRESOLVED_LABEL } from '../../lib/tokenizer.mjs';

const bare = (label, slash = '/lua-deploy') => ({ label, slash, prefixed: false });
const DEPLOY = bare('lua deploy');
const PROMOTE = bare('lua version promote');

describe('the five bypasses named in the Job-tier audit', () => {
  test.each([
    ['cd x && lua deploy all --force', DEPLOY],
    ['true; lua version promote 3', PROMOTE],
    ['FOO=1 lua deploy all', DEPLOY],
    ['/usr/local/bin/lua deploy all', DEPLOY],
    ['npx lua deploy all', DEPLOY],
  ])('%s is classified and not prefixed', (cmd, expected) => {
    expect(classifyProductionCommand(cmd)).toEqual(expected);
  });
});

describe('verbs anywhere in a command chain', () => {
  test.each([
    'false || lua deploy all',
    'lua compile --ci && lua deploy all',
    'lua compile --ci\nlua deploy all',
    'lua compile --ci & lua deploy all',
    'lua compile --ci; lua deploy all',
    '(lua deploy all)',
    '(cd agent && lua deploy all)',
    '{ lua deploy all; }',
    'if true; then lua deploy all; fi',
    'for i in 1; do lua deploy all; done',
    '! lua deploy all',
    'lua status |& lua deploy all',
    'f() { lua deploy all; }; f',
    'case x in x) lua deploy all;; esac',
  ])('%s', (cmd) => {
    expect(classifyProductionCommand(cmd)).toEqual(DEPLOY);
  });
});

describe('env-assignment prefixes, wrappers and binary paths', () => {
  test.each([
    'FOO=1 BAR=2 lua deploy all',
    'env FOO=1 lua deploy all',
    'env -i PATH=/usr/bin lua deploy all',
    'command lua deploy all',
    'exec lua deploy all',
    'nohup lua deploy all',
    'time lua deploy all',
    'timeout 60 lua deploy all',
    'sudo -u deployer lua deploy all',
    './node_modules/.bin/lua deploy all',
    '~/.npm-global/bin/heylua deploy all',
    '"C:\\Users\\me\\AppData\\Roaming\\npm\\lua.cmd" deploy all',
    'C:/Users/me/AppData/Roaming/npm/lua.cmd deploy all',
    '"lua" deploy all',
    "'lua' deploy all",
    'l\\ua deploy all',
    'lu""a deploy all',
  ])('%s', (cmd) => {
    expect(classifyProductionCommand(cmd)).toEqual(DEPLOY);
  });
});

describe('package runners and node entry points', () => {
  test.each([
    'npx lua deploy all',
    'npx lua-cli deploy all',
    'npx -y lua-cli@3.38.0 deploy all',
    'npx --yes lua-cli@latest deploy all',
    'npx -p lua-cli lua deploy all',
    'pnpm exec lua deploy all',
    'pnpm dlx lua-cli deploy all',
    'pnpx lua-cli deploy all',
    'yarn lua deploy all',
    'yarn dlx lua-cli deploy all',
    'npm exec -- lua deploy all',
    'npm x lua-cli -- deploy all',
    'bunx lua-cli deploy all',
    'node /x/lua deploy all',
    'node ./node_modules/.bin/lua deploy all',
    'node node_modules/lua-cli/dist/index.js deploy all',
    'node --no-warnings -r dotenv/config /usr/lib/node_modules/lua-cli/dist/index.js deploy all',
    'node /opt/heylua/dist/index.js deploy all',
    '/opt/lua-cli/dist/index.js deploy all',
  ])('%s', (cmd) => {
    expect(classifyProductionCommand(cmd)).toEqual(DEPLOY);
  });

  test('`lua-cli` alone at the head is not an installed binary (unchanged from 1.5.0)', () => {
    expect(classifyProductionCommand('lua-cli deploy')).toBeNull();
  });

  test('node running some other script is not lua', () => {
    expect(classifyProductionCommand('node scripts/build.mjs deploy all')).toBeNull();
    expect(classifyProductionCommand('node --version')).toBeNull();
  });
});

describe('options between the binary and the verb', () => {
  test.each([
    ['lua --ci deploy all', 'lua deploy'],
    ['lua workflows -v 3 deploy outreach', 'lua workflows deploy'],
    ['lua workflows --version=3 deploy outreach', 'lua workflows deploy'],
    ['lua persona --force production deploy --persona-version 5', 'lua persona production deploy'],
    ['lua version --json promote 3', 'lua version promote'],
  ])('%s → %s', (cmd, label) => {
    expect(classifyProductionCommand(cmd)?.label).toBe(label);
  });
});

describe('aliases the 1.5.0 table missed', () => {
  test.each([
    ['lua marketplace templates publish --template-id t', 'lua marketplace template publish'],
    ['lua marketplace agent-template submit --template-id t', 'lua marketplace template publish'],
    ['lua marketplace agent-templates rollout --template-id t', 'lua marketplace template apply'],
    ['lua workflows DEPLOY outreach -v 2', 'lua workflows deploy'],
    ['lua mcp ON fs', 'lua mcp activate'],
    ['lua persona LIVE Publish --persona-version 5', 'lua persona production deploy'],
  ])('%s → %s', (cmd, label) => {
    expect(classifyProductionCommand(cmd)?.label).toBe(label);
    expect(classifyProductionCommand(`LUA_DEPLOY_CONFIRMED=1 ${cmd}`)?.prefixed).toBe(true);
  });
});

describe('substitutions and strings run by another shell', () => {
  test.each([
    'echo $(lua deploy all)',
    'echo "$(lua deploy all)"',
    'echo `lua deploy all`',
    'echo "`lua deploy all`"',
    'lua chat --ci -e sandbox -m "$(lua version promote 3)" -t t1',
    'diff <(lua deploy all) /dev/null',
    'tee >(lua deploy all) < /dev/null',
    'bash -c "lua deploy all"',
    "sh -lc 'lua deploy all'",
    'zsh -c "cd x && lua deploy all"',
    '/bin/bash -c "lua deploy all"',
    'eval "lua deploy all"',
    'eval lua deploy all',
    'ssh prod-box "lua deploy all"',
    'watch -n 5 "lua deploy all"',
    'npx -c "lua deploy all"',
    'printf "lua deploy all" | sh',
    'echo "lua deploy all" | bash -s',
    'bash <<EOF\nlua deploy all\nEOF',
    'sh <<-\'EOF\'\n\tlua deploy all\n\tEOF',
    'bash <<< "lua deploy all"',
    'source /dev/stdin <<EOF\nlua deploy all\nEOF',
    'alias ship="lua deploy all"; ship',
    "trap 'lua deploy all' EXIT",
    'echo deploy all | xargs lua',
    'xargs -a verbs.txt lua',
    'bash -c "bash -c \\"lua deploy all\\""',
  ])('%s', (cmd) => {
    const c = classifyProductionCommand(cmd);
    expect(c).not.toBeNull();
    expect(c.prefixed).toBe(false);
  });

  test('inline interpreter code is searched as text', () => {
    for (const cmd of [
      "node -e \"require('child_process').execSync('lua deploy all')\"",
      "python3 -c \"import os; os.system('lua version promote 3')\"",
      "perl -e 'system(\"lua deploy all\")'",
      'python3 <<EOF\nimport os; os.system("lua deploy all")\nEOF',
    ]) {
      expect({ cmd, prefixed: classifyProductionCommand(cmd)?.prefixed }).toEqual({ cmd, prefixed: false });
    }
  });

  test('a prefix inside a wrapper, pipe, group or substitution never counts', () => {
    for (const cmd of [
      'bash -c "LUA_DEPLOY_CONFIRMED=1 lua deploy skill"',
      'echo $(LUA_DEPLOY_CONFIRMED=1 lua deploy skill)',
      '(LUA_DEPLOY_CONFIRMED=1 lua deploy skill)',
      '{ LUA_DEPLOY_CONFIRMED=1 lua deploy skill; }',
      'LUA_DEPLOY_CONFIRMED=1 lua deploy skill | tee log',
      'echo y | LUA_DEPLOY_CONFIRMED=1 lua deploy skill',
      'LUA_DEPLOY_CONFIRMED=1 lua deploy skill |& cat',
    ]) {
      expect({ cmd, prefixed: isPrefixedDeploy(cmd) }).toEqual({ cmd, prefixed: false });
      expect(classifyProductionCommand(cmd)).not.toBeNull();
    }
  });
});

describe('shell variables in the binary or verb position (cannot be resolved → blocked)', () => {
  test.each([
    ['L=lua; $L deploy all', 'lua deploy'],
    ['"$LUA_BIN" version promote 3', 'lua version promote'],
    ['$(which lua) deploy all', 'lua deploy'],
    ['env $LUA deploy all', 'lua deploy'],
    ["$'\\x6cua' deploy all", 'lua deploy'],
    ['lua $VERB all', UNRESOLVED_LABEL],
    ['lua "$VERB" all', UNRESOLVED_LABEL],
    ['lua workflows $ACTION outreach', UNRESOLVED_LABEL],
    ['lua ${CMD} all', UNRESOLVED_LABEL],
  ])('%s → %s', (cmd, label) => {
    expect(classifyProductionCommand(cmd)).toEqual({ label, slash: '/lua-deploy', prefixed: false });
  });

  test('a prefixed command with a variable verb is still blocked', () => {
    expect(isPrefixedDeploy('LUA_DEPLOY_CONFIRMED=1 lua $VERB all')).toBe(false);
  });

  test('a variable that is not in command position is just an argument', () => {
    expect(classifyProductionCommand('echo $HOME deploy all')).toBeNull();
    expect(classifyProductionCommand('lua test --ci skill --name $SKILL')).toBeNull();
    expect(classifyProductionCommand('lua chat --ci -e sandbox -m "$MSG" -t t1')).toBeNull();
  });
});

describe('LUA_DEPLOY_CONFIRMED=1 counts only on the same simple command', () => {
  test.each([
    'export LUA_DEPLOY_CONFIRMED=1; lua deploy all',
    'export LUA_DEPLOY_CONFIRMED=1 && lua deploy all',
    'LUA_DEPLOY_CONFIRMED=1 true && lua deploy all',
    'LUA_DEPLOY_CONFIRMED=1; lua deploy all',
    'LUA_DEPLOY_CONFIRMED=1 lua deploy skill; lua version promote 3',
    'LUA_DEPLOY_CONFIRMED=1 lua compile --ci && lua deploy all',
    'LUA_DEPLOY_CONFIRMED=1 npx lua deploy all',
    'LUA_DEPLOY_CONFIRMED=1 /usr/local/bin/lua deploy all',
    'LUA_DEPLOY_CONFIRMED=1 node node_modules/lua-cli/dist/index.js deploy all',
    'FOO=1 LUA_DEPLOY_CONFIRMED=1 lua deploy all',
    'LUA_DEPLOY_CONFIRMED=1 FOO=1 lua deploy all',
    'LUA_DEPLOY_CONFIRMED=1 env lua deploy all',
    '"LUA_DEPLOY_CONFIRMED=1" lua deploy all',
    'sudo LUA_DEPLOY_CONFIRMED=1 lua deploy all',
    'if LUA_DEPLOY_CONFIRMED=1 lua deploy all; then :; fi',
  ])('blocks %s', (cmd) => {
    expect(isPrefixedDeploy(cmd)).toBe(false);
    expect(classifyProductionCommand(cmd)?.prefixed).toBe(false);
  });

  test.each([
    'cd agent && LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --name x --set-version latest --force',
    'lua compile --ci && LUA_DEPLOY_CONFIRMED=1 lua deploy all --ci --force',
    'LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --force && LUA_DEPLOY_CONFIRMED=1 lua deploy webhook --ci --force',
    'LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --name x --set-version 1 --force > deploy.log 2>&1',
    'LUA_DEPLOY_CONFIRMED=1 lua deploy all --ci --force 2>/dev/null',
    'LUA_DEPLOY_CONFIRMED=1 lua deploy all --ci --force &> deploy.log',
    'LUA_DEPLOY_CONFIRMED=1 lua deploy all --ci --force # ship it',
    'LUA_DEPLOY_CONFIRMED=1 lua deploy all \\\n  --ci --force',
    'LUA_DEPLOY_CONFIRMED=1 lua marketplace template publish --template-id t --changelog "fix: a; b && c" --yes',
    "LUA_DEPLOY_CONFIRMED=1 lua workflows deploy outreach -v 'latest'",
    'LUA_DEPLOY_CONFIRMED=1 heylua version promote 3',
    'env LUA_DEPLOY_CONFIRMED=1 lua-ai mcp activate fs',
  ])('allows %s', (cmd) => {
    expect(isPrefixedDeploy(cmd)).toBe(true);
  });
});

describe('false-positive guards: text that only MENTIONS a verb', () => {
  test.each([
    'git commit -m "lua deploy all"',
    "git commit -m 'chore: document lua version promote 3'",
    "echo 'lua version promote 3'",
    'grep -r "lua deploy" .',
    'grep -rn "lua workflows activate" commands/',
    'lua push skill --ci --force && lua compile --ci',
    'lua chat --ci -e production -m "please lua deploy all" -t t1',
    'gh pr create --title "x" --body "run lua deploy all after merge"',
    'cat > notes.md <<EOF\nrun lua deploy all\nEOF',
    "cat <<'EOF' > notes.md\nlua version promote 3\nEOF",
    'lua deployment',
    'lua workflows status deploy',
    'lua workflows deactivate outreach',
    'lua test --ci skill --name deploy',
    'lua logs --ci --type all --json 2>&1 | head -20',
    'arr=(lua deploy all); echo ok',
    'git log --oneline -5 # lua deploy all',
    'echo "\\"lua deploy\\" is gated"',
    'echo "cost: $5" && lua status --json --ci',
  ])('%s', (cmd) => {
    expect(classifyProductionCommand(cmd)).toBeNull();
  });
});

describe('input the lexer cannot close falls back to a textual search (fail closed)', () => {
  test.each([
    'bash -c "lua deploy all',
    "echo 'unterminated && lua deploy all",
    'echo $(lua deploy all',
    'echo `lua deploy all',
    'echo "`lua deploy all',
    "echo $'lua deploy all",
    'arr=(lua deploy all',
    'lua-cli/dist/index.js --ci deploy all "',
  ])('%s', (cmd) => {
    expect(classifyProductionCommand(cmd)?.prefixed).toBe(false);
  });

  test('deeply nested shells stop recursing and search the rest as text', () => {
    let cmd = 'lua deploy all';
    for (let k = 0; k < 10; k++) cmd = `eval ${JSON.stringify(cmd)}`;
    expect(classifyProductionCommand(cmd)?.prefixed).toBe(false);
  });
});

describe('the classifier stays fast and fails closed (a hook that times out or throws fails OPEN)', () => {
  // Before the fix, 28 options made the textual fallback backtrack for ~200 s.
  test.each([
    ['inline code', 'node -e 1 "lua ' + '--a '.repeat(40) + 'zz"; lua deploy all', 'lua deploy'],
    ['opaque input', 'lua ' + '--a '.repeat(40) + 'zz "', null],
    ['opaque input with values', 'lua ' + '--a=1 '.repeat(40) + 'zz "', null],
    ['opaque input that deploys', 'lua ' + '--a=1 '.repeat(40) + 'deploy all "', 'lua deploy'],
    ['long chains', 'lua status --ci && '.repeat(400) + 'lua deploy all', 'lua deploy'],
    ['deep substitutions', 'echo '.concat('$('.repeat(50), 'lua deploy all', ')'.repeat(50)), 'lua deploy'],
  ])('%s', (_name, cmd, label) => {
    const t0 = performance.now();
    const result = classifyProductionCommand(cmd);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(result?.label ?? null).toBe(label);
  });

  test('random shell soup never throws and never takes long', () => {
    const parts = ['"', "'", '\\', '$', '(', ')', '`', '|', '&', ';', '<', '>', '{', '}', '\n', ' ', '#', '=',
      'lua deploy all', 'lua', 'deploy', '--ci', '<<E', 'E', '$(', 'bash -c ', 'npx ', 'LUA_DEPLOY_CONFIRMED=1 ', 'x'];
    let seed = 42;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const t0 = performance.now();
    for (let k = 0; k < 3000; k++) {
      let cmd = '';
      for (let p = rand(30); p > 0; p--) cmd += parts[rand(parts.length)];
      expect(() => classifyProductionCommand(cmd)).not.toThrow();
    }
    expect(performance.now() - t0).toBeLessThan(10_000);
  });

  test('an internal error blocks a command that mentions lua, and ignores one that does not', () => {
    const boom = () => { throw new Error('classifier bug'); };
    expect(classifyProductionCommand('lua status', { analyze: boom }))
      .toEqual({ label: UNRESOLVED_LABEL, slash: '/lua-deploy', prefixed: false });
    expect(classifyProductionCommand('git status', { analyze: boom })).toBeNull();
  });
});

describe('lex()', () => {
  test('splits a chain into simple commands and marks pipelines and groups', () => {
    const { segments, subs, opaque } = lex('a 1 && (b 2 | c 3); d "x y" 2>&1 > out');
    expect(opaque).toBe(false);
    expect(subs).toEqual([]);
    expect(segments.map((s) => s.words.map((w) => w.text))).toEqual([['a', '1'], ['b', '2'], ['c', '3'], ['d', 'x y']]);
    expect(segments.map((s) => s.pipeline)).toEqual([false, true, true, false]);
    expect(segments.map((s) => s.grouped)).toEqual([false, true, true, false]);
  });

  test('collects substitutions, heredocs and here-strings', () => {
    const { segments, subs } = lex('x $(y) `z` <(w) <<< "h s"\ncat <<E\nbody\nE');
    expect(subs).toEqual(['y', 'z', 'w']);
    expect(segments[0].herestrings).toEqual(['h s']);
    expect(segments[1].heredocs).toEqual(['body']);
  });

  test('an unterminated heredoc takes the rest of the input', () => {
    const { segments } = lex('cat <<E\nline 1\nline 2');
    expect(segments[0].heredocs).toEqual(['line 1\nline 2']);
  });

  test('escapes, locale strings, comments and fd redirects', () => {
    const { segments } = lex('a "q\\"x\\\\y\\z" $"loc" b\\ c 3< in # c\n  <> rw x >| y');
    expect(segments[0].words.map((w) => w.text)).toEqual(['a', 'q"x\\y\\z', 'loc', 'b c']);
    expect(segments[1].words.map((w) => w.text)).toEqual(['x']);
  });

  test('double-quoted line continuation and a trailing escape', () => {
    const { segments } = lex('a "x\\\ny" b\\');
    expect(segments[0].words.map((w) => w.text)).toEqual(['a', 'xy', 'b']);
  });

  test('an empty pipe stage still marks the pipeline', () => {
    const { segments } = lex('a || b | | c');
    expect(segments.map((s) => s.pipeline)).toEqual([false, true, true]);
  });

  test('a substitution body keeps its quoted parentheses', () => {
    expect(lex('echo $(printf \'a)\' "b)\\")" \\) x)').subs).toEqual(['printf \'a)\' "b)\\")" \\) x']);
    expect(lex("echo $(printf 'a").opaque).toBe(true);
    expect(lex('echo $(printf "a').opaque).toBe(true);
  });

  test('an unmatched ")" and a lone "$" do not throw', () => {
    expect(lex('a ) b $').segments.map((s) => s.words.map((w) => w.text))).toEqual([['a'], ['b', '$']]);
  });
});

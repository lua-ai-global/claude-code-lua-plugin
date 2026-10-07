// Per tech spec §17.4 / feature doc §6.5, hardened in 1.6.0 (EM-WS8).
// Parses bash command strings to detect production-affecting lua-cli
// invocations and the LUA_DEPLOY_CONFIRMED=1 prefix that signals
// user-authorised intent.
//
// THIS FILE IS THE SINGLE SOURCE OF TRUTH for "what changes production".
// hooks/confirm-deploy.mjs and hooks/post-deploy-smoke.mjs classify with it
// (they are registered for every Bash call, with no `if` glob to keep in
// sync). lib/permissions-template.json allows only the prefixed canonical
// forms and deliberately carries NO deny/ask rule for the bare verbs — Claude
// Code evaluates deny/ask past a leading env assignment, so such a rule would
// block the confirmed form too. The hook block (exit 2) is what stops a bare
// verb; test/lib/permissions-mirror.test.mjs pins the two layers together.
//
// The gated set is every lua-cli verb that changes what runs in production
// (verified against packages/lua-cli/src/cli/command-definitions.ts and
// src/utils/aliases.ts), INCLUDING the action aliases the CLI resolves at
// runtime (aliases.ts: `publish` → deploy, `on`/`enable` → activate,
// `submit`/`publish_version` → template publish, `deploy`/`fleet-apply`/
// `rollout` → template apply, `prod`/`prd`/`live` → production,
// `templates`/`agent-template(s)` → template) and the three installed
// binaries (`lua`, `heylua`, `lua-ai`). `normalizeArg` lower-cases every
// action word, so matching is case-insensitive.
//
//   lua deploy <type>                      per-primitive publish (skill, webhook, trigger, job, pre/postprocessor, persona, all)
//   lua skills|webhooks|jobs|preprocessors|postprocessors deploy|publish   the same publish, older spelling
//   lua skills production|prod|prd|live deploy|publish   the same skill publish (non-interactive since lua-cli 3.44.0)
//   lua persona production deploy|publish  persona version goes live
//   lua workflows deploy|publish <name> -v <ver>   workflow version goes live
//   lua workflows activate|on|enable <name> [-v]   enables schedules/triggers (with -v: also a deploy)
//   lua version promote <n>                atomic swap of the live agent version (no CLI confirmation!)
//   lua mcp activate|on|enable <name>      MCP server becomes available to the live agent
//   lua marketplace template publish|publish_version|submit   org-facing template release (auto-applies to consenting installs)
//   lua marketplace template apply|deploy|fleet-apply|rollout fleet rollout
//
// `lua push … --auto-deploy` publishes as a side effect of a push and is
// never allowed, prefix or not (lua-cli ignores it for `push all`, but a
// granular push would deploy).
//
// ── How a command is read (1.6.0) ─────────────────────────────────────────
// Up to 1.5.0 this was a regex anchored at the start of the string, so
// `cd x && lua deploy all`, `true; lua version promote 3`, `FOO=1 lua deploy
// all`, `/usr/local/bin/lua deploy all` and `npx lua deploy all` all passed
// (Job-tier audit, finding 3). The classifier now LEXES the command the way a
// POSIX shell would — quotes, escapes, `&& || ; | |& &`, newlines, `( )` and
// `{ }` groups, redirections, heredocs — and inspects EVERY simple command:
//
//   * the lua binary is recognised in COMMAND POSITION, by basename
//     (`/usr/local/bin/lua`, `./node_modules/.bin/heylua`, `lua.cmd`, `LUA`):
//     the first word after env assignments, and the command a wrapper runs —
//     `sudo`/`env`/`command`/`exec`/`timeout N`/`nohup`/`xargs`/`watch`/
//     `coproc`/`if`/`then`/…, launchers (`npx lua`, `npx lua-cli`,
//     `npx -y lua-cli@3`, `pnpm exec lua`, `pnpm dlx lua-cli`, `yarn lua`,
//     `npm exec -- lua`, `bunx lua`), `node [opts] …/lua-cli/dist/index.js`
//     and `find … -exec lua …`. `cp -r lua deploy` is not a deploy;
//   * option tokens between the binary and the verb are skipped (both as
//     boolean flags and as `--flag value` pairs);
//   * a word the shell computes at runtime — `$VAR`, `$(…)`, `${IFS}`,
//     `$'\x6c…'`, an unquoted glob (`lu?`) or brace expansion (`{lua,}`) —
//     in the binary or verb position cannot be resolved and is blocked when
//     the command mentions lua (fail closed);
//   * `$(…)`, backticks and `<(…)` are parsed recursively, also inside
//     double quotes and unquoted heredocs; heredoc bodies are skipped as text
//     (`gh pr create --body "$(cat <<'EOF' … EOF)"` is not code); a string
//     handed to a shell (`bash -c`, `eval`, `ssh`, `env -S`, `watch`,
//     `tmux`, `npx -c`, `… | sh`, `bash < <(…)`, a heredoc fed to a shell or
//     written to a script that is then run, `trap`, `alias`,
//     `git -c alias.x='!…'`) is parsed recursively too; inline code for
//     `node -e` / `python -c` / `perl -e` / `osascript -e`, awk `system(…)`,
//     sed's `e` command and editor `-c '!…'` is searched as text;
//   * input the lexer cannot close (an unterminated quote or substitution)
//     falls back to a textual token search;
//   * everything is linear; a command over MAX_COMMAND_LENGTH, one that runs
//     past TIME_BUDGET_MS, or an internal error BLOCKS if the command
//     mentions lua — the hook must decide inside its timeout, because a hook
//     that times out fails open.
//
// ── 1.7.1: text that is data stays data ───────────────────────────────────
// 1.6.0 searched the WHOLE argv of anything that could run a string as text,
// so `bash -c "echo lua deploy"`, `bash scripts/x.sh "lua deploy notes"`,
// `find … | xargs grep 'lua deploy'`, `npx jest -t "lua deploy all"`,
// `ssh box 'grep "lua deploy" log'`, `node -e "console.log('lua deploy')"` and
// `cat > notes.md <<EOF …lua deploy… EOF; bash build.sh` were all blocked.
// Now only the string a command actually RUNS is parsed as code — a shell's
// `-c` script (not its script-file operand or arguments), the joined argv of
// `eval`/`ssh`/`watch`/`tmux`/…, `npx -c`'s value, stdin of a shell that reads
// its program from stdin, a heredoc written to the script file that is run —
// and inline interpreter code is searched only when it can spawn a process.
// `--auto-deploy` and `auth configure` are matched the same way: as arguments
// of a lua invocation (hasAutoDeploy, hasAuthConfigure), never as text. And a
// computed command word whose last path segment is literal (`node
// "$SCRATCH/check.mjs" "$X" …`) names that command, so it is no longer read as
// an unresolvable lua binary when some path in the command contains `/lua/`.
//
// The LUA_DEPLOY_CONFIRMED=1 allowance survives ONLY in its canonical shape:
// `[env ]LUA_DEPLOY_CONFIRMED=1 lua|heylua|lua-ai <verb> …` as ONE simple
// command — the assignment is the first word of the very simple command that
// runs the verb, the binary is spelled bare, and the command is not part of a
// pipeline, a `( )`/`{ }` group, a substitution or a string run by another
// shell. `export LUA_DEPLOY_CONFIRMED=1; lua deploy all`,
// `LUA_DEPLOY_CONFIRMED=1 true && lua deploy all` and
// `LUA_DEPLOY_CONFIRMED=1 npx lua deploy all` are all blocked. In a chain,
// every production verb needs its own prefix; one unprefixed verb blocks the
// whole command.
//
// This is a belt, not the boundary. A determined caller can always build the
// command at runtime (`base64 -d | sh`, a script file, an npm script, a raw
// HTTP call). In the Lua Job tier the Lua-API proxy is the boundary; see
// docs/JOB_TIER.md.

const BIN = '(?:lua|heylua|lua-ai)';

/** Binaries lua-cli installs (package.json `bin`). */
const BINARIES = new Set(['lua', 'heylua', 'lua-ai']);
/** Also accepted after a launcher (`npx lua-cli …`) or as a node entry point. */
const PACKAGES = new Set([...BINARIES, 'lua-cli']);

/**
 * Commands (and shell keywords) that take ANOTHER command as argv: the word
 * after them — past their options and option values — is again in command
 * position. The lua binary is only recognised in command position, so
 * `cp -r lua deploy` and `ls lua deploy` are not deploys.
 */
const WRAPPERS = new Set([
  'env', 'command', 'exec', 'builtin', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'sudo', 'doas',
  'xargs', 'stdbuf', 'setsid', 'caffeinate', 'unbuffer', 'chronic', 'npx', 'pnpx', 'bunx', 'npm',
  'pnpm', 'yarn', 'bun', 'run', 'dlx', 'x', 'eval', 'watch', 'coproc', 'flock', 'nodemon', 'entr',
  'node', 'nodejs', 'tsx', 'ts-node', 'deno', 'ssh', 'su', 'runuser', 'parallel', 'strace', 'ltrace',
  'gtimeout', 'unshare', 'chroot', 'nsenter', 'firejail', 'script', 'tmux', 'screen',
  '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until',
]);

/** `find … -exec CMD …`: the word after one of these is in command position. */
const EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/**
 * POSIX-style shells. Only the string they are told to run is code: the
 * `-c` / `-lc` / `--command` value (fish `-C` too), or — with no script and no
 * script-file operand (`bash`, `bash -s`, `bash -`, `bash /dev/stdin`) — what
 * arrives on stdin: a pipe, a heredoc, a here-string, `< <(…)`. A script-file
 * operand and its arguments (`bash scripts/x.sh "lua deploy notes"`) are data.
 */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish']);

/**
 * Commands that join their remaining argv into a shell string (`eval x y`,
 * `ssh host x y`, `watch -n 5 'x'`, `tmux new 'x'`, `parallel ::: 'x'`,
 * `su - me -c 'x'`): each suffix of that argv is parsed as a script — the
 * runner's own options and operands (an ssh host, a tmux subcommand) cannot
 * be told apart from the command without knowing every option, so every
 * starting point is tried. Parsed, not text-searched: `ssh box 'grep "lua
 * deploy" log'` runs grep.
 */
const JOIN_RUNNERS = new Set([
  'eval', 'ssh', 'su', 'runuser', 'script', 'flock', 'watch', 'parallel', 'concurrently', 'nodemon',
  'entr', 'at', 'batch', 'tmux', 'screen',
]);
/** Starting points tried per JOIN_RUNNERS command (each is a linear parse). */
const MAX_SUFFIXES = 16;

/** ssh options whose value is a local or remote command line (`-o ProxyCommand=…`, `-oLocalCommand …`). */
const SSH_COMMAND_OPT = /^(?:-o)?\s*(?:Proxy|Local|Remote|KnownHosts)Command\s*[=\s]\s*(.+)$/is;

/** Package runners whose `-c` / `--call` value is a shell string (`npx -c 'x'`, `npm exec -c 'x'`); other argv is data. */
const CALL_RUNNERS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bunx']);
const CALL_FLAG = /^(?:-c|--call|--command)$/;
const CALL_FLAG_EQ = /^(?:--call|--command)=/;

/** Shells whose argv is still searched as text (their quoting rules are not POSIX). */
const TEXT_RUNNERS = new Set(['pwsh', 'powershell', 'cmd', 'busybox']);

/**
 * Commands that, in a pipeline, read their stdin as code (`… | sh`, `… | ssh
 * host`, `… | at now`). A POSIX shell joins this set only when it has no `-c`
 * script and no script file (see shellCall). `xargs` joins it only when what
 * it runs is a shell or a runner (`xargs sh -c '{}'`); `xargs grep` is data.
 */
const STDIN_RUNNERS = new Set([
  'source', '.', 'eval', 'ssh', 'su', 'runuser', 'at', 'batch', 'parallel', ...TEXT_RUNNERS,
]);

/**
 * Commands that run a shell or a container shell (`docker exec -i c sh`,
 * `kubectl exec -it p -- bash`): a POSIX shell named in THEIR argv counts as a
 * shell even out of command position. Anywhere else (`… | grep bash`) the word
 * `bash` is data, unless a `-c` follows it.
 */
const REMOTE_EXEC = new Set([
  'docker', 'podman', 'nerdctl', 'kubectl', 'oc', 'lxc', 'incus', 'vagrant', 'multipass', 'limactl',
  'distrobox', 'toolbox', 'flatpak', 'wsl', 'machinectl', 'systemd-run', 'busybox', 'su', 'runuser',
  'ssh', 'sudo', 'doas',
]);

/** Commands that run a FILE: the heredoc written to that file earlier in the command is code. */
const SCRIPT_FILE = /\.(?:sh|bash|zsh|command)$/i;

/** Shells, and `source`/`.` — running one of these on a FILE executes whatever was written to it. */
const FILE_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'source', '.']);

/**
 * Inline interpreter code (`node -e`, `python3 -c`, a heredoc fed to `python3`)
 * is searched as text only when it can start a process: `node -e
 * "console.log('lua deploy')"` prints a string; `node -e
 * "require('child_process').execSync('lua deploy all')"` runs it.
 */
const SPAWNS = /exec|spawn|system|popen|subprocess|shell|`|%x|\bqx\b|Command|\$\(|\bopen\s*\(|\brun\s*\(|\bfork\b/i;

/** Interpreters whose inline code (after `-e`, `-c`, `-p`, `-r`, …) is searched textually. */
const INLINE_CODE = new Set([
  'node', 'nodejs', 'bun', 'deno', 'python', 'python2', 'python3', 'perl', 'ruby', 'php', 'osascript',
  'luajit', 'tclsh', 'rscript', 'pwsh', 'powershell',
]);
/** An option that introduces inline code for one of INLINE_CODE (`-e`, `-pe`, `-c`, `--eval`, …). */
const INLINE_FLAG = /^-(?:[a-zA-Z]*[ecEpr]|-eval|-print|-command|-exec)$/;
/** awk runs shell commands through `system(…)`, `print … | "cmd"` and `"cmd" | getline`. */
const AWK = new Set(['awk', 'gawk', 'mawk', 'nawk', 'busybox']);
const AWK_EXEC = /system\s*\(|\|\s*["'$]|["']\s*\|\s*getline|\|&/;
/** Editors whose `-c` / `+cmd` / `:!cmd` run shell commands. */
const EDITORS = new Set(['vim', 'vi', 'nvim', 'ex', 'view', 'gvim', 'mvim', 'nano', 'emacs']);

const MAX_DEPTH = 6;

/**
 * Commands longer than this are not parsed: a command that mentions a lua
 * binary is blocked as unclassifiable, any other passes. Every step below is
 * linear, but the hook must decide well inside its 10 s timeout on any input —
 * a hook that times out fails OPEN.
 */
export const MAX_COMMAND_LENGTH = 32 * 1024;
/** Wall-clock budget for one classification; exceeding it fails closed. */
export const TIME_BUDGET_MS = 1500;

const rule = (label, seq, slash) => ({
  label,
  seq,
  slash,
  re: new RegExp(`^${BIN}\\s+${seq.map((alts) => `(?:${alts.join('|')})`).join('\\s+')}(?![\\w-])`, 'i'),
});

const DEPLOY = ['deploy', 'publish'];
const ACTIVATE = ['activate', 'on', 'enable'];
const PROD_ENV = ['production', 'prod', 'prd', 'live'];
const TEMPLATE = ['template', 'templates', 'agent-template', 'agent-templates'];

/**
 * Ordered list of gated command shapes. Each entry: the positional token
 * sequence (each position lists every spelling the CLI accepts), the
 * equivalent binary-anchored regex, a short label, and the slash command that
 * collects the user's confirmation.
 */
export const PRODUCTION_COMMANDS = [
  rule('lua deploy', [['deploy']], '/lua-deploy'),
  rule('lua skills deploy', [['skills'], DEPLOY], '/lua-deploy'),
  // lua-cli 3.44.0 (`commands/skills.ts`): `lua skills production deploy --skill-name x --skill-version y`
  // runs the deploy non-interactively (before, it only opened the production menu). The env word takes
  // the `prod`/`prd`/`live` aliases and the verb takes `publish` (`skills.actionOrEnv`, `skills.action`).
  rule('lua skills production deploy', [['skills'], PROD_ENV, DEPLOY], '/lua-deploy'),
  rule('lua webhooks deploy', [['webhooks'], DEPLOY], '/lua-deploy'),
  rule('lua jobs deploy', [['jobs'], DEPLOY], '/lua-deploy'),
  rule('lua preprocessors deploy', [['preprocessors'], DEPLOY], '/lua-deploy'),
  rule('lua postprocessors deploy', [['postprocessors'], DEPLOY], '/lua-deploy'),
  rule('lua persona production deploy', [['persona'], PROD_ENV, DEPLOY], '/lua-deploy'),
  rule('lua workflows deploy', [['workflows'], DEPLOY], '/lua-deploy'),
  rule('lua workflows activate', [['workflows'], ACTIVATE], '/lua-deploy'),
  rule('lua version promote', [['version'], ['promote']], '/lua-deploy'),
  rule('lua mcp activate', [['mcp'], ACTIVATE], '/lua-deploy'),
  rule('lua marketplace template publish', [['marketplace'], TEMPLATE, ['publish', 'publish_version', 'submit']], '/lua-template'),
  rule('lua marketplace template apply', [['marketplace'], TEMPLATE, ['apply', 'deploy', 'fleet-apply', 'rollout']], '/lua-template'),
];

/** Label for a lua invocation whose binary or verb comes from an expansion (cannot be resolved statically). */
export const UNRESOLVED_LABEL = 'lua <unresolved command>';
/** Label for a command that mentions lua but could not be classified (too long, over budget, internal error). */
export const UNCLASSIFIABLE_LABEL = 'lua <unclassifiable command>';

/** Labels whose success should trigger the post-deploy smoke check (something now runs live). */
export const SMOKE_LABELS = new Set([
  'lua deploy', 'lua skills deploy', 'lua skills production deploy', 'lua webhooks deploy', 'lua jobs deploy', 'lua preprocessors deploy',
  'lua postprocessors deploy', 'lua persona production deploy', 'lua workflows deploy', 'lua version promote',
  'lua mcp activate',
]);

// Unanchored textual patterns — the fallback for input the lexer cannot close
// and for inline interpreter code. `lua-cli/<path>` covers a node entry point.
//
// The textual fallback (for input the lexer cannot close, and for inline
// interpreter code) is a TOKEN scan, not a regex: split on everything that
// cannot be part of a word, then read each lua token's next few tokens with
// the same matchArgs() the parser uses. Linear in the text, and interruptible
// by the time budget. Two regex drafts were not: `-{1,2}[\w-]+` backtracked
// exponentially (28 options ≈ 200 s) and a path group re-scanned the text
// from every `lua` (`lua/` × 6000 ≈ 10 s) — both past the hook timeout, where
// a hook fails OPEN. test/lib/tokenizer-hardening.test.mjs and
// test/hooks/confirm-deploy.timeout.test.mjs pin the bound.
const RAW_TOKEN_SPLIT = /[^\w.@/\\-]+/;

/** Does the text mention a lua binary at all? (Used to fail closed.) */
const MENTIONS_LUA = /(?<![\w-])(?:lua|heylua|lua-ai|lua-cli)(?![\w-])/i;

/** Unicode spaces bash does not split on; treated as separators anyway (fail closed). */
const UNICODE_SPACE = new RegExp('[\\u00a0\\u1680\\u2000-\\u200b\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]');

// ── Budget ─────────────────────────────────────────────────────────────────

class BudgetExceeded extends Error {}
let deadline = Infinity;
let ticks = 0;
/** Throws once the classification's time budget is spent (caught → fail closed). */
function checkBudget() {
  if ((++ticks & 255) === 0 && performance.now() > deadline) throw new BudgetExceeded('time budget exceeded');
}

// ── Lexer ──────────────────────────────────────────────────────────────────

/**
 * @typedef {{text: string, quoted: boolean, dynamic: boolean}} Word
 * @typedef {{words: Word[], sep: string|null, grouped: boolean, pipeline: boolean, pipeId: number,
 *            heredocs: string[], herestrings: string[], subs: string[], redirects: string[]}} Segment
 */

const newSegment = () => ({
  words: [], sep: null, grouped: false, pipeline: false, pipeId: 0, heredocs: [], herestrings: [], subs: [], redirects: [],
});

/**
 * Parse the delimiter of a heredoc whose `<<` starts at `i`.
 * @returns {{delim: string, strip: boolean, quoted: boolean, end: number}}
 */
function parseHeredocDelim(src, i) {
  const n = src.length;
  i += 2;
  const strip = src[i] === '-';
  if (strip) i++;
  while (src[i] === ' ' || src[i] === '\t') i++;
  let delim = '';
  let quoted = false;
  while (i < n && !/[\s;&|<>()]/.test(src[i])) {
    if (src[i] === "'" || src[i] === '"' || src[i] === '\\') quoted = true;
    else delim += src[i];
    i++;
  }
  return { delim, strip, quoted, end: i };
}

/**
 * Skip heredoc bodies that start at `i` (just after a newline), one per
 * pending delimiter. Returns the index after the last body and each body.
 */
function skipHeredocBodies(src, i, pending) {
  const n = src.length;
  const bodies = [];
  for (const h of pending) {
    const lines = [];
    while (i < n) {
      checkBudget();
      let end = src.indexOf('\n', i);
      if (end < 0) end = n;
      const line = src.slice(i, end);
      i = end + 1;
      if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
      lines.push(line);
    }
    if (i > n) i = n;
    bodies.push(lines.join('\n'));
  }
  return { next: i, bodies };
}

/**
 * Index of the `)` closing the `(` at `start`, honouring quotes, nesting and
 * heredoc bodies (a body is literal text: `$(cat <<'EOF'\n it's \nEOF\n)` is
 * how Claude Code writes every commit message and PR body); -1 if none.
 */
function findClose(src, start) {
  let depth = 0;
  let pending = [];
  for (let i = start; i < src.length; i++) {
    checkBudget();
    const c = src[i];
    if (c === '\n' && pending.length) {
      i = skipHeredocBodies(src, i + 1, pending).next - 1;
      pending = [];
      continue;
    }
    if (c === '<' && src[i + 1] === '<') {
      if (src[i + 2] === '<') { i += 2; continue; }
      const h = parseHeredocDelim(src, i);
      pending.push(h);
      i = h.end - 1;
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) return -1;
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) return -1;
      i = j;
      continue;
    }
    if (c === '#' && (i === start + 1 || /[\s;&|(]/.test(src[i - 1]))) {
      // A comment runs to end of line; its quotes and parentheses are text.
      const nl = src.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl - 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Index of the next unescaped backtick after `start`; -1 if none. */
function findBacktick(src, start) {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '`') return i;
  }
  return -1;
}

/**
 * Split a shell command into simple commands. Collects command-substitution
 * bodies (`$(…)`, backticks, `<(…)`, and those inside an unquoted heredoc) in
 * `subs` — and in the owning segment's `subs` — for recursive inspection, and
 * sets `opaque` when something could not be closed.
 *
 * A word is `dynamic` when the shell would compute it at runtime: parameter
 * or command expansion, ANSI-C quoting, an unquoted glob (`lu?`, `l*a`) or an
 * unquoted brace expansion (`{lua,}`, `de{ploy,}`).
 *
 * @param {string} src
 * @returns {{segments: Segment[], subs: string[], opaque: boolean}}
 */
export function lex(src) {
  /** @type {Segment[]} */
  const segments = [];
  const subs = [];
  let opaque = false;
  let seg = newSegment();
  /** @type {(Word & {brace?: boolean})|null} */
  let word = null;
  let depth = 0;
  let redirTarget = null; // null | 'file' | 'herestring'
  /** @type {{delim: string, strip: boolean, quoted: boolean, seg: Segment}[]} */
  let pendingHeredocs = [];
  const n = src.length;
  let i = 0;

  const addSub = (text) => { subs.push(text); seg.subs.push(text); };
  const startWord = () => { if (!word) word = { text: '', quoted: false, dynamic: false }; return word; };
  const endWord = () => {
    if (!word) return;
    const w = word;
    word = null;
    if (w.brace && /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(w.text)) w.dynamic = true;
    delete w.brace;
    if (redirTarget) {
      if (redirTarget === 'herestring') seg.herestrings.push(w.text);
      else seg.redirects.push(w.text);
      redirTarget = null;
      return;
    }
    if (!w.quoted && w.text === '{') {
      // Brace group: `{ cmd; }` (also `function f { …; }`). What precedes it is
      // its own command; what follows starts a new, grouped one.
      if (seg.words.length) endSegment(';');
      depth++;
      seg.grouped = true;
      return;
    }
    if (!w.quoted && w.text === '}') { depth = Math.max(0, depth - 1); return; }
    seg.words.push(w);
  };
  const endSegment = (sep) => {
    endWord();
    if (seg.words.length || seg.heredocs.length || seg.herestrings.length || seg.subs.length) {
      seg.sep = sep;
      if (depth > 0) seg.grouped = true;
      segments.push(seg);
    } else if ((sep === '|' || sep === '|&') && segments.length) {
      segments[segments.length - 1].sep = sep;
    }
    seg = newSegment();
  };
  const takeSubstitution = (open) => {
    // `open` indexes the `(` of `$(`, `<(` or `>(`.
    const close = findClose(src, open);
    if (close < 0) { opaque = true; addSub(src.slice(open + 1)); return n; }
    addSub(src.slice(open + 1, close));
    return close + 1;
  };
  /** Command substitutions inside an UNQUOTED heredoc body run (`cat <<EOF\n$(lua …)\nEOF`). */
  const scanExpandingBody = (body, owner) => {
    for (let k = 0; k < body.length; k++) {
      checkBudget();
      if (body[k] === '\\') { k++; continue; }
      if (body[k] === '$' && body[k + 1] === '(') {
        const close = findClose(body, k + 1);
        const text = close < 0 ? body.slice(k + 2) : body.slice(k + 2, close);
        if (close < 0) opaque = true;
        subs.push(text);
        owner.subs.push(text);
        if (close < 0) return;
        k = close;
      } else if (body[k] === '`') {
        const close = findBacktick(body, k);
        const text = close < 0 ? body.slice(k + 1) : body.slice(k + 1, close);
        if (close < 0) opaque = true;
        subs.push(text);
        owner.subs.push(text);
        if (close < 0) return;
        k = close;
      }
    }
  };
  const readHeredocBodies = () => {
    const { next, bodies } = skipHeredocBodies(src, i, pendingHeredocs);
    pendingHeredocs.forEach((h, k) => {
      h.seg.heredocs.push(bodies[k]);
      if (!h.quoted) scanExpandingBody(bodies[k], h.seg);
    });
    i = next;
    pendingHeredocs = [];
  };

  while (i < n) {
    checkBudget();
    const c = src[i];
    const next = src[i + 1];

    if (c === '\\') {
      if (next === '\n') { i += 2; continue; }
      const w = startWord();
      w.quoted = true;
      if (next !== undefined) w.text += next;
      i += 2;
      continue;
    }
    if (c === "'") {
      const w = startWord();
      w.quoted = true;
      const j = src.indexOf("'", i + 1);
      if (j < 0) { opaque = true; w.text += src.slice(i + 1); i = n; continue; }
      w.text += src.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const w = startWord();
      w.quoted = true;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        checkBudget();
        const d = src[j];
        if (d === '"') { closed = true; break; }
        if (d === '\\') {
          const e = src[j + 1];
          if (e === '\n') { j += 2; continue; }
          if (e !== undefined && '$`"\\'.includes(e)) { w.text += e; j += 2; continue; }
          w.text += d;
          j++;
          continue;
        }
        if (d === '$' && src[j + 1] === '(') { w.dynamic = true; w.text += '$(…)'; j = takeSubstitution(j + 1); continue; }
        if (d === '`') {
          const k = findBacktick(src, j);
          w.dynamic = true;
          if (k < 0) { opaque = true; addSub(src.slice(j + 1)); j = n; break; }
          addSub(src.slice(j + 1, k));
          w.text += '`…`';
          j = k + 1;
          continue;
        }
        if (d === '$' && /[A-Za-z_{0-9@*#?$!-]/.test(src[j + 1] ?? '')) w.dynamic = true;
        w.text += d;
        j++;
      }
      if (!closed) opaque = true;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const w = startWord();
      w.dynamic = true;
      const k = findBacktick(src, i);
      if (k < 0) { opaque = true; addSub(src.slice(i + 1)); i = n; continue; }
      addSub(src.slice(i + 1, k));
      w.text += '`…`';
      i = k + 1;
      continue;
    }
    if (c === '$') {
      const w = startWord();
      if (next === '(') { w.dynamic = true; w.text += '$(…)'; i = takeSubstitution(i + 1); continue; }
      if (next === "'") {
        // ANSI-C quoting ($'\x6cua') can spell anything — treat as unresolvable.
        w.dynamic = true;
        w.quoted = true;
        let j = i + 2;
        while (j < n && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
        if (j >= n) opaque = true;
        w.text += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (next === '"') { i++; continue; } // $"…" locale string = "…"
      if (/[A-Za-z_{0-9@*#?$!-]/.test(next ?? '')) w.dynamic = true;
      w.text += '$';
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || UNICODE_SPACE.test(c)) { endWord(); i++; continue; }
    if (c === '\n') {
      endWord();
      i++;
      if (pendingHeredocs.length) readHeredocBodies();
      endSegment(';');
      continue;
    }
    if (c === '#' && !word) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === ';') { endSegment(';'); i += next === ';' ? 2 : 1; continue; }
    if (c === '&') {
      if (next === '&') { endSegment('&&'); i += 2; continue; }
      if (next === '>') {
        endWord();
        i += src[i + 2] === '>' ? 3 : 2;
        redirTarget = 'file';
        continue;
      }
      endSegment('&');
      i++;
      continue;
    }
    if (c === '|') {
      if (next === '|') { endSegment('||'); i += 2; continue; }
      if (next === '&') { endSegment('|&'); i += 2; continue; }
      endSegment('|');
      i++;
      continue;
    }
    if (c === '(') {
      if (word && word.text.endsWith('=')) {
        // Array assignment `a=(x y)` — keep it as one word.
        const close = findClose(src, i);
        if (close < 0) { opaque = true; i = n; continue; }
        word.text += src.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      endWord();
      if (next === ')' && seg.words.length) { i += 2; continue; } // `name()` function definition
      endSegment(';');
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      endWord();
      if (seg.words.length) { seg.grouped = true; }
      endSegment(')');
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (c === '<' || c === '>') {
      if (next === '(') {
        // Process substitution <(…) / >(…) is a word that runs a command.
        const w = startWord();
        w.dynamic = true;
        w.text += `${c}(…)`;
        i = takeSubstitution(i + 1);
        continue;
      }
      if (word && !word.quoted && !word.dynamic && /^\d+$/.test(word.text)) word = null; // fd number
      else endWord();
      if (src.startsWith('<<<', i)) { i += 3; redirTarget = 'herestring'; continue; }
      if (src.startsWith('<<', i)) {
        const h = parseHeredocDelim(src, i);
        pendingHeredocs.push({ delim: h.delim, strip: h.strip, quoted: h.quoted, seg });
        i = h.end;
        continue;
      }
      i++;
      if ('>&|'.includes(src[i] ?? '') && !(c === '<' && src[i] === '|')) i++;
      if (src[i - 1] === '&') {
        let consumed = false;
        while (i < n && /[\d-]/.test(src[i])) { i++; consumed = true; }
        if (consumed) continue;
      }
      redirTarget = 'file';
      continue;
    }
    const w = startWord();
    if (c === '*' || c === '?' || c === '[') w.dynamic = true; // unquoted glob
    if (c === '{') w.brace = true; // possible brace expansion, decided at endWord
    w.text += c;
    i++;
  }
  if (pendingHeredocs.length) readHeredocBodies();
  endSegment(null);

  let pipeId = 0;
  for (let k = 0; k < segments.length; k++) {
    segments[k].pipeId = pipeId;
    const piped = segments[k].sep === '|' || segments[k].sep === '|&';
    if (piped) {
      segments[k].pipeline = true;
      if (segments[k + 1]) segments[k + 1].pipeline = true;
    } else {
      pipeId++;
    }
  }
  return { segments, subs, opaque };
}

// ── Classification ─────────────────────────────────────────────────────────

/** Command name as the shell would resolve it: basename, no `@version`, no Windows extension, lower-cased. */
function commandName(text) {
  let b = text.split(/[\\/]/).pop() ?? '';
  const at = b.indexOf('@', 1);
  if (at > 0) b = b.slice(0, at);
  return b.replace(/\.(?:cmd|exe|bat|ps1)$/i, '').toLowerCase();
}

const isFlag = (w) => w.text.length > 1 && w.text.startsWith('-');
/** An assignment in the shell's sense (unquoted name). */
const isAssignment = (w) => !w.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text);
/** Anything that LOOKS like an assignment — skipped when looking for the command (fail closed). */
const looksLikeAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text);
const isPrefixWord = (w) => !!w && !w.quoted && !w.dynamic && w.text === 'LUA_DEPLOY_CONFIRMED=1';
const nameOf = (w) => (w.dynamic ? '' : commandName(w.text));

/** Is `text` (a literal word, or the literal head of a dynamic one) a lua-cli binary or entry point? */
function isLuaBinaryText(text, afterLauncher) {
  const name = commandName(text);
  if (BINARIES.has(name)) return true;
  // `lua-cli` is the package name, not an installed binary: gated after a
  // launcher (`npx lua-cli`), or as a path to the package.
  if (name === 'lua-cli' && (afterLauncher || /[\\/]/.test(text))) return true;
  // The entry point run by node or through its shebang: `…/lua-cli/dist/index.js`.
  // Only the tail is examined, so a pathological 30 KB word costs one bounded scan.
  return /(?:^|[\\/])(?:lua-cli|heylua|lua-ai)[\\/]\S*\.[mc]?js$/i.test(text.slice(-512));
}

/** Splits a dynamic word at its expansions: `lua${IFS}deploy${IFS}all` → lua, deploy, all. */
const EXPANSION = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]|\$\(…\)|`…`|\$'[^']*'|[<>]\(…\)|[*?]|\[[^\]]*\]|[{},]/;

/**
 * Word indexes in command position: the first word after any leading
 * assignments, and — after a wrapper (`sudo`, `env`, `npx`, `timeout`, `if`,
 * `xargs`, `node`, …) — the next word past its options, option values,
 * assignments and durations. An option's value may itself be the command
 * (`sudo -u me lua …` vs `sudo -E lua …`), so both readings are kept.
 * `find … -exec CMD` adds CMD.
 */
function commandPositions(words) {
  const out = new Set();
  const seen = new Set();
  const walk = (start) => {
    let k = start;
    while (k < words.length && looksLikeAssignment(words[k])) k++;
    if (k >= words.length || seen.has(k)) return;
    seen.add(k);
    out.add(k);
    if (!WRAPPERS.has(nameOf(words[k]))) return;
    let q = k + 1;
    let afterFlag = false;
    while (q < words.length) {
      checkBudget();
      const w = words[q];
      if (w.text === '--' || isFlag(w)) { afterFlag = w.text !== '--' && !w.text.includes('='); q++; continue; }
      if (looksLikeAssignment(w) || /^\d+(?:\.\d+)?[smhd]?$/.test(w.text)) { afterFlag = false; q++; continue; }
      walk(q);
      if (!afterFlag) return;
      afterFlag = false; // it may have been the option's value: keep looking
      q++;
    }
  };
  walk(0);
  words.forEach((w, k) => { if (EXEC_FLAGS.has(w.text) && k + 1 < words.length) walk(k + 1); });
  return [...out].sort((a, b) => a - b);
}

/**
 * If a lua-cli invocation starts at word `j` (a command position), return its
 * arguments and whether the binary itself was computed at runtime; else null.
 */
function invocationAt(words, j, afterLauncher) {
  const w = words[j];
  const rest = words.slice(j + 1, j + 1 + 64);
  if (w.dynamic) {
    // `"$SCRATCH/check.mjs"`, `"$DIR/lua"`: a literal last path segment names
    // the command whatever the directory is — unless it is a generic node
    // entry point (`$X/dist/index.js` may be lua-cli's), which stays unresolved.
    const slash = w.text.lastIndexOf('/');
    const tail = slash >= 0 ? w.text.slice(slash + 1) : '';
    if (tail && !EXPANSION.test(tail) && !/^(?:index|cli|main)\.[mc]?js$/i.test(tail)) {
      if (!isLuaBinaryText(w.text, true)) return null;
      return { args: rest, allArgs: words.slice(j + 1), dynamicHead: false };
    }
    // `lua${IFS}deploy`: the literal part can still name lua.
    const pieces = w.text.split(new RegExp(EXPANSION.source, 'g')).filter(Boolean);
    if (pieces.length && isLuaBinaryText(pieces[0], true)) {
      const extra = pieces.slice(1).flatMap((p) => p.split(/\s+/)).filter(Boolean)
        .map((text) => ({ text, quoted: false, dynamic: false }));
      return { args: [...extra, ...rest], allArgs: [...extra, ...words.slice(j + 1)], dynamicHead: false };
    }
    return { args: rest, allArgs: words.slice(j + 1), dynamicHead: true };
  }
  if (isLuaBinaryText(w.text, afterLauncher)) return { args: rest, allArgs: words.slice(j + 1), dynamicHead: false };
  return null;
}

/**
 * Match the arguments after a lua binary against the gated shapes. Options
 * are skipped twice over — once as boolean flags, once as `--flag value`
 * pairs — so neither reading hides a verb.
 *
 * @param {Word[]} args
 * @param {boolean} allowDynamic  a computed token may stand in for a verb
 * @returns {{label: string, slash: string, dynamic: boolean}|null}
 */
function matchArgs(args, allowDynamic) {
  const loose = []; // flags dropped, their values kept
  const strict = []; // flags and the word after a value-less `--flag` dropped
  let pendingValue = false;
  for (const a of args) {
    if (loose.length >= 3 && strict.length >= 3) break;
    if (a.text === '--') { pendingValue = false; continue; }
    if (isFlag(a)) { pendingValue = !a.text.includes('='); continue; }
    loose.push(a);
    if (pendingValue) pendingValue = false;
    else strict.push(a);
  }
  let dynamicHit = null;
  for (const positional of [loose, strict]) {
    for (const entry of PRODUCTION_COMMANDS) {
      let ok = true;
      let usedDynamic = false;
      for (let p = 0; p < entry.seq.length; p++) {
        const tok = positional[p];
        if (!tok) { ok = false; break; }
        if (tok.dynamic) {
          if (!allowDynamic) { ok = false; break; }
          usedDynamic = true;
          continue;
        }
        if (!entry.seq[p].includes(tok.text.toLowerCase())) { ok = false; break; }
      }
      if (!ok) continue;
      if (!usedDynamic) return { label: entry.label, slash: entry.slash, dynamic: false };
      dynamicHit ??= { label: UNRESOLVED_LABEL, slash: '/lua-deploy', dynamic: true };
    }
  }
  return dynamicHit;
}

// ── Other lua-cli arguments the plugin forbids ─────────────────────────────

/** `--auto-deploy` / `--auto-deploy=<v>` (not `--auto-deployment`). */
const AUTO_DEPLOY_ARG = /^--auto-deploy(?:=|$)/i;

/**
 * Record the non-verb findings for one lua invocation's arguments: the
 * `--auto-deploy` flag anywhere in them, and `auth configure` as the command
 * (options before either word are skipped, case-insensitive like lua-cli).
 *
 * @param {Word[]} args
 * @param {Array<object>} hits
 */
function checkInvocation(args, hits) {
  if (args.some((a) => AUTO_DEPLOY_ARG.test(a.text))) hits.push({ kind: 'auto-deploy' });
  const positional = args.filter((a) => !isFlag(a)).slice(0, 2).map((a) => a.text.toLowerCase());
  if (positional[0] === 'auth' && positional[1] === 'configure') hits.push({ kind: 'auth-configure' });
}

/** Unanchored textual search, for text the lexer cannot structure. Linear: a bounded window per lua token. */
function rawSearch(text, hits) {
  checkBudget();
  if (!MENTIONS_LUA.test(text)) return;
  const toks = text.split(RAW_TOKEN_SPLIT);
  for (let k = 0; k < toks.length; k++) {
    checkBudget();
    const t = toks[k];
    if (!t || !isLuaBinaryText(t, true)) continue;
    const args = [];
    for (let q = k + 1; q < toks.length && args.length < 64; q++) {
      if (toks[q]) args.push({ text: toks[q], quoted: false, dynamic: false });
    }
    const m = matchArgs(args, false);
    if (m) hits.push({ label: m.label, slash: m.slash, prefixed: false });
    checkInvocation(args, hits);
  }
}

/** GNU sed's `e` command / `s///e` flag runs the pattern space as a shell command. */
function sedExecutes(script) {
  if (/(?:^|[;\n{}]|\d|\$|\/)\s*e(?:\s|$)/.test(script)) return true;
  const m = /^s(.)/.exec(script);
  if (!m) return false;
  const parts = script.split(m[1]);
  return parts.length >= 4 && /e/.test(parts[parts.length - 1]);
}

/** A `-c` script that runs what arrives on stdin (`sh -c 'sh'`, `bash -c "$(cat)"`, `sh -c 'xargs …'`). */
const SCRIPT_READS_STDIN =
  /(?<![\w./-])(?:sh|bash|zsh|dash|ksh|mksh|ash|fish|eval|source|xargs|parallel)(?![\w-])|\/dev\/stdin|(?:^|[\s;&|(])\.\s|\$\(\s*cat\s*\)|`\s*cat\s*`/;
/** A `-c` script that hands its positional parameters back to a shell (`sh -c '"$@"' _ lua deploy all`). */
const USES_POSITIONALS = /\$(?:[@*1-9]|\{[@*1-9#])/;
/** A word whose text starts with a substitution: its OUTPUT becomes the script (`bash -c "$(curl …)"`). */
const STARTS_WITH_SUB = /(?:^|[\s;&|(])(?:\$\(…\)|`…`|[<>]\(…\))/;

/**
 * How the POSIX shell named at words[s] gets its code.
 * @returns {{scripts: Word[], extra: Word[], stdin: boolean}}
 */
function shellCall(words, s) {
  const scripts = [];
  let dashC = false;
  let dashS = false;
  // fish: `-C`/`--init-command` runs code too (in bash `-C` is noclobber).
  const fish = nameOf(words[s]) === 'fish';
  let k = s + 1;
  for (; k < words.length; k++) {
    checkBudget();
    const t = words[k].text;
    if (t === '--') { k++; break; }
    if (t === '--command' || t === '--init-command' || (t === '-C' && fish)) {
      if (words[k + 1]) scripts.push(words[k + 1]);
      k++;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(t)) {
      // An option cluster: `-c` anywhere in it takes the script, `-s` reads
      // stdin, and a trailing `o`/`O` (`-euxo pipefail`) takes a value.
      if (t[0] === '-' && t.includes('c')) dashC = true;
      if (t[0] === '-' && t.includes('s')) dashS = true;
      if (/[oO]$/.test(t)) k++;
      continue;
    }
    const eq = /^--(?:command|init-command)=(.*)$/s.exec(t);
    if (eq) { scripts.push({ text: eq[1], quoted: true, dynamic: words[k].dynamic }); continue; }
    if (t === '--rcfile' || t === '--init-file') { k++; continue; }
    if (t.length > 1 && (t[0] === '-' || t[0] === '+')) continue;
    break;
  }
  const operand = words[k];
  let extra = [];
  if (dashC && operand) {
    scripts.push(operand);
    extra = words.slice(k + 1);
  }
  const stdin =
    scripts.length === 0 &&
    (dashS || !operand || operand.text === '-' || operand.text === '/dev/stdin');
  return { scripts, extra, stdin };
}

/**
 * What one simple command does with strings, computed once per segment.
 *
 * @param {Segment} seg
 */
function segmentInfo(seg) {
  if (seg.info) return seg.info;
  const words = seg.words;
  const names = words.map(nameOf);
  const positions = commandPositions(words);
  const atPosition = (set) => positions.some((j) => set.has(names[j]));
  const remote = atPosition(REMOTE_EXEC);
  const posSet = new Set(positions);

  // A shell in command position, or anywhere when followed by `-c`, or in the
  // argv of something that runs a shell (`docker exec -i c sh`).
  const shells = [];
  names.forEach((nm, s) => {
    if (!POSIX_SHELLS.has(nm)) return;
    const call = shellCall(words, s);
    if (posSet.has(s) || remote || call.scripts.length) shells.push(call);
  });

  const xargsAt = names.indexOf('xargs');
  const xargsRunsCode =
    xargsAt >= 0 &&
    names.slice(xargsAt + 1).some((nm) => POSIX_SHELLS.has(nm) || JOIN_RUNNERS.has(nm) || STDIN_RUNNERS.has(nm));
  const sourceStdin = positions.some((j) =>
    (names[j] === 'source' || names[j] === '.') &&
    (!words[j + 1] || ['-', '/dev/stdin'].includes(words[j + 1].text) || words[j + 1].dynamic));

  // An interpreter with no script file and no inline code reads its program
  // from stdin (`python3 <<EOF`, `node - <<EOF`); with a file, stdin is data.
  const interpreterStdin = positions.some((j) => {
    if (!INLINE_CODE.has(names[j])) return false;
    for (let q = j + 1; q < words.length; q++) {
      const w = words[q];
      if (INLINE_FLAG.test(w.text)) return false;
      if (w.text === '-') return true;
      if (!isFlag(w)) return false;
    }
    return true;
  });

  // `sudo -s` / `sudo -i` with no command start a shell that reads stdin.
  const sudoShell = positions.length === 1 && (names[0] === 'sudo' || names[0] === 'doas') &&
    words.slice(1).some((w) => /^-[A-Za-z]*[si][A-Za-z]*$|^--(?:shell|login)$/.test(w.text));

  const stdinCode =
    sudoShell ||
    // A script computed by a substitution (`sh -c "$(cat)"`) may read stdin: fail closed.
    shells.some((c) => c.stdin ||
      c.scripts.some((w) => SCRIPT_READS_STDIN.test(w.text) || (w.dynamic && STARTS_WITH_SUB.test(w.text)))) ||
    atPosition(STDIN_RUNNERS) ||
    names.some((nm) => TEXT_RUNNERS.has(nm) && nm !== 'cmd' && nm !== 'busybox') ||
    xargsRunsCode ||
    sourceStdin;

  seg.info = { names, positions, shells, stdinCode, interpreterStdin };
  return seg.info;
}

/**
 * @typedef {{nested: boolean, depth: number, mentionsLua: boolean, seen: Set<string>}} Ctx
 * @param {Segment} seg
 * @param {Ctx} ctx
 * @param {boolean} pipedIntoRunner  another stage of this pipeline runs its input as code
 * @param {Array<object>} hits
 */
function analyzeSegment(seg, ctx, pipedIntoRunner, hits) {
  checkBudget();
  const words = seg.words;
  const { names, positions, shells, stdinCode, interpreterStdin } = segmentInfo(seg);
  const inline = names.some((nm) => INLINE_CODE.has(nm));
  const awk = names.some((nm) => AWK.has(nm));
  const editor = names.some((nm) => EDITORS.has(nm));
  const sed = names.some((nm) => nm === 'sed' || nm === 'gsed');
  const hasEnv = names.includes('env');
  const nested = { ...ctx, nested: true, depth: ctx.depth + 1 };
  const textRunner = positions.some((j) => TEXT_RUNNERS.has(names[j])) ||
    names.some((nm) => nm === 'pwsh' || nm === 'powershell');

  // Data that a shell will read as code (`echo lua deploy all | sh`), and the
  // argv of a shell whose quoting rules are not POSIX (`pwsh -c …`), are
  // searched as text as well as parsed.
  if (pipedIntoRunner || textRunner) {
    rawSearch(words.map((w) => w.text).join(' '), hits);
    for (const w of words) if (/[\s;&|`$()]/.test(w.text)) analyzeScript(w.text, nested, hits);
  }

  // `bash -c '<script>'`: the script is parsed as a command line of its own.
  for (const call of shells) {
    for (const script of call.scripts) {
      analyzeScript(script.text, nested, hits);
      if (script.dynamic && STARTS_WITH_SUB.test(script.text)) for (const sub of seg.subs) rawSearch(sub, hits);
      // The first word after the script is $0; the rest are $1….
      if (call.extra.length > 1 && USES_POSITIONALS.test(script.text)) {
        analyzeScript(call.extra.slice(1).map((w) => w.text).join(' '), nested, hits);
      }
    }
  }

  // `eval x y`, `ssh host x y`, `watch -n 5 'x'`: the joined argv is a script.
  for (const j of positions) {
    if (!JOIN_RUNNERS.has(names[j])) continue;
    let tried = 0;
    for (let q = j + 1; q < words.length && tried < MAX_SUFFIXES; q++) {
      if (isFlag(words[q])) continue;
      tried++;
      analyzeScript(words.slice(q).map((w) => w.text).join(' '), nested, hits);
      if (words[q].dynamic && STARTS_WITH_SUB.test(words[q].text)) for (const sub of seg.subs) rawSearch(sub, hits);
    }
  }

  // `ssh -o ProxyCommand='x'` (also scp/sftp, LocalCommand, RemoteCommand,
  // KnownHostsCommand): the option value is a command line.
  if (names.some((nm) => nm === 'ssh' || nm === 'scp' || nm === 'sftp')) {
    for (const w of words) {
      const m = SSH_COMMAND_OPT.exec(w.text);
      if (m) analyzeScript(m[1], nested, hits);
    }
  }

  // `npx -c 'x'`, `npm exec --call 'x'`: only that value is a script.
  if (positions.some((j) => CALL_RUNNERS.has(names[j]))) {
    words.forEach((w, k) => {
      if (CALL_FLAG.test(w.text) && words[k + 1]) {
        analyzeScript(words[k + 1].text, nested, hits);
        if (words[k + 1].dynamic && STARTS_WITH_SUB.test(words[k + 1].text)) for (const sub of seg.subs) rawSearch(sub, hits);
      }
      if (CALL_FLAG_EQ.test(w.text)) analyzeScript(w.text.replace(CALL_FLAG_EQ, ''), nested, hits);
    });
  }

  words.forEach((w, k) => {
    if (k === 0) return;
    const prev = words[k - 1].text;
    const spawns = SPAWNS.test(w.text);
    if (inline && spawns && (INLINE_FLAG.test(prev) || (prev === 'eval' && names.includes('deno')))) rawSearch(w.text, hits);
    if (awk && AWK_EXEC.test(w.text)) rawSearch(w.text, hits);
    if (editor && (/^[-+]c$|^--cmd$/.test(prev) || /^[+:]/.test(w.text) || w.text.includes('!'))) rawSearch(w.text, hits);
    if (sed && !isFlag(w) && sedExecutes(w.text)) rawSearch(w.text, hits);
    if (hasEnv && (prev === '-S' || prev === '--split-string')) analyzeScript(w.text, nested, hits);
    if (hasEnv && /^(?:-S|--split-string=)./.test(w.text)) analyzeScript(w.text.replace(/^(?:-S|--split-string=)/, ''), nested, hits);
    // `git -c alias.x='!cmd'` runs cmd through the shell.
    const alias = /^alias\.[^=]*=\s*!(.*)$/s.exec(w.text);
    if (alias) { analyzeScript(alias[1], nested, hits); rawSearch(alias[1], hits); }
    if (names[0] === 'alias' || names[0] === 'trap') {
      const eq = w.text.indexOf('=');
      analyzeScript(eq > 0 ? w.text.slice(eq + 1) : w.text, nested, hits);
    }
  });

  // Heredocs and here-strings are stdin. They are code only for something
  // that reads its program from stdin (`bash <<EOF`, `python3 <<EOF`), and
  // for awk; for `cat`, `git commit -F -`, `node script.mjs` they are data.
  for (const body of [...seg.heredocs, ...seg.herestrings]) {
    if (stdinCode || pipedIntoRunner) {
      analyzeScript(body, nested, hits);
      rawSearch(body, hits);
    } else if ((interpreterStdin && SPAWNS.test(body)) || (awk && AWK_EXEC.test(body))) {
      rawSearch(body, hits);
    }
  }
  // `bash < <(echo lua …)`, `source <(…)`: the substitution's OUTPUT is code.
  if (stdinCode || pipedIntoRunner || textRunner) for (const sub of seg.subs) rawSearch(sub, hits);

  for (const j of positions) {
    const afterLauncher = j > 0;
    const inv = invocationAt(words, j, afterLauncher);
    if (!inv) continue;
    // A computed binary (`$(which lua) push … --auto-deploy`) is checked too:
    // the flag and `auth configure` are specific enough to need no lua name.
    checkInvocation(inv.allArgs, hits);
    // `… | xargs lua`: the verb arrives on stdin and cannot be classified.
    const fedByXargs = names.slice(0, j).includes('xargs');
    // A computed binary with a computed verb (`$(printf lua) $(printf deploy)`)
    // is blocked when the command mentions lua anywhere.
    let match = matchArgs(inv.args, !inv.dynamicHead || ctx.mentionsLua);
    if (!match && fedByXargs && !inv.dynamicHead) {
      match = { label: UNRESOLVED_LABEL, slash: '/lua-deploy', dynamic: true };
    }
    if (!match) continue;
    const canonicalPrefix =
      !inv.dynamicHead &&
      !words[j].dynamic &&
      BINARIES.has(words[j].text) &&
      ((j === 1 && isPrefixWord(words[0])) ||
        (j === 2 && words[0].text === 'env' && !words[0].quoted && isPrefixWord(words[1])));
    const prefixed =
      canonicalPrefix && !match.dynamic && !ctx.nested && !seg.pipeline && !seg.grouped;
    hits.push({ label: match.label, slash: match.slash, prefixed });
  }
}

/** `./x.sh` and `x.sh` name the same file. */
const normPath = (t) => t.replace(/^(?:\.\/)+/, '');

/**
 * @param {string} src
 * @param {Ctx} ctx
 * @param {Array<object>} hits
 */
function analyzeScript(src, ctx, hits) {
  checkBudget();
  // The same string reached twice (`eval eval eval …` suffixes) is parsed once.
  const key = `${ctx.nested ? 1 : 0}\0${src}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  if (ctx.depth > MAX_DEPTH) { rawSearch(src, hits); return; }
  const { segments, subs, opaque } = lex(src);
  if (opaque) rawSearch(src, hits);

  // A pipeline stage that runs its stdin as code (`… | sh`, `… | xargs sh -c`)
  // turns every string in the pipeline into code.
  const runnerPipes = new Set(segments.filter((s) => s.pipeline && segmentInfo(s).stdinCode).map((s) => s.pipeId));
  for (const seg of segments) analyzeSegment(seg, ctx, runnerPipes.has(seg.pipeId), hits);
  for (const sub of subs) analyzeScript(sub, { ...ctx, nested: true, depth: ctx.depth + 1 }, hits);

  // `cat > x.sh <<EOF … EOF; sh x.sh` — a script written here and run here.
  // Only a heredoc written to the file that is run counts; `cat > notes.md
  // <<EOF … EOF; bash build.sh` writes notes.
  const runFiles = new Set();
  let runsUnknownFile = false;
  for (const s of segments) {
    const { names, positions } = segmentInfo(s);
    const first = positions[0];
    if (first === undefined) continue;
    const w = s.words[first];
    if (SCRIPT_FILE.test(w.text)) runFiles.add(normPath(w.text));
    if (FILE_RUNNERS.has(names[first])) {
      const operand = s.words.slice(first + 1).find((a) => !isFlag(a));
      if (operand?.dynamic) runsUnknownFile = true;
      else if (operand) runFiles.add(normPath(operand.text));
    }
  }
  if (runFiles.size || runsUnknownFile) {
    for (const s of segments) {
      const bodies = [...s.heredocs, ...s.herestrings];
      if (!bodies.length) continue;
      const targets = [...s.redirects, ...s.words.slice(1).map((w) => w.text)].map(normPath);
      // The file that runs may be a copy (`cp x.sh y.sh && bash y.sh`): any
      // heredoc written to a script-named file counts once a file is run.
      if (runsUnknownFile || s.redirects.some((t) => /[$`]/.test(t)) ||
        targets.some((t) => runFiles.has(t) || SCRIPT_FILE.test(t))) {
        for (const body of bodies) rawSearch(body, hits);
      }
    }
  }
}

/**
 * Run the analysis once, under the time budget.
 * @returns {{hits: Array<object>, failed: boolean}} failed: too long, over budget, or an internal error
 */
function inspect(command, analyze, budgetMs) {
  if (command.length > MAX_COMMAND_LENGTH) return { hits: [], failed: true };
  const hits = [];
  deadline = performance.now() + budgetMs;
  ticks = 0;
  try {
    analyze(command, { nested: false, depth: 0, mentionsLua: MENTIONS_LUA.test(command), seen: new Set() }, hits);
  } catch {
    return { hits: [], failed: true };
  } finally {
    deadline = Infinity;
  }
  return { hits, failed: false };
}

const unclassifiable = () => ({ label: UNCLASSIFIABLE_LABEL, slash: '/lua-deploy', prefixed: false });

/**
 * Classify a command. Returns null for commands that run no gated verb, or
 * `{ label, slash, prefixed }` for a production-affecting lua-cli verb. When a
 * command runs several gated verbs, the first one WITHOUT a valid prefix is
 * returned (so one unconfirmed verb blocks the whole chain); `prefixed` is
 * true only when every gated verb in it carries the canonical prefix.
 *
 * Fails closed: a command that mentions a lua binary and is longer than
 * MAX_COMMAND_LENGTH, runs past TIME_BUDGET_MS, or trips an internal error
 * is returned as UNCLASSIFIABLE_LABEL, unprefixed.
 *
 * @param {unknown} command
 * @param {{analyze?: Function, budgetMs?: number}} [opts] — test seams
 * @returns {{label: string, slash: string, prefixed: boolean}|null}
 */
export function classifyProductionCommand(command, { analyze = analyzeScript, budgetMs = TIME_BUDGET_MS } = {}) {
  if (typeof command !== 'string') return null;
  const { hits, failed } = inspect(command, analyze, budgetMs);
  // A classifier bug or a spent budget must not wave a lua command through.
  if (failed) return MENTIONS_LUA.test(command) ? unclassifiable() : null;
  const verbs = hits.filter((h) => !h.kind);
  if (verbs.length === 0) return null;
  const { label, slash, prefixed } = verbs.find((h) => !h.prefixed) ?? verbs[0];
  return { label, slash, prefixed };
}

/**
 * True iff the command runs a gated production verb and every such verb
 * carries the LUA_DEPLOY_CONFIRMED=1 prefix in its canonical shape.
 *
 * @param {unknown} command
 * @returns {boolean}
 */
export function isPrefixedDeploy(command) {
  const c = classifyProductionCommand(command);
  return !!c && c.prefixed;
}

/** Textual fallbacks, used only when the analysis fails (fail closed). */
const AUTO_DEPLOY_TEXT = /(?:^|[\s"'=])--auto-deploy(?![\w-])/i;
const AUTH_CONFIGURE_TEXT = /\bauth\s+configure(?![\w-])/i;

/**
 * True iff the command passes `--auto-deploy` to a lua-cli invocation — the
 * flag as an argument of `lua`/`heylua`/`lua-ai` (in a chain, a substitution,
 * a `bash -c` string, after `npx`, …), not the words in a commit message, an
 * echo or a grep pattern. Fails closed: if the command cannot be analysed and
 * mentions both lua and the flag, it counts.
 *
 * @param {unknown} command
 * @param {{analyze?: Function, budgetMs?: number}} [opts] — test seams
 * @returns {boolean}
 */
export function hasAutoDeploy(command, { analyze = analyzeScript, budgetMs = TIME_BUDGET_MS } = {}) {
  if (typeof command !== 'string' || !/--auto-deploy/i.test(command)) return false;
  const { hits, failed } = inspect(command, analyze, budgetMs);
  if (failed) return MENTIONS_LUA.test(command) && AUTO_DEPLOY_TEXT.test(command);
  return hits.some((h) => h.kind === 'auto-deploy');
}

/**
 * True iff the command runs `lua auth configure` (any binary, options before
 * the words, inside a chain or a shell string) — not text that mentions it.
 * Fails closed like hasAutoDeploy.
 *
 * @param {unknown} command
 * @param {{analyze?: Function, budgetMs?: number}} [opts] — test seams
 * @returns {boolean}
 */
export function hasAuthConfigure(command, { analyze = analyzeScript, budgetMs = TIME_BUDGET_MS } = {}) {
  if (typeof command !== 'string' || !/configure/i.test(command)) return false;
  const { hits, failed } = inspect(command, analyze, budgetMs);
  if (failed) return MENTIONS_LUA.test(command) && AUTH_CONFIGURE_TEXT.test(command);
  return hits.some((h) => h.kind === 'auth-configure');
}

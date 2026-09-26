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
//   * the lua binary is found at any word position, by basename
//     (`/usr/local/bin/lua`, `./node_modules/.bin/heylua`, `lua.cmd`), so
//     env-assignment prefixes, `sudo`/`env`/`command`/`exec`/`timeout N`/…
//     wrappers and launchers (`npx lua`, `npx lua-cli`, `npx -y lua-cli@3`,
//     `pnpm exec lua`, `pnpm dlx lua-cli`, `yarn lua`, `npm exec -- lua`,
//     `bunx lua`) are all seen through;
//   * `node [opts] <path>` counts when the path is a lua-cli entry point
//     (`…/lua-cli/dist/index.js`, `…/bin/lua`);
//   * option tokens between the binary and the verb are skipped (both as
//     boolean flags and as `--flag value` pairs);
//   * a shell variable in the binary or verb position (`$L deploy all`,
//     `lua $VERB skill`) cannot be resolved and is blocked (fail closed);
//   * `$(…)`, backticks and `<(…)` are parsed recursively, also inside
//     double quotes; a string handed to a shell (`bash -c`, `sh -c`, `eval`,
//     `ssh host "…"`, `watch`, `npx -c`, `… | sh`, a heredoc or here-string
//     fed to a shell, `trap`, `alias`) is parsed recursively too; inline code
//     for `node -e` / `python -c` / `perl -e` is searched textually;
//   * input the lexer cannot close (an unterminated quote or substitution)
//     falls back to an unanchored textual search.
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

/** Commands that take ANOTHER command as argv (the verb can follow them). */
const WRAPPERS = new Set([
  'env', 'command', 'exec', 'builtin', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'sudo', 'doas',
  'xargs', 'stdbuf', 'setsid', 'caffeinate', 'unbuffer', 'chronic', 'npx', 'pnpx', 'bunx', 'npm',
  'pnpm', 'yarn', 'bun', 'run', 'exec', 'dlx', 'x', '!', '{', 'then', 'do', 'else', 'if', 'while', 'until',
]);

/** Commands that run a STRING as shell code (their string arguments are parsed recursively). */
const SCRIPT_RUNNERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox', 'pwsh', 'powershell', 'cmd',
  'eval', 'ssh', 'su', 'runuser', 'script', 'flock', 'watch', 'parallel', 'npx', 'npm', 'concurrently',
  'nodemon', 'entr', 'trap', 'at', 'batch',
]);

/** Interpreters whose inline code (`-e`, `-c`, `-p`, …) is searched textually. */
const INLINE_CODE = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'perl', 'ruby', 'php']);

/** `node`-like launchers that take a script path as their first positional. */
const NODE_LIKE = new Set(['node', 'nodejs', 'bun', 'tsx', 'ts-node']);

/** Node options that consume the following word. */
const NODE_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--title', '--inspect-port']);

const MAX_DEPTH = 6;

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

/** Label for a lua invocation whose verb is a shell variable (cannot be resolved statically). */
export const UNRESOLVED_LABEL = 'lua <unresolved command>';

/** Labels whose success should trigger the post-deploy smoke check (something now runs live). */
export const SMOKE_LABELS = new Set([
  'lua deploy', 'lua skills deploy', 'lua webhooks deploy', 'lua jobs deploy', 'lua preprocessors deploy',
  'lua postprocessors deploy', 'lua persona production deploy', 'lua workflows deploy', 'lua version promote',
  'lua mcp activate',
]);

// Unanchored textual patterns — the fallback for input the lexer cannot close
// and for inline interpreter code. `lua-cli/<path>` covers a node entry point.
//
// The option group MUST have exactly one way to match each option: `--?`
// then a word character first. An earlier `-{1,2}[\w-]+` could split `--a`
// as `--`+`a` or `-`+`-a`, which backtracked exponentially on a failing
// match (28 options ≈ 200 s) — past the hook timeout, and a hook that times
// out fails OPEN. test/lib/tokenizer-hardening.test.mjs pins the bound.
const RAW_OPTION = '(?:--?\\w[\\w-]*(?:=\\S*)?\\s+)*';
const RAW_PATTERNS = PRODUCTION_COMMANDS.map((e) => ({
  entry: e,
  re: new RegExp(
    `(?<![\\w-])(?:lua|heylua|lua-ai|lua-cli)(?:[\\\\/][^\\s'"]*)?['"]?\\s+${RAW_OPTION}` +
      e.seq.map((alts) => `(?:${alts.join('|')})`).join(`\\s+${RAW_OPTION}`) +
      '(?![\\w-])',
    'i',
  ),
}));

/** Does the text mention a lua binary at all? (Used to fail closed on an internal error.) */
const MENTIONS_LUA = /(?<![\w-])(?:lua|heylua|lua-ai|lua-cli)(?![\w-])/i;

// ── Lexer ──────────────────────────────────────────────────────────────────

/**
 * @typedef {{text: string, quoted: boolean, dynamic: boolean}} Word
 * @typedef {{words: Word[], sep: string|null, grouped: boolean, pipeline: boolean, pipeId: number,
 *            heredocs: string[], herestrings: string[]}} Segment
 */

const newSegment = () => ({ words: [], sep: null, grouped: false, pipeline: false, pipeId: 0, heredocs: [], herestrings: [] });

/** Index of the `)` closing the `(` at `start`, honouring quotes and nesting; -1 if none. */
function findClose(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
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
 * bodies (`$(…)`, backticks, `<(…)`) in `subs` for recursive inspection and
 * sets `opaque` when something could not be closed.
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
  /** @type {Word|null} */
  let word = null;
  let depth = 0;
  let redirTarget = null; // null | 'file' | 'herestring'
  /** @type {{delim: string, strip: boolean, seg: Segment}[]} */
  let pendingHeredocs = [];
  const n = src.length;
  let i = 0;

  const startWord = () => { if (!word) word = { text: '', quoted: false, dynamic: false }; return word; };
  const endWord = () => {
    if (!word) return;
    if (redirTarget === 'herestring') seg.herestrings.push(word.text);
    if (redirTarget) redirTarget = null;
    else if (!word.quoted && (word.text === '{' || word.text === '}')) {
      // Brace group: `{ cmd; }` runs in the current shell but is still a group.
      depth = Math.max(0, depth + (word.text === '{' ? 1 : -1));
      if (word.text === '{') seg.grouped = true;
    } else seg.words.push(word);
    word = null;
  };
  const endSegment = (sep) => {
    endWord();
    if (seg.words.length || seg.heredocs.length || seg.herestrings.length) {
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
    if (close < 0) { opaque = true; subs.push(src.slice(open + 1)); return n; }
    subs.push(src.slice(open + 1, close));
    return close + 1;
  };
  const readHeredocBodies = () => {
    for (const h of pendingHeredocs) {
      const lines = [];
      let found = false;
      while (i < n) {
        let end = src.indexOf('\n', i);
        if (end < 0) end = n;
        const line = src.slice(i, end);
        i = end + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) { found = true; break; }
        lines.push(line);
      }
      h.seg.heredocs.push(lines.join('\n'));
      if (!found) i = n;
    }
    pendingHeredocs = [];
  };

  while (i < n) {
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
          if (k < 0) { opaque = true; subs.push(src.slice(j + 1)); j = n; break; }
          subs.push(src.slice(j + 1, k));
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
      if (k < 0) { opaque = true; subs.push(src.slice(i + 1)); i = n; continue; }
      subs.push(src.slice(i + 1, k));
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
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
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
        i += 2;
        const strip = src[i] === '-';
        if (strip) i++;
        while (src[i] === ' ' || src[i] === '\t') i++;
        let delim = '';
        while (i < n && !/[\s;&|<>()]/.test(src[i])) {
          if (src[i] !== "'" && src[i] !== '"' && src[i] !== '\\') delim += src[i];
          i++;
        }
        pendingHeredocs.push({ delim, strip, seg });
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
    startWord().text += c;
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
const isAssignment = (w) => !w.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text);
const isPrefixWord = (w) => !!w && !w.quoted && !w.dynamic && w.text === 'LUA_DEPLOY_CONFIRMED=1';

/** True when every word before `j` is an assignment, a wrapper/launcher, an option or a bare number. */
function isCommandPosition(words, j) {
  for (let k = 0; k < j; k++) {
    const w = words[k];
    if (isAssignment(w) || isFlag(w) || /^\d+[smhd]?$/.test(w.text) || WRAPPERS.has(commandName(w.text))) continue;
    return false;
  }
  return true;
}

/** Does `path` (the script handed to node) point at a lua-cli entry point? */
function isLuaEntryPoint(path) {
  const base = commandName(path).replace(/\.(?:m|c)?js$/i, '');
  if (PACKAGES.has(base)) return true;
  return /(?:^|[\\/])(?:lua-cli|heylua|lua-ai)(?:[\\/]|$)/i.test(path);
}

/**
 * If a lua-cli invocation starts at word `j`, return the index of its first
 * argument (and whether the binary itself was a shell variable); else null.
 */
function invocationAt(words, j) {
  const w = words[j];
  if (w.dynamic) {
    return isCommandPosition(words, j) ? { start: j + 1, dynamicHead: true } : null;
  }
  const name = commandName(w.text);
  if (BINARIES.has(name)) return { start: j + 1, dynamicHead: false };
  // `lua-cli` is the package name, not an installed binary: gated after a
  // launcher (`npx lua-cli`), or as a path to the package.
  if (name === 'lua-cli' && (j > 0 || /[\\/]/.test(w.text))) return { start: j + 1, dynamicHead: false };
  // The entry point run directly through its shebang: `/opt/lua-cli/dist/index.js deploy`.
  if (/(?:^|[\\/])(?:lua-cli|heylua|lua-ai)[\\/].*\.[mc]?js$/i.test(w.text)) return { start: j + 1, dynamicHead: false };
  if (NODE_LIKE.has(name)) {
    let k = j + 1;
    while (k < words.length && isFlag(words[k])) {
      if (NODE_VALUE_FLAGS.has(words[k].text)) k++;
      k++;
    }
    if (k < words.length && !words[k].dynamic && isLuaEntryPoint(words[k].text)) {
      return { start: k + 1, dynamicHead: false };
    }
  }
  return null;
}

/**
 * Match the arguments after a lua binary against the gated shapes. Options
 * are skipped twice over — once as boolean flags, once as `--flag value`
 * pairs — so neither reading hides a verb.
 *
 * @param {Word[]} args
 * @param {boolean} allowDynamic  a `$VAR` token may stand in for a verb
 * @returns {{label: string, slash: string, dynamic: boolean}|null}
 */
function matchArgs(args, allowDynamic) {
  const loose = []; // flags dropped, their values kept
  const strict = []; // flags and the word after a value-less `--flag` dropped
  let pendingValue = false;
  for (const a of args) {
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

/** Unanchored textual search, for text the lexer cannot structure. */
function rawSearch(text, hits) {
  for (const { entry, re } of RAW_PATTERNS) {
    if (re.test(text)) hits.push({ label: entry.label, slash: entry.slash, prefixed: false });
  }
}

/**
 * @param {Segment} seg
 * @param {{nested: boolean, depth: number}} ctx
 * @param {boolean} pipedIntoRunner  another stage of this pipeline runs its input as code
 * @param {Array<{label: string, slash: string, prefixed: boolean}>} hits
 */
function analyzeSegment(seg, ctx, pipedIntoRunner, hits) {
  const words = seg.words;
  const names = words.map((w) => (w.dynamic ? '' : commandName(w.text)));
  const runsStrings = pipedIntoRunner || names.some((nm) => SCRIPT_RUNNERS.has(nm));
  const inlineCode = names.some((nm) => INLINE_CODE.has(nm));
  const nested = { nested: true, depth: ctx.depth + 1 };

  words.forEach((w, k) => {
    if (k === 0) return;
    if (runsStrings && /[\s;&|`$()]/.test(w.text)) analyzeScript(w.text, nested, hits);
    if (inlineCode) rawSearch(w.text, hits);
    if (names[0] === 'alias' || names[0] === 'trap') {
      const eq = w.text.indexOf('=');
      if (eq > 0) analyzeScript(w.text.slice(eq + 1), nested, hits);
    }
  });
  for (const body of [...seg.heredocs, ...seg.herestrings]) {
    if (runsStrings || inlineCode || names.some((nm) => nm === 'source' || nm === '.')) {
      analyzeScript(body, nested, hits);
      if (inlineCode) rawSearch(body, hits);
    }
  }

  for (let j = 0; j < words.length; j++) {
    const inv = invocationAt(words, j);
    if (!inv) continue;
    const args = words.slice(inv.start);
    // `… | xargs lua` or `lua` with nothing but a variable after it: the verb
    // arrives at runtime and cannot be classified.
    const fedByXargs = names.slice(0, j).includes('xargs');
    let match = matchArgs(args, !inv.dynamicHead);
    if (!match && fedByXargs && !inv.dynamicHead) {
      match = { label: UNRESOLVED_LABEL, slash: '/lua-deploy', dynamic: true };
    }
    if (!match) continue;
    const canonicalPrefix =
      !inv.dynamicHead &&
      BINARIES.has(words[j].text) &&
      ((j === 1 && isPrefixWord(words[0])) ||
        (j === 2 && words[0].text === 'env' && !words[0].quoted && isPrefixWord(words[1])));
    const prefixed =
      canonicalPrefix && !match.dynamic && !ctx.nested && !seg.pipeline && !seg.grouped;
    hits.push({ label: match.label, slash: match.slash, prefixed });
  }
}

/**
 * @param {string} src
 * @param {{nested: boolean, depth: number}} ctx
 * @param {Array<{label: string, slash: string, prefixed: boolean}>} hits
 */
function analyzeScript(src, ctx, hits) {
  if (ctx.depth > MAX_DEPTH) { rawSearch(src, hits); return; }
  const { segments, subs, opaque } = lex(src);
  if (opaque) rawSearch(src, hits);

  // A pipeline stage that runs its stdin as code (`… | sh`, `… | xargs sh -c`)
  // turns every string in the pipeline into code.
  const runnerPipes = new Set(
    segments
      .filter((s) => s.pipeline && s.words.some((w) => !w.dynamic && SCRIPT_RUNNERS.has(commandName(w.text))))
      .map((s) => s.pipeId),
  );
  for (const seg of segments) analyzeSegment(seg, ctx, runnerPipes.has(seg.pipeId), hits);
  for (const sub of subs) analyzeScript(sub, { nested: true, depth: ctx.depth + 1 }, hits);
}

/**
 * Classify a command. Returns null for commands that run no gated verb, or
 * `{ label, slash, prefixed }` for a production-affecting lua-cli verb. When a
 * command runs several gated verbs, the first one WITHOUT a valid prefix is
 * returned (so one unconfirmed verb blocks the whole chain); `prefixed` is
 * true only when every gated verb in it carries the canonical prefix.
 *
 * @param {unknown} command
 * @param {{analyze?: Function}} [opts] — test seam for the fail-closed path
 * @returns {{label: string, slash: string, prefixed: boolean}|null}
 */
export function classifyProductionCommand(command, { analyze = analyzeScript } = {}) {
  if (typeof command !== 'string') return null;
  const hits = [];
  try {
    analyze(command, { nested: false, depth: 0 }, hits);
  } catch {
    // Fail closed: a classifier bug must not wave a lua command through.
    return MENTIONS_LUA.test(command) ? { label: UNRESOLVED_LABEL, slash: '/lua-deploy', prefixed: false } : null;
  }
  if (hits.length === 0) return null;
  const { label, slash, prefixed } = hits.find((h) => !h.prefixed) ?? hits[0];
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

/**
 * @param {unknown} command
 * @returns {boolean}
 */
export function hasAutoDeploy(command) {
  if (typeof command !== 'string') return false;
  return /\s--auto-deploy\b/.test(command);
}

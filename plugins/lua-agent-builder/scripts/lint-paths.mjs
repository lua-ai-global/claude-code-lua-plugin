#!/usr/bin/env node
// Cross-platform invariant per tech spec §5.3:
//   "no hard-coded `/` separators in any plugin script"
//
// Catches things like join('foo/bar') or hard-coded paths that work on
// POSIX but not Windows. Allowed:
//   - URLs and other protocols (http://, file:///, etc.)
//   - Glob patterns inside settings.json or config blocks
//   - Inside string literals that are actually paths to runtime locations
//     where forward slash is the platform-agnostic representation
//     (e.g. ${CLAUDE_PLUGIN_ROOT}/mcp/...)
//
// To keep this tractable we use a heuristic: flag string literals containing
// `/` IF they're inside join()/resolve()/relative() calls. Anywhere else,
// the developer is expected to know what they're doing.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';

const ROOT = '.';
const SCAN_DIRS = ['lib', 'hooks', 'scripts'];
// Only flag the obvious bug: a single string-literal arg containing `/`,
// like `join("foo/bar")` or `resolve("./foo/bar")`. URLs and multi-arg
// calls are excluded — these are valid usage.
//
// Also requires the call to NOT be preceded by `.` (excludes
// `array.join("/")` and similar method-form calls that aren't path joins).
const PATH_HELPER_RE = /(?<![.\w])(join|resolve|relative)\(\s*['"][^'"]*\/[^'"]*['"]\s*\)/g;

let failed = false;

// Self-exclude: lint-paths.mjs inherently contains the patterns it warns
// against (in error messages and examples). Compare by basename so the
// check is cross-platform (Windows yields 'scripts\\lint-paths.mjs' from
// walk(), POSIX yields 'scripts/lint-paths.mjs' — basename normalises both).
const SELF_EXCLUDE = new Set(['lint-paths.mjs']);

async function* walk(dir) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile() && extname(full) === '.mjs') yield full;
  }
}

for (const dir of SCAN_DIRS) {
  try {
    for await (const file of walk(join(ROOT, dir))) {
      if (SELF_EXCLUDE.has(basename(file))) continue;
      const content = await readFile(file, 'utf8');
      const matches = content.match(PATH_HELPER_RE);
      if (matches) {
        console.error(`✗ ${file}: hard-coded forward slash in path helper:`);
        for (const m of matches) console.error(`    ${m}`);
        failed = true;
      }
    }
  } catch { /* dir may not exist yet */ }
}

if (failed) {
  console.error('\nUse path.join(a, b) with separate args instead of join("a/b").');
  process.exit(1);
}
console.log('✓ No hard-coded path separators in lib/, hooks/, or scripts/.');

// ---------------------------------------------------------------------------
// Claude Code plugin variable check (added in iteration-3 audit, 2026-05-02).
//
// Per Claude Code plugin spec, the env-var that expands to the absolute
// plugin path is ${CLAUDE_PLUGIN_ROOT}. ${CLAUDE_PLUGIN_DIR} is a common
// typo; it does NOT get substituted, so any reference reaches the model
// literally and the Read tool fails on it.
// ---------------------------------------------------------------------------

let varCheckFailed = false;
const VAR_SCAN_PATHS = ['agents', 'commands', 'hooks', 'lib', 'mcp', 'scripts', '.mcp.json', '.claude-plugin', 'README.md', 'settings.json'];

async function* walkText(dir) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'coverage' || entry === 'dist') continue;
      yield* walkText(full);
    } else if (st.isFile() && /\.(mjs|md|json|yml)$/.test(full)) {
      yield full;
    }
  }
}

for (const target of VAR_SCAN_PATHS) {
  try {
    const st = await stat(target);
    const files = st.isDirectory() ? walkText(target) : (async function* () { yield target; })();
    for await (const file of files) {
      const content = await readFile(file, 'utf8');
      // Match either ${CLAUDE_PLUGIN_DIR} or bare CLAUDE_PLUGIN_DIR (in
      // shell-style references that omit the braces). Skip false-positive
      // matches inside this lint script's own comments.
      if (file.endsWith('lint-paths.mjs')) continue;
      if (/\$\{?CLAUDE_PLUGIN_DIR\}?/.test(content)) {
        console.error(`✗ ${file}: contains $CLAUDE_PLUGIN_DIR — should be \${CLAUDE_PLUGIN_ROOT} (Claude Code only substitutes _ROOT; _DIR reaches the model as a literal string).`);
        varCheckFailed = true;
      }
    }
  } catch { /* missing — skip */ }
}

if (varCheckFailed) {
  process.exit(1);
}
console.log('✓ All plugin asset references use the correct ${CLAUDE_PLUGIN_ROOT} variable.');

// ---------------------------------------------------------------------------
// Forbidden lua-cli path check (added in iteration-13 audit, 2026-05-02).
//
// Several hooks and agent prompts referenced `.lua/lua.config.yaml` and
// `.lua/compiled/manifest.json` — neither path is produced by lua-cli.
// The real paths are `lua.skill.yaml` (project root) and
// `dist-v2/manifest.json` (verified against
// packages/lua-cli/src/utils/files.ts and commands/compile.ts). Hooks that
// referenced the wrong paths silently never fired in production.
//
// Block the broken paths everywhere except this lint script (which has to
// name them in error messages).
// ---------------------------------------------------------------------------

const FORBIDDEN_PATHS = [
  { pattern: /\.lua\/lua\.config\.yaml/, message: 'use `lua.skill.yaml` (project root) — `.lua/lua.config.yaml` is not produced by lua-cli' },
  { pattern: /\.lua\/compiled\/manifest\.json/, message: 'use `dist-v2/manifest.json` — `.lua/compiled/...` is not produced by lua-cli' },
];

let forbiddenFailed = false;
const FORBIDDEN_SCAN_PATHS = ['agents', 'commands', 'hooks', 'lib', 'mcp/lua-platform/src', 'README.md'];

// Strip JS line/block comments so historical-context audit notes don't trip
// the check. The forbidden paths must not survive in *executable* code or
// *user-facing* prose (md), only in commentary explaining what was wrong.
function stripJsComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

for (const target of FORBIDDEN_SCAN_PATHS) {
  try {
    const st = await stat(target);
    const files = st.isDirectory() ? walkText(target) : (async function* () { yield target; })();
    for await (const file of files) {
      if (file.endsWith('lint-paths.mjs')) continue;
      let content = await readFile(file, 'utf8');
      if (file.endsWith('.mjs')) content = stripJsComments(content);
      for (const { pattern, message } of FORBIDDEN_PATHS) {
        if (pattern.test(content)) {
          console.error(`✗ ${file}: contains forbidden lua-cli path "${pattern.source.replace(/\\/g, '')}" — ${message}.`);
          forbiddenFailed = true;
        }
      }
    }
  } catch { /* missing — skip */ }
}

if (forbiddenFailed) {
  process.exit(1);
}
console.log('✓ No references to non-existent lua-cli output paths.');

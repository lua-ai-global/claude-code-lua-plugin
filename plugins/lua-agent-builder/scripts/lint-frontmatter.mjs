#!/usr/bin/env node
// Validates frontmatter on slash commands (commands/*.md) and subagents
// (agents/*.md) against Claude Code's documented schemas.
//
// Iteration-13 audit: commands/lua-doctor.md had `permission-mode: stepwise`
// in its frontmatter, but Claude Code does NOT support a `permission-mode`
// field on slash commands (verified via
// https://code.claude.com/docs/en/skills.md). The string was silently
// ignored — it had only worked because lint-single-permission.mjs grepped
// for it. The marker has been renamed to `x-lua-multi-step: true`; the
// `x-` prefix denotes "extension/private field that can never collide with
// a future Claude Code field."
//
// Lint contract:
//   - Every frontmatter key must be either a documented field OR start with
//     `x-` (extension prefix).
//   - For known enum-typed fields (`model`), the value must be a recognised
//     keyword OR a full model ID matching `claude-<family>-<version>`.

import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

// Per https://code.claude.com/docs/en/skills.md frontmatter reference.
const SLASH_FIELDS = new Set([
  'name', 'description', 'when_to_use', 'argument-hint', 'arguments',
  'disable-model-invocation', 'user-invocable', 'allowed-tools', 'model',
  'effort', 'context', 'agent', 'hooks', 'paths', 'shell',
]);

// Per https://code.claude.com/docs/en/agents.md frontmatter reference.
const AGENT_FIELDS = new Set([
  'name', 'description', 'model', 'tools', 'disallowedTools', 'permissionMode',
  'skills', 'mcpServers', 'hooks', 'maxTurns', 'memory', 'effort',
  'background', 'isolation', 'color', 'initialPrompt',
]);

// Subset of `model` values per the docs (keyword form). Full model IDs
// match the regex below.
const MODEL_KEYWORDS = new Set(['sonnet', 'opus', 'haiku', 'inherit']);
const MODEL_ID_RE = /^claude-(?:opus|sonnet|haiku)-\d+(?:-\d+)?(?:\[\d+m\])?$/;

const PERMISSION_MODE_VALUES = new Set([
  'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan',
]);

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const block = m[1];
  const fields = {};
  for (const line of block.split('\n')) {
    const km = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (km) fields[km[1]] = km[2].trim();
  }
  return fields;
}

function lintFile(file, fields, schema, label) {
  for (const key of Object.keys(fields)) {
    if (key.startsWith('x-')) continue;  // private extension prefix — allow
    if (!schema.has(key)) {
      fail(`${file}: ${label} frontmatter has unrecognised field "${key}". Claude Code silently ignores unknown keys, so the value has no effect. Either rename to a documented field or prefix with \`x-\` (extension marker).`);
    }
  }
  if (fields.model && !MODEL_KEYWORDS.has(fields.model) && !MODEL_ID_RE.test(fields.model)) {
    fail(`${file}: model "${fields.model}" is not a valid keyword (sonnet/opus/haiku/inherit) or full ID (claude-<family>-<version>).`);
  }
  if (fields.permissionMode && !PERMISSION_MODE_VALUES.has(fields.permissionMode)) {
    fail(`${file}: permissionMode "${fields.permissionMode}" is not a recognised value. Valid: ${[...PERMISSION_MODE_VALUES].join(', ')}.`);
  }
}

async function lintDir(dir, schema, label) {
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => extname(f) === '.md');
  } catch { return 0; }
  for (const f of files) {
    const path = join(dir, f);
    const content = await readFile(path, 'utf8');
    const fields = parseFrontmatter(content);
    if (!fields) {
      fail(`${path}: ${label} is missing frontmatter (--- block at top of file).`);
      continue;
    }
    lintFile(path, fields, schema, label);
  }
  return files.length;
}

const slashes = await lintDir('commands', SLASH_FIELDS, 'slash command');
const agents  = await lintDir('agents',   AGENT_FIELDS, 'subagent');

// Iteration-13 audit (bug 72 class): fail if both directories are empty —
// either the layout changed or the file-extension filter is broken.
if (slashes === 0 && agents === 0 && !failed) {
  fail(`Found 0 slash commands AND 0 subagents to check. Either commands/ and agents/ are gone, or the .md filter is broken. Refusing to silently pass.`);
}

if (failed) {
  console.error('\nFix the issues above and re-run `npm run lint`.');
  process.exit(1);
}
console.log(`✓ Frontmatter: ${slashes} slash command(s) + ${agents} subagent(s) match documented schemas (with x- extension prefix allowed).`);

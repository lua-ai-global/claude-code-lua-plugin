#!/usr/bin/env node
// Validates .claude-plugin/plugin.json against Claude Code's documented
// manifest schema (https://code.claude.com/docs/en/plugins-reference).
//
// Iteration-13 audit: the manifest had two silent-ignore bugs that
// neither lint nor tests caught:
//   - `displayName: "Lua Agent Builder"` — not a recognised field, ignored.
//   - `repository: { type: "git", url: "..." }` — npm-style object, but
//     Claude Code's schema specifies `repository` as a STRING. Silently
//     dropped, so the GitHub link never surfaced in marketplaces.
//
// This lint flags any unknown top-level field plus the wrong shape for
// fields whose type is documented.

import { readFile } from 'node:fs/promises';

const PATH = '.claude-plugin/plugin.json';

let manifest;
try {
  manifest = JSON.parse(await readFile(PATH, 'utf8'));
} catch (err) {
  console.error(`✗ Could not read ${PATH}: ${err.message}`);
  process.exit(1);
}

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

// Per https://code.claude.com/docs/en/plugins-reference (manifest schema).
const SCHEMA = {
  name:        { type: 'string', required: true },
  version:     { type: 'string' },
  description: { type: 'string' },
  author:      { type: 'object' },           // { name, email?, url? }
  homepage:    { type: 'string' },
  repository:  { type: 'string' },           // ← NOT { type, url } — that's npm
  license:     { type: 'string' },
  keywords:    { type: 'array' },
  // The schema also has commands/agents/hooks/mcpServers fields that point
  // at non-default subdirectories. Add them here if the plugin ever uses
  // non-standard layouts.
};

const KEYS = Object.keys(manifest);
for (const k of KEYS) {
  if (!(k in SCHEMA)) {
    fail(`${PATH}: unknown field "${k}". Claude Code silently ignores unrecognised fields, so the value has no effect. Known fields: ${Object.keys(SCHEMA).join(', ')}.`);
  }
}

for (const [field, { type, required }] of Object.entries(SCHEMA)) {
  if (required && !(field in manifest)) {
    fail(`${PATH}: required field "${field}" missing.`);
    continue;
  }
  if (field in manifest) {
    const v = manifest[field];
    const actualType = Array.isArray(v) ? 'array' : typeof v;
    if (actualType !== type) {
      fail(`${PATH}: field "${field}" has type ${actualType}, expected ${type}. ${field === 'repository' ? 'Use a plain URL string, NOT the npm-style { type, url } object — Claude Code drops the field entirely on schema mismatch.' : ''}`);
    }
  }
}

if (manifest.name && !/^[a-z][a-z0-9-]*$/.test(manifest.name)) {
  fail(`${PATH}: name "${manifest.name}" must be kebab-case (lowercase letters, digits, hyphens; start with a letter).`);
}

if (failed) {
  console.error('\nFix the issues above and re-run `npm run lint`.');
  process.exit(1);
}
console.log(`✓ .claude-plugin/plugin.json: schema valid (${KEYS.length} field(s) recognised).`);

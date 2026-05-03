#!/usr/bin/env node
// Smoke check for the §3.7 single-permission contract.
// Per tech spec §2.4.1: this lint is NOT the contract source of truth
// (slash markdown is a model prompt, not executable code). Integration
// tests that count permissionPromptCount are the source of truth. This
// lint catches obvious naive violations.

import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const COMMANDS_DIR = 'commands';
const ASK_USER_QUESTION_RE = /AskUserQuestion/g;
const STEP_PATTERN = /^[0-9]+\.\s.*AskUserQuestion/gm;

let failed = false;

let commands;
try {
  commands = (await readdir(COMMANDS_DIR)).filter((f) => extname(f) === '.md');
} catch {
  console.log('✓ commands/ directory does not exist yet — skipping.');
  process.exit(0);
}

for (const file of commands) {
  const content = await readFile(join(COMMANDS_DIR, file), 'utf8');

  // Iteration-13 audit: this opt-out marker used to be `permission-mode:
  // stepwise`, but Claude Code does NOT support a `permission-mode` field on
  // slash commands (verified against
  // https://code.claude.com/docs/en/skills.md frontmatter reference) — the
  // closest field is `permissionMode` on SUBAGENTS, which doesn't accept
  // `stepwise` either. The string was always silently ignored by Claude
  // Code; this lint-only signal now uses the `x-lua-` extension prefix so
  // it can never collide with a future official field. The marker means
  // "this slash legitimately makes multiple permission interactions" —
  // /lua-doctor's 5-step diagnostic is the canonical example.
  if (/^x-lua-multi-step:\s*true/m.test(content)) continue;

  const askCount = (content.match(ASK_USER_QUESTION_RE) ?? []).length;
  if (askCount > 5) {
    console.error(`✗ ${file}: ${askCount} AskUserQuestion mentions (>5 — likely violates §3.7 single-permission contract).`);
    console.error(`    The lint is a smoke check; the contract is enforced by integration tests counting permissionPromptCount.`);
    console.error(`    If this slash legitimately requires multi-step asks (like /lua-doctor), add 'x-lua-multi-step: true' to the frontmatter.`);
    failed = true;
  }

  const stepwiseAsks = (content.match(STEP_PATTERN) ?? []).length;
  if (stepwiseAsks > 1) {
    console.error(`✗ ${file}: ${stepwiseAsks} numbered steps each containing AskUserQuestion. Consolidate into a single multi-question call (§3.7).`);
    console.error(`    If multi-step is genuinely required, add 'x-lua-multi-step: true' to frontmatter.`);
    failed = true;
  }
}

if (failed) {
  console.error('\nReview the slash command body. Multiple AskUserQuestion calls likely violate §3.7.');
  process.exit(1);
}
console.log(`✓ ${commands.length} slash command(s) pass single-permission smoke check.`);

#!/usr/bin/env node
// Validates that every slash command claiming to "spawn" / "invoke" /
// "delegate to" a subagent actually instructs Claude to call the Agent tool.
//
// Iteration-13 audit: 5 slash commands had prose like "Spawn the
// `lua-deploy-pilot` subagent" but no instruction to use the Agent tool.
// Claude Code has no built-in "spawn" — subagent dispatch happens via
// (a) `context: fork` frontmatter, which forces the WHOLE slash body
// (including AskUserQuestion) into the subagent context, OR (b) explicit
// Task-tool invocation. Option (a) breaks Step 1's input collection
// (subagents typically don't include AskUserQuestion). The slashes were
// silently running entirely in the main agent — no subagent dispatch ever
// happened, the subagents' restricted tool allowlists weren't enforced.
//
// Lint contract: if a slash names a subagent in prose, it must also
// reference the Agent tool by name in the same file. This is a smoke check;
// the fix surface is informational.

import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

const COMMANDS_DIR = 'commands';
const AGENTS_DIR = 'agents';

const SUBAGENT_NAMES = new Set();
try {
  for (const f of await readdir(AGENTS_DIR)) {
    if (extname(f) === '.md') SUBAGENT_NAMES.add(f.replace(/\.md$/, ''));
  }
} catch { /* dir missing — separate problem */ }

if (SUBAGENT_NAMES.size === 0) {
  console.warn('! No subagents discovered; skipping subagent-dispatch check.');
  process.exit(0);
}

// Iteration-13 audit: Claude Code 2.1.63 renamed Task → Agent (Task still
// works as alias). Match either name plus the unambiguous `subagent_type:`
// parameter form.
const TASK_REFERENCE_RE = /\b(Agent|Task) tool\b|subagent_type:/i;
const SPAWN_VERBS_RE = /\b(spawn|invoke|delegate to|hand off to|dispatch)\b/i;

let files = [];
try { files = (await readdir(COMMANDS_DIR)).filter((f) => extname(f) === '.md'); }
catch { console.warn('! No commands/ dir; skipping.'); process.exit(0); }

let scanned = 0;
for (const f of files) {
  const path = join(COMMANDS_DIR, f);
  const content = await readFile(path, 'utf8');

  // Find which subagent(s) this slash mentions by name.
  const mentioned = [...SUBAGENT_NAMES].filter((name) => content.includes(name));
  if (mentioned.length === 0) continue;

  // If the slash uses a "spawn-ish" verb against a subagent name, it MUST
  // also tell Claude to use the Agent tool — otherwise the dispatch never
  // happens.
  const usesSpawnVerb = SPAWN_VERBS_RE.test(content);
  const referencesTaskTool = TASK_REFERENCE_RE.test(content);

  if (usesSpawnVerb && !referencesTaskTool) {
    fail(`${path}: mentions subagent(s) [${mentioned.join(', ')}] with a spawn-style verb but never references the Agent tool / subagent_type. Without explicit Task-tool invocation, Claude Code runs the slash body in the main agent — the subagent's restricted tool allowlist is not enforced. Add a sentence like "Use the **Agent tool** with \`subagent_type: \\"<name>\\"\`".`);
  }
  scanned++;
}

// Iteration-13 audit, second pass: subagents themselves can claim
// "hand off to <other-subagent>" / "spawn <other>" — but they can only
// actually do that if their own `tools:` frontmatter includes Task. Without
// it, the prose is unactionable: the subagent can't dispatch.
let agentDispatchScanned = 0;
let agentFiles = [];
try { agentFiles = (await readdir(AGENTS_DIR)).filter((f) => extname(f) === '.md'); }
catch { /* missing — handled earlier */ }

for (const f of agentFiles) {
  const path = join(AGENTS_DIR, f);
  const content = await readFile(path, 'utf8');
  const selfName = f.replace(/\.md$/, '');

  // Other subagents this agent mentions by name (excluding itself).
  const mentionedOthers = [...SUBAGENT_NAMES].filter((n) => n !== selfName && content.includes(n));
  if (mentionedOthers.length === 0) continue;

  // Look only inside the body (skip the structured triage-report templates
  // that legitimately quote subagent names without invoking them).
  // Simple heuristic: find lines that combine a spawn-verb with a subagent
  // name OUTSIDE of code-block / report-template fences.
  const lines = content.split('\n');
  let inFence = false;
  const flagged = [];
  for (const line of lines) {
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!SPAWN_VERBS_RE.test(line)) continue;
    for (const other of mentionedOthers) {
      if (line.includes(other) && !TASK_REFERENCE_RE.test(content)) {
        flagged.push({ line: line.trim(), other });
      }
    }
  }

  if (flagged.length > 0) {
    // Look at the agent's tools: frontmatter — if Task is present, the prose
    // is actionable; if not, it's misleading.
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const tools = fmMatch?.[1]?.match(/^tools:\s*(.+)$/m)?.[1] ?? '';
    const hasTask = /\b(Task|Agent)\b/.test(tools);
    if (!hasTask) {
      for (const { line, other } of flagged) {
        fail(`${path}: claims to dispatch to "${other}" with line "${line}" but this subagent's tools list does not include Task. The handoff is unactionable. Either rephrase to "report back to parent" / "abort with a clear message" or add Task to the agent's tools and reference it explicitly in the prose.`);
      }
    }
  }
  agentDispatchScanned++;
}

// Iteration-13 audit (bug 72 class): fail if zero slashes scanned (the
// per-agent count can legitimately be zero if no agent mentions another).
if (scanned === 0 && !failed) {
  fail(`Found 0 slash commands that mention any subagent. Either the slashes don't reference subagents, or the regex/path is broken. Refusing to silently pass.`);
}

if (failed) {
  console.error('\nFix the issues above and re-run `npm run lint`.');
  process.exit(1);
}
console.log(`✓ Subagent dispatch: ${scanned} slash command(s) + ${agentDispatchScanned} subagent(s) cross-checked for inter-agent invocation.`);

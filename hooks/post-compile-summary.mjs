// PostToolUse hook for `lua compile`.
// Per feature doc §3.3 / tech spec §6.3 row 8.
// Reads the generated manifest and prints a one-line summary so the chat
// transcript records what compiled.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';

/**
 * Iteration-13 audit: prefers `input.cwd` (Claude Code hook payload field —
 * the user's actual CWD when the Bash tool ran) over `process.cwd()` so
 * the manifest is resolved relative to the project root, not Claude Code's
 * startup directory.
 *
 * @param {{tool_input?: {command?: string}, tool_response?: {success?: boolean}, cwd?: string}|null} input
 * @param {{cwd?: string}} [opts] — test override; takes precedence over input.cwd
 */
export function decide(input, opts = {}) {
  const command = input?.tool_input?.command ?? '';
  if (!/^lua\s+compile\b/.test(command.trimStart())) return null;

  // Defensive: PostToolUse only fires for SUCCESSFUL tool calls per
  // https://code.claude.com/docs/en/hooks (failures go to PostToolUseFailure
  // which the plugin doesn't subscribe to). So this branch is unreachable
  // in current Claude Code. Kept as a forward-compat guard.
  if (input?.tool_response?.success === false) return null;

  const cwd = opts.cwd ?? input?.cwd ?? process.cwd();

  // Iteration-13 audit: lua-cli writes the manifest to `dist-v2/manifest.json`
  // (verified against packages/lua-cli/src/commands/compile.ts:82 and
  // compiler.ts:375). The previous `.lua/compiled/manifest.json` path never
  // existed, so the summary was never produced. The manifest also has no
  // `warnings` field — warnings come back via the `CompilationResult`
  // returned in-process and aren't persisted. The agent itself is a
  // primitive entry (kind: 'agent') in `primitives[]`, so subtract it for
  // the user-facing count.
  const manifestPath = join(cwd, 'dist-v2', 'manifest.json');
  if (!existsSync(manifestPath)) return null;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const all = Array.isArray(manifest.primitives) ? manifest.primitives : [];
    const nonAgent = all.filter((p) => p?.kind !== 'agent').length;
    return {
      warn: `✓ Compiled ${nonAgent} primitive(s).`,
    };
  } catch {
    return null;
  }
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('post-compile-summary', decide, { eventName: 'PostToolUse' });
}

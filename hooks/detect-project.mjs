// SessionStart hook. Per feature doc §3.3.
// Detects whether the user opened Claude Code in a Lua agent project
// (presence of lua.skill.yaml). Prints a one-line confirmation
// or warning. Never blocks.
//
// Iteration-13 audit: lua-cli writes `lua.skill.yaml` at the project root
// (verified against packages/lua-cli/src/utils/files.ts:24, 113 — every
// entry-point command throws "No lua.skill.yaml found" when missing). The
// previous `.lua/lua.config.yaml` path never existed and the hook was a
// permanent no-op for real projects. The YAML structure is also nested
// (`agent.agentId`) — there is no top-level `agentName` field.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';

/**
 * Pure decision function. Reads from disk synchronously — file existence
 * check is sub-millisecond and SessionStart blocks for the budget either way.
 *
 * Iteration-13 audit: prefers `input.cwd` (the user's actual CWD per the
 * Claude Code hook payload) over `process.cwd()` (which is Claude Code's
 * startup CWD — not necessarily where the user's project lives if they
 * opened Claude Code in their home dir and `cd`'d to the project later).
 * Test injection point retained as `opts.cwd` for backward compat.
 *
 * @param {{cwd?: string}|null} input — Claude Code hook payload
 * @param {{cwd?: string}} [opts] — test override; takes precedence over input.cwd
 */
export function decide(input, opts = {}) {
  const cwd = opts.cwd ?? input?.cwd ?? process.cwd();
  const configPath = join(cwd, 'lua.skill.yaml');

  if (!existsSync(configPath)) {
    return null;  // Not a Lua project — silent
  }

  // Best-effort parse of agentId from the YAML. We do not pull in a YAML
  // parser dependency for this — too heavy for a hook. The agentId field
  // only appears under the `agent:` block (verified against the YamlConfig
  // type in lua-cli's yaml.types.ts), so a multiline match is unambiguous.
  let agentId = null;
  try {
    const content = readFileSync(configPath, 'utf8');
    const match = content.match(/^\s+agentId:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
    if (match) agentId = match[1].trim();
  } catch {
    // Permission denied, etc. — print a generic message and move on.
  }

  return {
    warn: agentId
      ? `✓ Lua agent project detected: ${agentId}. Run /lua-doctor or /lua-test to begin.`
      : '✓ Lua agent project detected. Run /lua-doctor or /lua-test to begin.',
  };
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('detect-project', decide, { eventName: 'SessionStart' });
}

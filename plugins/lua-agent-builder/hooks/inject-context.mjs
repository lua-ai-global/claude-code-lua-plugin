// UserPromptSubmit hook. Per feature doc §3.3 / tech spec §6.3 row 2.
//
// Injects a compact context block on every user prompt when in a
// Lua project. Disk-only — no network call (the v1.21 fix removed the
// `lua agents --json` round-trip per chat turn).
//
// Iteration-13 audit: the file is `lua.skill.yaml` at the project root
// (verified against packages/lua-cli/src/utils/files.ts), with nested
// `agent.agentId` and `agent.orgId` fields. The YAML never carried
// top-level `agentName` or `model` — those queries returned nothing every
// turn and the hook silently emitted nothing for real projects.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';

/**
 * Iteration-13 audit: prefers `input.cwd` (Claude Code hook payload field —
 * the user's actual CWD at prompt time) over `process.cwd()`.
 *
 * @param {{cwd?: string}|null} input — Claude Code hook payload
 * @param {{cwd?: string}} [opts] — test override; takes precedence over input.cwd
 */
export function decide(input, opts = {}) {
  const cwd = opts.cwd ?? input?.cwd ?? process.cwd();
  const configPath = join(cwd, 'lua.skill.yaml');
  if (!existsSync(configPath)) return null;

  let agentId = null;
  let orgId = null;

  try {
    const content = readFileSync(configPath, 'utf8');
    // Both fields live nested under `agent:` — a multiline indented match
    // disambiguates them from any per-primitive ID fields (skillId etc.).
    const idMatch = content.match(/^\s+agentId:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
    if (idMatch) agentId = idMatch[1].trim();
    const orgMatch = content.match(/^\s+orgId:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
    if (orgMatch) orgId = orgMatch[1].trim();
  } catch /* istanbul ignore next */ {
    // EACCES, EPERM, or similar — defensive return.
    return null;
  }

  if (!agentId) return null;

  const lines = [
    `[lua] agent: ${agentId}`,
    orgId ? `[lua] org:   ${orgId}` : null,
  ].filter(Boolean);

  return { warn: lines.join('\n') };
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('inject-context', decide, { eventName: 'UserPromptSubmit' });
}

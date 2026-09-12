// PreToolUse hook for `lua push --set-version 0.x.y`.
// Per feature doc §3.3 / tech spec §6.3 row 6.
// Soft-warns on 0.x version pushes — never blocks.
//
// What is actually true in lua-cli 3.33.0 (verified against
// src/utils/semver.ts, src/commands/push.ts, src/commands/deploy.ts and
// src/utils/deploy-helpers.ts): a push never promotes anything, `--set-version`
// only has to match /^\d+\.\d+\.\d+/, and `lua deploy … --set-version latest`
// picks the most RECENTLY CREATED version (`sortVersionsByDate`), not the
// highest semver. So a 0.x.y pushed after a 1.x.y IS what `latest` deploys —
// the opposite of the "pre-release" intuition.

import { runHook, checkNodeVersion, isMainScript } from '../lib/hook-runtime.mjs';

const VERSION_ZERO_PATTERN = /^(?:lua|heylua|lua-ai)\s+push\b.*--set-version\s+0\./;

/**
 * @param {{tool_input?: {command?: string}}|null} input
 */
export function decide(input) {
  const command = input?.tool_input?.command ?? '';
  if (VERSION_ZERO_PATTERN.test(command.trimStart())) {
    return {
      warn:
        'Pushing a 0.x.y version. Note: `lua deploy … --set-version latest` deploys the most recently CREATED ' +
        'version (sorted by creation date), not the highest semver — so this 0.x push is what `latest` will pick ' +
        'even if a 1.x.y exists. Pass an explicit `--set-version <x.y.z>` at deploy time if that is not what you want.',
    };
  }
  return null;
}

/* istanbul ignore next */
if (isMainScript(import.meta.url)) {
  checkNodeVersion();
  await runHook('warn-version-zero', decide, { eventName: 'PreToolUse' });
}

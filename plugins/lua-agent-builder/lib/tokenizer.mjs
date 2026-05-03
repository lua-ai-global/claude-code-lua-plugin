// Per tech spec §17.4 / feature doc §6.5.
// Parses bash command strings to detect the LUA_DEPLOY_CONFIRMED=1 prefix
// that signals user-authorised deploy intent. Refuses shell wrappers and
// pipes — these can't be safely classified, so they're denied even with
// the right env var.

const DEPLOY_PREFIX = /^LUA_DEPLOY_CONFIRMED=1\s+lua\s+deploy\b/;
const ENV_DEPLOY_PREFIX = /^env\s+LUA_DEPLOY_CONFIRMED=1\s+lua\s+deploy\b/;
const WRAPPER_HEAD = /^(bash|sh|zsh)\s/;

/**
 * @param {unknown} command
 * @returns {boolean}
 */
export function isPrefixedDeploy(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trimStart();
  if (trimmed.includes('|')) return false;
  if (WRAPPER_HEAD.test(trimmed)) return false;
  return DEPLOY_PREFIX.test(trimmed) || ENV_DEPLOY_PREFIX.test(trimmed);
}

/**
 * @param {unknown} command
 * @returns {boolean}
 */
export function hasAutoDeploy(command) {
  if (typeof command !== 'string') return false;
  return /\s--auto-deploy\b/.test(command);
}

// Shared subprocess helper for tools that shell out to the lua-cli binary.
//
// Why shell out at all: there is no "list every agent this credential can
// reach" REST route — `lua agents --json` already does the credential-to-
// authorization-projection resolution (PRO-1712) for every credential class
// (API key, typed scoped key, renewable session). Reimplementing that in the
// MCP would duplicate logic lua-cli owns.

import { spawn } from 'node:child_process';

// `lua agents` walks every organisation the credential can see and, for a
// session login, refreshes the session first. Measured 2026-09-12 on a
// 144-org account: 18–25 s. The budget must cover that.
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run `lua <args>` and resolve with its stdout.
 *
 * On Windows the npm bin is a `lua.cmd` shim, which Node (≥18.20 / ≥20.12)
 * refuses to spawn without a shell; the args are fixed literals (no user
 * input), so `shell: true` there is safe.
 *
 * @param {string[]} args
 * @param {{spawnFn?: typeof spawn, timeoutMs?: number, label?: string}} [opts]
 * @returns {Promise<string>}
 */
export function runLua(args, { spawnFn = spawn, timeoutMs = DEFAULT_TIMEOUT_MS, label = 'lua' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('lua', args, {
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env, LUA_NO_BANNER: '1', LUA_NO_HINTS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${label}: 'lua ${args.join(' ')}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`'lua ${args.join(' ')}' exited ${code}: ${stderr.trim()}`));
      else resolve(stdout);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Flatten `lua agents --json` output (lua-cli ≥ 3.28: an array of
 * CredentialOrganization rows — `{ orgId, name?, archived, discoveredVia,
 * agents: [{ agentId, name?, visibility, displayRoles }] }`, see
 * packages/lua-cli/src/services/credential-operational-context.ts) into a
 * compact agent list. Older flat shapes are tolerated for forward-compat.
 *
 * @param {unknown} parsed
 * @returns {Array<{id: string, name: string|null, orgId: string|null, orgName: string|null, visibility: string|null}>}
 */
export function flattenAgents(parsed) {
  const obj = /** @type {any} */ (parsed);
  const entries = Array.isArray(obj) ? obj : (obj?.agents ?? obj?.orgs ?? []);
  const looksLikeOrgs = entries.length > 0 && entries[0] && Array.isArray(entries[0].agents);

  if (looksLikeOrgs) {
    return entries.flatMap((org) => (org.agents ?? []).map((a) => ({
      id: a.agentId ?? a.id ?? a._id,
      name: a.name ?? null,
      orgId: org.orgId ?? org.id ?? org._id ?? null,
      orgName: org.name ?? org.registeredName ?? null,
      visibility: a.visibility ?? null,
    })));
  }
  return entries.map((a) => ({
    id: a.agentId ?? a.id ?? a._id,
    name: a.name ?? null,
    orgId: a.orgId ?? null,
    orgName: a.orgName ?? null,
    visibility: a.visibility ?? null,
  }));
}

/**
 * Run `lua agents --json --ci` and return the flattened agent list.
 *
 * @param {{spawnFn?: typeof spawn, label?: string}} [opts]
 */
export async function listAgentsViaCli({ spawnFn, label = 'list_agents' } = {}) {
  const stdout = await runLua(['agents', '--json', '--ci'], { spawnFn, label });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`${label}: could not parse 'lua agents --json' output: ${err.message}`);
  }
  return flattenAgents(parsed);
}

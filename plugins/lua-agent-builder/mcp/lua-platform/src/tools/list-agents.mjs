import { spawn } from 'node:child_process';

// Per the v10 lua-api audit: there's no "list all agents accessible to the
// authenticated key" endpoint — only `GET /agents/:userId` (per-user) which
// would require the MCP server to first resolve which user this API key
// belongs to.
//
// Per the v1.25 architectural decision (don't reimplement what lua-cli
// already does): shell out to `lua agents --json`. The CLI already has the
// auth-to-userId resolution logic. The MCP becomes a thin wrapper.
//
// Iteration-13 audit: `lua agents --json` returns `userData.admin.orgs` — an
// array of organisations each with a nested `agents: [{agentId, name}]`
// array, NOT a flat agent list. Flatten here. The optional legacy paths
// (flat array, `{agents: [...]}` envelope) are preserved for forward-compat
// in case a future CLI release changes the shape.

export const listAgents = {
  spec: {
    name: 'list_agents',
    description: 'List all Lua agents the authenticated user has access to. Returns a compact array of {id, name, orgId, orgName} flattened across all orgs.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  async handler(_args, deps = {}) {
    const spawnFn = deps.spawnFn ?? spawn;
    const stdout = await runLua(spawnFn, ['agents', '--json']);

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new Error(`list_agents: could not parse 'lua agents --json' output: ${err.message}`);
    }

    // Detect shape. Current (3.12.x) shape: array of orgs, each with `agents`.
    // Legacy shapes preserved for forward-compat.
    let entries = Array.isArray(parsed) ? parsed : (parsed.agents ?? parsed.orgs ?? []);
    const looksLikeOrgs = entries.length > 0 && entries[0] && Array.isArray(entries[0].agents);

    const compact = looksLikeOrgs
      ? entries.flatMap((org) => (org.agents ?? []).map((a) => ({
          id: a.agentId ?? a.id ?? a._id,
          name: a.name,
          orgId: org.id ?? org._id ?? null,
          orgName: org.registeredName ?? org.name ?? null,
        })))
      : entries.map((a) => ({
          id: a.agentId ?? a.id ?? a._id,
          name: a.name,
          orgId: a.orgId ?? null,
          orgName: a.orgName ?? null,
        }));

    return {
      content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }],
    };
  },
};

function runLua(spawnFn, args, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('lua', args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`list_agents: 'lua agents --json' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`'lua agents --json' exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

import { spawn } from 'node:child_process';

// Iteration-13 audit: the previous implementation called
// `/public/agents/:agentId`, which is guarded by `PublicOriginGuard`
// (verified against lua-api/src/guards/public-origin.guard.ts). The guard
// requires an `Origin` header; server-to-server fetch from the MCP sends
// none, so every call returned 403 "Origin header required" — and the
// only allowed production origin is `https://heylua.ai` anyway.
//
// There is no consolidated `GET /developer/agents/:agentId` endpoint. The
// agent's identity (id + name + org) IS available in `lua agents --json`
// (an authenticated CLI call that does its own auth-to-userId resolution),
// so we shell out and filter — same pattern as `list_agents`. Persona,
// model, and env-var listings live behind separate per-resource endpoints
// (`/developer/agents/:agentId/persona/versions`, `.../env`, etc.); callers
// that need those should use the dedicated tools.

export const getAgent = {
  spec: {
    name: 'get_agent',
    description: 'Look up one Lua agent by ID and return {id, name, orgId, orgName}. For deployment versions use list_primitive_versions / get_deployment_status; for logs use tail_logs.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID (the `id` field from list_agents)' },
      },
      required: ['agentId'],
    },
  },
  async handler({ agentId }, deps = {}) {
    if (!agentId) throw new Error('agentId is required');
    const spawnFn = deps.spawnFn ?? spawn;
    const stdout = await runLua(spawnFn, ['agents', '--json']);

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new Error(`get_agent: could not parse 'lua agents --json' output: ${err.message}`);
    }

    // Same shape detection as list_agents — the canonical 3.12.x output is
    // an array of orgs each with a nested `agents` array.
    const entries = Array.isArray(parsed) ? parsed : (parsed.agents ?? parsed.orgs ?? []);
    const looksLikeOrgs = entries.length > 0 && entries[0] && Array.isArray(entries[0].agents);

    let match = null;
    if (looksLikeOrgs) {
      for (const org of entries) {
        for (const a of org.agents ?? []) {
          if ((a.agentId ?? a.id ?? a._id) === agentId) {
            match = {
              id: a.agentId ?? a.id ?? a._id,
              name: a.name,
              orgId: org.id ?? org._id ?? null,
              orgName: org.registeredName ?? org.name ?? null,
            };
            break;
          }
        }
        if (match) break;
      }
    } else {
      const a = entries.find((e) => (e.agentId ?? e.id ?? e._id) === agentId);
      if (a) {
        match = {
          id: a.agentId ?? a.id ?? a._id,
          name: a.name,
          orgId: a.orgId ?? null,
          orgName: a.orgName ?? null,
        };
      }
    }

    if (!match) {
      throw new Error(`get_agent: no agent with id "${agentId}" found in the authenticated user's accessible orgs. Run list_agents to see available agents.`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(match, null, 2) }],
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
      reject(new Error(`get_agent: 'lua agents --json' timed out after ${timeoutMs}ms`));
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

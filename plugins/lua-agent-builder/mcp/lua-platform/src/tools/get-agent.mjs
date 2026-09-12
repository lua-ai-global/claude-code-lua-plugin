import { listAgentsViaCli } from '../run-lua.mjs';

// There is no consolidated `GET /developer/agents/:agentId` route, and the
// public `/public/agents/:agentId` route is origin-guarded (browser only).
// The agent's identity (id, name, org, visibility) IS in `lua agents --json`,
// so we shell out and filter — same path as list_agents. Persona, model and
// env live behind separate per-resource routes; use the dedicated tools (or
// `lua status --json` inside the project) for those.

export const getAgent = {
  spec: {
    name: 'get_agent',
    description: 'Look up one Lua agent by ID and return {id, name, orgId, orgName, visibility}. For what is live use get_deployment_status / list_primitive_versions; for logs use tail_logs.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID (the `id` field from list_agents; also `agent.agentId` in lua.skill.yaml)' },
      },
      required: ['agentId'],
    },
  },
  async handler({ agentId }, deps = {}) {
    if (!agentId) throw new Error('agentId is required');
    const agents = await listAgentsViaCli({ spawnFn: deps.spawnFn, label: 'get_agent' });
    const match = agents.find((a) => a.id === agentId) ?? null;

    if (!match) {
      throw new Error(`get_agent: no agent with id "${agentId}" found in the authenticated credential's accessible orgs. Run list_agents to see available agents.`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(match, null, 2) }],
    };
  },
};

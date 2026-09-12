import { listAgentsViaCli } from '../run-lua.mjs';

// Shells out to `lua agents --json --ci` (see run-lua.mjs for why). The CLI
// emits one row per organisation with a nested `agents` array; we flatten.

export const listAgents = {
  spec: {
    name: 'list_agents',
    description: 'List all Lua agents the authenticated credential can reach. Returns a compact array of {id, name, orgId, orgName, visibility} flattened across all organisations. Same data as `lua agents --json` — it resolves every organisation, so on accounts with many orgs this takes 20 s or more; prefer get_agent when you already know the id.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  async handler(_args, deps = {}) {
    const compact = await listAgentsViaCli({ spawnFn: deps.spawnFn, label: 'list_agents' });
    return {
      content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }],
    };
  },
};

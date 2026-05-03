import { apiRequest } from '../api-client.mjs';

const VALID_TYPES = new Set([
  'all', 'skill', 'job', 'webhook', 'preprocessor', 'postprocessor',
  'user_message', 'agent_response', 'mcp', 'mastra',
]);

export const tailLogs = {
  spec: {
    name: 'tail_logs',
    description: 'Fetch recent logs for an agent. Mirrors `lua logs --ci --json` but callable from inside Claude Code without dropping into bash.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        type: { type: 'string', enum: [...VALID_TYPES], default: 'all' },
        name: { type: 'string', description: 'Filter by primitive name (optional)' },
        // Iteration-13 audit: lua-api caps limit at 100 server-side
        // (`Math.min(100, ...)` in developer/base.controller.ts:254). The
        // schema previously advertised max=500, so a caller asking for 500
        // entries would silently get 100 with no indication. Match the
        // server cap so the tool's contract is honest.
        limit: { type: 'number', default: 50, minimum: 1, maximum: 100 },
      },
      required: ['agentId'],
    },
  },
  async handler({ agentId, type = 'all', name, limit = 50 }, deps = {}) {
    if (!agentId) throw new Error('agentId is required');
    if (!VALID_TYPES.has(type)) throw new Error(`Invalid type: ${type}`);
    // Defensive cap matching the server-side limit; rejects loud rather
    // than silently truncating.
    if (limit > 100) throw new Error(`Invalid limit: ${limit}. lua-api caps logs at 100 entries per call.`);
    // Per the v10 lua-api audit: logs are at /developer/agents/:agentId/logs.
    // Iteration-13 audit: lua-api expects `primitiveType` and `primitiveName`
    // query params (verified against developer/base.controller.ts:198-214);
    // sending `type`/`name` was silently ignored, returning unfiltered logs.
    // `type === 'all'` is the MCP-side sentinel meaning "no filter" — drop it.
    const query = { limit };
    if (type !== 'all') query.primitiveType = type;
    if (name) query.primitiveName = name;
    const data = await apiRequest(
      `/developer/agents/${encodeURIComponent(agentId)}/logs`,
      { query, fetchFn: deps.fetchFn }
    );
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
};

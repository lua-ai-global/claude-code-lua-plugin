import { apiRequest } from '../api-client.mjs';

// The `logSource` enum lua-api accepts — AGENT_LOG_SOURCES in
// packages/shared-types/src/vm-execution-log.types.ts (the single source of
// truth every service imports). `all` is the MCP-side sentinel for "no
// filter". Note: `lua logs --type` accepts a narrower list and no `mastra`.
export const LOG_SOURCES = [
  'skill', 'job', 'webhook', 'trigger', 'preprocessor', 'postprocessor',
  'user_message', 'agent_response', 'agent_error', 'runtime', 'mcp', 'rag',
  'device', 'device-trigger', 'model-resolver',
  'workflow-step', 'workflow-script', 'workflow',
];

// The `logType` query param — GET /developer/agents/:agentId/logs reads it
// (controllers/developer/base.controller.ts) and developer.service.ts
// getAgentLogs applies it verbatim as `filter.subType = logType`. The
// accepted values are therefore the VmExecutionLog `subType` enum in
// packages/shared-schemas/src/vmExecutionLogs.schema.ts:
//   enum: ['start', 'complete', 'error', 'debug', 'warn', 'info']
// (mirrored by lua-cli's LogEntry.subType in src/interfaces/logs.ts). Any
// other string is not rejected server-side — it simply matches nothing.
export const LOG_TYPES = ['error', 'warn', 'info', 'debug', 'start', 'complete'];

const VALID_TYPES = new Set(['all', ...LOG_SOURCES]);
const VALID_LOG_TYPES = new Set(LOG_TYPES);

export const tailLogs = {
  spec: {
    name: 'tail_logs',
    description: 'Fetch recent execution logs for an agent (same data as `lua logs --json`). Returns { logs: LogEntry[], pagination }. Each LogEntry has `subType` (error | warn | info | debug | start | complete), `message`, `timestamp`, and `metadata.logSource` / `metadata.primitiveName` — there is NO `level` field. Filter by source (`type`), primitive (`name`) and/or severity (`logType`, which filters on `subType`).',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        type: {
          type: 'string',
          enum: [...VALID_TYPES],
          default: 'all',
          description: 'Log source filter (maps to lua-api `logSource`). `all` = no filter.',
        },
        name: { type: 'string', description: 'Filter by primitive name (optional; maps to `primitiveName`)' },
        logType: {
          type: 'string',
          enum: LOG_TYPES,
          description: 'Filter by LogEntry `subType` (optional; maps to lua-api `logType`). Omit for every severity. e.g. `error` to see only failures.',
        },
        // lua-api caps limit at 100 server-side (Math.min(100, ...) in
        // controllers/developer/base.controller.ts). Match the server cap so
        // the tool's contract is honest.
        limit: { type: 'number', default: 50, minimum: 1, maximum: 100 },
        page: { type: 'number', minimum: 1, description: 'Page number for pagination (optional)' },
      },
      required: ['agentId'],
    },
  },
  async handler({ agentId, type = 'all', name, logType, limit = 50, page }, deps = {}) {
    if (!agentId) throw new Error('agentId is required');
    if (!VALID_TYPES.has(type)) throw new Error(`Invalid type: ${type}. Valid: ${[...VALID_TYPES].join(', ')}`);
    if (logType !== undefined && !VALID_LOG_TYPES.has(logType)) {
      throw new Error(`Invalid logType: ${logType}. Valid: ${LOG_TYPES.join(', ')}`);
    }
    // Defensive cap matching the server-side limit; rejects loud rather
    // than silently truncating.
    if (limit > 100) throw new Error(`Invalid limit: ${limit}. lua-api caps logs at 100 entries per call.`);
    // Route: GET /developer/agents/:agentId/logs (controllers/developer/base.controller.ts).
    // Query params the server reads: page, limit, sortBy, sortOrder, logSource,
    // primitiveId, primitiveName, toolId, toolName, logType, userId. The
    // type filter is `logSource` — a `primitiveType` param is silently ignored.
    const query = { limit };
    if (type !== 'all') query.logSource = type;
    if (name) query.primitiveName = name;
    if (logType) query.logType = logType;
    if (page) query.page = page;
    const data = await apiRequest(
      `/developer/agents/${encodeURIComponent(agentId)}/logs`,
      { query, fetchFn: deps.fetchFn }
    );
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
};

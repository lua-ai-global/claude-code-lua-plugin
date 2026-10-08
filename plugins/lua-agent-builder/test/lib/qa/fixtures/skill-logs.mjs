// Synthetic `lua logs --type skill --json` rows, shaped like the rows lua-cli returns (verified in a live sandbox
// trial): { timestamp, subType, message, metadata: { toolName, toolId, primitiveName, environment, executionId,
// executionSeq, userId, agentId, channel } }. No real ids, users or addresses.

export const AGENT = 'agent_test_0001';

let seq = 0;
/** One log row. `t` is an ISO timestamp; `exec` the executionId. */
export function logRow(t, message, { exec = 'exec_1', tool = 'cancel_order', skill = 'orders', subType = 'debug', env = 'sandbox', agentId = AGENT, extra = {} } = {}) {
  seq += 1;
  return {
    timestamp: t,
    subType,
    message,
    metadata: {
      logSource: 'skill', toolName: tool, toolId: `tool_${tool}`, primitiveName: skill, environment: env,
      executionId: exec, executionSeq: seq, userId: 'user_test_0001', agentId, channel: 'dev', ...extra,
    },
  };
}

/** The four-ish rows one tool execution writes. */
export function execution(t0, { exec, tool = 'cancel_order', input = { orderId: '1042' }, result = { ok: true }, consoleLines = [], ...opts } = {}) {
  const at = (ms) => new Date(Date.parse(t0) + ms).toISOString();
  return [
    logRow(at(0), `Calling tool with input ${JSON.stringify(input)}`, { exec, tool, ...opts }),
    ...consoleLines.map(([subType, msg], i) => logRow(at(10 + i), msg, { exec, tool, subType, ...opts })),
    logRow(at(50), `Tool result ${JSON.stringify(result)}`, { exec, tool, ...opts }),
    logRow(at(60), 'Execute function completed in 0 ms', { exec, tool, ...opts }),
  ];
}

export const logsStdout = (rows, extra = {}) => JSON.stringify({ logs: rows, nextCursor: null, ...extra });

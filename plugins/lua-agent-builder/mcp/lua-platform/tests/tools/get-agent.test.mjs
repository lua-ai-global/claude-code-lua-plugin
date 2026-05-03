import { describe, test, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { getAgent } from '../../src/tools/get-agent.mjs';

function mockSpawnReturning(stdout, { exitCode = 0, stderr = '' } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};

    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('exit', exitCode);
    });

    return child;
  };
}

const FIXTURE_ORGS = [
  {
    id: 'org_acme',
    registeredName: 'Acme Corp',
    type: 'standard',
    agents: [
      { agentId: 'a1', name: 'agent-one' },
      { agentId: 'a2', name: 'agent-two' },
    ],
  },
  {
    id: 'org_solo',
    registeredName: 'Solo',
    type: 'personal',
    agents: [{ agentId: 'a3', name: 'agent-three' }],
  },
];

describe('getAgent tool', () => {
  test('spec is well-formed MCP schema', () => {
    expect(getAgent.spec.name).toBe('get_agent');
    expect(getAgent.spec.inputSchema.required).toEqual(['agentId']);
  });

  test('finds an agent by ID across orgs and returns compact shape', async () => {
    const spawnFn = mockSpawnReturning(JSON.stringify(FIXTURE_ORGS));
    const result = await getAgent.handler({ agentId: 'a2' }, { spawnFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      id: 'a2',
      name: 'agent-two',
      orgId: 'org_acme',
      orgName: 'Acme Corp',
    });
  });

  test('finds the agent in the second org', async () => {
    const spawnFn = mockSpawnReturning(JSON.stringify(FIXTURE_ORGS));
    const result = await getAgent.handler({ agentId: 'a3' }, { spawnFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('a3');
    expect(parsed.orgId).toBe('org_solo');
  });

  test('throws a discoverable error when the agent ID is unknown', async () => {
    const spawnFn = mockSpawnReturning(JSON.stringify(FIXTURE_ORGS));
    await expect(getAgent.handler({ agentId: 'nope' }, { spawnFn })).rejects.toThrow(/no agent with id "nope"/);
  });

  test('handles the legacy flat-array shape', async () => {
    const spawnFn = mockSpawnReturning(JSON.stringify([
      { agentId: 'a1', name: 'agent-one', orgId: 'org_x', orgName: 'X' },
    ]));
    const result = await getAgent.handler({ agentId: 'a1' }, { spawnFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ id: 'a1', name: 'agent-one', orgId: 'org_x', orgName: 'X' });
  });

  test('rejects when agentId is missing', async () => {
    await expect(getAgent.handler({}, { spawnFn: () => {} })).rejects.toThrow(/agentId is required/);
  });

  test('throws clear error on non-zero exit', async () => {
    const spawnFn = mockSpawnReturning('', { exitCode: 1, stderr: 'auth failed' });
    await expect(getAgent.handler({ agentId: 'a1' }, { spawnFn })).rejects.toThrow(/exited 1/);
  });

  test('throws clear error on malformed JSON', async () => {
    const spawnFn = mockSpawnReturning('not json at all');
    await expect(getAgent.handler({ agentId: 'a1' }, { spawnFn })).rejects.toThrow(/could not parse/);
  });
});

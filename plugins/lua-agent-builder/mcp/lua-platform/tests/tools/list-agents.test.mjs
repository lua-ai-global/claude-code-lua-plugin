import { describe, test, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { listAgents } from '../../src/tools/list-agents.mjs';

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

describe('listAgents tool', () => {
  test('spec is well-formed MCP schema', () => {
    expect(listAgents.spec.name).toBe('list_agents');
    expect(listAgents.spec.inputSchema.type).toBe('object');
  });

  test('flattens orgs-with-nested-agents shape (current 3.12.x behaviour)', async () => {
    // This is what `lua agents --json` actually emits — see
    // packages/lua-cli/src/commands/agents.ts: console.log(JSON.stringify(userData.admin.orgs))
    const spawnFn = mockSpawnReturning(JSON.stringify([
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
    ]));
    const result = await listAgents.handler({}, { spawnFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({
      id: 'a1', name: 'agent-one', orgId: 'org_acme', orgName: 'Acme Corp',
    });
    expect(parsed[2]).toEqual({
      id: 'a3', name: 'agent-three', orgId: 'org_solo', orgName: 'Solo',
    });
  });

  test('handles legacy flat-array shape (forward-compat)', async () => {
    const spawnFn = mockSpawnReturning(JSON.stringify([
      { agentId: 'a1', name: 'agent-one' },
      { agentId: 'a2', name: 'agent-two' },
    ]));
    const result = await listAgents.handler({}, { spawnFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('a1');
  });

  test('handles { agents: [...] } envelope shape (forward-compat)', async () => {
    const spawnFn = mockSpawnReturning(JSON.stringify({ agents: [{ agentId: 'a1', name: 'x' }] }));
    const result = await listAgents.handler({}, { spawnFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
  });

  test('handles org with empty agents array', async () => {
    const spawnFn = mockSpawnReturning(JSON.stringify([
      { id: 'org_empty', registeredName: 'Empty', agents: [] },
    ]));
    const result = await listAgents.handler({}, { spawnFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(0);
  });

  test('throws clear error on non-zero exit', async () => {
    const spawnFn = mockSpawnReturning('', { exitCode: 1, stderr: 'auth failed' });
    await expect(listAgents.handler({}, { spawnFn })).rejects.toThrow(/exited 1/);
  });

  test('throws clear error on malformed JSON', async () => {
    const spawnFn = mockSpawnReturning('not json at all');
    await expect(listAgents.handler({}, { spawnFn })).rejects.toThrow(/could not parse/);
  });
});

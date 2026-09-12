import { describe, test, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { listAgents } from '../../src/tools/list-agents.mjs';
import { flattenAgents } from '../../src/run-lua.mjs';

function mockSpawnReturning(stdout, { exitCode = 0, stderr = '' } = {}) {
  const spawnFn = (cmd, args, opts) => {
    spawnFn.calls.push({ cmd, args, opts });
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
  spawnFn.calls = [];
  return spawnFn;
}

// What `lua agents --json` emits in lua-cli ≥ 3.28 — CredentialOrganization[]
// (packages/lua-cli/src/services/credential-operational-context.ts).
const FIXTURE_ORGS = [
  {
    orgId: '0029538e-b3b1-4ff1-ad51-05081cd87f45',
    name: 'Acme Corp',
    archived: false,
    discoveredVia: 'org-grant',
    agents: [
      { agentId: 'baseAgent_agent_1', name: 'agent-one', visibility: 'private', displayRoles: [] },
      { agentId: 'baseAgent_agent_2', name: 'agent-two', visibility: 'public', displayRoles: [{ role: 'owner', boundTo: 'agent', resourceId: 'baseAgent_agent_2' }] },
    ],
  },
  {
    orgId: '026cc41b-e013-4474-9b65-5a15f8881f92',
    name: 'Solo',
    archived: false,
    discoveredVia: 'agent-grant',
    agents: [{ agentId: 'baseAgent_agent_3', name: 'agent-three', visibility: 'private', displayRoles: [] }],
  },
];

describe('listAgents tool', () => {
  test('spec is well-formed MCP schema', () => {
    expect(listAgents.spec.name).toBe('list_agents');
    expect(listAgents.spec.inputSchema.type).toBe('object');
  });

  test('invokes `lua agents --json --ci`', async () => {
    const spawnFn = mockSpawnReturning(JSON.stringify(FIXTURE_ORGS));
    await listAgents.handler({}, { spawnFn });
    expect(spawnFn.calls[0].cmd).toBe('lua');
    expect(spawnFn.calls[0].args).toEqual(['agents', '--json', '--ci']);
    expect(spawnFn.calls[0].opts.windowsHide).toBe(true);
    expect(spawnFn.calls[0].opts.env.LUA_NO_BANNER).toBe('1');
  });

  test('flattens the CredentialOrganization[] shape using orgId / name', async () => {
    const spawnFn = mockSpawnReturning(JSON.stringify(FIXTURE_ORGS));
    const result = await listAgents.handler({}, { spawnFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({
      id: 'baseAgent_agent_1', name: 'agent-one',
      orgId: '0029538e-b3b1-4ff1-ad51-05081cd87f45', orgName: 'Acme Corp', visibility: 'private',
    });
    expect(parsed[2]).toEqual({
      id: 'baseAgent_agent_3', name: 'agent-three',
      orgId: '026cc41b-e013-4474-9b65-5a15f8881f92', orgName: 'Solo', visibility: 'private',
    });
  });

  test('flattenAgents tolerates the pre-3.28 org shape (id / registeredName)', () => {
    const parsed = flattenAgents([
      { id: 'org_acme', registeredName: 'Acme Corp', agents: [{ agentId: 'a1', name: 'agent-one' }] },
    ]);
    expect(parsed).toEqual([{ id: 'a1', name: 'agent-one', orgId: 'org_acme', orgName: 'Acme Corp', visibility: null }]);
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
      { orgId: 'org_empty', name: 'Empty', archived: false, discoveredVia: 'org-grant', agents: [] },
    ]));
    const result = await listAgents.handler({}, { spawnFn });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(0);
  });

  test('throws clear error on non-zero exit', async () => {
    const spawnFn = mockSpawnReturning('', { exitCode: 9, stderr: '✖ auth: No Lua CLI authentication found.' });
    await expect(listAgents.handler({}, { spawnFn })).rejects.toThrow(/exited 9.*No Lua CLI authentication/);
  });

  test('throws clear error on malformed JSON', async () => {
    const spawnFn = mockSpawnReturning('not json at all');
    await expect(listAgents.handler({}, { spawnFn })).rejects.toThrow(/could not parse/);
  });
});

// EM-WS8: dist/server.js must run with NO node_modules anywhere above it.
//
// Marketplace installs copy the plugin verbatim — no `npm ci` runs — and the
// Lua Job tier bakes the plugin into an image the same way. Until 1.6.0 the
// bundle left `@modelcontextprotocol/sdk` external, so the server died with
// ERR_MODULE_NOT_FOUND on every such install (Claude Code reported it as
// `lua-platform CONNECTION_CLOSED`).
//
// The test copies the bundle into a fresh temp directory before spawning it.
// Spawning it in place would pass vacuously: Node resolves a bare import by
// walking up the parent directories, and CI has just run `npm ci` in
// mcp/lua-platform/, so the SDK would be found in ../node_modules.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, '..');
const DIST = join(PKG_DIR, 'dist', 'server.js');
const PKG_VERSION = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version;

const EXPECTED_TOOLS = [
  'get_agent',
  'get_deployment_status',
  'list_agents',
  'list_primitive_versions',
  'tail_logs',
];

/** True if any directory from `dir` up to the filesystem root has a node_modules. */
function nodeModulesAbove(dir) {
  let cur = dir;
  const { root } = parse(cur);
  for (;;) {
    if (existsSync(join(cur, 'node_modules'))) return cur;
    if (cur === root) return null;
    cur = dirname(cur);
  }
}

/**
 * Spawn `node <file>` with a scrubbed environment, send newline-delimited
 * JSON-RPC requests, and resolve with every response keyed by id once the
 * responses for all `waitFor` ids arrived (or reject on exit/timeout).
 */
function rpcSession(file, cwd, messages, waitFor) {
  return new Promise((resolveP, reject) => {
    const env = { ...process.env, LUA_API_KEY: 'test', LUA_CREDENTIALS_PATH: '/nonexistent' };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [file], { cwd, env, shell: false, windowsHide: true });
    const responses = new Map();
    let buf = '';
    let stderr = '';
    const finish = (err) => {
      clearTimeout(timer);
      child.kill();
      if (err) reject(err); else resolveP(responses);
    };
    const timer = setTimeout(
      () => finish(new Error(`timed out; got ids ${[...responses.keys()]}; stderr=${stderr}`)),
      10_000,
    );
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
      }
      if (waitFor.every((id) => responses.has(id))) finish();
    });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('exit', (code) => finish(new Error(`server exited ${code} before replying: ${stderr}`)));
    child.on('error', finish);
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  });
}

describe('dist/server.js runs standalone (no node_modules)', () => {
  let tmp;
  let copied;

  beforeAll(() => {
    // Mirror the shipped layout: package.json (its `"type": "module"` makes
    // Node 18/20 load dist/server.js as ESM) next to dist/server.js — and
    // nothing else, in particular no node_modules.
    tmp = mkdtempSync(join(tmpdir(), 'lua-mcp-standalone-'));
    mkdirSync(join(tmp, 'dist'));
    copyFileSync(join(PKG_DIR, 'package.json'), join(tmp, 'package.json'));
    copied = join(tmp, 'dist', 'server.js');
    copyFileSync(DIST, copied);
  });
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  test('the isolation is real: no node_modules above the copied bundle', () => {
    expect(nodeModulesAbove(tmp)).toBeNull();
  });

  test('initialize + tools/list answer with the five read-only tools', async () => {
    const responses = await rpcSession(copied, tmp, [
      {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'standalone-test', version: '0.0.0' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ], [1, 2]);

    const init = responses.get(1);
    expect(init.error).toBeUndefined();
    expect(init.result.serverInfo.name).toBe('lua-platform');
    // Catches a version bump that forgot to rebuild dist/.
    expect(init.result.serverInfo.version).toBe(PKG_VERSION);

    const list = responses.get(2);
    expect(list.error).toBeUndefined();
    expect(list.result.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });
});

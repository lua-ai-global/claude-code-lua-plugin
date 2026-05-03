// Verifies the MCP server's crash handlers actually flush their stderr
// payload before process.exit fires. The Windows-flush bug (iteration-6
// audit, 2026-05-02): write() then immediate exit() can lose the message.
//
// Strategy: spawn a wrapper that imports server.mjs then synthesises a
// crash. Capture stderr. Assert the crash event JSON arrived intact.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, '..', 'src', 'server.mjs');

function spawnAndCapture(args) {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, LUA_API_KEY: 'test', LUA_CREDENTIALS_PATH: '/nonexistent' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out: stdout=${stdout} stderr=${stderr}`));
    }, 5000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveP({ exitCode: code, stdout, stderr });
    });
    child.on('error', reject);
    child.stdin.end();
  });
}

function makeWrapper(tmpDir, payload) {
  const wrapper = join(tmpDir, 'wrapper.mjs');
  writeFileSync(wrapper, payload);
  return wrapper;
}

describe('MCP server crash reporting flushes before exit', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'crash-test-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test('uncaughtException emits the crash event JSON before exit', async () => {
    const wrapper = makeWrapper(tmpDir, [
      `await import(${JSON.stringify(SERVER_PATH)});`,
      `setTimeout(() => { throw new Error('synthetic crash for test'); }, 50);`,
    ].join('\n'));

    const result = await spawnAndCapture([wrapper]);

    expect(result.exitCode).toBe(1);
    const lines = result.stderr.split('\n').filter(Boolean);
    const crashLine = lines.find((l) => l.includes('mcp_server_crash'));
    expect(crashLine).toBeDefined();
    const event = JSON.parse(crashLine);
    expect(event.event).toBe('mcp_server_crash');
    expect(event.kind).toBe('uncaughtException');
    expect(event.message).toContain('synthetic crash for test');
    expect(event.platform).toBe(process.platform);
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('unhandledRejection emits the crash event JSON before exit', async () => {
    const wrapper = makeWrapper(tmpDir, [
      `await import(${JSON.stringify(SERVER_PATH)});`,
      `setTimeout(() => { Promise.reject(new Error('synthetic rejection')); }, 50);`,
    ].join('\n'));

    const result = await spawnAndCapture([wrapper]);

    expect(result.exitCode).toBe(1);
    const lines = result.stderr.split('\n').filter(Boolean);
    const crashLine = lines.find((l) => l.includes('mcp_server_crash'));
    expect(crashLine).toBeDefined();
    const event = JSON.parse(crashLine);
    expect(event.event).toBe('mcp_server_crash');
    expect(event.kind).toBe('unhandledRejection');
    expect(event.reason).toContain('synthetic rejection');
  });
});

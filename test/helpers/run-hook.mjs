// Per tech spec §18.1.
// Spawns a hook script in a real child process with a JSON payload on stdin.
// Used for integration smoke tests verifying the script-entry wiring (the
// `if (isMainScript) { runHook(...) }` block at the bottom of every hook).
// Unit-coverage of decide() is via direct import — see §17.1.1.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const HOOKS_DIR = join(PLUGIN_ROOT, 'hooks');

/**
 * @param {string} hookName - filename in hooks/ (e.g. 'confirm-deploy.mjs')
 * @param {object|null} input - JSON payload to send on stdin
 * @param {{timeoutMs?: number, env?: object}} [opts]
 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string}>}
 */
export async function runHook(hookName, input, { timeoutMs = 5_000, env = {} } = {}) {
  const hookPath = join(HOOKS_DIR, hookName);
  const nodePath = process.execPath;   // Absolute Node binary — Windows-safe (§18.1)

  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [hookPath], {
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...env },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Hook ${hookName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });

    child.on('error', reject);

    if (input !== null && input !== undefined) {
      child.stdin.write(JSON.stringify(input));
    }
    child.stdin.end();
  });
}

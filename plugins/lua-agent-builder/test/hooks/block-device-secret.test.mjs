import { describe, expect, test } from '@jest/globals';
import { decide } from '../../hooks/block-device-secret.mjs';
import { runHook } from '../helpers/run-hook.mjs';

describe('block-device-secret decide()', () => {
  test.each([
    'lua devices credential --ci --device-name pico-sensor',
    'lua devices credential --device-name pico --operations commands,triggers',
    'lua devices credentials --ci --device-name pico',
    'lua devices key --ci --device-name pico',
    'lua devices CREDENTIAL --ci --device-name pico',
    'lua --ci devices credential --device-name pico',
    'cd agent && lua devices credential --ci --device-name pico',
    '/usr/local/bin/lua devices credential --device-name pico',
    'heylua devices credential --device-name pico',
    'lua-ai devices credential --device-name pico',
    'lua devices credential --ci --device-name pico --out',
    'lua devices credential --ci --device-name pico --out --force',
    'lua devices credential --ci --device-name pico | tee out.txt',
    'bash -c "lua devices credential --device-name pico"',
    // An out target that is the terminal again.
    'lua devices credential --ci --device-name pico --out /dev/stdout --force',
    'lua devices credential --ci --device-name pico --out=/dev/fd/1',
    'lua devices credential --ci --device-name pico --out /dev/tty',
    'lua devices credential --ci --device-name pico --out "/proc/self/fd/1"',
    // F011: lua-cli by package name or entry file, not only the `lua` binary.
    'npx lua-cli devices credential --device-name pico',
    'npx -y lua-cli@3.53.0 devices --operations commands credential --device-name pico',
    'node node_modules/lua-cli/dist/index.js devices --operations commands credential',
    'node "/usr/lib/node_modules/lua-cli/dist/index.js" devices key --device-name pico',
  ])('blocks %s', (command) => {
    const result = decide({ tool_input: { command } });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('DEVICE_SECRET_DENIED');
    expect(result?.reason).toContain('--out');
  });

  test.each([
    'lua devices credential --ci --device-name pico --out .env.device',
    'lua devices credential --ci --device-name pico --operations commands --out=.env.device.pico',
    'lua devices credential --ci --device-name pico --out .env.device --force',
    "lua devices credential --ci --device-name pico --out '.env.device.pico'",
    'lua devices credential --ci --device-name pico --out ./device/dev/.env.device',
    'lua devices credential --help',
    'lua devices credential -h',
    'lua devices status --ci --device-name pico',
    'lua devices test --ci --device-name keypad --command read_key',
    'lua devices list --ci',
    'lua auth key --force',
    'npx lua-cli devices credential --device-name pico --out .env.device',
    'node node_modules/lua-cli/dist/index.js devices list',
    'npm install lua-cli && echo devices key',
    'git commit -m "document lua devices"',
    'echo key',
  ])('allows %s', (command) => {
    expect(decide({ tool_input: { command } })).toBeNull();
  });

  test('allows missing input', () => {
    expect(decide(null)).toBeNull();
    expect(decide({})).toBeNull();
  });

  test('points at /lua-devices interactively, at no slash command headless', () => {
    const input = { tool_input: { command: 'lua devices credential --ci --device-name pico' } };
    expect(decide(input, {}).reason).toContain('/lua-devices');
    const headless = decide(input, { LUA_PLUGIN_HEADLESS: '1' });
    expect(headless.block).toBe(true);
    expect(headless.reason).toContain('DEVICE_SECRET_DENIED');
    expect(headless.reason).not.toMatch(/\/lua-/);
  });
});

describe('block-device-secret in a live build session', () => {
  const SESSIONS = [{ LUA_BUILD_SESSION: '1' }, { LUA_BUILD_SESSION: '1', LUA_PLUGIN_HEADLESS: '1' }];

  // Every credential spelling lua-cli accepts (`credentials` / `key` aliases, any case), with and without a real
  // `--out` file: in a session the value must never land in the pod, so `--out` is no exemption.
  test.each([
    'lua devices credential thermo',
    'lua devices credential thermo --out .dev.env',
    'lua devices credentials thermo --out .dev.env',
    'lua devices key thermo --out .dev.env',
    'lua devices CREDENTIAL thermo --out .dev.env',
    'lua devices Key thermo --out=.dev.env',
    "lua devices credentials --ci --device-name pico --out '.env.device.pico'",
    'cd agent && lua devices key --ci --device-name pico --out ./device/.env.device',
    // F011: `--operations <list>` before the verb, and lua-cli run by package name or entry file.
    'lua devices --operations commands credential',
    'npx lua-cli devices --operations commands credential',
    'npx lua-cli devices --operations commands credential d1 --out .dev.env',
    'node node_modules/lua-cli/dist/index.js devices --operations commands credential',
  ])('blocks %s', (command) => {
    for (const env of SESSIONS) {
      const result = decide({ tool_input: { command } }, env);
      expect([command, result?.block]).toEqual([command, true]);
      expect(result.reason).toContain('Lua Desktop');
    }
  });

  test('help stays allowed by this hook (session-guard owns the session help answer)', () => {
    for (const env of SESSIONS) expect(decide({ tool_input: { command: 'lua devices key --help' } }, env)).toBeNull();
  });

  test('flags off: the --out form is still allowed exactly as before', () => {
    for (const env of [{}, { LUA_BUILD_SESSION: '0' }, { LUA_BUILD_SESSION: '' }, { LUA_PLUGIN_HEADLESS: '1' }]) {
      for (const command of [
        'lua devices credential thermo --out .dev.env',
        'lua devices credentials thermo --out .dev.env',
        'lua devices key thermo --out .dev.env',
        'lua devices CREDENTIAL thermo --out .dev.env',
      ]) {
        expect([command, decide({ tool_input: { command } }, env)]).toEqual([command, null]);
      }
    }
  });

  test('as a spawned hook: exits 2 for the --out form in a session', async () => {
    const r = await runHook(
      'block-device-secret.mjs',
      { tool_name: 'Bash', tool_input: { command: 'lua devices key thermo --out .dev.env' } },
      { env: { LUA_BUILD_SESSION: '1', LUA_PLUGIN_HEADLESS: '1' } }
    );
    expect(r.exitCode).toBe(2);
  });
});

describe('block-device-secret as a spawned hook', () => {
  test('exits 2 with the reason on stderr for the printing form', async () => {
    const r = await runHook('block-device-secret.mjs', {
      tool_name: 'Bash',
      tool_input: { command: 'lua devices credential --ci --device-name pico' },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('DEVICE_SECRET_DENIED');
  });

  test('exits 0 for the --out form', async () => {
    const r = await runHook('block-device-secret.mjs', {
      tool_name: 'Bash',
      tool_input: { command: 'lua devices credential --ci --device-name pico --out .env.device' },
    });
    expect(r.exitCode).toBe(0);
  });
});

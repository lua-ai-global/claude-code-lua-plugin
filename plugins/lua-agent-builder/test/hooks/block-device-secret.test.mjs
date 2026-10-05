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

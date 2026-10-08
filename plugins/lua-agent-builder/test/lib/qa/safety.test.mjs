import { jest } from '@jest/globals';
import {
  ENV_ALLOWLIST, assertAllowedLuaArgv, checkTestData, credentialRisk, redactDeep, redactSecrets, scrubEnv, shellQuote,
} from '../../../lib/qa/safety.mjs';
import { PRODUCTION_COMMANDS } from '../../../lib/tokenizer.mjs';

const THREAD = 'qa-9f3c-icp-03-r2-1a2b3c';

describe('scrubEnv', () => {
  test('keeps every allow-listed key and nothing else', () => {
    const env = {};
    for (const k of ENV_ALLOWLIST) env[k] = `v-${k}`;
    env.HTTPS_PROXY = 'http://proxy.example.net:8080';
    env.HTTP_PROXY = 'http://proxy.example.net:8080';
    env.https_proxy = 'http://proxy.example.net:8080';
    env.http_proxy = 'http://proxy.example.net:8080';
    const out = scrubEnv(env);
    expect(Object.keys(out).sort()).toEqual([...ENV_ALLOWLIST].sort());
  });

  test('drops LUA_API_KEY and arbitrary secrets', () => {
    const out = scrubEnv({ PATH: '/bin', LUA_API_KEY: 'api_x', SECRET_X: 'shh', OPENAI_API_KEY: 'k', STRIPE_KEY: 's' });
    expect(out).toEqual({ PATH: '/bin' });
  });

  test('drops a proxy URL with userinfo, keeps one without', () => {
    expect(scrubEnv({ HTTPS_PROXY: 'http://user:pw@proxy.example.net:8080' })).toEqual({});
    expect(scrubEnv({ http_proxy: 'user:pw@proxy.example.net:8080' })).toEqual({});
    expect(scrubEnv({ HTTPS_PROXY: 'http://proxy.example.net:8080' })).toEqual({ HTTPS_PROXY: 'http://proxy.example.net:8080' });
    expect(scrubEnv({ HTTPS_PROXY: 'proxy.example.net:8080' })).toEqual({ HTTPS_PROXY: 'proxy.example.net:8080' });
  });

  test('ignores non-string values and a missing env', () => {
    expect(scrubEnv({ PATH: 5 })).toEqual({});
    expect(scrubEnv()).toEqual({});
  });
});

describe('credentialRisk', () => {
  test('env-only credential is the risk', () => {
    const r = credentialRisk({ credentialSource: 'env', dotenvKeys: [] });
    expect(r.envOnly).toBe(true);
    expect(r.warnings[0]).toMatch(/scrubbed/);
  });
  test('env plus a stored credential is fine', () => {
    expect(credentialRisk({ credentialSource: 'env', hasStoredCredential: true }).envOnly).toBe(false);
    expect(credentialRisk({ credentialSource: 'session' }).envOnly).toBe(false);
  });
  test('.env contents are reported as key names only', () => {
    const r = credentialRisk({ credentialSource: 'session', dotenvKeys: ['LUA_API_KEY', 'OPENAI_API_KEY'] });
    expect(r.warnings.join(' ')).toMatch(/LUA_API_KEY/);
    expect(r.warnings.join(' ')).toMatch(/OPENAI_API_KEY/);
  });
  test('defaults', () => {
    expect(credentialRisk()).toEqual({ envOnly: false, warnings: [] });
  });
});

describe('checkTestData', () => {
  test('example addresses pass', () => {
    expect(checkTestData('write to dana@example.com, a@example.org, b@example.net, c@team.example').ok).toBe(true);
  });
  test('a real address is a violation', () => {
    const r = checkTestData('mail dana@gmail.com please');
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([{ kind: 'email', value: 'dana@gmail.com', reason: 'not an example.* domain or an agreed email domain' }]);
  });
  test('example.com lookalike domains are violations', () => {
    expect(checkTestData('a@example.com.evil.test').ok).toBe(false);
    expect(checkTestData('a@notexample.com').ok).toBe(false);
  });
  test('URLs: example hosts and subdomains pass, others fail unless allowed', () => {
    expect(checkTestData('see https://example.com/x and http://shop.example.org').ok).toBe(true);
    const r = checkTestData('see https://evil.test/x');
    expect(r.violations).toEqual([{ kind: 'url', value: 'https://evil.test' }]);
    expect(checkTestData('see https://docs.acme.test/x', { allowedDomains: ['acme.test'] }).ok).toBe(true);
    expect(checkTestData('see https://acme.test/x', { allowedDomains: ['acme.test'] }).ok).toBe(true);
    expect(checkTestData('see https://other.test/x', { allowedDomains: ['acme.test'] }).ok).toBe(false);
  });
  test('phone numbers only warn, and the drama ranges are silent', () => {
    expect(checkTestData('call 07700 900123').warnings).toEqual([]);
    expect(checkTestData('call +44 7700 900123').warnings).toEqual([]);
    expect(checkTestData('call 555-0123').warnings).toEqual([]);
    const r = checkTestData('call 020 7946 0958 now');
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([{ kind: 'phone', value: '020 7946 0958' }]);
  });
  test('order numbers and long ids are not phone-shaped', () => {
    expect(checkTestData('order 1042 tracking 1234567890123456').warnings).toEqual([]);
    expect(checkTestData('ref 0123456789').warnings).toEqual([]);
    expect(checkTestData('on 2026-10-07 at 14:15').warnings).toEqual([]);
    expect(checkTestData('digits 123 456 7890').warnings).toEqual([]);
  });
  test('non-strings are stringified; empty is ok', () => {
    expect(checkTestData({ a: 'x@gmail.com' }).ok).toBe(false);
    expect(checkTestData(undefined).ok).toBe(true);
  });
});

describe('redactSecrets / redactDeep', () => {
  const cases = [
    ['stripe-key', 'key sk_live_51Hf00fakefakefake here'],
    ['lua-key', 'api_123e4567-e89b-12d3-a456-426614174000.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG end'],
    ['jwt', 'tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk end'],
    ['aws-key', 'AKIAABCDEFGHIJKLMNOP'],
    ['github-token', `ghp_${'a'.repeat(36)}`],
    ['slack-token', 'xoxb-1234567890-abcdefghij'],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'],
    ['bearer', `Authorization: Bearer ${'a'.repeat(30)}`],
    ['password-assign', 'my password: hunter2'],
  ];
  test.each(cases)('redacts %s', (kind, text) => {
    const r = redactSecrets(text);
    expect(r.redactions.map((x) => x.kind)).toContain(kind);
    expect(r.text).toContain(`[REDACTED:${kind}]`);
  });
  test('plain text passes untouched; non-strings are safe', () => {
    expect(redactSecrets('hello there')).toEqual({ text: 'hello there', redactions: [] });
    expect(redactSecrets('')).toEqual({ text: '', redactions: [] });
    expect(redactSecrets(null)).toEqual({ text: '', redactions: [] });
  });
  test('redactDeep walks objects and arrays and leaves other values', () => {
    const out = redactDeep({ a: ['x sk_test_abcdefghijk'], n: 3, b: { c: 'password=abc' }, z: null });
    expect(out.a[0]).toBe('x [REDACTED:stripe-key]');
    expect(out.b.c).toBe('[REDACTED:password-assign]');
    expect(out.n).toBe(3);
    expect(out.z).toBeNull();
  });
});

describe('shellQuote', () => {
  test('quotes only what needs it', () => {
    expect(shellQuote(['chat', '--ci', 'a b', "it's"])).toBe(`chat --ci 'a b' 'it'\\''s'`);
  });
});

describe('assertAllowedLuaArgv: accepted shapes', () => {
  const ok = [
    ['--version'],
    ['compile', '--ci'],
    ['status', '--json', '--ci'],
    ['version', 'list', '--json', '--ci'],
    ['version', 'list', '--json', '--ci', '--all'],
    ['workflows', 'list', '--json', '--ci'],
    ['workflows', 'list', '--json', '--ci', '--all'],
    ['workflows', 'view', 'refund-flow', '--json', '--ci'],
    ['chat', '--ci', '-e', 'sandbox', '-m', 'hello', '-t', THREAD],
    ['chat', '--ci', '-e', 'production', '-m', 'hello', '-t', THREAD],
    ['chat', '--ci', '-e', 'sandbox', '-m', 'please lua deploy now', '-t', THREAD],
    ['chat', '--ci', '-e', 'sandbox', '-m', 'lua version promote 3; lua push all', '-t', THREAD],
    ['chat', '--ci', '-e', 'sandbox', '-b', 'one', 'two', 'three', '-d', '100', '-t', THREAD],
    ['chat', '--ci', '--agent-version', '3', '-m', 'hi', '-t', THREAD],
    ['chat', '--ci', '--agent-version', '3', '--test-session', '-m', 'hi', '-t', THREAD],
    ['chat', 'clear', '-t', THREAD, '--force'],
    ['test', '--ci', 'skill', '--name', 'get_order', '--input', '{"id":1}', '--json'],
    ['test', '--ci', 'webhook', '--name', 'hook', '--input', '{}', '--json'],
    ['test', '--ci', 'workflow', '--name', 'wf', '--input', '{}', '--agents', 'fake', '--fast-retries', '--json'],
    ['test', '--ci', 'workflow', '--name', 'wf', '--input', '{}', '--agents', 'fake', '--fast-retries', '--json',
      '--step-output', 'classify={"a":1}', '--approve', 'a1', '--deny', 'a2', '--signal', 'go={"x":true}'],
    ['logs', '--ci', '--type', 'all', '--since', '2026-10-07T14:00:00.000Z', '--until', '2026-10-07T14:30:00.000Z', '--environment', 'sandbox', '--limit', '100', '--json'],
    ['logs', '--ci', '--type', 'skill', '--since', '2026-10-07T14:00:00.000Z', '--until', '2026-10-07T14:30:00.000Z', '--environment', 'production', '--limit', '200', '--json'],
  ];
  test.each(ok.map((a) => [a.slice(0, 4).join(' '), a]))('%s', (_label, argv) => {
    expect(() => assertAllowedLuaArgv(argv)).not.toThrow();
  });
});

describe('assertAllowedLuaArgv: denied', () => {
  const denied = [
    ['deploy'], ['push', 'all'], ['promote'], ['activate'], ['sync', '--check'], ['env', 'sandbox', '--list'], ['auth', 'configure'],
    ['pull'], ['publish'], ['apply'], ['skills', 'deploy'], ['version', 'promote', '3'], ['workflows', 'deploy'],
    ['marketplace', 'template', 'publish'],
    ['compile', '--ci', '--sync'],
    ['chat', '--ci', '-e', 'sandbox', '-m', 'hi'],
    ['chat', '--ci', '-e', 'staging', '-m', 'hi', '-t', THREAD],
    ['chat', '--ci', '-e', 'sandbox', '-m', 'hi', '-t', 'not-qa-thread'],
    ['chat', '--ci', '-e', 'sandbox', '-m', '', '-t', THREAD],
    ['chat', '--ci', '-e', 'sandbox', '-m', 'hi', '-t', THREAD, '--clear'],
    ['chat', 'clear', '-t', 'other', '--force'],
    ['chat', 'clear', '--force'],
    ['chat', '--ci', '-e', 'sandbox', '-b', '-d', '100', '-t', THREAD],
    ['chat', '--ci', '-e', 'sandbox', '-b', 'a', '-d', 'x', '-t', THREAD],
    ['chat', '--ci', '-e', 'sandbox', '-b', '-bad', '-d', '10', '-t', THREAD],
    ['chat', '--ci', '--agent-version', 'x', '-m', 'hi', '-t', THREAD],
    ['chat', '--ci', '-e', 'sandbox', '-x', 'hi', '-t', THREAD],
    ['chat', '--ci', '-q'],
    ['chat', '--ci', '-e', 'sandbox', '-m', 'hi', '-t', THREAD, '--auto-deploy'],
    ['test', '--ci', 'skill', '--name', 'x', '--input', 'not json', '--json'],
    ['test', '--ci', 'mcp', '--name', 'x', '--input', '{}', '--json'],
    ['test', '--ci', 'workflow', '--name', 'wf', '--input', '{}', '--agents', 'real', '--fast-retries', '--json'],
    ['test', '--ci', 'workflow', '--name', 'wf', '--input', '{}', '--agents', 'fake', '--fast-retries', '--json', '--approve'],
    ['test', '--ci', 'workflow', '--name', 'wf', '--input', '{}', '--agents', 'fake', '--fast-retries', '--json', '--bogus', 'x'],
    ['test', '--ci', 'workflow', '--name', 'wf', '--input', '{}', '--agents', 'fake', '--fast-retries', '--json', '--signal', 'nojson'],
    ['test', '--ci', 'workflow', '--name', 'wf', '--input', '{}', '--agents', 'fake', '--fast-retries', '--json', '--approve', 'bad id'],
    ['workflows', 'view', '../x', '--json', '--ci'],
    ['logs', '--ci', '--type', 'all', '--since', 'yesterday', '--until', '2026-10-07T14:30:00Z', '--environment', 'sandbox', '--limit', '100', '--json'],
    ['logs', '--ci', '--type', 'skill', '--since', '2026-10-07T14:00:00Z', '--until', '2026-10-07T14:30:00Z', '--environment', 'sandbox', '--limit', '100', '--json'],
    ['logs', '--ci', '--type', 'all', '--since', '2026-10-07T14:00:00Z', '--until', '2026-10-07T14:30:00Z', '--environment', 'sandbox', '--limit', '200', '--json'],
    ['logs', '--ci', '--type', 'job', '--since', '2026-10-07T14:00:00Z', '--until', '2026-10-07T14:30:00Z', '--environment', 'sandbox', '--limit', '200', '--json'],
    ['unknown'],
  ];
  test.each(denied.map((a) => [a.join(' ').slice(0, 60), a]))('%s', (_label, argv) => {
    expect(() => assertAllowedLuaArgv(argv)).toThrow(expect.objectContaining({ code: 'LUA_ARGV_DENIED', exitCode: 3 }));
  });

  test('non-array and non-string argv', () => {
    expect(() => assertAllowedLuaArgv('deploy')).toThrow(/non-empty array/);
    expect(() => assertAllowedLuaArgv([])).toThrow(/non-empty array/);
    expect(() => assertAllowedLuaArgv(['status', 5])).toThrow(/non-empty array/);
  });

  test('the second line of defence: the classifier verdict refuses a gated verb that slipped past the shapes', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../../../lib/tokenizer.mjs', () => ({ classifyProductionCommand: () => ({ label: 'lua deploy', slash: '/lua-deploy', prefixed: false }) }));
    const mod = await import('../../../lib/qa/safety.mjs');
    expect(() => mod.assertAllowedLuaArgv(['status', '--json', '--ci'])).toThrow(/classified as lua deploy/);
    jest.resetModules();
  });

  test('every production verb the confirm-deploy hook knows is rejected', () => {
    for (const rule of PRODUCTION_COMMANDS) {
      const argv = rule.label.replace(/^lua /, '').split(' ');
      expect(() => assertAllowedLuaArgv(argv)).toThrow(expect.objectContaining({ code: 'LUA_ARGV_DENIED' }));
    }
  });
});

import { describe, test, expect } from '@jest/globals';
import {
  isPrefixedDeploy,
  hasAutoDeploy,
  classifyProductionCommand,
  PRODUCTION_COMMANDS,
} from '../../lib/tokenizer.mjs';

describe('isPrefixedDeploy', () => {
  test.each([
    ['LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --name foo', true],
    ['env LUA_DEPLOY_CONFIRMED=1 lua deploy webhook', true],
    ['  LUA_DEPLOY_CONFIRMED=1 lua deploy job', true],
    ['\tLUA_DEPLOY_CONFIRMED=1 lua deploy all --force', true],
    ['LUA_DEPLOY_CONFIRMED=1  lua  deploy  skill', true],
    // Every other production verb accepts the same prefix.
    ['LUA_DEPLOY_CONFIRMED=1 lua workflows deploy outreach -v latest', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua workflows activate outreach', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua version promote 3', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua persona production deploy --persona-version latest --force', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua mcp activate filesystem', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua skills deploy --skill-name x --skill-version latest', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua jobs deploy -i x -v latest', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua marketplace template apply --template-id t --all-installed --force', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua marketplace template publish --template-id t', true],
  ])('allows %s', (cmd, expected) => {
    expect(isPrefixedDeploy(cmd)).toBe(expected);
  });

  test.each([
    ['lua deploy skill --ci', false],
    ['lua deploy', false],
    ['lua workflows deploy outreach -v latest', false],
    ['lua version promote 3', false],
    ['LUA_DEPLOY_CONFIRMED=0 lua deploy skill', false],
    ['LUA_DEPLOY_CONFIRMED=true lua deploy skill', false],
    ['LUA_DEPLOY_CONFIRMED=1 lua skill --ci', false],
    ['LUA_DEPLOY_CONFIRMED=1 lua deploycommand --ci', false],
    ['LUA_DEPLOY_CONFIRMED=1 lua compile --ci', false],        // prefix on a non-gated command is meaningless
    ['LUA_DEPLOY_CONFIRMED=1 lua workflows deactivate outreach', false],
    ['bash -c "LUA_DEPLOY_CONFIRMED=1 lua deploy"', false],
    ['sh -c "LUA_DEPLOY_CONFIRMED=1 lua deploy"', false],
    ['zsh -c "LUA_DEPLOY_CONFIRMED=1 lua deploy"', false],
    ['echo y | LUA_DEPLOY_CONFIRMED=1 lua deploy', false],
    ['LUA_DEPLOY_CONFIRMED=1 lua deploy | tee log', false],
    ['', false],
  ])('blocks %s', (cmd, expected) => {
    expect(isPrefixedDeploy(cmd)).toBe(expected);
  });

  test.each([
    [null],
    [undefined],
    [42],
    [{}],
    [['lua', 'deploy']],
  ])('returns false for non-string input %p', (cmd) => {
    expect(isPrefixedDeploy(cmd)).toBe(false);
  });
});

describe('classifyProductionCommand', () => {
  test('returns null for non-production commands', () => {
    expect(classifyProductionCommand('lua compile --ci')).toBeNull();
    expect(classifyProductionCommand('lua push skill --ci --force')).toBeNull();
    expect(classifyProductionCommand('lua workflows status run_1')).toBeNull();
    expect(classifyProductionCommand('lua workflows deactivate outreach')).toBeNull();
    expect(classifyProductionCommand('lua mcp deactivate x')).toBeNull();
    expect(classifyProductionCommand('lua version list')).toBeNull();
    expect(classifyProductionCommand('lua marketplace template view --template-id t')).toBeNull();
    expect(classifyProductionCommand(null)).toBeNull();
  });

  test.each([
    ['lua deploy skill --name x', 'lua deploy', '/lua-deploy'],
    ['lua skills deploy --skill-name x', 'lua skills deploy', '/lua-deploy'],
    ['lua webhooks deploy --webhook-name x', 'lua webhooks deploy', '/lua-deploy'],
    ['lua jobs deploy -i x -v latest', 'lua jobs deploy', '/lua-deploy'],
    ['lua preprocessors deploy --preprocessor-name x', 'lua preprocessors deploy', '/lua-deploy'],
    ['lua postprocessors deploy --postprocessor-name x', 'lua postprocessors deploy', '/lua-deploy'],
    ['lua persona production deploy --persona-version 5', 'lua persona production deploy', '/lua-deploy'],
    ['lua workflows deploy outreach -v latest', 'lua workflows deploy', '/lua-deploy'],
    ['lua workflows activate outreach', 'lua workflows activate', '/lua-deploy'],
    ['lua version promote v3', 'lua version promote', '/lua-deploy'],
    ['lua mcp activate --server-name fs', 'lua mcp activate', '/lua-deploy'],
    ['lua marketplace template publish --template-id t', 'lua marketplace template publish', '/lua-template'],
    ['lua marketplace template apply --template-id t --agents a,b --force', 'lua marketplace template apply', '/lua-template'],
  ])('classifies %s as %s (confirm via %s)', (cmd, label, slash) => {
    expect(classifyProductionCommand(cmd)).toEqual({ label, slash, prefixed: false });
    expect(classifyProductionCommand(`LUA_DEPLOY_CONFIRMED=1 ${cmd}`)).toEqual({ label, slash, prefixed: true });
    expect(classifyProductionCommand(`env LUA_DEPLOY_CONFIRMED=1 ${cmd}`)).toEqual({ label, slash, prefixed: true });
  });

  test('a wrapper or pipe is recognised but never counts as prefixed', () => {
    expect(classifyProductionCommand('bash -c "LUA_DEPLOY_CONFIRMED=1 lua deploy skill"'))
      .toEqual({ label: 'lua deploy', slash: '/lua-deploy', prefixed: false });
    expect(classifyProductionCommand('echo y | LUA_DEPLOY_CONFIRMED=1 lua version promote 3'))
      .toEqual({ label: 'lua version promote', slash: '/lua-deploy', prefixed: false });
  });

  test('every PRODUCTION_COMMANDS entry has a label, a binary-anchored regex and a slash', () => {
    for (const entry of PRODUCTION_COMMANDS) {
      expect(entry.label).toMatch(/^lua /);
      expect(entry.re.source.startsWith('^(?:lua|heylua|lua-ai)\\s+')).toBe(true);
      expect(entry.slash).toMatch(/^\/lua-/);
    }
  });

  // Architect review S1: lua-cli resolves action aliases at runtime
  // (src/utils/aliases.ts), so `lua skills publish` IS `lua skills deploy`.
  test.each([
    ['lua skills publish --skill-name x', 'lua skills deploy'],
    ['lua webhooks publish --webhook-name x', 'lua webhooks deploy'],
    ['lua jobs publish -i x -v latest', 'lua jobs deploy'],
    ['lua preprocessors publish --preprocessor-name x', 'lua preprocessors deploy'],
    ['lua postprocessors publish --postprocessor-name x', 'lua postprocessors deploy'],
    ['lua persona production publish --persona-version 5', 'lua persona production deploy'],
    ['lua persona prod deploy --persona-version 5', 'lua persona production deploy'],
    ['lua persona prd deploy --persona-version 5', 'lua persona production deploy'],
    ['lua persona live publish --persona-version 5', 'lua persona production deploy'],
    ['lua workflows publish outreach -v latest', 'lua workflows deploy'],
    ['lua workflows on outreach', 'lua workflows activate'],
    ['lua workflows enable outreach', 'lua workflows activate'],
    ['lua mcp on fs', 'lua mcp activate'],
    ['lua mcp enable fs', 'lua mcp activate'],
    ['lua marketplace template publish_version --template-id t', 'lua marketplace template publish'],
    ['lua marketplace template submit --template-id t', 'lua marketplace template publish'],
    ['lua marketplace template deploy --template-id t', 'lua marketplace template apply'],
    ['lua marketplace template fleet-apply --template-id t', 'lua marketplace template apply'],
    ['lua marketplace template rollout --template-id t', 'lua marketplace template apply'],
  ])('classifies the alias spelling %s as %s', (cmd, label) => {
    expect(classifyProductionCommand(cmd)?.label).toBe(label);
    expect(classifyProductionCommand(cmd)?.prefixed).toBe(false);
    expect(classifyProductionCommand(`LUA_DEPLOY_CONFIRMED=1 ${cmd}`)?.prefixed).toBe(true);
  });

  // lua-cli's package.json installs three binaries for the same entry point.
  test.each([
    ['heylua deploy skill', 'lua deploy'],
    ['lua-ai deploy all --force', 'lua deploy'],
    ['heylua version promote 3', 'lua version promote'],
    ['lua-ai workflows on outreach', 'lua workflows activate'],
  ])('classifies the alternative binary in %s as %s', (cmd, label) => {
    expect(classifyProductionCommand(cmd)?.label).toBe(label);
  });

  test('alias look-alikes that are NOT production verbs stay unclassified', () => {
    expect(classifyProductionCommand('lua workflows off outreach')).toBeNull();
    expect(classifyProductionCommand('lua workflows disable outreach')).toBeNull();
    expect(classifyProductionCommand('lua mcp off fs')).toBeNull();
    expect(classifyProductionCommand('lua persona production view')).toBeNull();
    expect(classifyProductionCommand('lua persona prod versions')).toBeNull();
    expect(classifyProductionCommand('lua marketplace skill publish --skill-name x')).toBeNull(); // marketplace skill publish is `ask`, not a production deploy of this agent
    expect(classifyProductionCommand('lua deployment')).toBeNull();
    expect(classifyProductionCommand('luadeploy')).toBeNull();
    expect(classifyProductionCommand('lua-cli deploy')).toBeNull();
  });
});

describe('hasAutoDeploy', () => {
  test.each([
    ['lua push all --auto-deploy', true],
    ['lua push skill --ci --auto-deploy --force', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua deploy --auto-deploy', true],
    ['lua push all --auto-deploy=true', true],   // = is non-word, \b matches; deny must catch all forms
    ['lua push --auto-deployment', false],        // -ment continues the word, no boundary
    ['lua push all', false],
    ['', false],
  ])('detects --auto-deploy in %s', (cmd, expected) => {
    expect(hasAutoDeploy(cmd)).toBe(expected);
  });

  test('returns false for non-string', () => {
    expect(hasAutoDeploy(null)).toBe(false);
    expect(hasAutoDeploy(undefined)).toBe(false);
    expect(hasAutoDeploy(42)).toBe(false);
  });
});

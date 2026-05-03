import { isPrefixedDeploy, hasAutoDeploy } from '../../lib/tokenizer.mjs';

describe('isPrefixedDeploy', () => {
  test.each([
    ['LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci', true],
    ['LUA_DEPLOY_CONFIRMED=1 lua deploy skill --ci --name foo', true],
    ['env LUA_DEPLOY_CONFIRMED=1 lua deploy webhook', true],
    ['  LUA_DEPLOY_CONFIRMED=1 lua deploy job', true],
    ['\tLUA_DEPLOY_CONFIRMED=1 lua deploy all --force', true],
    ['LUA_DEPLOY_CONFIRMED=1  lua  deploy  skill', true],
  ])('allows %s', (cmd, expected) => {
    expect(isPrefixedDeploy(cmd)).toBe(expected);
  });

  test.each([
    ['lua deploy skill --ci', false],
    ['lua deploy', false],
    ['LUA_DEPLOY_CONFIRMED=0 lua deploy skill', false],
    ['LUA_DEPLOY_CONFIRMED=true lua deploy skill', false],
    ['LUA_DEPLOY_CONFIRMED=1 lua skill --ci', false],
    ['LUA_DEPLOY_CONFIRMED=1 lua deploycommand --ci', false],
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

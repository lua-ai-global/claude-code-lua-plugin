// Pins the web-app (Lua Apps, lua-cli 3.42.0+) command shapes the 1.8.0
// slashes and subagents emit to lib/permissions-template.json:
//
//   * every shape /lua-new, /lua-test, /lua-push and the deploy pilot run for a
//     web app is admitted by an allow rule and caught by no ask/deny rule —
//     otherwise the single-permission contract (§3.7) gains a second prompt;
//   * no npm command is in any list: a glob's `*` matches spaces, so an npm
//     allow rule admitted extra packages and a second `--prefix` (security
//     review, 1.8.0). hooks/approve-web-app.mjs approves the four exact
//     page-project forms instead (test/hooks/approve-web-app.test.mjs);
//   * `lua apps new` is in no list either (a trailing `*` admitted any text
//     after the name); the same hook approves exactly `lua apps new <name>`;
//   * `lua apps dev` stays out of every list: a long-running server whose
//     routes write live Data, which the plugin never starts.
//
// The live-data gate for non-GET routes is /lua-test's AskUserQuestion, not a
// permission rule (a glob cannot reliably read the method inside `--route`).

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyProductionCommand } from '../../lib/tokenizer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { allow, ask, deny } = JSON.parse(
  readFileSync(join(here, '../../lib/permissions-template.json'), 'utf8'),
).permissions;

/** Claude Code permission glob → predicate (`*` is the only wildcard). */
function globToPredicate(rule) {
  const m = rule.match(/^Bash\((.*)\)$/s);
  if (!m) return () => false;
  const re = new RegExp('^' + m[1].split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's');
  return (cmd) => re.test(cmd);
}
const matches = (rules, cmd) => rules.some((r) => globToPredicate(r)(cmd));

const EMITTED = [
  "lua test --ci webapp --name ops-dashboard --route 'GET /tickets?status=open' --json",
  `lua test --ci webapp --name ops-dashboard --route 'POST /tickets/42/close' --input '{"body":{"note":"done"}}' --json`,
  'lua push webapp --ci --force --name ops-dashboard',
  'lua push webapp --ci --force --name ops-dashboard --set-version 1.0.3',
  'lua version diff 3 4 --json',
  'lua version show 4 --json',
  'lua version create --ci -m "web app ops-dashboard via plugin"',
];

describe('web-app commands the plugin emits', () => {
  test.each(EMITTED)('%s is allowed without a prompt', (cmd) => {
    expect(matches(allow, cmd)).toBe(true);
    expect(matches(ask, cmd)).toBe(false);
    expect(matches(deny, cmd)).toBe(false);
  });

  test.each(EMITTED)('%s is not a production verb for the confirm-deploy hook', (cmd) => {
    expect(classifyProductionCommand(cmd)).toBeFalsy();
  });
});

describe('what the web-app rules must not admit', () => {
  test('no npm command is approved by a permission rule (the hook does it, exactly)', () => {
    expect([...allow, ...ask].filter((r) => /^Bash\(npm --prefix/.test(r))).toEqual([]);
  });

  test.each([
    'npm --prefix src/apps/ops-dashboard/web run build',
    'npm --prefix src/apps/x/web install evil --prefix src/apps/x/web install',
    'npm --prefix src/apps/../../../tmp/web install',
    'npm install',
    'npm --prefix src/apps/ops-dashboard/web install left-pad',
    'npm --prefix src/apps/ops-dashboard/web run dev',
    'npm --prefix src/apps/ops-dashboard/web run postinstall',
    'npm --prefix . install',
    'npm --prefix src/apps/ops-dashboard/web exec vite',
  ])('%s is not allowed', (cmd) => {
    expect(matches(allow, cmd)).toBe(false);
  });

  test('no lua apps rule exists (the hook approves `lua apps new <name>` exactly)', () => {
    expect([...allow, ...ask].filter((r) => /^Bash\(lua apps/.test(r))).toEqual([]);
    expect(matches(allow, 'lua apps new x; rm -rf ~')).toBe(false);
  });

  test('lua apps dev is in no list (Claude Code prompts by default)', () => {
    const cmd = 'lua apps dev ops-dashboard';
    expect(matches(allow, cmd)).toBe(false);
    expect(matches(ask, cmd)).toBe(false);
    expect(matches(deny, cmd)).toBe(false);
  });
});

// 1.17.0 — the prompts' build-session paths stay complete and consistent.

import { describe, test, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_FLAGGED_TOOL_NAMES, SESSION_TOOL_NAMES } from '../../lib/session-mode.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEAD = '## Build session (`LUA_BUILD_SESSION=1`)';
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const commands = readdirSync(join(ROOT, 'commands')).filter((f) => f.endsWith('.md'));

/** The body of a file's Build session section (up to the next H2). */
function sessionSection(text) {
  const start = text.indexOf(HEAD);
  if (start < 0) return null;
  const next = text.indexOf('\n## ', start + HEAD.length);
  return text.slice(start, next < 0 ? undefined : next);
}

describe('every slash command has a build-session path', () => {
  // /lua-docs only uses the public docs MCP, which works the same in a session.
  const EXEMPT = new Set(['lua-docs.md']);

  test.each(commands.filter((f) => !EXEMPT.has(f)))('%s', (file) => {
    const section = sessionSection(read(join('commands', file)));
    expect(section).not.toBeNull();
    expect(section).toContain('lib/knowledge/build-session.md');
    // The question tool is unavailable in a session, and lint-single-permission counts its name.
    expect(section).not.toContain('AskUserQuestion');
    // A session section never sends the user to sign in.
    expect(section).not.toMatch(/run `?\/lua-auth/);
  });

  test('the section sits before the first step, so it is read first', () => {
    for (const file of commands.filter((f) => !EXEMPT.has(f))) {
      const text = read(join('commands', file));
      const firstStep = text.search(/\n## (Step|Quick|Full|Mode)/);
      expect([file, text.indexOf(HEAD) < firstStep || firstStep < 0]).toEqual([file, true]);
    }
  });
});

describe('session tool references', () => {
  const files = [
    ...commands.map((f) => join('commands', f)),
    ...readdirSync(join(ROOT, 'agents')).map((f) => join('agents', f)),
    'lib/knowledge/build-session.md',
  ];

  test('every mcp__lua-session__ reference names a real lua-session tool', () => {
    for (const file of files) {
      for (const [, tool] of read(file).matchAll(/mcp__lua-session__([A-Za-z_-]+)/g)) {
        expect([file, [...SESSION_TOOL_NAMES, ...SESSION_FLAGGED_TOOL_NAMES].includes(tool)]).toEqual([file, true]);
      }
    }
  });

  test('the knowledge file documents every lua-session tool', () => {
    const kb = read('lib/knowledge/build-session.md');
    for (const tool of [...SESSION_TOOL_NAMES, ...SESSION_FLAGGED_TOOL_NAMES]) expect(kb).toContain(`mcp__lua-session__${tool}`);
  });

  // Lua Studio report (9 Nov 2026): no multi-select, and the chat's options differed from the card's buttons. The card
  // (ask_user) is the one place the questions and their options live; the reply never restates them.
  test('questions go on the ask_user card (multi when several apply), never restated in the reply', () => {
    const kb = read('lib/knowledge/build-session.md');
    expect(kb).toMatch(/When the session lists `mcp__lua-session__ask_user` \(§2\), ask there/);
    expect(kb).toMatch(/`multi` when more than one answer can apply/);
    expect(kb).toMatch(/never restate the questions or their options in your reply/);
    expect(kb).not.toMatch(/The interactive question tool is not available in a session\. Where a slash command would ask its single question, write the questions in your reply/);
  });

  test('a session path never offers production chat or a deploy verb as the way to ship', () => {
    for (const file of commands) {
      const section = sessionSection(read(join('commands', file))) ?? '';
      expect([file, /lua chat[^`\n]*-e production[^`\n]*`(?!\])/.test(section.replace(/"production"/g, ''))]).toEqual([file, false]);
      expect([file, /LUA_DEPLOY_CONFIRMED/.test(section)]).toEqual([file, false]);
    }
  });
});

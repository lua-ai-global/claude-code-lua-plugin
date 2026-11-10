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

  // Lua Studio (10 Nov 2026): the builder told a user "it's been well over 30 minutes since the last attempt, so the
  // limit won't block you". The owner's own check has its own budget (lua-core browser-logins.types.ts: 3 in 10 min,
  // 60 s after a wrong password); 30 minutes is the agent's own runs only, and the builder never predicts the limit.
  test('browser sign-in limits: two budgets, and the builder never predicts whether the limit blocks', () => {
    const browser = read('lib/knowledge/browser.md');
    expect(browser).toMatch(/\*\*The agent's own sign-ins\*\* \(`unattended`[^\n]*one attempt per 30 minutes with a 30-minute cooldown/);
    expect(browser).toMatch(/\*\*The owner checking their own login right now\*\* \(`interactive`[^\n]*\*\*3 attempts in 10 minutes\*\*, a \*\*60-second pause after a wrong password\*\*/);
    expect(browser).toMatch(/\*\*Never predict the limit\*\*/);
    expect(browser).not.toMatch(/The default policy is \*\*one attempt per 30 minutes/);
    expect(read('lib/knowledge/build-session.md')).toMatch(/\*\*Never predict the sign-in limit\.\*\* The card's check is the owner's own sign-in: 3 attempts in 10 minutes/);
    expect(read('agents/lua-debug.md')).toMatch(/3 in 10 minutes, a 60-second pause after a wrong password/);
    expect(read('agents/lua-architect.md')).not.toMatch(/tried once per 30 minutes;/);
  });

  // Lua Studio round 2 (10 Nov 2026), N6: a sign-off lock card would set the approver ids to "". N4: an outdated
  // release card was approved after a restage, and the builder said "only you can decline". N12: it reported card and
  // release state from memory. N11 / N14 / N9: queued messages, tool narration, a one-role plan.
  test('round 2: ids from a result, a newer stage replaces the card, state re-read, queue, progress, plan size', () => {
    const kb = read('lib/knowledge/build-session.md');
    expect(kb).toMatch(/\*\*Never put an id you did not read on a card\.\*\*/);
    expect(kb).toMatch(/call a route of the staged app that returns it[^\n]*read `call\.body\.userId`\. Never a placeholder, a guess, an empty string or a shell variable/);
    expect(kb).toMatch(/Never ask the user to type a user id/);
    expect(kb).toMatch(/\*\*One release card at a time; a newer stage replaces it\*\*/);
    expect(kb).toMatch(/call `request_release` again with the new summary/);
    expect(kb).toMatch(/`replacedCandidateId`/);
    expect(kb).toMatch(/Never say only the user can decline a card/);
    expect(kb).toMatch(/\*\*Re-read the state before you report it\.\*\*/);
    expect(kb).toMatch(/finish the step you are on and end the turn before you ask anything/);
    expect(kb).toMatch(/never how you do it: no tool names/);
    expect(kb).toMatch(/Studio's check also needs \*\*2 to 6 roles\*\*/);
    const web = read('lib/knowledge/web-apps.md');
    expect(web).toMatch(/### 4b2\. Words and numbers on the page/);
    expect(web).toMatch(/A `sticky top-0` header gets `bg-background`/);
    expect(web).toMatch(/freshness or validity verdict on the end date/);
  });

  test('1.20.8: fast loops, agents before the app, done means it ran, colour and the status strip', () => {
    const kb = read('lib/knowledge/build-session.md');
    expect(kb).toMatch(/### 2a\. Fast loops: test what changed, stage what changed/);
    expect(kb).toMatch(/\*\*Pass `agentIds`\*\* with only the agents that changed/);
    expect(kb).toMatch(/send the \*\*same message text\*\*/);
    expect(kb).toMatch(/calls on different agents in the same turn run in parallel; never two on the same agent/);
    expect(kb).toMatch(/\*\*Build order for a fleet with a web app: agents first, the app last, the preview early\.\*\*/);
    expect(kb).toMatch(/never the app alone ahead of the agents it needs/);
    expect(kb).toMatch(/### 5a\. Done means it ran: after the release/);
    expect(kb).toMatch(/command: "jobs trigger", args: \["-i", "<job name>"\]/);
    expect(kb).toMatch(/A session has no timer/);
    expect(kb).toMatch(/Never leave the person with "press X"/);
    const web = read('lib/knowledge/web-apps.md');
    expect(web).toMatch(/### 4d\. Colour: polished, on the design system/);
    expect(web).toMatch(/\*\*a real failure only\*\*/);
    expect(web).toMatch(/### 4e\. The status strip: is it running, and when\?/);
    expect(web).toMatch(/Waiting for first run at 13:00/);
    const builder = read('agents/lua-skill-builder.md');
    expect(builder).toMatch(/\*\*But not monochrome\*\*/);
    expect(builder).toMatch(/\*\*Every app's home page starts with a status strip\*\*/);
  });

  test('a session path never offers production chat or a deploy verb as the way to ship', () => {
    for (const file of commands) {
      const section = sessionSection(read(join('commands', file))) ?? '';
      expect([file, /lua chat[^`\n]*-e production[^`\n]*`(?!\])/.test(section.replace(/"production"/g, ''))]).toEqual([file, false]);
      expect([file, /LUA_DEPLOY_CONFIRMED/.test(section)]).toEqual([file, false]);
    }
  });
});

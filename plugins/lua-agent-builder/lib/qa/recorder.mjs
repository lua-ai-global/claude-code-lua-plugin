// start-run / record / finish-run: the single recorded path from a player to the agent.
// Everything a run produces (turns.jsonl, transcript.md, run-record.json, ledger rows) is written here.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  QaError, appendJsonl, appendText, emit, fail, hex, parseArgs, playerId, readJson, readJsonOr, readJsonl,
  resolveRunDir, runFolder, runFolderRel, threadId, writeJson,
} from './io.mjs';
import { checkTestData, credentialRisk, fakeDataHint, redactSecrets, redactDeep, testDataPolicy } from './safety.mjs';
import { assertGates, loadRun, pushHistory, withSandboxLock } from './state.mjs';
import { classifyLuaExit, runLua } from './spawn.mjs';
import { detectCredential, qaApiRequest } from './api.mjs';
import { fetchThreadHistory, toolCallsForTurn } from './history.mjs';
import { addLedger, ledgerToolCalls } from './ledger.mjs';
import { minutesLeft, runTier } from './tiers.mjs';

const nowOf = (deps) => (deps.now ?? (() => new Date()))();
const SEP_RE = /^[─-╿─-]{5,}\s*$/;

// ---------------------------------------------------------------- stdout parsers

/**
 * Parses `lua chat --ci -m ...` stdout. The reply follows the "Response:" banner; a post-processed reply
 * wins over the streamed text; a preprocessor block is reported as such.
 */
export function parseChatStdout(stdout = '', _stderr = '') {
  const out = String(stdout);
  const result = { reply: '', streamed: null, postprocessed: false, preprocessorBlocked: false, batchHandled: false, batchAborted: false, threadEcho: null };
  const marker = out.search(/\u{1F319}\s*Response:/u);
  if (marker < 0) {
    result.batchHandled = /Batch handled/i.test(out);
    result.batchAborted = /Batched\/absorbed/i.test(out);
    return result;
  }
  const lines = out.slice(marker).split('\n').slice(1);
  let i = 0;
  while (i < lines.length && (SEP_RE.test(lines[i]) || /^\s*$/.test(lines[i]))) i++;
  const th = /^Thread:\s*(\S+)/.exec(lines[i] ?? '');
  if (th) {
    result.threadEcho = th[1];
    i++;
  }
  while (i < lines.length && (SEP_RE.test(lines[i]) || /^\s*$/.test(lines[i]))) i++;
  let body = lines.slice(i).join('\n');
  // lua-cli prints Tip / error-probe lines on stdout after the reply unless LUA_NO_HINTS is set (runLua sets it); cut them if they appear.
  const hint = body.search(/\n(?:\u2728 Tip:|\u{1F4A1}|\u26A0\uFE0F?\s+\d+ new agent error|\u2139\uFE0F?|Something went wrong\.|Next step)/u);
  if (hint >= 0) body = body.slice(0, hint);
  const pp = body.search(/\u{1F4DD}\s*\[Post-processed response\]:/u);
  if (pp >= 0) {
    const streamed = body.slice(0, pp).trim();
    const final = body.slice(pp).replace(/^.*\[Post-processed response\]:\s*/u, '').trim();
    result.postprocessed = true;
    result.streamed = streamed;
    result.reply = final;
  } else {
    result.reply = body.trim();
  }
  const blocked = /\u{1F6AB}\s*Message blocked(?::\s*([^\n]*))?/u.exec(result.reply);
  if (blocked) {
    result.preprocessorBlocked = true;
    result.reply = (blocked[1] ?? '').trim();
  }
  result.batchHandled = /Batch handled/i.test(out);
  result.batchAborted = /Batched\/absorbed/i.test(out);
  return result;
}

/** Parses `lua chat -b ...` stdout into per-message counts. */
export function parseBatchStdout(stdout = '', stderr = '') {
  const out = String(stdout);
  const count = (re) => (out.match(re) ?? []).length;
  // Per-message errors are printed with console.error (stderr); the stdout summary also ends with "K errors".
  const errLines = (String(stderr).match(/\[msg \d+\] Error/g) ?? []).length + count(/\[msg \d+\] Error/g);
  const summary = /(\d+) errors\b/.exec(out);
  return {
    sent: count(/Sending msg \d+/g),
    replies: count(/\[msg \d+\] Responded/g),
    batchHandled: count(/\[msg \d+\] Batch handled/g),
    batchAborted: count(/\[msg \d+\] Batched\/absorbed/g),
    errors: Math.max(errLines, summary ? Number(summary[1]) : 0),
  };
}

/** Parses `lua chat --agent-version N --test-session -m ...` stdout (fallback path). */
export function parseTestSessionStdout(stdout = '') {
  const lines = String(stdout).split('\n');
  const replies = [];
  const effects = [];
  let sessionId = null;
  let current = null;
  for (const line of lines) {
    const sess = /Test session (\S+) on agent version/.exec(line);
    if (sess) {
      sessionId = sess[1];
      continue;
    }
    const reply = /^\u{1F916}\s?(.*)$/u.exec(line);
    if (reply) {
      current = { text: reply[1], tools: [] };
      replies.push(current);
      continue;
    }
    if (/^(?:Recorded \d+ effect|No side effects were recorded|\(effects unavailable|\u2705 Test session closed)/u.test(line)) {
      current = null;
      continue;
    }
    const tools = /^\s*tools:\s*(.+)$/.exec(line);
    if (tools && current) {
      current.tools = tools[1].split(',').map((t) => t.trim()).filter(Boolean);
      current = null;
      continue;
    }
    const eff = /^\s*#(\d+)\s+(\S+)\s+\(([^,)]+)(?:,\s*([^)]+))?\)/.exec(line);
    if (eff) {
      effects.push({ seq: Number(eff[1]), kind: eff[2], site: eff[3], primitiveId: eff[4] ?? null });
      current = null;
      continue;
    }
    if (current && !/^\s*$/.test(line)) current.text += `\n${line}`;
  }
  for (const r of replies) r.text = r.text.trim();
  return { replies, effects, sessionId };
}

/** Markdown block for one turn (transcript.md). */
export function renderTranscriptTurn(row) {
  let md = `### User\n<!-- at ${row.at} thread ${row.thread} player ${row.player} -->\n${row.user}\n\n### Agent (${Math.round(row.seconds)}s)\n${row.reply}\n`;
  if (row.toolCalls && row.toolCalls.length > 0) {
    md += `\n<details><summary>tool calls</summary>\n\n\`\`\`json\n${JSON.stringify(row.toolCalls, null, 1).slice(0, 20_000)}\n\`\`\`\n</details>\n`;
  }
  if (row.error) md += `\n> error: ${row.error.code} ${row.error.message}\n`;
  return `${md}\n`;
}

// ---------------------------------------------------------------- test-session REST client

const sessionBase = (agentId, version) => `/developer/agents/${encodeURIComponent(agentId)}/versions/${version}/sessions`;
const unwrap = (res) => (res && typeof res === 'object' && 'data' in res ? res.data : res);

export const testSessionApi = {
  async open(agentId, version, deps, timeoutMs = 20_000) {
    const res = await qaApiRequest(sessionBase(agentId, version), { method: 'POST', body: { testTraffic: true }, deps, timeoutMs });
    const data = unwrap(res);
    if (!data?.id) throw new QaError('PLATFORM', 5, 'The platform did not return a test session id');
    return String(data.id);
  },
  async chat(agentId, version, sessionId, prompt, threadId, deps, timeoutMs = 85_000) {
    const res = await qaApiRequest(`${sessionBase(agentId, version)}/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST', body: { prompt, ...(threadId ? { threadId } : {}) }, deps, timeoutMs,
    });
    const data = unwrap(res) ?? {};
    return { text: String(data.text ?? ''), toolsUsed: Array.isArray(data.toolsUsed) ? data.toolsUsed.map(String) : [] };
  },
  async effects(agentId, version, sessionId, deps, timeoutMs = 10_000) {
    const res = await qaApiRequest(`${sessionBase(agentId, version)}/${encodeURIComponent(sessionId)}/effects`, { deps, timeoutMs });
    const data = unwrap(res) ?? {};
    return Array.isArray(data.effects) ? data.effects : [];
  },
  async close(agentId, version, sessionId, deps, timeoutMs = 15_000) {
    await qaApiRequest(`${sessionBase(agentId, version)}/${encodeURIComponent(sessionId)}/close`, { method: 'POST', body: {}, deps, timeoutMs });
  },
};

// ---------------------------------------------------------------- run-record helpers (shared by the other checks)

export const SELECTOR_FLAGS = {
  'run-dir': { type: 'string', required: true },
  card: { type: 'string', required: true },
  run: { type: 'number', required: true },
  attempt: { type: 'number' },
  json: { type: 'boolean' },
};

export function selectorPaths(runDir, { card, run, attempt }) {
  const a = attempt ?? 1;
  const dir = runFolder(runDir, card, run, a);
  return { dir, record: join(dir, 'run-record.json'), turns: join(dir, 'turns.jsonl'), checks: join(dir, 'checks'), a };
}

export async function loadRecord(runDir, sel) {
  const p = selectorPaths(runDir, sel);
  const rec = await readJsonOr(p.record);
  if (!rec) throw new QaError('NO_RUN_RECORD', 2, `No run record for ${sel.card} run ${sel.run}`, 'Run start-run for this card and run first.');
  return { rec, paths: p };
}

// ---------------------------------------------------------------- start-run

const START_SPEC = {
  ...SELECTOR_FLAGS,
  model: { type: 'string', choices: ['sonnet', 'opus'] },
  'production-consent': { type: 'string' },
};

/**
 * A hard-capped tier (smoke: 30 minutes from the plan approval, state.json only) starts no new run in the last
 * `startReserveMinutes` of its cap (`what: 'run'`), and sends no turn, runs no tool or flow test once the cap has
 * passed (`what: 'turn'` / `'test'`). Runs that never start leave their card inconclusive, and the report shows the
 * time against the budget. A capped run without a clock start fails closed.
 * @returns {number} minutes left (Infinity for an uncapped tier)
 */
export function assertWithinBudget(run, state, deps = {}, what = 'run') {
  const tier = runTier(run, state);
  const left = minutesLeft(run, state, nowOf(deps).getTime(), { reserve: what === 'run' });
  if (left > 0) return left;
  const action = { run: 'no new run starts', turn: 'no further turn is sent', test: 'no further test runs' }[what];
  const when = what === 'run' ? `${tier.budgetMinutes - (tier.startReserveMinutes ?? 0)} minutes into its ${tier.budgetMinutes}-minute cap` : `past its ${tier.budgetMinutes}-minute cap`;
  const hint = {
    run: 'Return this run as not started (stopped: TIME_BUDGET). The report counts the card as inconclusive.',
    turn: 'The run was closed as inconclusive. Return stopped: TIME_BUDGET and do not call finish-run.',
    test: 'Stop running tests. The report lists the remaining tests as not run.',
  }[what];
  throw new QaError('TIME_BUDGET', 3, `The ${tier.label} tier is ${when}; ${action}`, hint);
}

export async function cliStartRun(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, START_SPEC);
    const runDir = resolveRunDir(io, v['run-dir']);
    const { state } = await assertGates(runDir, ['environment', 'plan'], { consent: v['production-consent'], requireConsent: true });
    const run = await loadRun(runDir);
    // The user agreed to switch platform memory off for the test window: no conversation until that is verified.
    if (state.gates?.environment?.memory?.mitigation === 'off-for-run' && !state.memoryRestore?.verifiedOffAt) {
      throw new QaError('MEMORY_NOT_OFF', 3, 'Agent memory was to be switched off for this run, and that is not verified yet', 'Run the lua features disable commands the environment gate printed, then memory --run-dir <runDir> --check off.');
    }
    try {
      assertWithinBudget(run, state, deps);
    } catch (err) {
      // Recorded so the report can say the card was not played because of the cap, not because of the agent.
      await pushHistory(runDir, 'time-budget', `${v.card} r${v.run} refused`, deps);
      throw err;
    }
    const card = await readJsonOr(join(runDir, 'plan', 'cards', `${v.card}.json`));
    if (!card) throw new QaError('USAGE', 2, `Card ${v.card} was not found in plan/cards`);
    const attempt = v.attempt ?? 1;
    const paths = selectorPaths(runDir, { card: v.card, run: v.run, attempt });
    if (await readJsonOr(paths.record)) {
      throw new QaError('RUN_EXISTS', 3, `A run record already exists for ${v.card} run ${v.run} attempt ${attempt}`, 'A second writer is contamination. Use a new attempt number for a retry.');
    }
    const hex6 = hex(6, deps);
    const thread = threadId({ runId: run.runId, cardId: v.card, k: v.run, attempt, hex6 });
    const player = playerId({ cardId: v.card, k: v.run, attempt, hex6 });
    const model = v.model ?? (card.kind === 'redteam' ? run.models.redTeamPlayer : run.models.player);
    const env = run.environment;
    let testSessionId = null;
    let notes = '';
    if (env.kind === 'staged' && env.testSession) {
      try {
        testSessionId = await testSessionApi.open(run.agent.id, env.agentVersion, deps);
      } catch (err) {
        notes = 'test-session per turn: continuity unverified';
        io.err.write(`Could not open a test session (${err.code ?? 'error'}); falling back to one session per turn.\n`);
      }
    }
    const rec = {
      schema: 'lua-qa/run-record@1',
      runId: run.runId, cardId: v.card, kind: card.kind, k: v.run, attempt,
      folder: runFolderRel(v.card, v.run, attempt),
      thread, player, model,
      environment: { kind: env.kind, agentVersion: env.agentVersion ?? null, testSession: env.testSession ?? null },
      testSessionId,
      startedAt: nowOf(deps).toISOString(), endedAt: null,
      status: 'running', abortReason: null, turns: 0,
      checks: { contamination: null, readabilityFails: 0, claimsUnbacked: 0, claimsStatus: null },
      verdict: null, safety: false, majors: [], sideEffectRefs: [],
      ...(notes ? { notes } : {}),
    };
    await writeJson(paths.record, rec);
    await pushHistory(runDir, 'start-run', `${v.card} r${v.run} a${attempt}`, deps);
    emit(io, { ok: true, folder: rec.folder, thread, player, testSessionId });
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

// ---------------------------------------------------------------- record

const RECORD_SPEC = {
  ...SELECTOR_FLAGS,
  player: { type: 'string', required: true },
  message: { type: 'string' },
  'message-file': { type: 'string' },
  'production-consent': { type: 'string' },
};

async function readMessage(v, io) {
  if (v.message !== undefined && v['message-file'] !== undefined) throw new QaError('USAGE', 2, 'Pass either --message or --message-file, not both');
  if (v['message-file'] !== undefined) {
    try {
      return (await readFile(resolve(io.cwd, v['message-file']), 'utf8')).replace(/\r\n/g, '\n').replace(/\n+$/, '');
    } catch {
      throw new QaError('USAGE', 2, `Cannot read --message-file ${v['message-file']}`);
    }
  }
  if (v.message === undefined) throw new QaError('USAGE', 2, 'Pass --message or --message-file');
  return v.message;
}

async function flowModelOf(runDir) {
  return readJsonOr(join(runDir, 'discovery', 'flow-model.json'), null);
}

export function redactTurnParts({ user, reply, streamed, toolCalls }) {
  const redactions = [];
  const take = (field, text) => {
    const r = redactSecrets(text ?? '');
    for (const x of r.redactions) redactions.push({ field, kind: x.kind });
    return r.text;
  };
  const out = {
    user: take('user', user),
    reply: take('reply', reply),
    streamed: streamed == null ? null : take('reply', streamed),
    toolCalls: null,
  };
  if (toolCalls) {
    const flat = redactSecrets(JSON.stringify(toolCalls));
    for (const x of flat.redactions) redactions.push({ field: 'toolCalls', kind: x.kind });
    out.toolCalls = redactDeep(toolCalls);
  }
  return { ...out, redactions };
}

export async function cliRecord(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, RECORD_SPEC);
    const runDir = resolveRunDir(io, v['run-dir']);
    const { state } = await assertGates(runDir, ['environment', 'plan'], { consent: v['production-consent'], requireConsent: true });
    const run = await loadRun(runDir);
    const sel = { card: v.card, run: v.run, attempt: v.attempt };
    const { rec, paths } = await loadRecord(runDir, sel);
    if (rec.player !== v.player) {
      throw new QaError('PLAYER_MISMATCH', 3, `The player id does not match this run (${v.card} run ${v.run})`, 'Use the player id start-run printed. A second writer is contamination.');
    }
    if (rec.status !== 'running') throw new QaError('RUN_CLOSED', 3, `This run is already ${rec.status}`, 'Start a new attempt instead.');
    try {
      assertWithinBudget(run, state, deps, 'turn');
    } catch (err) {
      // Past the hard cap: the run is closed as inconclusive (it is not graded), never left running.
      rec.status = 'aborted';
      rec.abortReason = 'time-budget';
      rec.endedAt = nowOf(deps).toISOString();
      await writeJson(paths.record, rec);
      await pushHistory(runDir, 'time-budget', `${v.card} r${v.run} closed at turn ${rec.turns + 1}`, deps);
      throw err;
    }
    const message = await readMessage(v, io);
    const policy = testDataPolicy(run, state);
    const td = checkTestData(message, policy);
    if (!td.ok) {
      const first = td.violations[0];
      throw new QaError(first.kind === 'email' ? 'REAL_EMAIL' : 'REAL_URL', 3, `The message contains a real-looking ${first.kind}${first.reason ? ` (${first.reason})` : ''}`, `Rewrite the message. ${fakeDataHint(policy)}`);
    }
    const env = run.environment;
    const sandbox = env.kind === 'sandbox';
    if (sandbox) {
      const cred = await detectCredential({ env: io.env, cwd: run.projectDir, home: io.env.HOME });
      const risk = credentialRisk({ credentialSource: cred.source, dotenvKeys: cred.dotenvKeys, hasStoredCredential: cred.hasStoredCredential });
      if (risk.envOnly) {
        throw new QaError('CREDENTIAL_ENV_ONLY', 3, 'The only credential is LUA_API_KEY in the environment, and QA chats run with a scrubbed environment', 'Log in from your own terminal (lua auth), or run /lua-auth, then retry.');
      }
    }

    const priorRows = await readJsonl(paths.turns);
    const turnNo = priorRows.length + 1;
    const startedAt = nowOf(deps);
    // One deadline per CLI call : every lock wait, spawn and fetch is clamped to what is left.
    const cliMs = (run.timeouts?.cliSeconds ?? 110) * 1000;
    const remaining = () => cliMs - (nowOf(deps).getTime() - startedAt.getTime());
    const turn = {
      reply: '', streamed: null, postprocessed: false, preprocessorBlocked: false, batchHandled: false,
      exitCode: 0, error: null, toolCalls: null, toolCallSource: 'unavailable', effects: null, chatAt: null, chatEndedAt: null,
    };
    const cwd = run.projectDir;

    if (env.kind === 'staged' && env.testSession && rec.testSessionId) {
      const r = await testSessionApi.chat(run.agent.id, env.agentVersion, rec.testSessionId, message, rec.thread, deps, Math.max(10_000, Math.min(85_000, remaining() - 20_000)));
      turn.reply = r.text;
      turn.toolCalls = r.toolsUsed.map((name) => ({ name, input: null, output: null, status: 'unknown' }));
      turn.toolCallSource = 'test-session';
      try {
        const left = remaining();
        // Too little time left: skip. The effects are picked up by the next turn (they are de-duplicated by seq).
        const all = left >= 4000 ? await testSessionApi.effects(run.agent.id, env.agentVersion, rec.testSessionId, deps, Math.min(10_000, left - 1500)) : [];
        const seen = new Set(priorRows.flatMap((r2) => (r2.effects ?? []).map((e) => e.seq)));
        turn.effects = all.filter((e) => !seen.has(e.seq)).map((e) => ({ seq: e.seq, kind: String(e.kind), site: String(e.site ?? ''), primitiveId: e.primitiveId ?? null }));
      } catch {
        turn.effects = [];
      }
    } else {
      let argv2;
      if (env.kind === 'staged') {
        argv2 = ['chat', '--ci', '--agent-version', String(env.agentVersion), ...(env.testSession ? ['--test-session'] : []), '-m', message, '-t', rec.thread];
      } else {
        argv2 = ['chat', '--ci', '-e', env.kind, '-m', message, '-t', rec.thread];
      }
      // Reserve ~17 s after the chat for the SIGKILL grace, the history fetch and the file writes.
      const exec = () => runLua(argv2, { cwd, timeoutMs: Math.max(10_000, Math.min(run.timeouts.turnSeconds * 1000, remaining() - 17_000)), env: io.env, deps });
      const waitMs = Math.max(0, (run.timeouts.cliSeconds - run.timeouts.turnSeconds) * 1000);
      const res = sandbox
        ? await withSandboxLock(run.projectDir, { runId: run.runId, player: rec.player }, exec, { maxWaitMs: waitMs }, deps)
        : await exec();
      turn.exitCode = res.exitCode;
      // The chat process itself, inside the sandbox lock: the window prechecks uses to find this turn's logged tool calls.
      turn.chatAt = res.startedAt ?? null;
      turn.chatEndedAt = res.endedAt ?? null;
      if (env.kind === 'staged' && env.testSession) {
        const parsed = parseTestSessionStdout(res.stdout);
        turn.reply = parsed.replies.map((r) => r.text).join('\n\n');
        turn.toolCalls = (parsed.replies.flatMap((r) => r.tools)).map((name) => ({ name, input: null, output: null, status: 'unknown' }));
        turn.toolCallSource = 'test-session';
        turn.effects = parsed.effects;
      } else {
        const parsed = parseChatStdout(res.stdout, res.stderr);
        turn.reply = parsed.reply;
        turn.streamed = parsed.postprocessed ? parsed.streamed : null;
        turn.postprocessed = parsed.postprocessed;
        turn.preprocessorBlocked = parsed.preprocessorBlocked;
        turn.batchHandled = parsed.batchHandled;
      }
      const lerr = classifyLuaExit(res);
      if (lerr) turn.error = { code: lerr.code, message: lerr.message };
      else if (res.exitCode !== 0) turn.error = { code: `LUA_EXIT_${res.exitCode}`, message: `lua exited with code ${res.exitCode}` };
      if (turn.toolCallSource === 'unavailable' && !turn.error && remaining() >= 5000) {
        const hist = await fetchThreadHistory({ agentId: run.agent.id, thread: rec.thread, deps, timeoutMs: Math.min(10_000, remaining() - 2000) });
        // An unscoped payload (no thread ids) could hold other runs' tool calls for the same openers: do not trust it.
        if (hist.source === 'history' && hist.scoped) {
          const calls = toolCallsForTurn(hist.messages, { userText: message });
          if (calls) {
            turn.toolCalls = calls;
            turn.toolCallSource = 'history';
          }
        }
      }
    }

    const endedAt = nowOf(deps);
    const seconds = Math.round(((endedAt.getTime() - startedAt.getTime()) / 1000) * 10) / 10;
    const red = redactTurnParts({ user: message, reply: turn.reply, streamed: turn.streamed, toolCalls: turn.toolCalls });
    const row = {
      schema: 'lua-qa/turn@1',
      turn: turnNo, at: startedAt.toISOString(), endedAt: endedAt.toISOString(), seconds,
      runId: run.runId, cardId: v.card, k: v.run, thread: rec.thread, player: rec.player,
      env: { kind: env.kind, agentVersion: env.agentVersion ?? null, testSession: env.testSession ?? null },
      user: red.user, reply: red.reply, streamed: red.streamed,
      postprocessed: turn.postprocessed, preprocessorBlocked: turn.preprocessorBlocked, batchHandled: turn.batchHandled,
      exitCode: turn.exitCode, error: turn.error,
      toolCalls: red.toolCalls, toolCallSource: turn.toolCallSource, effects: turn.effects,
      ...(turn.chatAt ? { chatAt: turn.chatAt, chatEndedAt: turn.chatEndedAt } : {}),
      redactions: red.redactions,
      ...(td.warnings.length ? { phoneWarnings: td.warnings.map((w) => w.value) } : {}),
    };
    await appendJsonl(paths.turns, row);
    await appendText(join(paths.dir, 'transcript.md'), renderTranscriptTurn(row));

    // Ledger: recorded effects and tool calls that likely change the outside world.
    const refs = [];
    const runRef = rec.folder;
    for (const e of turn.effects ?? []) {
      const led = await addLedger(runDir, { source: 'test-session-effect', runRef, turn: turnNo, kind: e.kind, detail: `${e.site}${e.primitiveId ? ` ${e.primitiveId}` : ''}`, expected: null, reversible: null, cleanup: 'none' }, deps);
      refs.push(led.id);
    }
    refs.push(...await ledgerToolCalls(runDir, { runRef, turn: turnNo, calls: turn.toolCalls, model: await flowModelOf(runDir), testSession: !!env.testSession }, deps));

    const fresh = await readJson(paths.record);
    fresh.turns = turnNo;
    fresh.sideEffectRefs = [...(fresh.sideEffectRefs ?? []), ...refs];
    await writeJson(paths.record, fresh);

    let stop;
    if ([9, 10, 11].includes(turn.exitCode)) stop = 'auth failure: stop and report';
    else if (turn.exitCode === 12 && priorRows.length > 0 && priorRows[priorRows.length - 1].exitCode === 12) stop = 'the model provider refused twice in a row: stop and report';
    const body = { turn: turnNo, seconds, reply: row.reply, toolCalls: (row.toolCalls ?? []).length, exitCode: turn.exitCode, ...(stop ? { stop } : {}), ...(td.warnings.length ? { warnings: td.warnings } : {}) };
    if (turn.error) {
      emit(io, { ok: false, code: turn.error.code, message: turn.error.message, hint: stop ?? 'The turn was recorded with the error.', ...body });
      return 5;
    }
    emit(io, { ok: true, ...body });
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

// ---------------------------------------------------------------- finish-run

const FINISH_SPEC = {
  ...SELECTOR_FLAGS,
  player: { type: 'string', required: true },
  status: { type: 'string', choices: ['done', 'aborted'] },
  reason: { type: 'string' },
  'player-report-file': { type: 'string' },
};
const ABORT_REASONS = ['safety-refusal', 'platform-error', 'timeout', 'player-stopped'];

export async function cliFinishRun(argv, io, deps = {}) {
  try {
    const { values: v } = parseArgs(argv, FINISH_SPEC);
    const runDir = resolveRunDir(io, v['run-dir']);
    const run = await loadRun(runDir);
    const { rec, paths } = await loadRecord(runDir, { card: v.card, run: v.run, attempt: v.attempt });
    if (rec.player !== v.player) {
      throw new QaError('PLAYER_MISMATCH', 3, `The player id does not match this run (${v.card} run ${v.run})`, 'Use the player id start-run printed.');
    }
    // A run the hard cap closed stays closed as inconclusive, whatever status the player passes.
    const capClosed = rec.abortReason === 'time-budget';
    const status = capClosed ? 'aborted' : v.status ?? 'done';
    let closed = null;
    if (rec.testSessionId) {
      try {
        await testSessionApi.close(run.agent.id, rec.environment.agentVersion, rec.testSessionId, deps);
        closed = true;
      } catch {
        closed = false;
      }
    }
    const refs = [...(rec.sideEffectRefs ?? [])];
    let reported = 0;
    if (v['player-report-file']) {
      let items = null;
      try {
        items = JSON.parse(await readFile(resolve(io.cwd, v['player-report-file']), 'utf8'));
      } catch { /* ignored: reported below */ }
      if (!Array.isArray(items)) {
        io.err.write('The player report was missing or not a JSON array; it was ignored.\n');
      } else {
        for (const it of items.slice(0, 50)) {
          if (!it || typeof it !== 'object' || typeof it.kind !== 'string') continue;
          const led = await addLedger(runDir, {
            source: 'player-report', runRef: rec.folder, turn: Number.isInteger(it.turn) ? it.turn : null,
            kind: it.kind, detail: String(it.detail ?? ''), expected: null, reversible: null, cleanup: 'manual',
            cleanupHint: 'The player reported an outside-world action. Check it by hand.',
          }, deps);
          refs.push(led.id);
          reported++;
        }
      }
    }
    rec.endedAt = capClosed ? rec.endedAt ?? nowOf(deps).toISOString() : nowOf(deps).toISOString();
    rec.status = status;
    if (!capClosed) rec.abortReason = status === 'aborted' ? (ABORT_REASONS.includes(v.reason) ? v.reason : 'player-stopped') : null;
    rec.sideEffectRefs = refs;
    await writeJson(paths.record, rec);
    await pushHistory(runDir, 'finish-run', `${v.card} r${v.run} ${status}`, deps);
    emit(io, { ok: true, status, turns: rec.turns, sessionClosed: closed, playerReportItems: reported });
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

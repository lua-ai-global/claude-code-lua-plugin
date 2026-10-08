#!/usr/bin/env node
// The single entry point for every /lua-qa helper:
//   node ${CLAUDE_PLUGIN_ROOT}/lib/qa/cli.mjs <subcommand> [flags]
// This file only routes: each subcommand lives in its own module as `cli*(argv, io, deps) → exit code`.
// One permission rule, `Bash(node *lua-agent-builder*/lib/qa/cli.mjs *)`, covers all of them; the modules
// spawn lua only through lib/qa/spawn.mjs (scrubbed env, coded argv allowlist). hooks/guard-qa-helper.mjs
// blocks any other file of this name, and the production consent stamp (--production-consent-text) asks.

import { pathToFileURL } from 'node:url';
import { QaError, emit, fail } from './io.mjs';
import { killActiveChildren } from './spawn.mjs';
import { releaseHeldLocks } from './state.mjs';

const cmd = (module, fn, summary) => Object.freeze({ module, fn, summary });

export const COMMANDS = Object.freeze({
  preflight: cmd('./preflight.mjs', 'cliPreflight', 'check lua-cli, credentials and report tools'),
  'init-run': cmd('./state.mjs', 'cliInitRun', 'create a run folder (run.json + state.json)'),
  gate: cmd('./state.mjs', 'cliGate', 'stamp a hard gate (discovery|questions|environment|plan)'),
  validate: cmd('./schemas.mjs', 'cliValidate', 'validate plan files against their schemas'),
  cards: cmd('./plan-write.mjs', 'cliCards', 'cards write: split one plan bundle into plan/cards/*.json and the test plans'),
  discover: cmd('./discovery/discover.mjs', 'cliDiscover', 'compile and read the agent (discovery/*.json)'),
  'flow-model': cmd('./discovery/flow-model.mjs', 'cliFlowModel', 'build discovery/flow-model.json'),
  diagrams: cmd('./discovery/diagrams.mjs', 'cliDiagrams', 'draw the flow, decision and branch SVGs'),
  'start-run': cmd('./recorder.mjs', 'cliStartRun', 'open one persona run (thread + player id)'),
  record: cmd('./recorder.mjs', 'cliRecord', 'send one turn and record it'),
  'finish-run': cmd('./recorder.mjs', 'cliFinishRun', 'close a persona run'),
  prechecks: cmd('./prechecks.mjs', 'cliPrechecks', 'contamination + readability + claims for one run'),
  contamination: cmd('./contamination.mjs', 'cliContamination', 'check one run for cross-run contamination'),
  readability: cmd('./readability.mjs', 'cliReadability', 'readability pre-check'),
  claims: cmd('./claims.mjs', 'cliClaims', 'claims audit against recorded tool calls'),
  'backfill-tools': cmd('./tool-logs.mjs', 'cliBackfillTools', 'fill tool calls from the skill logs, then re-run prechecks'),
  'run-verdict': cmd('./report/results.mjs', 'cliRunVerdict', 'combine grades and checks into a run verdict'),
  'tool-test': cmd('./tool-test.mjs', 'cliToolTest', 'run direct tool tests (lua test)'),
  'flow-test': cmd('./flow-test.mjs', 'cliFlowTest', 'run offline workflow flow tests (lua test workflow)'),
  stress: cmd('./stress.mjs', 'cliStress', 'run the stress plan (resumable)'),
  'log-scan': cmd('./log-scan.mjs', 'cliLogScan', 'scan agent logs inside the test window'),
  ledger: cmd('./ledger.mjs', 'cliLedger', 'list or add side-effect ledger rows'),
  cleanup: cmd('./cleanup.mjs', 'cliCleanup', 'plan (or --apply) the cleanup actions'),
  memory: cmd('./memory.mjs', 'cliMemory', 'check the agent\'s cross-chat memory features (status|off|restored)'),
  'workflow-args': cmd('./workflow/args.mjs', 'cliWorkflowArgs', 'print the Workflow tool args'),
  aggregate: cmd('./report/results.mjs', 'cliAggregate', 'write report/results.json'),
  report: cmd('./report/build.mjs', 'cliReport', 'build report.md/html (and PDF when possible)'),
});

export function usageText() {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  const rows = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`);
  return [
    'Usage: node <plugin-root>/lib/qa/cli.mjs <subcommand> [flags]',
    '',
    'Subcommands:',
    ...rows,
    '',
    'Common flags: --run-dir <path>, --json (accepted, output is always JSON), --production-consent <token>,',
    `  --timeout <seconds> (${TIMEOUT_MIN}-${TIMEOUT_MAX}; ${TIMEOUT_SUBCOMMANDS.join(', ')} only): stop the call and any lua`,
    '  it started after that long. Use it instead of a `timeout` wrapper, which macOS does not have and which the',
    '  permission rule does not match.',
    '',
  ].join('\n');
}

/** `--json` is a common flag that is accepted and ignored (output is always JSON). A leading `--json`,
 * or a trailing one that does not follow another flag (where it could be that flag's value), is
 * dropped; handlers that list `json` in their own spec accept any other position. */
export function dropJsonFlag(argv) {
  const rest = [...argv];
  while (rest[0] === '--json') rest.shift();
  while (rest.length && rest[rest.length - 1] === '--json' && !String(rest[rest.length - 2] ?? '').startsWith('--')) rest.pop();
  return rest;
}

export const TIMEOUT_MIN = 5;
export const TIMEOUT_MAX = 115;
/**
 * Subcommands that may be stopped part-way: each is resumable or rewrites its output whole, so the next call carries
 * on. `record`, `start-run`, `finish-run`, `gate`, `cards` and the rest are refused: stopping `record` after the chat
 * reached the agent but before the turn was written would void the run.
 */
export const TIMEOUT_SUBCOMMANDS = Object.freeze(['tool-test', 'flow-test', 'stress', 'log-scan', 'prechecks', 'backfill-tools', 'discover', 'aggregate', 'report']);

/**
 * `--timeout <seconds>` (or `--timeout=<seconds>`) is a common flag: a hard wall-clock limit for the whole call,
 * applied here so every subcommand honours it. Returns the argv without it and the limit in ms (null when absent).
 */
export function takeTimeoutFlag(argv) {
  const rest = [];
  let seconds = null;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--timeout' || (typeof tok === 'string' && tok.startsWith('--timeout='))) {
      const raw = tok === '--timeout' ? argv[++i] : tok.slice('--timeout='.length);
      const n = Number(raw);
      if (raw === undefined || raw === '' || !Number.isFinite(n) || n < TIMEOUT_MIN || n > TIMEOUT_MAX) {
        throw new QaError('USAGE', 2, `--timeout needs a number of seconds from ${TIMEOUT_MIN} to ${TIMEOUT_MAX}`, 'Each call stays under 120 s; long jobs are resumable, so run the same command again.');
      }
      seconds = n;
      continue;
    }
    rest.push(tok);
  }
  return { argv: rest, timeoutMs: seconds === null ? null : seconds * 1000 };
}

export function defaultIo() {
  return { out: process.stdout, err: process.stderr, cwd: process.cwd(), env: process.env };
}

/** `commands` is injectable for tests only; the entry guard always routes through COMMANDS. */
export async function main(argv, io = defaultIo(), deps = {}, commands = COMMANDS) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help' || !Object.hasOwn(commands, sub)) {
    io.err.write(usageText());
    return fail(io, new QaError('USAGE', 2, sub && !['--help', '-h', 'help'].includes(sub)
      ? `Unknown subcommand "${String(sub).slice(0, 40)}"`
      : 'A subcommand is required', 'See the subcommand list above.'));
  }
  const { module, fn } = commands[sub];
  let timer = null;
  try {
    const { argv: args, timeoutMs } = takeTimeoutFlag(rest);
    if (timeoutMs !== null && !TIMEOUT_SUBCOMMANDS.includes(sub)) {
      throw new QaError('USAGE', 2, `--timeout is not accepted by ${sub}`, `Only ${TIMEOUT_SUBCOMMANDS.join(', ')} can be stopped part-way; ${sub} finishes on its own within 110 s.`);
    }
    const mod = await import(new URL(module, import.meta.url).href);
    if (typeof mod[fn] !== 'function') throw new QaError('INTERNAL', 5, `${module} does not export ${fn}`);
    if (timeoutMs === null) return await mod[fn](dropJsonFlag(args), io, deps);
    // Past the limit the handler's own output is dropped (one JSON object per call), its lua children are killed and
    // the entry guard exits; a resumable job picks up where it stopped on the next call.
    let timedOut = false;
    const quiet = { ...io, out: { write: (x) => (timedOut ? true : io.out.write(x)) }, err: { write: (x) => (timedOut ? true : io.err.write(x)) } };
    const limit = new Promise((resolveLimit) => {
      timer = setTimeout(() => {
        timedOut = true;
        (deps.killActiveChildren ?? killActiveChildren)();
        (deps.releaseHeldLocks ?? releaseHeldLocks)();
        emit(io, { ok: false, code: 'HELPER_TIMEOUT', message: `${sub} did not finish within --timeout ${timeoutMs / 1000} s and was stopped`, hint: 'Run the same command again: long jobs are resumable.' });
        io.timedOut = true;
        resolveLimit(5);
      }, timeoutMs);
    });
    return await Promise.race([mod[fn](dropJsonFlag(args), quiet, deps), limit]);
  } catch (err) {
    return fail(io, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* istanbul ignore next */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const io = defaultIo();
  main(process.argv.slice(2), io).then((c) => {
    process.exitCode = c;
    // A timed-out handler may still hold timers or sockets: leave now, with the timeout already reported.
    if (io.timedOut) process.exit(c);
  });
}

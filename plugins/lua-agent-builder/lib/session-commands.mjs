// Live Build Sessions (spec v3 B23): the lua-cli command classes, VENDORED.
//
// SOURCE OF TRUTH: lua-core-services `packages/shared-types/src/build-sessions/commands.ts`
// (`BUILD_SESSION_COMMAND_RULES`, `classifyLuaCommand`) and `packages/shared-types/src/secret-scrub.ts`
// (`WORKFLOW_SECRET_KEY_RE`), as of commit 7c53151b5171501383980f873536bd9ec52ea8b7 on `feat/live-build-sessions`
// (`--operations` takes a value; the `build-session` rows), plus the `features.stage` / `models.stage` and
// `webhooks.keys` rows of `main` 7c590f79b1d6b5845a21d7e808153d263e1cec17, and the `shared-data` rows of
// `feat/agent-record-handoff` (lua-core-services, typed agent-to-agent hand-offs). This mirror is deliberately STRICTER than that commit in
// one way, kept from lua-core-services b4be3b9b (branch `feat/lbs/plugin-session-mode`, not yet on the integration
// branch): action words match case-insensitively and the `devices` credential aliases `credentials` / `key` are
// listed, like lua-cli `normalizeArg`. This plugin is a public repository of plain ESM with no dependency on the private
// monorepo (or zod), so the table is mirrored here line for line. test/lib/session-commands.test.mjs carries the
// shared spec's tables verbatim as a parity fixture: when the shared table changes, port the change here and the
// new spec rows there. coding-harness `session-mode.ts` uses the same mirror-plus-parity pattern.
//
// The rule: reads run directly; session-scoped writes go to the session's private store / test version; anything
// that changes production becomes an ACTION REQUEST the user approves in Lua Desktop; secret VALUES are typed by
// the user in Lua Desktop, never by Claude. This classifier serves the plugin's session-mode hook only. It is NOT
// the boundary: the session's :8092 Lua-API proxy decides what reaches the platform.

export const BUILD_SESSION_COMMAND_CLASSES = Object.freeze([
  'direct_read',
  'session_write',
  'approval',
  'secret',
  'unavailable',
]);

/** shared-types secret-scrub.ts `WORKFLOW_SECRET_KEY_RE` (verbatim). */
export const WORKFLOW_SECRET_KEY_RE =
  /(^|[_\-.\s])(secret|token|password|passwd|pwd|passphrase|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|authorization|auth[_-]?token|access[_-]?token|id[_-]?token|refresh[_-]?token|session[_-]?key|credential(s)?)([_\-.\s]|$)|^(secret|token|password|passwd|pwd|passphrase|apikey|authorization|credentials?)$/i;

/** @param {string} key */
export function isSecretKeyName(key) {
  return WORKFLOW_SECRET_KEY_RE.test(String(key));
}

const hasFlag =
  (...flags) =>
  (argv) =>
    argv.some((a) => flags.includes(a) || flags.some((f) => a.startsWith(`${f}=`)));

/**
 * @param {readonly string[]} argv
 * @param {...string} flags
 * @returns {string|undefined}
 */
export function flagValue(argv, ...flags) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    for (const f of flags) {
      if (a === f) return argv[i + 1];
      if (a.startsWith(`${f}=`)) return a.slice(f.length + 1);
    }
  }
  return undefined;
}

/** `lua chat -e <env>` / `--env <env>`; sandbox when absent. */
function chatEnv(argv) {
  return (flagValue(argv, '-e', '--env') ?? 'sandbox').toLowerCase();
}

/** `lua env … -k KEY -v VALUE`: a value write. Secret-shaped key → the user types it in Desktop. */
function isEnvValueWrite(argv) {
  return hasFlag('-v', '--value')(argv);
}
function isEnvSecretWrite(argv) {
  if (!isEnvValueWrite(argv)) return false;
  const key = flagValue(argv, '-k', '--key');
  return key === undefined || isSecretKeyName(key);
}

const READ_VERBS = ['list', 'ls', 'show', 'view', 'get', 'status', 'versions', 'inspect', 'logs', 'info'];

/** Environment names some commands take before their verb (`lua skills production view`, `lua persona sandbox`). */
const ENV_TOKENS = ['sandbox', 'staging', 'production', 'dev'];

/** Flags known to take a value. A flag NOT listed here is boolean: its next token counts as a positional. */
const VALUE_TAKING_FLAGS = [
  '-e', '--env', '--environment', '-m', '--message', '-k', '--key', '-v', '--value', '-t', '--thread', '--input',
  '--name', '--agent', '--agent-id', '--type', '--limit', '--page', '--since', '--until', '--user-id', '--channel',
  '--execution-id', '--run-id', '-i', '--workflow-name', '-r', '--status', '--workflow', '--cursor', '--sort',
  '--tag', '--device-name', '--operations', '--group', '--payload', '--command', '--trigger', '--timeout', '--out', '--org',
  '--integration', '--scope', '--connection-id', '--connection', '--webhook-id', '--template-id', '--skill-name',
  '--query', '--version-id', '--model', '--reason', '--direction', '--batch-id', '--id', '--file', '--path',
];

/** Tokens that change something outside the session: a read / session-write match becomes `approval`. */
const MUTATING_TOKENS = [
  'activate', 'deactivate', 'publish', 'apply', 'install', 'uninstall', 'connect', 'disconnect', 'convert',
  'subscribe', 'unsubscribe', 'create', 'add', 'set', 'unset', 'update', 'start', 'approve', 'signal', 'resume',
  'cancel', 'pause', 'promote', 'deploy', 'rotate-secret', 'rotate-token', 'issue', 'enable', 'disable',
  'configure', 'transfer', 'replay', 'retry-step', 'resolve-step', 'raise-budget', 'test-trigger',
];
/** Destructive tokens: `approval` with `critical` risk wherever they appear ("any delete" in B23). */
const DESTRUCTIVE_TOKENS = ['delete', 'remove', 'rm', 'destroy', 'purge'];
/** Tokens whose approval is `high` risk (production changes / releases). */
const HIGH_RISK_TOKENS = ['deploy', 'promote', 'publish', 'apply', 'install', 'transfer', 'rotate-secret', 'rotate-token'];

/**
 * Positional tokens after `skip` leading tokens: flags and the values of known value-taking flags removed. Tokens are
 * LOWERCASED: lua-cli `normalizeArg` (src/utils/aliases.ts) matches action words case-insensitively, so
 * `lua devices CREDENTIAL` is the credential verb and `lua skills DELETE` is a delete. Flag values (`-k KEY`,
 * `--out <file>`) are read with `flagValue` from the raw argv and keep their case.
 */
function positionals(argv, skip) {
  const out = [];
  for (let i = skip; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) {
      if (!a.includes('=') && VALUE_TAKING_FLAGS.includes(a)) i++;
      continue;
    }
    out.push(a.toLowerCase());
  }
  return out;
}

const isRestore = (argv) => hasFlag('--restore-sources', '--restore')(argv);

const POD_IDENTITY_NOTE = "The session's identity is the pod key.";

/**
 * B23 table as data. Order matters: specific rows before generic ones; every known command ends in a catch-all.
 * @type {ReadonlyArray<{id: string, path: string[], verbs?: string[], bareOk?: boolean,
 *   when?: (argv: string[]) => boolean, class: string, risk?: string, note?: string}>}
 */
export const BUILD_SESSION_COMMAND_RULES = Object.freeze([
  // ── not available ──
  { id: 'auth', path: ['auth'], class: 'unavailable', note: POD_IDENTITY_NOTE },
  { id: 'configure', path: ['configure'], class: 'unavailable', note: POD_IDENTITY_NOTE },
  { id: 'login', path: ['login'], class: 'unavailable', note: POD_IDENTITY_NOTE },
  { id: 'logout', path: ['logout'], class: 'unavailable', note: POD_IDENTITY_NOTE },
  { id: 'admin', path: ['admin'], class: 'unavailable', note: 'Admin commands are not available in a session.' },
  { id: 'docs', path: ['docs'], class: 'unavailable', note: 'Opens a browser; use the lua-docs MCP instead.' },
  { id: 'update', path: ['update'], class: 'unavailable', note: "The CLI version is the session image's." },
  { id: 'destroy', path: ['destroy'], class: 'unavailable', note: 'Not available in a session.' },
  { id: 'telemetry', path: ['telemetry'], class: 'unavailable', note: 'Local CLI setting; fixed in the session image.' },
  { id: 'completion', path: ['completion'], class: 'unavailable', note: 'Shell completion is not needed in a session.' },
  // `lua build-session` drives sessions from a terminal (B24). Inside a session pod it would let Claude start, end,
  // send to or approve the release of sessions, skipping the Desktop approval B12/B23 require: only the read is
  // allowed. Claude's own session tools are the lua-session MCP tools (request_release, test_chat).
  { id: 'build-session.read', path: ['build-session'], verbs: ['status'], class: 'direct_read', note: 'Reads the session row.' },
  {
    id: 'build-session',
    path: ['build-session'],
    class: 'unavailable',
    note: 'Sessions are started, released and ended by the user in Lua Desktop; inside a session use the lua-session tools.',
  },

  // ── env: names-only list is a read; value writes are secret or approval; deletes approval ──
  { id: 'env.list', path: ['env'], when: hasFlag('--list', '-l'), class: 'direct_read', note: 'Names only.' },
  { id: 'env.delete', path: ['env'], when: hasFlag('--delete', '-d'), class: 'approval', risk: 'high' },
  { id: 'env.secret', path: ['env'], when: isEnvSecretWrite, class: 'secret', risk: 'high' },
  { id: 'env.set', path: ['env'], when: isEnvValueWrite, class: 'approval', risk: 'medium' },
  { id: 'env.other', path: ['env'], class: 'approval', risk: 'medium' },

  // ── chat: sandbox → session test version; anything else talks to the live agent ──
  {
    id: 'chat.sandbox',
    path: ['chat'],
    when: (argv) => chatEnv(argv) === 'sandbox',
    class: 'session_write',
    note: 'Routed to the session test version with shadow data and recorded calls.',
  },
  { id: 'chat.live', path: ['chat'], class: 'approval', risk: 'medium' },

  // ── session-scoped writes ──
  {
    id: 'push.auto_deploy',
    path: ['push'],
    when: hasFlag('--auto-deploy'),
    class: 'approval',
    risk: 'high',
    note: 'Deploying becomes a release (B12).',
  },
  { id: 'push', path: ['push'], class: 'session_write' },
  { id: 'sync', path: ['sync'], class: 'session_write' },
  { id: 'init.restore', path: ['init'], when: isRestore, class: 'session_write', note: 'Restores the session tree.' },
  { id: 'init', path: ['init'], class: 'approval', risk: 'medium', note: 'Creates or duplicates an agent.' },
  { id: 'compile', path: ['compile'], class: 'direct_read' },
  { id: 'status', path: ['status'], class: 'direct_read' },
  { id: 'test.workflow', path: ['test', 'workflow'], class: 'session_write' },
  { id: 'test', path: ['test'], class: 'direct_read', note: 'Offline.' },
  { id: 'apps.preview', path: ['apps', 'preview'], class: 'session_write' },
  { id: 'apps.local', path: ['apps'], verbs: ['new', 'dev', 'upgrade'], class: 'session_write' },
  { id: 'apps.read', path: ['apps'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'evals.run', path: ['evals', 'run'], class: 'session_write', note: 'Against the session test version.' },
  { id: 'evals.read', path: ['evals'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },

  // ── deploy / promote → the B12 release flow ──
  { id: 'deploy', path: ['deploy'], class: 'approval', risk: 'high', note: 'Becomes a release (B12).' },
  { id: 'version.promote', path: ['version', 'promote'], class: 'approval', risk: 'high', note: 'Puts that version back live.' },
  { id: 'version.create', path: ['version', 'create'], class: 'approval', risk: 'medium', note: 'Use stage_for_test.' },
  { id: 'version.read', path: ['version'], verbs: ['list', 'show', 'diff', 'status'], bareOk: true, class: 'direct_read' },

  // ── reads ──
  { id: 'logs', path: ['logs'], class: 'direct_read', note: 'Output is fenced as untrusted data.' },
  {
    id: 'workflows.read',
    path: ['workflows'],
    verbs: ['list', 'status', 'runs', 'job-logs', 'logs', 'watch', 'show', 'inspect', 'approval-payload'],
    bareOk: true,
    class: 'direct_read',
  },
  {
    id: 'workflows.live',
    path: ['workflows'],
    verbs: ['start', 'run', 'approve', 'signal', 'resume', 'cancel', 'replay', 'retry-step', 'resolve-step'],
    class: 'approval',
    risk: 'medium',
  },
  { id: 'source.read', path: ['source'], verbs: ['list', 'show', 'diff'], bareOk: true, class: 'direct_read' },
  {
    id: 'integrations.read',
    path: ['integrations'],
    verbs: ['list', 'available', 'info', 'inspect', 'connections', 'catalog', 'requests', 'webhooks', 'triggers', 'mcp', 'events'],
    bareOk: true,
    class: 'direct_read',
  },
  {
    id: 'integrations.write',
    path: ['integrations'],
    verbs: ['connect', 'update', 'disconnect', 'convert'],
    class: 'approval',
    risk: 'medium',
    note: 'OAuth connect returns a link the user completes in the browser from Desktop.',
  },
  { id: 'decisions.read', path: ['decisions'], verbs: ['list', 'versions', 'show'], bareOk: true, class: 'direct_read' },
  { id: 'decisions.run', path: ['decisions', 'run'], class: 'session_write' },
  { id: 'persona.read', path: ['persona'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'skills.read', path: ['skills'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'webhooks.read', path: ['webhooks'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  // A webhook key is shown once, to the owner: never routed through a session approval, whose result reaches the pod.
  {
    id: 'webhooks.keys',
    path: ['webhooks'],
    verbs: ['protect', 'rotate-key', 'revoke-key', 'unprotect'],
    class: 'unavailable',
    note: "Webhook keys belong to the agent's owner and are shown only to them. Tell the user to run this after the release.",
  },
  { id: 'triggers.read', path: ['triggers'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'jobs.read', path: ['jobs'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'preprocessors.read', path: ['preprocessors'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'postprocessors.read', path: ['postprocessors'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'mcp.read', path: ['mcp'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'channels.read', path: ['channels'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'resources.read', path: ['resources'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'production.read', path: ['production'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'features.read', path: ['features'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'models.read', path: ['models'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  // Staged with the session (lua-api's session view) and released with it, never a live change.
  { id: 'features.stage', path: ['features'], verbs: ['enable', 'disable', 'configure'], class: 'session_write' },
  { id: 'models.stage', path: ['models'], verbs: ['set', 'unset'], class: 'session_write' },
  { id: 'governance.read', path: ['governance'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'browsers.read', path: ['browsers'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'agents.read', path: ['agents'], verbs: READ_VERBS, bareOk: true, class: 'direct_read' },
  { id: 'devices.read', path: ['devices'], verbs: ['list', 'logs', 'show', 'status'], bareOk: true, class: 'direct_read' },
  {
    id: 'devices.credential',
    path: ['devices'],
    // lua-cli `devices.action` aliases: `credentials` and `key` both normalise to `credential`.
    verbs: ['credential', 'credentials', 'key', 'issue', 'token', 'rotate'],
    class: 'secret',
    risk: 'high',
    note: 'Credentials are issued to the user in Desktop, never into the pod.',
  },
  { id: 'drains.read', path: ['drains'], verbs: ['list', 'status', 'deliveries', 'show'], bareOk: true, class: 'direct_read' },
  // org-shared Data collections (typed agent-to-agent hand-offs): list reads; create / update are cards (catch-all)
  { id: 'shared-data.read', path: ['shared-data'], verbs: ['list'], bareOk: true, class: 'direct_read' },
  {
    id: 'marketplace.read',
    path: ['marketplace'],
    when: (a) => {
      const pos = positionals(a, 1);
      const verb = pos[1] ?? pos[0];
      return (
        verb === undefined ||
        ['view', 'versions', 'status', 'health', 'installed', 'list', 'search', 'show', 'skill', 'template'].includes(verb)
      );
    },
    class: 'direct_read',
  },

  // ── catch-alls: every other verb of a known command is an approval (never `default`) ──
  ...[
    'apps', 'evals', 'version', 'workflows', 'source', 'integrations', 'decisions', 'persona', 'skills', 'webhooks',
    'triggers', 'jobs', 'preprocessors', 'postprocessors', 'mcp', 'channels', 'resources', 'production', 'features',
    'models', 'governance', 'browsers', 'browser', 'agents', 'devices', 'drains', 'shared-data', 'marketplace', 'voice',
  ].map((cmd) => ({ id: `${cmd}.write`, path: [cmd], class: 'approval' })),
]);

/**
 * Normalise an argv: drop a leading `npx` and a leading `lua` / `lua-cli`.
 * @param {readonly unknown[]} argv
 * @returns {string[]}
 */
export function normaliseLuaArgv(argv) {
  const out = (Array.isArray(argv) ? argv : []).filter((a) => typeof a === 'string');
  if (out[0] === 'npx') out.shift();
  if (out[0] === 'lua' || out[0] === 'lua-cli') out.shift();
  return out;
}

function ruleMatches(rule, argv) {
  if (argv.length < rule.path.length) return false;
  for (let i = 0; i < rule.path.length; i++) if (argv[i].toLowerCase() !== rule.path[i]) return false;
  if (rule.verbs) {
    // The verb is the first positional after the path, skipping a leading environment name.
    const verb = positionals(argv, rule.path.length).find((t) => !ENV_TOKENS.includes(t));
    if (verb === undefined) {
      if (!rule.bareOk) return false;
    } else if (!rule.verbs.includes(verb)) {
      return false;
    }
  }
  if (rule.when && !rule.when(argv)) return false;
  return true;
}

function tokenRisk(pos) {
  if (pos.some((t) => DESTRUCTIVE_TOKENS.includes(t))) return 'critical';
  if (pos.some((t) => HIGH_RISK_TOKENS.includes(t))) return 'high';
  return 'medium';
}

/**
 * Classify a lua-cli invocation (shared-types `classifyLuaCommand`). A destructive token (`delete`, `remove`, …)
 * makes any match `approval` / `critical`; a mutating token makes a read or session-write match `approval`.
 * Unknown → `approval` / `high`.
 *
 * @param {readonly unknown[]} rawArgv
 * @returns {{class: string, ruleId: string, risk?: string, note?: string}}
 */
export function classifyLuaCommand(rawArgv) {
  const argv = normaliseLuaArgv(rawArgv);
  const pos = positionals(argv, 0);
  const destructive = pos.some((t) => DESTRUCTIVE_TOKENS.includes(t)) || hasFlag('--delete')(argv);
  for (const rule of BUILD_SESSION_COMMAND_RULES) {
    if (!ruleMatches(rule, argv)) continue;
    if (rule.class === 'unavailable') return { class: 'unavailable', ruleId: rule.id, note: rule.note };
    const after = positionals(argv, rule.path.length);
    if (destructive) {
      return { class: 'approval', ruleId: rule.class === 'approval' ? rule.id : `${rule.id}+delete`, risk: 'critical' };
    }
    // A rule's own verbs are what it classifies (`lua features disable` is staged); any other mutating word escalates.
    if (
      (rule.class === 'direct_read' || rule.class === 'session_write') &&
      after.some((t) => MUTATING_TOKENS.includes(t) && !rule.verbs?.includes(t))
    ) {
      return { class: 'approval', ruleId: `${rule.id}+mutating`, risk: tokenRisk(after) };
    }
    const out = { class: rule.class, ruleId: rule.id };
    if (rule.risk) out.risk = rule.risk;
    else if (rule.class === 'approval' || rule.class === 'secret') out.risk = tokenRisk(after);
    if (rule.note) out.note = rule.note;
    return out;
  }
  return { class: 'approval', ruleId: 'default', risk: destructive ? 'critical' : 'high' };
}

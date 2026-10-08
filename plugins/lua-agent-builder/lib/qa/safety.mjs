// Enforcement core for the /lua-qa runtime: env scrub, test-data policy,
// secret redaction and the allowlist of `lua` argument shapes.
//
// Why this exists: `lua chat -e sandbox` uploads the child's whole process environment as the
// sandbox skill versions' env (kept ~24 h), and a node child bypasses the Bash permission layer
// and the confirm-deploy hook. So safety has to be code, not advice.

import { QaError } from './io.mjs';
import { classifyProductionCommand } from '../tokenizer.mjs';

export const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TERM', 'TZ', 'NO_COLOR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'LUA_API_URL', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SystemDrive', 'WINDIR',
  'ComSpec', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMDATA', 'ProgramFiles',
]);

const PROXY_KEYS = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']);

function proxyHasUserinfo(value) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(String(value).trim());
  const authority = m ? m[1] : String(value).split('/')[0];
  return authority.includes('@');
}

/** New object holding only allow-listed keys. LUA_API_KEY and every other secret are dropped. */
export function scrubEnv(env = {}) {
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    const v = env[key];
    if (typeof v !== 'string') continue;
    if (PROXY_KEYS.has(key) && proxyHasUserinfo(v)) continue;
    out[key] = v;
  }
  return out;
}

/**
 * envOnly is true when the only credential is LUA_API_KEY in the shell environment (no stored session,
 * no credentials file): a scrubbed child then has nothing to authenticate with.
 */
export function credentialRisk({ credentialSource, dotenvKeys = [], hasStoredCredential = false } = {}) {
  const warnings = [];
  const envOnly = credentialSource === 'env' && !hasStoredCredential;
  if (envOnly) {
    warnings.push('The only credential is LUA_API_KEY in the environment. QA chats run with a scrubbed environment, so they cannot use it. Log in with `lua auth configure` in your own terminal (the session is stored under HOME), or run /lua-auth.');
  }
  if (dotenvKeys.includes('LUA_API_KEY')) {
    warnings.push('The project .env holds LUA_API_KEY. lua-cli loads .env itself and uploads it to the sandbox whatever the scrub does. Remove it from .env and use the stored session instead.');
  }
  const others = dotenvKeys.filter((k) => k !== 'LUA_API_KEY');
  if (others.length > 0) {
    warnings.push(`The project .env defines ${others.length} key(s) (${others.slice(0, 8).join(', ')}). Sandbox chat uploads .env values to the platform; use throwaway test values only.`);
  }
  return { envOnly, warnings };
}

// ---------------------------------------------------------------- test-data policy

// The local part takes every RFC 5322 atext character, so jane=test.1@acme.com is seen whole, never as test.1@acme.com.
const EMAIL_RE = /[A-Z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /https?:\/\/([^\s/:?#)"'<>\]\\]+)/gi;
const PHONE_RE = /(?<![\w.])(\+?\d[\d\s-]{8,18}\d)(?![\w])/g;
const EXAMPLE_HOSTS = ['example.com', 'example.org', 'example.net'];

// A company domain the user agreed to at the environment gate is accepted only with an obviously fake local part,
// so a test can reach a tool that refuses @example.* (a password reset that only takes @acme-corp.test) without
// ever naming a real employee: qa.reset.01@acme-corp.test passes, jane.smith@acme-corp.test does not.
export const FAKE_LOCAL_PART_RE = /^(?:qa|test|testing|tester|testuser|fake|dummy|sample|example|demo|noreply|no-reply)(?:$|[._+-]|\d)/i;
// Public mailbox providers are never an agreed email domain: test01@gmail.com is somebody's real inbox.
export const PUBLIC_MAIL_DOMAINS = Object.freeze([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'mail.com',
  'yandex.com', 'yandex.ru', 'zoho.com', 'qq.com', '163.com', 'web.de', 'hey.com', 'fastmail.com', 'mail.ru',
]);
// Public mailbox provider families: refused on every TLD and country suffix (yahoo.co.uk, outlook.de, gmx.at ...).
export const PUBLIC_MAIL_FAMILIES = Object.freeze([
  'gmail', 'googlemail', 'yahoo', 'ymail', 'rocketmail', 'hotmail', 'outlook', 'live', 'msn', 'aol', 'aim', 'icloud',
  'gmx', 'web', 'yandex', 'mail', 'inbox', 'proton', 'protonmail', 'zoho', 'zohomail', 'qq', '163', '126', 'sina',
  't-online', 'tutanota', 'tuta', 'tutamail', 'duck', 'fastmail', 'hey', 'rediffmail', 'seznam', 'libero', 'orange',
  'free', 'laposte', 'wp', 'o2', 'interia', 'onet', 'freenet', 'arcor', 'bluewin', 'virgilio', 'tiscali', 'btinternet',
  'sky', 'mailbox', 'posteo', 'runbox', 'naver', 'daum', 'hanmail', 'rambler', 'ukr', 'abv', 'bol', 'uol', 'terra',
]);
// Second-level labels under a two-letter country TLD (yahoo.co.uk, yahoo.com.br): the provider is the label before.
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ne', 'or', 'go', 'gen', 'ltd', 'plc']);

/** The registrable label of a domain: `yahoo` for mail.yahoo.co.uk, `acme-corp` for mail.acme-corp.test. */
export function registrableLabel(domain) {
  const labels = String(domain ?? '').split('.').filter(Boolean);
  if (labels.length < 2) return labels[0] ?? '';
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(second)) return labels[labels.length - 3];
  return second;
}

/** True for a public mailbox provider: an exact listed domain, or a provider family on any TLD. */
export function isPublicMailDomain(domain) {
  const d = String(domain ?? '').toLowerCase();
  return PUBLIC_MAIL_DOMAINS.includes(d) || PUBLIC_MAIL_FAMILIES.includes(registrableLabel(d));
}
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const normDomain = (d) => String(d ?? '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');

function isExampleEmailDomain(d) {
  return EXAMPLE_HOSTS.includes(d) || d.endsWith('.example');
}

/**
 * Parses the agreed email domains (a list or a comma-separated string). Throws QaError USAGE (2) for a malformed
 * domain and EMAIL_DOMAIN_REFUSED (3) for a public mailbox provider. Example domains are dropped (always allowed).
 * @returns {string[]}
 */
export function parseAllowedEmailDomains(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const out = [];
  for (const item of raw) {
    const d = normDomain(item);
    if (!d) continue;
    if (!DOMAIN_RE.test(d)) throw new QaError('USAGE', 2, `"${String(item).slice(0, 80)}" is not a domain name`, 'Pass bare domains such as acme-corp.test, comma separated.');
    if (isPublicMailDomain(d)) {
      throw new QaError('EMAIL_DOMAIN_REFUSED', 3, `${d} is a public mailbox provider and cannot be a test email domain`, 'Only the company domain a tool insists on can be agreed; everything else stays @example.com.');
    }
    if (!isExampleEmailDomain(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

/** The test-data policy of a run: URL hosts from run.json, email domains only from the environment-gate stamp. */
export function testDataPolicy(run, state) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return { allowedDomains: arr(run?.allowedDomains), allowedEmailDomains: arr(state?.gates?.environment?.allowedEmailDomains).map(normDomain) };
}

/** null when the address is fake test data, else the reason it is not. */
export function emailProblem(address, allowedEmailDomains = []) {
  const at = String(address).lastIndexOf('@');
  // Leading punctuation is markup or quoting around the address ('qa.01@..., **qa.01@...**), not its first letter.
  const local = String(address).slice(0, at).replace(/^[^A-Z0-9]+/i, '');
  const d = normDomain(String(address).slice(at + 1));
  if (isExampleEmailDomain(d)) return null;
  if (!allowedEmailDomains.map(normDomain).includes(d)) return 'not an example.* domain or an agreed email domain';
  return FAKE_LOCAL_PART_RE.test(local) ? null : `the local part on ${d} must look fake (start with qa, test, fake, dummy, sample or demo)`;
}

function urlHostOk(host, allowed) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (EXAMPLE_HOSTS.some((e) => h === e || h.endsWith(`.${e}`))) return true;
  return allowed.some((a) => {
    const x = String(a).toLowerCase();
    return h === x || h.endsWith(`.${x}`);
  });
}

function phoneIsFake(raw) {
  const digits = raw.replace(/\D/g, '');
  if (/^07700900\d{3}$/.test(digits) || /^447700900\d{3}$/.test(digits)) return true;
  if (/555[\s-]?01\d\d/.test(raw)) return true;
  return false;
}

/**
 * Emails must be @example.{com,org,net} (or .example), or carry an obviously fake local part on an email domain the
 * user agreed to at the environment gate; URL hosts must be example.* or allow-listed.
 * Phone-shaped strings outside the drama ranges only warn.
 */
export function checkTestData(text, { allowedDomains = [], allowedEmailDomains = [] } = {}) {
  const violations = [];
  const warnings = [];
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  for (const m of s.matchAll(EMAIL_RE)) {
    const reason = emailProblem(m[0], allowedEmailDomains);
    if (reason) violations.push({ kind: 'email', value: m[0], reason });
  }
  for (const m of s.matchAll(URL_RE)) {
    if (!urlHostOk(m[1], allowedDomains)) violations.push({ kind: 'url', value: m[0] });
  }
  for (const m of s.matchAll(PHONE_RE)) {
    const raw = m[1];
    const digits = raw.replace(/\D/g, '');
    if (!(raw.startsWith('+') || raw.startsWith('0'))) continue;
    if (digits.length < 10 || digits.length > 13) continue;
    if (!/[\s-]/.test(raw) && !raw.startsWith('+')) continue; // an unbroken digit run is an id, not a phone
    if (phoneIsFake(raw)) continue;
    warnings.push({ kind: 'phone', value: raw });
  }
  return { ok: violations.length === 0, violations, warnings };
}

/** The hint for a REAL_EMAIL / REAL_URL refusal, naming the agreed domains when there are any. */
export function fakeDataHint(policy = {}) {
  const doms = Array.isArray(policy.allowedEmailDomains) ? policy.allowedEmailDomains : [];
  return doms.length
    ? `Use @example.com addresses, or a qa./test. address on ${doms.join(', ')}, and example.com links.`
    : 'Use @example.com addresses and example.com links.';
}

// ---------------------------------------------------------------- secret redaction

const REDACTIONS = [
  ['stripe-key', /sk_(?:live|test)_[A-Za-z0-9]{8,}/g],
  ['lua-key', /api_[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}/g],
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g],
  ['aws-key', /AKIA[0-9A-Z]{16}/g],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/g],
  ['slack-token', /xox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['bearer', /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  ['password-assign', /\b(?:password|passwd|pwd|secret|token)\s*[:=]\s*\S+/gi],
];

export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return { text: typeof text === 'string' ? text : '', redactions: [] };
  let out = text;
  const redactions = [];
  for (const [kind, re] of REDACTIONS) {
    out = out.replace(re, () => {
      redactions.push({ kind });
      return `[REDACTED:${kind}]`;
    });
  }
  return { text: out, redactions };
}

/** Recursive redaction over strings in objects/arrays. Returns a copy. */
export function redactDeep(value) {
  if (typeof value === 'string') return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- lua argv allowlist

export function shellQuote(argv) {
  return argv
    .map((a) => {
      const s = String(a);
      return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}

const THREAD_ARG = /^qa-[A-Za-z0-9-]{1,61}$/;
const NAME_ARG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const ENV_ARG = ['sandbox', 'production'];
const ISO_ARG = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/;
const TEST_TYPES = ['skill', 'webhook', 'job', 'preprocessor', 'postprocessor'];
const AUTO_FLAG = ['--auto', 'deploy'].join('-');

const isMsg = (m) => typeof m === 'string' && m.length > 0 && m.length <= 8000 && !m.includes('\0');
const isJson = (s) => {
  if (typeof s !== 'string' || s.length > 100_000) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

function equalsAll(argv, expected) {
  return argv.length === expected.length && expected.every((e, i) => argv[i] === e);
}

/** Two exact shapes: the window scan (`--type all --limit 100`) and the tool-call fetch (`--type skill --limit 200`). */
const LOG_SHAPES = Object.freeze([['all', '100'], ['skill', '200']]);

function matchLogs(argv) {
  return argv.length === 13
    && argv[1] === '--ci' && argv[2] === '--type'
    && LOG_SHAPES.some(([type, limit]) => argv[3] === type && argv[11] === limit)
    && argv[4] === '--since' && ISO_ARG.test(argv[5])
    && argv[6] === '--until' && ISO_ARG.test(argv[7])
    && argv[8] === '--environment' && ENV_ARG.includes(argv[9])
    && argv[10] === '--limit' && argv[12] === '--json';
}

function matchChat(r) {
  if (r[0] === 'clear') {
    return r.length === 4 && r[1] === '-t' && THREAD_ARG.test(r[2]) && r[3] === '--force';
  }
  if (r[0] !== '--ci') return false;
  if (r[1] === '-e') {
    if (!ENV_ARG.includes(r[2])) return false;
    if (r[3] === '-m') return r.length === 7 && isMsg(r[4]) && r[5] === '-t' && THREAD_ARG.test(r[6]);
    if (r[3] === '-b') {
      const dIdx = r.indexOf('-d', 4);
      if (dIdx < 5) return false;
      const msgs = r.slice(4, dIdx);
      return msgs.every((m) => isMsg(m) && !m.startsWith('-'))
        && /^\d{1,5}$/.test(r[dIdx + 1] ?? '')
        && r[dIdx + 2] === '-t' && THREAD_ARG.test(r[dIdx + 3] ?? '') && r.length === dIdx + 4;
    }
    return false;
  }
  if (r[1] === '--agent-version') {
    if (!/^\d{1,6}$/.test(r[2] ?? '')) return false;
    let i = 3;
    if (r[i] === '--test-session') i++;
    return r[i] === '-m' && isMsg(r[i + 1]) && r[i + 2] === '-t' && THREAD_ARG.test(r[i + 3] ?? '') && r.length === i + 4;
  }
  return false;
}

function matchTest(r) {
  if (r[0] !== '--ci') return false;
  if (TEST_TYPES.includes(r[1])) {
    return r.length === 7 && r[2] === '--name' && NAME_ARG.test(r[3]) && r[4] === '--input' && isJson(r[5]) && r[6] === '--json';
  }
  if (r[1] === 'workflow') {
    const head = r[2] === '--name' && NAME_ARG.test(r[3]) && r[4] === '--input' && isJson(r[5])
      && r[6] === '--agents' && r[7] === 'fake' && r[8] === '--fast-retries' && r[9] === '--json';
    if (!head) return false;
    const rest = r.slice(10);
    if (rest.length % 2 !== 0) return false;
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i];
      const val = rest[i + 1];
      if (flag === '--approve' || flag === '--deny') {
        if (!NAME_ARG.test(val)) return false;
      } else if (flag === '--step-output' || flag === '--signal') {
        const eq = val.indexOf('=');
        if (eq < 1 || !NAME_ARG.test(val.slice(0, eq)) || !isJson(val.slice(eq + 1))) return false;
      } else return false;
    }
    return true;
  }
  return false;
}

function matchShape(argv) {
  const [verb, ...r] = argv;
  switch (verb) {
    case '--version':
      return argv.length === 1;
    case 'compile':
      return equalsAll(argv, ['compile', '--ci']);
    case 'status':
      return equalsAll(argv, ['status', '--json', '--ci']);
    case 'features':
      // read-only: whether the agent has memory that carries across chats (memory.mjs); enable/disable stay with the user
      return equalsAll(argv, ['features', 'list', '--ci']);
    case 'version':
      return equalsAll(argv, ['version', 'list', '--json', '--ci'])
        || equalsAll(argv, ['version', 'list', '--json', '--ci', '--all']);
    case 'workflows':
      if (equalsAll(argv, ['workflows', 'list', '--json', '--ci'])
        || equalsAll(argv, ['workflows', 'list', '--json', '--ci', '--all'])) return true;
      return argv.length === 5 && argv[1] === 'view' && NAME_ARG.test(argv[2]) && argv[3] === '--json' && argv[4] === '--ci';
    case 'chat':
      return matchChat(r);
    case 'test':
      return matchTest(r);
    case 'logs':
      return matchLogs(argv);
    default:
      return false;
  }
}

/**
 * Throws QaError('LUA_ARGV_DENIED', 3) unless `argv` (without the leading `lua`) is one of the accepted shapes
 * AND the confirm-deploy classifier sees nothing production-gated in the quoted command line.
 */
export function assertAllowedLuaArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
    throw new QaError('LUA_ARGV_DENIED', 3, 'lua argv must be a non-empty array of strings', 'Only the documented lua shapes are allowed.');
  }
  if (argv.includes(AUTO_FLAG)) {
    throw new QaError('LUA_ARGV_DENIED', 3, 'lua argv refused: auto-deploy is never allowed', 'QA never deploys.');
  }
  if (!matchShape(argv)) {
    const head = `lua ${argv[0]} ${argv[1] ?? ''}`.trim().slice(0, 60);
    throw new QaError('LUA_ARGV_DENIED', 3, `${head} is not an allowed QA command shape`, 'QA helpers run only compile, status, features list, version list, workflows list/view, chat with -t, test, logs (all or skill) and chat clear for qa- threads.');
  }
  const verdict = classifyProductionCommand(`lua ${shellQuote(argv)}`);
  if (verdict) {
    throw new QaError('LUA_ARGV_DENIED', 3, `lua argv refused: classified as ${verdict.label}`, 'QA never runs a production verb.');
  }
}

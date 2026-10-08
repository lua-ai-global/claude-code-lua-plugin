// Markdown section builders for the QA report.
//
// Sections use "##" with "###" subsections, so pandoc (--shift-heading-level-by=-1) turns them into h1/h2
// exactly like the CI/CD guide. Allowed raw-HTML blocks: .lede, .numbers/.num, .honest, .pull, figure.diagram.
// Every piece of agent-sourced text goes through mdEscape (markdown context) or htmlEscape (raw HTML context).

const ZWSP = '​';

/** Breaks up `%%` so agent-sourced text can never form a chip marker. */
export function neutralise(s) {
  return String(s ?? '').replace(/%%/g, `%${ZWSP}%`).replace(/%%/g, `%${ZWSP}%`);
}

export function htmlEscape(s) {
  return neutralise(String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
}

function idSlug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

/** Escapes text for a markdown paragraph, list item or table cell. Also breaks up `%%` so text cannot forge a chip. */
export function mdEscape(s) {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\\/g, '\\\\').replace(/[`*_[\]<>|#{}~$^@&!]/g, (c) => `\\${c}`);
  t = neutralise(t);
  if (/^[-+]\s/.test(t)) t = `\\${t}`;
  if (/^\d+\.\s/.test(t)) t = t.replace('.', '\\.');
  return t;
}

/** Inline code span that is safe inside a table cell. */
export function codeSpan(s) {
  const t = neutralise(String(s ?? '').replace(/\s+/g, ' ').replace(/`/g, "'")).replace(/\|/g, '\\|').trim();
  return t ? `\`${t}\`` : '';
}

export function chip(status) {
  switch (status) {
    case 'pass':
      return '%%PASS%%';
    case 'partial':
      return '%%PARTIAL%%';
    case 'fail':
      return '%%FAIL%%';
    case 'not-in-tier':
      return 'not in this tier';
    default:
      return 'n/a';
  }
}

const TIER_MARKER = { smoke: '%%TIER_SMOKE%%', medium: '%%TIER_MEDIUM%%', 'production-ready': '%%TIER_PRODUCTION%%' };

/** The tier badge marker (build.mjs turns it into a chip in the Pass/Partial/Fail style). */
export function tierChip(tier) {
  return TIER_MARKER[tier] ?? TIER_MARKER.medium;
}

const TIER_LABEL = { smoke: 'Smoke', medium: 'Medium', 'production-ready': 'Production-ready' };

export function tierLabel(tier) {
  return TIER_LABEL[tier] ?? TIER_LABEL.medium;
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : 'n/a');
const ms = (x) => {
  if (typeof x !== 'number') return 'n/a';
  return x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`;
};
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function visibleLength(cell) {
  const text = String(cell).replace(/%%[A-Z_]+%%/g, 'Pass').replace(/\\(.)/g, '$1');
  // monospace code spans are wider than body text
  return text.includes('`') ? Math.round(text.replace(/`/g, '').length * 1.4) : text.length;
}

/**
 * Pipe table. pandoc turns the dash counts of the separator row into relative column widths, so they are
 * derived from the content: never narrower than the header word, capped so one long note cannot starve the rest.
 */
function table(headers, rows) {
  const dashes = headers.map((h, i) => {
    const lens = rows.map((r) => visibleLength(r[i] ?? ''));
    const max = lens.length ? Math.max(...lens) : 0;
    const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
    return Math.max(String(h).length + 6, Math.min(Math.round((max + avg) / 2), 40));
  });
  const sep = dashes.map((n) => '-'.repeat(n)).join('|');
  return [`| ${headers.join(' | ')} |`, `|${sep}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function bullets(items) {
  return items.map((i) => `- ${i}`).join('\n');
}

function quoteBlock(text) {
  return `> ${mdEscape(clip(text, 400))}`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many ?? `${one}s`}`;
}

export function environmentLabel(results) {
  const e = results.environment ?? {};
  if (e.kind === 'staged') return `staged agent version ${e.agentVersion ?? '?'}${e.testSession ? ' (test session)' : ''}`;
  if (e.kind === 'production') return 'production (explicit consent given)';
  return 'the sandbox';
}

function runChip(verdict) {
  if (verdict === 'PASS') return '%%PASS%%';
  if (verdict === 'FAIL') return '%%FAIL%%';
  if (verdict === 'NOT_PLAYED') return 'Not played';
  return 'Void';
}

/** "n/a: <reason>" for a value with nothing behind it (a zero denominator), never a 100% or a pass. */
export function naText(reason) {
  return `n/a: ${reason || 'not measured'}`;
}

/** A headline tile: [big text, label]. With a zero denominator the big text is n/a and the label says why. */
function ratioTile(n, d, label, reason) {
  if (!d) return ['n/a', `${label} (${naText(reason)})`];
  return [`${n} / ${d}`, label];
}

function gradeCell(g) {
  if (!g) return 'not graded';
  return mdEscape(g.toLowerCase());
}

function figure(path, alt, caption) {
  if (typeof path !== 'string' || !/^diagrams\/[A-Za-z0-9_./ -]+\.svg$/.test(path) || path.includes('..')) return '';
  const cap = caption ? `<figcaption>${htmlEscape(caption)}</figcaption>` : '';
  return `<figure class="diagram">${cap}<img src="${htmlEscape(path)}" alt="${htmlEscape(alt)}"></figure>`;
}

const LOCUS_LABEL = {
  'persona-prompt': 'Persona prompt',
  'skill-prompt': 'Skill prompt',
  'tool-description': 'Tool description',
  'tool-schema': 'Tool schema',
  preprocessor: 'Preprocessor',
  postprocessor: 'Postprocessor',
  'workflow-step': 'Workflow step',
  'approval-gate': 'Approval gate',
  'validation-schema': 'Validation schema',
  'code-guard': 'Code guard',
  'platform-gap': 'Platform gap',
  'test-artifact': 'Test artifact',
};
const MOVE_OUT_LOCI = new Set(['workflow-step', 'approval-gate', 'validation-schema', 'code-guard']);

function movesOut(c) {
  return c.movesLogicOutOfPrompt === true || MOVE_OUT_LOCI.has(c.fixLocus);
}

const icpCards = (r) => (r.cards ?? []).filter((c) => c.kind === 'icp');
const redCards = (r) => (r.cards ?? []).filter((c) => c.kind === 'redteam');

// ---------------------------------------------------------------------------
// 01 The short version
// ---------------------------------------------------------------------------

export function shortVersion(results) {
  const s = results.summary;
  const agent = results.agent?.name ?? 'The agent';
  const verb = { pass: 'passed', partial: 'passed in part', fail: 'did not pass' }[s.overall] ?? 'was tested';
  // Harness artefacts (cross-run memory, not enough evidence) never headline the report.
  const top = (results.clusters ?? []).find((c) => c.fixLocus !== 'test-artifact' && c.harnessArtefact !== true);
  const v = results.verdict;
  const parts = [
    ...(v ? [`<b>${htmlEscape(v.text)}.</b>`] : []),
    `<b>${htmlEscape(agent)}</b> ${verb} this QA pass in ${htmlEscape(environmentLabel(results))}.`,
    `${s.cards.pass} of ${s.cards.total} cards met the bar of ${results.config.passRequired} passing ${results.config.passRequired === 1 ? 'run' : 'runs'} out of ${results.config.runsPerCard}, and ${s.runs.valid} of ${s.runs.total} runs were valid${s.runs.notPlayed ? ` (${plural(s.runs.notPlayed, 'run')} not played)` : ''}.`,
  ];
  if (s.safetyVetoes > 0) parts.push(`<b>${plural(s.safetyVetoes, 'card')} hit a safety veto</b>, which fails the card whatever else happened.`);
  if (s.cards.inconclusive > 0) parts.push(`${plural(s.cards.inconclusive, 'card')} had too few valid runs to be conclusive.`);
  if (top) parts.push(`The most serious finding: ${htmlEscape(top.title)} (${htmlEscape(top.severity)}, ${plural(top.count ?? 0, 'occurrence')}${top.caveat ? `; ${htmlEscape(top.caveat)}` : ''}).`);
  else parts.push('No failure clusters were recorded.');
  parts.push(`Overall verdict: ${chip(s.overall)}`);
  if (v?.recommendation) parts.push(`<b>${htmlEscape(v.recommendation)}</b>`);
  if (results.tier === 'smoke') parts.push('A smoke run is never a release decision.');

  const unplayed = s.runs.notPlayed ? `, ${s.runs.notPlayed} not played` : '';
  const tiles = [
    s.runs.valid ? ratioTile(s.cards.pass, s.cards.total, `Cards that met the bar (${results.config.passRequired} of ${results.config.runsPerCard} runs)`, 'no cards in the plan') : ['n/a', `Cards that met the bar (${naText('no valid runs')})`],
    ratioTile(s.runs.valid, s.runs.total, `Valid runs. ${s.runs.void} voided by contamination${unplayed}`, 'no runs were planned'),
    ratioTile(s.redTeam.pass, s.redTeam.total, 'Red-team attacks the agent held against in every required run', 'no red-team cards'),
    results.scope && results.scope.stress === 'not in this tier'
      ? ['n/a', 'Reply latency under stress: not in this tier']
      : typeof s.stress.p90Ms === 'number'
        ? [ms(s.stress.p90Ms), `Reply latency p90 under stress (${s.stress.status})`]
        : ['n/a', `Reply latency p90 under stress (${naText('no stress result')})`],
    s.toolTests.total ? [`${s.toolTests.pass} / ${s.toolTests.total}`, `Direct tool tests passed. ${s.toolTests.threwOnValidInput} threw on valid input`] : ['n/a', `Direct tool tests (${naText('no tool tests')})`],
    results.scope?.flowMode === 'happy-path'
      // With nothing to test, the tile says only why: "not in this tier" is about other branches of real workflows.
      ? s.flowTests.total
        ? [`${s.flowTests.pass} / ${s.flowTests.total}`, 'Workflow happy-path tests passed (other branches: not in this tier)']
        : ['n/a', `Workflow happy-path tests (${naText(s.flowTests.naReason ?? 'no flow tests')})`]
      : typeof s.flowTests.branchCoverage === 'number'
        ? [pct(s.flowTests.branchCoverage), `Workflow branch coverage (${s.flowTests.pass} of ${s.flowTests.total} flow tests passed)`]
        : ['n/a', `Workflow branch coverage (${naText(s.flowTests.naReason ?? 'no flow tests')})`],
  ];

  const rows = icpCards(results).map((c) => [
    mdEscape(c.name),
    `${c.bar.passes} of ${c.bar.required}${c.inconclusive ? ' (inconclusive)' : ''}`,
    chip(c.chip),
    c.topDefects.length ? mdEscape(clip(c.topDefects[0], 140)) : 'None recorded',
  ]);

  return [
    '## The short version {#short-version}',
    '',
    `<div class="lede">${parts.join(' ')}</div>`,
    '',
    '<div class="numbers">',
    ...tiles.map(([b, label]) => `<div class="num"><b>${htmlEscape(b)}</b><span>${htmlEscape(label)}</span></div>`),
    '</div>',
    '',
    scopeBlock(results),
    '### Personas at a glance {#personas-glance}',
    '',
    rows.length ? table(['Persona', 'Runs passed', 'Result', 'Main defect'], rows, [3, 2, 1, 5]) : 'No persona cards ran.',
    '',
  ].join('\n');
}

function minutes(n) {
  if (typeof n !== 'number') return 'not measured';
  if (n < 90) return `${n} min`;
  return n % 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n / 60} h`;
}

/** "Scope of this test": the tier, what ran and what did not, and the time taken against the tier's budget. */
export function scopeBlock(results) {
  const sc = results.scope;
  if (!sc) return '';
  const graders = sc.graders.length > 1 ? 'Grader A, then grader B when A passes' : 'Grader A only';
  const flows = sc.flowMode === 'happy-path' ? `${sc.flowTests} (happy path only)` : `${sc.flowTests} (every branch)`;
  const elapsed = results.elapsedMinutes ?? sc.elapsedMinutes;
  const budget = `${minutes(elapsed)} of ${minutes(sc.budgetMinutes)}${sc.hardCap ? ' (hard cap)' : ''}`;
  const over = typeof elapsed === 'number' && elapsed > sc.budgetMinutes;
  const rows = [
    ['Tier', tierChip(sc.tier)],
    ['Personas', `${sc.personas} persona cards`],
    ['Red team', `${sc.redTeam} attack card${sc.redTeam === 1 ? '' : 's'}${sc.attackClasses?.length ? ` (exposed classes: ${mdEscape(sc.attackClasses.join(', '))})` : ''}`],
    ['Runs and bar', `${sc.runsPerCard} run${sc.runsPerCard === 1 ? '' : 's'} per card, ${sc.passRequired} of ${sc.runsPerCard} must pass`],
    ['Graders', graders],
    ['Tool tests', String(sc.toolTests)],
    ['Flow tests', flows],
    ['Stress', mdEscape(sc.stress)],
    ['Log scan', sc.logScan ? 'yes' : 'no'],
    ['Not run in this tier', sc.notRun.length ? mdEscape(sc.notRun.join('; ')) : 'nothing'],
    ['Time taken', `${budget}${over ? ' **over budget**' : ''}, from plan approval to the last conversation or check; grading and the report take a few minutes more`],
  ];
  return [
    '### Scope of this test {#scope}',
    '',
    table(['What', 'This run'], rows),
    '',
    '<div class="honest"><h4>How much to trust this</h4>',
    `<p>${htmlEscape(sc.confidence)}</p>`,
    '</div>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 02 What we tested
// ---------------------------------------------------------------------------

export function whatWeTested(results) {
  const d = results.diagrams ?? { flow: null, skills: {}, workflows: {} };
  const out = ['## What we tested {#what-we-tested}', ''];
  const skillNames = Object.keys(d.skills ?? {});
  const wfNames = Object.keys(d.workflows ?? {});
  out.push(
    `${mdEscape(results.agent?.name ?? 'The agent')} runs on ${mdEscape(results.agent?.model ?? 'an unreported model')}. ` +
      `Discovery found ${plural(skillNames.length, 'skill')} with a decision tree and ${plural(wfNames.length, 'graph workflow')} with a branch tree. ` +
      `The tests ran in ${mdEscape(environmentLabel(results))}.`,
    '',
    '### The agent end to end {#flow-diagram}',
    '',
  );
  const flow = d.flow ? figure(d.flow, 'Agent flow diagram') : '';
  out.push(flow || 'No flow diagram was produced for this run.', '');

  out.push('### Decision trees per skill {#decision-trees}', '');
  if (skillNames.length) {
    for (const name of skillNames) {
      out.push(figure(d.skills[name], `Decision tree for skill ${name}`, name), '');
    }
  } else out.push('No skill decision trees were produced for this run.', '');

  out.push('### Branch trees per workflow {#branch-trees}', '');
  const coverage = results.workflowCoverage ?? [];
  if (wfNames.length || coverage.length) {
    const names = [...new Set([...wfNames, ...coverage.map((w) => w.workflow)])];
    for (const name of names) {
      const fig = d.workflows?.[name] ? figure(d.workflows[name], `Branch tree for workflow ${name}`, name) : '';
      out.push(fig || `**${mdEscape(name)}**`, '');
      const wf = coverage.find((w) => w.workflow === name);
      if (wf) {
        out.push(
          table(
            ['Path', 'Flow test', 'Covered'],
            wf.paths.map((p) => [codeSpan(p.id), p.tests.length ? p.tests.map(codeSpan).join(', ') : 'none', pathCell(p, results)]),
            [2, 4, 1],
          ),
          '',
        );
      }
    }
  } else out.push('No graph workflows were found, so there are no branch trees.', '');
  return out.join('\n');
}

const happyPathOnly = (results) => results.scope?.flowMode === 'happy-path';

/** A branch-tree row: covered, failing, untested, or (smoke tests the happy path only) not in this tier. */
function pathCell(p, results) {
  if (p.covered) return '%%PASS%%';
  if (p.status === 'fail') return '%%FAIL%%';
  return happyPathOnly(results) ? 'not in this tier' : '%%PARTIAL%%';
}

// ---------------------------------------------------------------------------
// 03 Method and environment
// ---------------------------------------------------------------------------

function metricValue(m, v) {
  if (v === null || v === undefined) return 'n/a';
  if (m.unit === 'ratio') return pct(v);
  if (m.unit === 'percent') return `${Math.round(v)}%`;
  if (m.unit === 'ms') return ms(v);
  if (m.unit === 'bool') return v ? 'yes' : 'no';
  return String(Math.round(v * 1000) / 1000);
}

const oneGrader = (results) => Array.isArray(results.scope?.graders) && !results.scope.graders.includes('B');

export function method(results) {
  const c = results.config;
  const env = results.environment ?? {};
  const out = ['## Method and environment {#method}', ''];

  const q = results.qualifying ?? [];
  const inferred = q.some((x) => x.inferred);
  out.push(inferred ? '### What we assumed before testing {#qualifying}' : '### What we asked before testing {#qualifying}', '');
  if (inferred) {
    out.push('These answers were inferred by the planner from the agent\'s code, persona, skills and tools, not asked of the owner. Each one names the file and line it came from; an owner who disagrees can re-run with --interview.', '');
    out.push(table(['Assumption', 'Inferred answer', 'Source'], q.map((x) => [mdEscape(x.question), mdEscape(x.answer), x.inferred ? `inferred: ${(x.evidence ?? []).slice(0, 2).map(codeSpan).join(', ')}` : 'asked'])), '');
  } else {
    out.push(q.length ? table(['Question', 'Answer'], q.map((x) => [mdEscape(x.question), mdEscape(x.answer)]), [4, 4]) : 'No qualifying answers were recorded.', '');
  }

  out.push('### Agreed metrics and results {#metrics}', '');
  const metrics = results.metrics ?? [];
  out.push(
    metrics.length
      ? table(
          ['Metric', 'Target', 'Actual', 'Result'],
          metrics.map((m) => [mdEscape(m.label), mdEscape(`${m.comparator} ${metricValue(m, m.target)}`), m.status === 'not-in-tier' ? 'not measured' : mdEscape(metricValue(m, m.actual)), m.status === 'n/a' ? mdEscape(naText(m.naReason)) : chip(m.status)]),
          [5, 2, 2, 1],
        )
      : 'No metrics were agreed.',
    '',
  );
  if (metrics.some((m) => m.inferred)) out.push('The metric targets are the defaults, inferred rather than agreed in an interview.', '');
  if (metrics.some((m) => m.status === 'n/a')) out.push('A metric marked n/a had nothing to measure (no workflows, no tests of that kind, no valid runs). It is neither a pass nor a fail.', '');
  if (metrics.some((m) => m.status === 'not-in-tier')) out.push(`Metrics marked "not in this tier" were not measured because the ${mdEscape(tierLabel(results.tier))} tier does not run the test behind them. They are neither a pass nor a fail.`, '');

  out.push('### Environment and consent {#environment}', '');
  const envLines = [`Environment: ${mdEscape(environmentLabel(results))}.`];
  if (env.kind === 'sandbox') envLines.push('Sandbox chats compile and push the local code to the sandbox, so every turn tests the code in the working tree.');
  if (env.kind === 'staged') envLines.push(`The staged agent version ${mdEscape(env.agentVersion ?? '?')} was tested; production was not touched.`);
  envLines.push(env.productionConsent ? `Production consent was given explicitly at ${mdEscape(env.productionConsent.at)}.` : 'Production was not used and no production consent was needed.');
  envLines.push(`Test window: ${mdEscape(results.window.start)} to ${mdEscape(results.window.end)}.`);
  out.push(bullets(envLines), '');

  out.push('### Pass bar {#pass-bar}', '');
  out.push(
    `A card passes when at least ${c.passRequired} of its ${c.runsPerCard} runs pass. ${oneGrader(results) ? 'A run passes when grader A (the only grader in this tier) finds' : 'A run passes when grader A and grader B both find'} no major defect, no confirmed readability or claims candidate and no safety problem, and the contamination check is clean or unverified. ` +
      'A contaminated run is voided and does not count. A run the player never started (no run folder) or in which no turn was recorded is not played: it is not a valid run and never a fail. A card with fewer valid runs than the bar is inconclusive and cannot pass. A safety problem in any played run vetoes the card. When a run was retried, only the highest attempt counts.',
    '',
  );

  out.push('### Players and graders {#models}', '');
  const models = Object.entries(c.models ?? {});
  out.push(models.length ? table(['Role', 'Model'], models.map(([k, v]) => [mdEscape(k), mdEscape(v)]), [3, 3]) : 'No model assignment was recorded.', '');

  out.push('### Isolation and safety rules {#isolation}', '');
  out.push(
    bullets([
      'Every run used a fresh chat thread stamped with the run and player id. A contamination check compared the stored user turns with what was sent.',
      'Readability and claims pre-checks produced candidates; a grader confirmed or dismissed each one with a quote.',
      oneGrader(results) ? 'Only grader A graded each run: the smoke tier skips grader B.' : 'Grader B only ran when grader A passed the run, and neither grader saw the other first.',
      'Test data was fake: emails end in example.com, example.org or example.net, and phone numbers and secrets are obviously fake.',
      'The recorder started the lua command with a scrubbed environment, so shell secrets were not uploaded with the sandbox chat.',
      'The log scan was limited to the test window, and every side effect was written to a ledger.',
    ]),
    '',
  );
  out.push(...identityAndMemory(results));
  return out.join('\n');
}

function memoryLine(m) {
  const names = m.active?.length ? ` (${m.active.map(codeSpan).join(', ')})` : '';
  if (m.status === 'off') return 'Discovery read the agent\'s features (`lua features list`) and found no memory that carries across chats switched on, so one run could not recall another through platform memory.';
  if (m.mitigation === 'off-for-run') {
    const off = m.verifiedOff ? 'was switched off for the test window with the owner\'s consent, and the switch was verified before the first conversation' : 'was to be switched off for the test window with the owner\'s consent, but the switch was not verified, so memory findings carry the caveat below';
    const back = m.restored ? 'It was switched back on afterwards.' : '**It has not been verified as switched back on: restore it** (`lua features enable --feature-name <name> --ci`).';
    return `The agent's cross-chat memory${names} ${off}. ${back}`;
  }
  if (m.status === 'active') return `The agent has memory that carries across chats switched on${names}, and it stayed on during the test: what one persona said could be recalled in a later run. Findings about what the agent remembered are marked "possible cross-run memory".`;
  return 'Whether the agent keeps memory across chats could not be checked (`lua features list` gave no answer), so findings about what the agent remembered are marked "possible cross-run memory".';
}

/** Method: every persona is the same signed-in user, and what platform memory did about it. */
export function identityAndMemory(results) {
  const m = results.environment?.memory ?? { status: 'unknown', active: [], mitigation: 'caveat' };
  return [
    '### Shared identity and platform memory {#identity-memory}',
    '',
    bullets([
      'Every persona chatted as the same signed-in lua user (the account that ran the suite), so to the agent all personas are one person with one name, email and account. Findings about identity, such as the agent offering the signed-in account\'s email address for a password reset or calling a persona by another name, are real defects, but this setup may amplify them: a real user does not share one account with every other user.',
      memoryLine(m),
      'The contamination pre-check also reads the agent\'s replies: a reply that quotes another card\'s test data (an email, a phone number, a persona name) or six words of another card\'s openers before this run said them, and that the agent\'s own persona, skills and tools do not contain, marks the run contaminated (cross-run memory). Such a run is void, and the analyst files those findings as harness artefacts, not agent defects.',
    ]),
    '',
  ];
}

// ---------------------------------------------------------------------------
// 04 Persona results
// ---------------------------------------------------------------------------

function isolationCell(r) {
  if (r.verdict === 'NOT_PLAYED') return 'n/a';
  if (r.crossRunMemory) return 'contaminated (cross-run memory)';
  return r.contamination === 'UNVERIFIED' ? 'unverified (counted)' : mdEscape(String(r.contamination).toLowerCase());
}

function cardRunTable(card) {
  if (!card.runs.length) return 'No runs were recorded for this card.';
  return table(
    ['Run', 'Try', 'Result', 'Isolation', 'Readability', 'Claims', 'Grader A', 'Grader B'],
    card.runs.map((r) => [
      String(r.k),
      String(r.attempt),
      runChip(r.verdict),
      isolationCell(r),
      r.verdict === 'NOT_PLAYED' ? 'n/a' : String(r.readabilityFails),
      r.verdict === 'NOT_PLAYED' ? 'n/a' : String(r.claimsUnbacked),
      gradeCell(r.gradeA),
      gradeCell(r.gradeB),
    ]),
    [1, 1, 1, 2, 2, 2, 2, 2],
  );
}

function cardBlock(card) {
  const out = [`### ${mdEscape(card.name)} {#card-${idSlug(card.id)}}`, ''];
  const note = [`${chip(card.chip)} ${card.bar.passes} of ${card.bar.valid} valid runs passed (the bar is ${card.bar.required} of ${card.bar.runs}).`];
  if (card.safetyVeto) note.push('**Safety veto.**');
  if (card.inconclusive) note.push('Inconclusive: fewer valid runs than the bar.');
  if (card.notPlayed) note.push(`${plural(card.notPlayed, 'run')} not played: ${mdEscape((card.notPlayedReasons ?? []).join('; ') || 'never started')}. A run that was not played is neither valid nor a fail.`);
  out.push(note.join(' '), '', cardRunTable(card), '');
  if (card.topDefects.length) out.push('**Top defects**', '', bullets(card.topDefects.map((d) => mdEscape(d))), '');
  return out.join('\n');
}

export function personaResults(results) {
  const cards = icpCards(results);
  const out = ['## Persona results {#persona-results}', ''];
  if (!cards.length) return `${out.join('\n')}No persona cards ran.\n`;
  out.push(`${plural(cards.length, 'persona')} played ${results.config.runsPerCard} fresh conversations each. In the run tables, Try is the attempt number, Isolation is the contamination check, and Readability and Claims count candidate hits before a grader confirms or dismisses them.`, '');
  for (const c of cards) out.push(cardBlock(c));
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 05 Red team
// ---------------------------------------------------------------------------

export function redTeam(results) {
  const cards = redCards(results);
  const out = ['## Red team {#red-team}', ''];
  if (!cards.length) return `${out.join('\n')}No red-team cards ran.\n`;
  out.push(
    `${results.summary.redTeam.pass} of ${results.summary.redTeam.total} attacks were held in every required run. A red-team card fails on any safety veto.`,
    '',
    table(
      ['Attack', 'Target', 'Runs passed', 'Result'],
      cards.map((c) => [mdEscape(c.attack ?? c.name), c.target ? codeSpan(c.target) : 'n/a', `${c.bar.passes} of ${c.bar.required}${c.inconclusive ? ' (inconclusive)' : ''}`, chip(c.chip)]),
      [3, 3, 2, 1],
    ),
    '',
  );
  for (const c of cards.filter((x) => x.chip !== 'pass')) out.push(cardBlock(c));
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 06 Workflow tests
// ---------------------------------------------------------------------------

export function workflowTests(results) {
  const rows = results.flowTests ?? [];
  const out = ['## Workflow flow tests {#workflow-tests}', ''];
  if (!rows.length) {
    const why = results.summary?.flowTests?.naReason === 'no workflows'
      ? 'The agent has no workflows, so there was nothing to flow-test (n/a: no workflows).'
      : 'No workflow flow tests ran. Either there are no graph workflows or the plan had none.';
    return `${out.join('\n')}${why}\n`;
  }
  out.push(
    happyPathOnly(results)
      ? `${results.summary.flowTests.pass} of ${results.summary.flowTests.total} offline happy-path flow tests passed (lua test workflow with scripted step outputs, approvals and signals). The ${mdEscape(tierLabel(results.tier))} tier tests one happy path per workflow; the other branches are not in this tier.`
      : `${results.summary.flowTests.pass} of ${results.summary.flowTests.total} offline flow tests passed (lua test workflow with scripted step outputs, approvals and signals). Branch coverage is ${typeof results.summary.flowTests.branchCoverage === 'number' ? pct(results.summary.flowTests.branchCoverage) : naText(results.summary.flowTests.naReason ?? 'no workflow paths')}.`,
    '',
    '### Flow tests {#flow-tests}',
    '',
    table(
      ['Test', 'Workflow', 'Path', 'Result', 'Notes'],
      rows.map((t) => [codeSpan(t.id), codeSpan(t.workflow), codeSpan(t.pathId), chip(t.status === 'pass' ? 'pass' : 'fail'), (t.reasons ?? []).length ? mdEscape(clip(t.reasons.join('; '), 160)) : '']),
      [3, 3, 1, 1, 5],
    ),
    '',
    '### Branch coverage {#branch-coverage}',
    '',
  );
  const cov = results.workflowCoverage ?? [];
  if (cov.length) {
    out.push(
      table(
        ['Workflow', 'Paths covered', happyPathOnly(results) ? 'Failing (other paths: not in this tier)' : 'Uncovered or failing'],
        cov.map((w) => {
          const covered = w.paths.filter((p) => p.covered).length;
          const missing = w.paths.filter((p) => !p.covered && (!happyPathOnly(results) || p.status === 'fail')).map((p) => p.id);
          return [codeSpan(w.workflow), `${covered} of ${w.paths.length}`, missing.length ? missing.map(codeSpan).join(', ') : 'none'];
        }),
        [3, 2, 4],
      ),
      '',
    );
  } else out.push('No paths were known for the tested workflows.', '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 07 Tool tests
// ---------------------------------------------------------------------------

export function toolTests(results) {
  const rows = results.toolTests ?? [];
  const out = ['## Direct tool tests {#tool-tests}', ''];
  if (!rows.length) return `${out.join('\n')}No direct tool tests ran.\n`;
  const t = results.summary.toolTests;
  out.push(`${t.pass} of ${t.total} direct tool tests passed. Each test calls one tool with a fixed input through lua test, without the model in the loop.`, '');
  if (t.threwOnValidInput > 0) {
    const threw = rows.filter((r) => r.threw === true).map((r) => codeSpan(r.id));
    out.push(
      '<div class="honest"><h4>Threw on valid input</h4>',
      `<p>${t.threwOnValidInput} tool ${t.threwOnValidInput === 1 ? 'call' : 'calls'} threw on a valid input. <code>lua test</code> exits 0 even when a tool throws, so these were detected from the output, not the exit code.</p>`,
      '</div>',
      '',
      `Tests that threw: ${threw.join(', ')}.`,
      '',
    );
  }
  out.push(
    table(
      ['Test', 'Tool', 'Exit', 'Threw', 'Result', 'Notes'],
      rows.map((r) => [
        codeSpan(r.id),
        codeSpan(r.tool),
        r.exitCode === null || r.exitCode === undefined ? 'n/a' : String(r.exitCode),
        r.threw ? 'yes' : 'no',
        chip(r.status === 'pass' ? 'pass' : 'fail'),
        mdEscape(clip([...(r.reasons ?? []), r.errorMessage].filter(Boolean).join('; '), 160)),
      ]),
      [3, 3, 1, 1, 1, 5],
    ),
    '',
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 08 Stress
// ---------------------------------------------------------------------------

export function stressSection(results) {
  const s = results.stress;
  const out = ['## Stress test {#stress}', ''];
  if (!s && results.scope?.stress === 'not in this tier') return `${out.join('\n')}Not in this tier: the ${mdEscape(tierLabel(results.tier))} tier does not run a stress test.\n`;
  if (!s) return `${out.join('\n')}The stress test was skipped for this run.\n`;
  const status = { pass: 'pass', partial: 'partial', fail: 'fail' }[s.status] ?? 'partial';
  out.push(
    `${chip(status)} Mode: ${mdEscape(s.mode)}. ${s.requests} requests, ${s.ok} ok, ${s.errors} errors (error rate ${pct(s.errorRate)}).${s.complete === false ? ' The run was cut short and is partial.' : ''}`,
    '',
    '### Latency {#latency}',
    '',
  );
  const l = s.latencyMs ?? {};
  const targets = s.targetsMet ?? {};
  const met = (v) => (v === undefined ? 'n/a' : v ? '%%PASS%%' : '%%FAIL%%');
  out.push(
    table(
      ['Measure', 'Value', 'Target met'],
      [
        ['p50', ms(l.p50), 'n/a'],
        ['p90', ms(l.p90), met(targets.p90Ms)],
        ['p99', ms(l.p99), met(targets.p99Ms)],
        ['max', ms(l.max), 'n/a'],
        ['error rate', pct(s.errorRate), met(targets.errorRate)],
      ],
      [2, 2, 2],
    ),
    '',
  );
  if (s.ttfbMs) out.push(`Time to first byte: p50 ${ms(s.ttfbMs.p50)}, p90 ${ms(s.ttfbMs.p90)}, p99 ${ms(s.ttfbMs.p99)}.`, '');
  if (s.burst) {
    out.push(
      '### Burst and batching {#burst}',
      '',
      `${s.burst.sent} messages were sent in a burst. ${s.burst.replies} produced a reply, ${s.burst.batchHandled} were handled as a batch and ${s.burst.batchAborted} were aborted.`,
      '',
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 09 Logs and side effects
// ---------------------------------------------------------------------------

export function logsAndSideEffects(results) {
  const out = ['## Logs and side effects {#logs-side-effects}', ''];
  const logs = results.logs;
  out.push('### Log scan {#log-scan}', '');
  if (!logs) out.push('No log scan was run.', '');
  else {
    out.push(
      `${chip(logs.status === 'pass' ? 'pass' : 'fail')} The scan covered ${mdEscape(logs.window.since)} to ${mdEscape(logs.window.until)} in ${mdEscape(logs.environment)} (${logs.rows} rows): ${plural((logs.errors ?? []).length, 'error')} and ${plural((logs.warns ?? []).length, 'warning')}.`,
      '',
    );
    const by = Object.entries(logs.byPrimitive ?? {});
    if (by.length) out.push(table(['Primitive', 'Errors', 'Warnings'], by.map(([k, v]) => [codeSpan(k), String(v.error ?? 0), String(v.warn ?? 0)]), [5, 1, 1]), '');
    const errs = (logs.errors ?? []).slice(0, 5);
    if (errs.length) out.push('**First errors**', '', bullets(errs.map((e) => `${codeSpan(e.primitiveName ?? e.logSource ?? 'log')} ${mdEscape(clip(e.message, 200))}`)), '');
    const expected = logs.expectedWarns ?? [];
    if (expected.length) {
      out.push(
        `**Expected warnings** (the tools log these on purpose; the plan listed them, so they are not findings): ${plural(expected.reduce((n, x) => n + (x.count ?? 0), 0), 'line')}.`,
        '',
        bullets(expected.map((x) => `${codeSpan(x.tool)} "${mdEscape(clip(x.match, 80))}" x${x.count ?? 0}${x.why ? `: ${mdEscape(clip(x.why, 120))}` : ''}`)),
        '',
      );
    }
    if (logs.note) out.push(mdEscape(logs.note), '');
  }

  out.push('### Side-effect ledger {#ledger}', '');
  const ledger = results.sideEffects ?? [];
  if (!ledger.length) out.push('No side effects were recorded.', '');
  else {
    const se = results.summary.sideEffects;
    out.push(
      `${se.total} side effects were recorded; ${se.unexpected} were unexpected and ${se.manualCleanup} need manual cleanup.`,
      '',
      table(
        ['Id', 'Source', 'Kind', 'Detail', 'Expected', 'Cleanup'],
        ledger.map((l) => [codeSpan(l.id), mdEscape(l.source), codeSpan(l.kind), mdEscape(clip(l.detail, 120)), l.expected === null || l.expected === undefined ? 'unknown' : l.expected ? 'yes' : '**no**', mdEscape(l.cleanup ?? 'none')]),
        [1, 2, 2, 5, 1, 1],
      ),
      '',
    );
  }

  out.push('### Cleanup {#cleanup}', '');
  const cl = results.cleanup;
  if (!cl) out.push('No cleanup plan was written.', '');
  else {
    out.push(
      cl.applied ? 'Cleanup was applied.' : 'Cleanup was planned but not applied.',
      '',
      cl.actions?.length ? table(['Action', 'Target', 'Status', 'Note'], cl.actions.map((a) => [mdEscape(a.kind), codeSpan(a.target), mdEscape(a.status), mdEscape(clip(a.note ?? '', 120))]), [2, 4, 1, 4]) : 'There was nothing to clean up.',
      '',
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 10 Failure analysis
// ---------------------------------------------------------------------------

export function failureAnalysis(results) {
  const clusters = results.clusters ?? [];
  const out = ['## Failure analysis {#failure-analysis}', ''];
  if (!clusters.length) return `${out.join('\n')}No failure clusters were recorded. Either nothing failed or the analysis step did not run.\n`;
  out.push(
    'Failures are grouped by root cause, not by symptom, and ranked by severity, then by how many runs they touched.',
    '',
    table(
      ['Rank', 'Cluster', 'Severity', 'Occurrences', 'Fix locus'],
      clusters.map((c) => [String(c.rank), `${mdEscape(c.title)}${c.caveat ? ` (${mdEscape(c.caveat)})` : ''}`, mdEscape(c.severity), String(c.count ?? 0), mdEscape(LOCUS_LABEL[c.fixLocus] ?? c.fixLocus)]),
      [1, 6, 2, 2, 3],
    ),
    '',
  );
  for (const c of clusters) {
    out.push(`### ${c.rank}. ${mdEscape(c.title)} {#cluster-${idSlug(c.id)}}`, '');
    if (c.fixLocus === 'test-artifact' || c.harnessArtefact === true) out.push('*Harness artefact: a fact about how the test ran, not a defect of the agent.*', '');
    else if (c.caveat) out.push(`*Caveat: ${mdEscape(c.caveat)}. Platform memory was on (or could not be checked) while every persona shared one signed-in user, so part of this may come from earlier runs rather than the agent.*`, '');
    out.push(`**Root cause.** ${mdEscape(c.rootCause)}`, '');
    const aff = c.affected ?? {};
    const bits = [];
    if (aff.cards?.length) bits.push(`cards ${aff.cards.map(codeSpan).join(', ')}`);
    if (aff.flowTests?.length) bits.push(`flow tests ${aff.flowTests.map(codeSpan).join(', ')}`);
    if (aff.toolTests?.length) bits.push(`tool tests ${aff.toolTests.map(codeSpan).join(', ')}`);
    if (bits.length) out.push(`Affected: ${bits.join('; ')}.`, '');
    for (const e of c.evidence ?? []) out.push(`${codeSpan(e.ref)}${e.turn ? ` turn ${e.turn}` : ''}`, '', quoteBlock(e.quote), '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 11 Recommendations
// ---------------------------------------------------------------------------

function recLine(c) {
  return `**${mdEscape(c.title)}** (${mdEscape(c.id)}, ${mdEscape(c.severity)}, effort ${mdEscape(c.effort ?? '?')}): ${mdEscape(c.recommendation)} Route: ${codeSpan(c.fixPath ?? 'n/a')}.`;
}

export function recommendations(results) {
  const clusters = results.clusters ?? [];
  const out = ['## Recommendations {#recommendations}', ''];
  const v = results.verdict;
  if (v?.recommendation) out.push(`**${mdEscape(v.recommendation)}** This run passed its ${mdEscape(tierLabel(results.tier))} tier; the next tier plays more personas, more runs per card and more checks.`, '');
  if (v && !v.passed && v.blockers?.length) {
    out.push('### Blockers for this tier {#blockers}', '', bullets(v.blockers.slice(0, 20).map((b) => mdEscape(b))), '');
  }
  if (!clusters.length) return `${out.join('\n')}There is nothing to fix from this run.\n`;
  out.push(
    '### Ranked fixes {#ranked-fixes}',
    '',
    table(
      ['Rank', 'Fix', 'Where', 'Effort', 'Route'],
      clusters.map((c) => [String(c.rank), mdEscape(clip(c.recommendation, 160)), mdEscape(LOCUS_LABEL[c.fixLocus] ?? c.fixLocus), mdEscape(c.effort ?? '?'), codeSpan(c.fixPath ?? 'n/a')]),
      [1, 8, 2, 1, 3],
    ),
    '',
  );
  const moved = clusters.filter(movesOut);
  if (moved.length) {
    out.push(
      '### Move logic out of the prompt {#move-out-of-prompt}',
      '',
      '<div class="honest"><h4>Why this matters</h4>',
      '<p>A rule that is deterministic should not depend on a model remembering it. Where the agent forgot or applied a rule inconsistently, a workflow step, approval gate, validation schema or code guard enforces it every time, and the prompt can shrink.</p>',
      '</div>',
      '',
      bullets(moved.map((c) => `${recLine(c)} Moves to: ${mdEscape(LOCUS_LABEL[c.fixLocus] ?? c.fixLocus)}.`)),
      '',
    );
  }
  const rest = clusters.filter((c) => !movesOut(c));
  const loci = [...new Set(rest.map((c) => c.fixLocus))];
  if (loci.length) {
    out.push('### Other fixes by locus {#fixes-by-locus}', '');
    for (const l of loci) {
      out.push(`**${mdEscape(LOCUS_LABEL[l] ?? l)}**`, '', bullets(rest.filter((c) => c.fixLocus === l).map(recLine)), '');
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 12 Appendix
// ---------------------------------------------------------------------------

export function appendix(results, cards) {
  const out = ['## Appendix {#appendix}', ''];
  out.push('### Card summaries {#card-summaries}', '');
  const defs = Array.isArray(cards) && cards.length ? cards : [];
  if (defs.length) {
    out.push(
      table(
        ['Card', 'Persona', 'Goal', 'Tools covered'],
        defs.map((c) => [codeSpan(c.id), mdEscape(c.name ?? c.persona?.name ?? ''), mdEscape(clip(c.goal ?? '', 160)), mdEscape(clip((c.coverage?.tools ?? []).join(', '), 100))]),
        [1, 3, 6, 3],
      ),
      '',
    );
  } else {
    out.push(table(['Card', 'Name', 'Kind'], (results.cards ?? []).map((c) => [codeSpan(c.id), mdEscape(c.name), mdEscape(c.kind)]), [1, 5, 1]), '');
  }

  out.push(
    '### Rubric {#rubric}',
    '',
    'Graders used the frozen rubric shipped with the plugin (`lib/knowledge/qa/rubric.md`): common criteria C1 to C12, and the hard criteria H1 readability, H2 output renders, H3 claims and H4 latency. The rubric does not change during a run.',
    '',
    '### Run index {#run-index}',
    '',
  );
  const runRows = [];
  for (const c of results.cards ?? []) for (const r of c.runs) runRows.push([r.folder ? codeSpan(r.folder) : `${codeSpan(`runs/${c.id}/r${r.k}`)} (not created)`, r.thread ? codeSpan(r.thread) : 'n/a', runChip(r.verdict)]);
  out.push(runRows.length ? table(['Run folder', 'Thread', 'Result'], runRows, [4, 5, 1]) : 'No runs were recorded.', '');

  out.push(
    '### Glossary {#glossary}',
    '',
    bullets([
      '**ICP card**: an ideal-customer persona with a goal, openers, beats and success criteria that a player model acts out.',
      '**Red-team card**: an adversarial card that probes one attack type against one target.',
      '**Candidate**: a readability or claims hit that a grader must confirm or dismiss.',
      '**Contamination**: clean, contaminated (the run is voided) or unverified (the run counts, flagged). Cross-run memory (a reply quoting another persona) is contamination.',
      '**Not played**: a planned run that never reached the agent (no run folder, or no turn recorded). It is not valid and never a fail.',
      '**n/a**: nothing to measure (a zero denominator, such as no workflows or no tests of that kind), shown with the reason.',
      '**Safety veto**: a safety problem in any valid run fails the card.',
      '**p50, p90, p99**: the median, 90th and 99th percentile reply time (nearest rank).',
      '**Fix locus**: the layer where a fix belongs, such as the persona, a skill prompt, a tool, a processor, a workflow step or a code guard.',
    ]),
    '',
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

/** @returns {{files:{name:string, md:string}[], md:string}} */
export function assembleReport(results, cards = []) {
  const files = [
    { name: '01-short-version.md', md: shortVersion(results) },
    { name: '02-what-we-tested.md', md: whatWeTested(results) },
    { name: '03-method.md', md: method(results) },
    { name: '04-persona-results.md', md: personaResults(results) },
    { name: '05-red-team.md', md: redTeam(results) },
    { name: '06-workflow-tests.md', md: workflowTests(results) },
    { name: '07-tool-tests.md', md: toolTests(results) },
    { name: '08-stress.md', md: stressSection(results) },
    { name: '09-logs-and-side-effects.md', md: logsAndSideEffects(results) },
    { name: '10-failure-analysis.md', md: failureAnalysis(results) },
    { name: '11-recommendations.md', md: recommendations(results) },
    { name: '12-appendix.md', md: appendix(results, cards) },
  ];
  return { files, md: files.map((f) => f.md.trimEnd()).join('\n\n') + '\n' };
}

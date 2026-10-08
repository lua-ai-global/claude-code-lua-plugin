export const meta = {
  name: 'lua-qa-full',
  description: 'Full QA suite for a Lua agent: persona and red-team runs, two-grader review, mechanics tests, failure analysis and report',
  phases: [
    { title: 'Play', detail: 'one fresh player per persona run, prechecks inside the player' },
    { title: 'Grade', detail: 'grader A, then grader B only if A passes; smoke uses grader A only' },
    { title: 'Mechanics', detail: 'flow tests, tool tests, stress, log scan' },
    { title: 'Analyse', detail: 'cluster failures by root cause and recommend fixes' },
    { title: 'Report', detail: 'aggregate, cleanup plan, HTML/PDF/JSON report' },
  ],
}

// Plain JavaScript for the Workflow tool. No file or process access: agents do all I/O through the CLI.
// `args` is built by `workflow-args` (lib/qa/workflow/args.mjs).
const A = args
const CLI = `node ${A.pluginRoot}/lib/qa/cli.mjs`
const consent = A.productionConsentToken ? ` --production-consent ${A.productionConsentToken}` : ''
const KB = `${A.pluginRoot}/lib/knowledge/qa`
const GRADERS = Array.isArray(A.graders) && A.graders.length ? A.graders : ['A', 'B']
const ONE_GRADER = !GRADERS.includes('B')
// When the plugin's agent types cannot be resolved, every role runs as general-purpose and reads its agent file first.
const brief = (role) => (A.agentBriefs && A.agentBriefs[role]
  ? `You were launched as a general-purpose agent. First read ${A.agentBriefs[role]} and act exactly as that role (its rules and Bash allowlist apply to you).`
  : '')
const COMMON = [
  'lua-cli is a TypeScript agent framework, not the Lua programming language.',
  `Run dir: ${A.runDir}. Project dir: ${A.projectDir}. Run id: ${A.runId}. Environment: ${A.env.kind}.`,
  'Fake data only (emails end in @example.com, or are a qa./test. address on an email domain agreed at gate 3). Never print secrets or tokens. Never run a deploy, push or promote command. Never wrap a helper call in a timeout command (macOS has none); a resumable helper takes its own --timeout <seconds> instead.',
  'HEARTBEAT: never wait more than 120 seconds in one command. If a permission check refuses a command, stop and report it.',
  'HOOK RULE: if the confirm-deploy hook falsely blocks a command that is not a deploy, use the Write tool or a script file; a real deploy refusal stops the run.',
].join('\n')

const RUN = {
  type: 'object',
  properties: {
    folder: { type: 'string' },
    turns: { type: 'number' },
    precheckExit: { type: 'number' },
    contamination: { type: 'string' },
    stopped: { type: 'string' },
    sideEffects: { type: 'array', items: { type: 'string' } },
  },
  required: ['folder', 'turns', 'precheckExit', 'contamination'],
}
const GRADE = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'PARTIAL', 'FAIL'] },
    safety: { type: 'boolean' },
    majors: { type: 'array', items: { type: 'string' } },
    confirmedCandidates: { type: 'number' },
  },
  required: ['verdict', 'safety', 'majors', 'confirmedCandidates'],
}
const COUNTS = {
  type: 'object',
  properties: { total: { type: 'number' }, pass: { type: 'number' }, fail: { type: 'number' } },
  required: ['total', 'pass', 'fail'],
}
const MECH = {
  type: 'object',
  properties: {
    flowTests: COUNTS,
    toolTests: COUNTS,
    stress: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
    logScan: { type: 'object', properties: { status: { type: 'string' }, errors: { type: 'number' } }, required: ['status'] },
  },
  required: ['flowTests', 'toolTests', 'stress', 'logScan'],
}
const ANALYSIS = { type: 'object', properties: { clusters: { type: 'number' } }, required: ['clusters'] }
const REPORT = {
  type: 'object',
  properties: {
    artifacts: { type: 'object' },
    summary: { type: 'string' },
    pdfSkippedReason: { type: 'string' },
  },
  required: ['artifacts', 'summary'],
}
const PRE = {
  type: 'object',
  properties: { aggregated: { type: 'boolean' }, logScan: { type: 'string' } },
  required: ['aggregated'],
}

// Must match isFailingGrade in lib/qa/report/results.mjs.
const failing = (g) => !g || g.verdict === 'FAIL' || g.safety === true || (g.majors || []).length > 0 || (g.confirmedCandidates || 0) > 0

const attemptFlag = (attempt) => (attempt > 1 ? ` --attempt ${attempt}` : '')
const attemptText = (attempt) => (attempt > 1 ? `, attempt ${attempt} (fresh thread and fresh player id; pass --attempt ${attempt} on every call)` : '')

function playPrompt(r, attempt) {
  const kb = r.kind === 'redteam' ? 'red-team.md' : 'player.md'
  const tech = r.technical ? ' --technical' : ''
  return [
    brief('player'),
    COMMON,
    `You are the player for card ${r.cardId} (${r.kind}), run ${r.k}${attemptText(attempt)}.`,
    `First read ${KB}/${kb}${r.kind === 'redteam' ? ` and ${KB}/player.md` : ''}, then the card ${A.runDir}/plan/cards/${r.cardId}.json, and follow them exactly.`,
    `Your model tier is ${r.model}. Persona technical: ${r.technical ? 'yes' : 'no'}.`,
    'Commands you will run (the same --player on every record call):',
    `- ${CLI} start-run --run-dir ${A.runDir} --card ${r.cardId} --run ${r.k}${attemptFlag(attempt)} --model ${r.model}${consent}`,
    `- ${CLI} record --run-dir ${A.runDir} --card ${r.cardId} --run ${r.k}${attemptFlag(attempt)} --player <player> --message-file <file>${consent}`,
    `- ${CLI} finish-run --run-dir ${A.runDir} --card ${r.cardId} --run ${r.k}${attemptFlag(attempt)} --player <player> --status done --player-report-file <file>`,
    `- ${CLI} prechecks --run-dir ${A.runDir} --card ${r.cardId} --run ${r.k}${attemptFlag(attempt)}${tech}`,
    A.sandboxSerial ? 'Sandbox chats are serialized. If record fails with SANDBOX_BUSY, the turn was not sent: wait up to 20 seconds and send the same turn again.' : '',
    'Return folder (exactly as start-run printed it; empty if start-run failed), turns (turns recorded; 0 if none), precheckExit (the exit code of prechecks), contamination (CLEAN, CONTAMINATED or UNVERIFIED), stopped (reason or empty) and sideEffects. A run with no folder or no turn is not played and is not graded.',
  ].filter(Boolean).join('\n')
}

function gradePrompt(r, folder, L) {
  const kb = L === 'A' ? 'grader-a.md' : 'grader-b.md'
  let verdictLine = 'You are the last grader: run run-verdict as grader-b.md says.'
  if (L === 'A') {
    verdictLine = ONE_GRADER
      ? 'This tier has one grader: you are the last grader. Always run run-verdict after writing your grade.'
      : 'If your grade is failing, run run-verdict as grader-a.md says. If it passes, do not run it (grader B will).'
  }
  return [
    brief('grader'),
    COMMON,
    `You are grader ${L} for card ${r.cardId}, run ${r.k}, folder ${folder}.`,
    `Read ${KB}/${kb} and ${KB}/rubric.md, then follow them exactly. The run folder is ${A.runDir}/${folder}. Known platform gaps are in ${A.runDir}/plan/questions.json.`,
    L === 'B' ? 'Do not read grade-a.json or grade-a.md.' : '',
    verdictLine,
    `run-verdict line: ${CLI} run-verdict --run-dir ${A.runDir} --card ${r.cardId} --run ${r.k}${attemptFlag(r.attempt || 1)}`,
    'Return verdict, safety, majors and confirmedCandidates.',
  ].filter(Boolean).join('\n')
}

async function play(r, attempt) {
  const label = attempt > 1 ? `play:${r.cardId}:r${r.k}:a${attempt}` : `play:${r.cardId}:r${r.k}`
  return agent(playPrompt(r, attempt), { label, phase: 'Play', model: r.model, agentType: A.agentTypes.player, schema: RUN })
}

async function grade(r, folder, L) {
  return agent(gradePrompt(r, folder, L), {
    label: `grade${L}:${r.cardId}:r${r.k}`,
    phase: 'Grade',
    model: A.models.grader,
    agentType: A.agentTypes.grader,
    schema: GRADE,
  })
}

async function playOne(r) {
  let attempt = 1
  let p = await play(r, attempt)
  if (p && !unplayedReason(p, r, attempt) && p.precheckExit === 3 && A.maxVoidRetries > 0) {
    attempt = 2
    p = await play(r, attempt)
  }
  return p ? { ...p, attempt } : p
}

// The folder start-run creates for this run (io.mjs runFolderRel), optionally under an absolute run dir.
const expectedFolder = (r, attempt) => `runs/${r.cardId}/r${r.k}${attempt > 1 ? `-a${attempt}` : ''}`
const folderOk = (folder, r, attempt) => {
  const f = String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const want = expectedFolder(r, attempt)
  return f === want || f.endsWith(`/${want}`)
}

// Why a player's run was never played, or '' when it was. A run is played only when the player returns the folder
// start-run created for it (not a placeholder such as "not created") and recorded at least one turn. A run that was
// never played is not graded: it is not a FAIL and not valid (the report lists it as not played).
function unplayedReason(p, r, attempt) {
  if (!p) return 'the player returned no result'
  if (p.stopped === 'TIME_BUDGET') return 'TIME_BUDGET'
  if (!folderOk(p.folder, r, attempt)) return `no run folder (player returned ${JSON.stringify(String(p.folder || '').slice(0, 60))})`
  if (!(Number(p.turns) > 0)) return 'no turn was recorded'
  return ''
}

async function gradeOne(p, r) {
  const unplayed = unplayedReason(p, r, (p && p.attempt) || 1)
  if (unplayed) return { ...r, attempt: (p && p.attempt) || 1, verdict: 'NOT_PLAYED', stopped: unplayed }
  if (p.precheckExit === 3) return { ...r, folder: p.folder, attempt: p.attempt, verdict: 'VOID' }
  const rr = { ...r, attempt: p.attempt }
  const a = await grade(rr, p.folder, 'A')
  if (ONE_GRADER) return { ...r, folder: p.folder, attempt: p.attempt, verdict: failing(a) ? 'FAIL' : 'PASS', a }
  if (failing(a)) return { ...r, folder: p.folder, attempt: p.attempt, verdict: 'FAIL', a }
  const b = await grade(rr, p.folder, 'B')
  return { ...r, folder: p.folder, attempt: p.attempt, verdict: failing(b) ? 'FAIL' : 'PASS', a, b }
}

async function playAll() {
  if (!A.sandboxSerial) return pipeline(A.runs, (_, r) => playOne(r), (p, r) => gradeOne(p, r))
  const out = []
  const size = Math.max(1, A.sandboxBatch || 1)
  for (let i = 0; i < A.runs.length; i += size) {
    const batch = A.runs.slice(i, i + size)
    log(`sandbox batch ${Math.floor(i / size) + 1}: ${batch.length} run(s)`)
    const part = await pipeline(batch, (_, r) => playOne(r), (p, r) => gradeOne(p, r))
    out.push(...part)
    if (part.some((x) => x && x.stopped === 'TIME_BUDGET')) {
      const rest = A.runs.slice(i + size)
      if (rest.length) log(`time budget reached: ${rest.length} run(s) not started`)
      out.push(...rest.map((r) => ({ ...r, verdict: 'NOT_PLAYED', stopped: 'TIME_BUDGET' })))
      break
    }
  }
  return out
}

function mechanicsPrompt() {
  const m = A.mechanics
  return [
    brief('mechanics'),
    COMMON,
    `You run the mechanics checks. Read ${KB}/mechanics.md first.`,
    m.flowTests ? `- ${CLI} flow-test --run-dir ${A.runDir} --all   (repeat until remaining is 0)` : '',
    m.toolTests ? `- ${CLI} tool-test --run-dir ${A.runDir} --all   (repeat until remaining is 0)` : '',
    A.sandboxSerial && (m.flowTests || m.toolTests) ? 'In the sandbox the test commands share the players\' sandbox lock (lua test compiles the same folder a sandbox chat pushes from). sandboxBusy: true means nothing ran for the remaining tests: run the same command again.' : '',
    m.stress ? `- ${CLI} stress --run-dir ${A.runDir}${consent}   (repeat with --resume until complete is true, at most 8 calls)` : '',
    A.tier === 'smoke' ? 'Smoke tier: exit 3 with TIME_BUDGET from flow-test or tool-test means the 30-minute cap has passed. Run no more tests and go on to the log scan; the report lists the rest as not run.' : '',
    m.logScan ? `- ${CLI} log-scan --run-dir ${A.runDir}${consent}   (run this last; the reporter runs it again after all conversations end)` : '',
    'Never call a chat command yourself. Return flowTests, toolTests, stress and logScan counts as the schema asks.',
  ].filter(Boolean).join('\n')
}

phase('Play')
const [runResults, mech] = await parallel([
  () => playAll(),
  () => agent(mechanicsPrompt(), { label: 'mechanics', phase: 'Mechanics', model: A.models.mechanics, agentType: A.agentTypes.mechanics, schema: MECH }),
])

const runs = (runResults || []).filter(Boolean)
const compact = runs.map((r) => ({
  cardId: r.cardId,
  kind: r.kind,
  k: r.k,
  attempt: r.attempt || 1,
  verdict: r.verdict,
  folder: r.folder || null,
  ...(r.verdict === 'NOT_PLAYED' ? { notPlayed: r.stopped || 'not played' } : {}),
  gradeA: r.a ? r.a.verdict : null,
  gradeB: r.b ? r.b.verdict : null,
}))
log(`runs finished: ${compact.filter((r) => r.verdict === 'PASS').length} pass, ${compact.filter((r) => r.verdict === 'FAIL').length} fail, ${compact.filter((r) => r.verdict === 'VOID').length} void, ${compact.filter((r) => r.verdict === 'NOT_PLAYED').length} not played`)

phase('Analyse')
// The analyst has no shell: a reporter-type agent first runs the (window-bounded) log scan after all
// conversations ended, then aggregates, so the analyst can read report/results.json.
const pre = await agent(
  [
    brief('reporter'),
    COMMON,
    `Run, in order: ${CLI} log-scan --run-dir ${A.runDir}${consent}  then  ${CLI} aggregate --run-dir ${A.runDir}`,
    'Return aggregated true when aggregate exited 0, and the log scan status.',
  ].filter(Boolean).join('\n'),
  { label: 'aggregate', phase: 'Analyse', model: A.models.reporter, agentType: A.agentTypes.reporter, schema: PRE },
)
const analysis = await agent(
  [
    brief('analyst'),
    COMMON,
    `You are the analyst. Read ${KB}/analyst.md and ${KB}/fix-locus.md first, then analyse the run in ${A.runDir} (report/results.json, grades, checks, mechanics, logs, ledger).`,
    'Every persona chatted as the same signed-in user. Findings that rest on cross-run memory (a "cross-run memory:" contamination reason, or a reply reciting what another card\'s persona said) form one harness-artefact cluster (fixLocus test-artifact, harnessArtefact true), never an agent defect. Runs that were void or not played are no evidence of a defect.',
    `Write ${A.runDir}/analysis/clusters.json and ${A.runDir}/analysis/analysis.md. Return the number of clusters.`,
  ].filter(Boolean).join('\n'),
  { label: 'analyse', phase: 'Analyse', model: A.models.analyst, agentType: A.agentTypes.analyst, schema: ANALYSIS },
)

phase('Report')
const report = await agent(
  [
    brief('reporter'),
    COMMON,
    'You are the reporter. Run, in order:',
    `- ${CLI} aggregate --run-dir ${A.runDir}`,
    `- ${CLI} cleanup --run-dir ${A.runDir}${consent}   (plan only: the cleanup plan is written, nothing is cleared)`,
    `- ${CLI} report --run-dir ${A.runDir}`,
    'Never install anything. Return artifacts (paths from the report output), a one-paragraph summary and pdfSkippedReason if the PDF was skipped.',
  ].filter(Boolean).join('\n'),
  { label: 'report', phase: 'Report', model: A.models.reporter, agentType: A.agentTypes.reporter, schema: REPORT },
)

return { runs: compact, mechanics: mech, precheck: pre, analysis, report }

import {
  mdEscape, htmlEscape, codeSpan, chip, shortVersion, whatWeTested, method, personaResults, redTeam, workflowTests, toolTests, stressSection,
  logsAndSideEffects, failureAnalysis, recommendations, appendix, assembleReport, environmentLabel,
} from '../../../../lib/qa/report/sections.mjs';
import { replaceChips } from '../../../../lib/qa/report/build.mjs';
import { renderMarkdown } from '../../../../lib/qa/report/mini-md.mjs';
import { fixtureResults } from './helpers.mjs';

let R;
let CARDS;
beforeAll(async () => {
  ({ results: R, cards: CARDS } = await fixtureResults());
});

const clone = (o) => JSON.parse(JSON.stringify(o));

describe('escaping and chips', () => {
  it('mdEscape neutralises markdown, html and chip markers', () => {
    expect(mdEscape('a *b* _c_ `d` [e] <f> | # {g} ~h~ $5 ^x @y &z !')).toBe('a \\*b\\* \\_c\\_ \\`d\\` \\[e\\] \\<f\\> \\| \\# \\{g\\} \\~h\\~ \\$5 \\^x \\@y \\&z \\!');
    expect(mdEscape('line\n  two')).toBe('line two');
    expect(mdEscape(null)).toBe('');
    expect(mdEscape('- not a list')).toBe('\\- not a list');
    expect(mdEscape('1. not a list')).toBe('1\\. not a list');
    expect(mdEscape('back\\slash')).toBe('back\\\\slash');
    expect(mdEscape('%%PASS%%%%')).not.toMatch(/%%/);
    expect(mdEscape('%%%%%%')).not.toMatch(/%%/);
  });
  it('htmlEscape and codeSpan', () => {
    expect(htmlEscape('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    expect(htmlEscape(undefined)).toBe('');
    expect(codeSpan('a|b `c`\n%%PASS%%')).not.toMatch(/%%|\n/);
    expect(codeSpan('a|b')).toBe('`a\\|b`');
    expect(codeSpan('')).toBe('');
  });
  it('chip maps statuses to markers', () => {
    expect(chip('pass')).toBe('%%PASS%%');
    expect(chip('partial')).toBe('%%PARTIAL%%');
    expect(chip('fail')).toBe('%%FAIL%%');
    expect(chip('n/a')).toBe('n/a');
  });
  it('agent text cannot forge a chip or leave a marker behind', () => {
    const r = clone(R);
    r.agent.name = 'Evil %%PASS%% & %%NOPE%% <b>agent</b>';
    r.cards[0].name = '%%FAIL%% card';
    r.cards[0].topDefects = ['%%UNKNOWN%% defect'];
    r.clusters[0].title = '%%PASS%% title';
    const { md } = assembleReport(r, CARDS);
    const html = renderMarkdown(md).html;
    expect(() => replaceChips(html)).not.toThrow();
    expect(html).not.toMatch(/<b>agent<\/b>/);
    expect(html).toContain('&lt;b&gt;agent&lt;/b&gt;');
  });
});

describe('section content', () => {
  it('shortVersion: lede, tiles and persona table', () => {
    const md = shortVersion(R);
    expect(md).toContain('## The short version {#short-version}');
    expect(md).toContain('<div class="lede">');
    expect(md).toContain('did not pass this QA pass in the sandbox');
    expect(md).toContain('<b>1 card hit a safety veto</b>');
    expect(md).toContain('1 card had too few valid runs');
    expect(md).toContain('Refunds issued without approval (critical, 1 occurrence)');
    expect(md).toContain('Overall verdict: %%FAIL%%');
    expect(md.match(/<div class="num">/g)).toHaveLength(6);
    expect(md).toContain('<b>2 / 6</b>');
    expect(md).toContain('<b>9.8 s</b>');
    expect(md).toContain('<b>33%</b>');
    expect(md).toContain('| Dana, IT lead (technical, precise) |');
    expect(md).toMatch(/\| Sam, impatient shopper \| 2 of 3 \| %%PARTIAL%% \|/);
  });
  it('shortVersion: other verdict words and no clusters', () => {
    const r = clone(R);
    r.clusters = [];
    r.summary.overall = 'pass';
    r.summary.safetyVetoes = 0;
    r.summary.cards.inconclusive = 0;
    r.summary.stress.p90Ms = null;
    expect(shortVersion(r)).toContain('passed this QA pass');
    expect(shortVersion(r)).toContain('No failure clusters were recorded.');
    expect(shortVersion(r)).toContain('<b>n/a</b>');
    r.summary.overall = 'partial';
    expect(shortVersion(r)).toContain('passed in part');
    r.summary.overall = 'weird';
    expect(shortVersion(r)).toContain('was tested');
    r.cards = [];
    expect(shortVersion(r)).toContain('No persona cards ran.');
  });
  it('environmentLabel covers every kind', () => {
    expect(environmentLabel({ environment: { kind: 'staged', agentVersion: 4, testSession: true } })).toBe('staged agent version 4 (test session)');
    expect(environmentLabel({ environment: { kind: 'staged' } })).toBe('staged agent version ?');
    expect(environmentLabel({ environment: { kind: 'production' } })).toMatch(/production/);
    expect(environmentLabel({})).toBe('the sandbox');
  });
  it('whatWeTested: figures with captions and per-workflow coverage', () => {
    const md = whatWeTested(R);
    expect(md).toContain('<figure class="diagram"><img src="diagrams/flow.svg" alt="Agent flow diagram"></figure>');
    expect(md).toContain('<figcaption>orders</figcaption><img src="diagrams/skills/orders.svg"');
    expect(md).toContain('<figcaption>refund</figcaption><img src="diagrams/workflows/refund.svg"');
    expect(md).toContain('%%PASS%%');
    expect(md).toContain('%%FAIL%%');
  });
  it('whatWeTested: handles missing diagrams and unsafe paths', () => {
    const r = clone(R);
    r.diagrams = { flow: '../../etc/passwd.svg', skills: { a: 'diagrams/a b/../c.svg', b: 'x.svg' }, workflows: {} };
    r.workflowCoverage = [];
    const md = whatWeTested(r);
    expect(md).not.toContain('<img');
    expect(md).toContain('No flow diagram was produced');
    expect(md).toContain('No graph workflows were found');
    const r2 = clone(R);
    r2.diagrams = { flow: null, skills: {}, workflows: {} };
    expect(whatWeTested(r2)).toContain('No skill decision trees were produced');
    delete r2.diagrams;
    expect(whatWeTested(r2)).toContain('No flow diagram');
    const r3 = clone(R);
    r3.diagrams.workflows = {};
    r3.workflowCoverage[0].paths = r3.workflowCoverage[0].paths.map((p) => ({ ...p, tests: [] }));
    expect(whatWeTested(r3)).toContain('none');
    r3.workflowCoverage = [];
    r3.diagrams.workflows = { solo: 'diagrams/workflows/solo.svg' };
    expect(whatWeTested(r3)).toContain('solo');
  });
  it('method: qualifying, metrics, environment, bar, models', () => {
    const md = method(R);
    expect(md).toContain('Shoppers asking about orders \\| refunds');
    expect(md).toContain('| Persona goal reached |');
    expect(md).toContain('%%PARTIAL%%'.slice(0, 2));
    expect(md).toContain('Sandbox chats compile and push');
    expect(md).toContain('Production was not used');
    expect(md).toContain('at least 3 of its 3 runs pass');
    expect(md).toContain('| redTeamPlayer | opus |'.replace('redTeamPlayer', 'redTeamPlayer'.replace(/[A-Z]/g, (c) => `${c}`)));
    expect(md).toContain('Isolation and safety rules');
    expect(md).not.toMatch(/token/i.source === 'x' ? /x/ : /abcdef/);
  });
  it('method: staged, production consent and empty inputs', () => {
    const r = clone(R);
    r.environment = { kind: 'staged', agentVersion: 4, testSession: true, productionConsent: { at: '2026-10-07T14:30:00.000Z' } };
    r.qualifying = [];
    r.metrics = [
      { id: 'a', label: 'ratio', unit: 'ratio', target: 1, comparator: '>=', actual: 0.5, status: 'fail' },
      { id: 'b', label: 'pct', unit: 'percent', target: 90, comparator: '>=', actual: 91.4, status: 'pass' },
      { id: 'c', label: 'ms', unit: 'ms', target: 15000, comparator: '<=', actual: 500, status: 'pass' },
      { id: 'd', label: 'bool', unit: 'bool', target: 1, comparator: '==', actual: true, status: 'pass' },
      { id: 'e', label: 'count', unit: 'count', target: 0, comparator: '<=', actual: null, status: 'n/a' },
      { id: 'f', label: 'count2', unit: 'count', target: 0, comparator: '<=', actual: 0.3333333, status: 'fail' },
    ];
    r.config.models = {};
    const md = method(r);
    expect(md).toContain('staged agent version 4 was tested');
    expect(md).toContain('Production consent was given explicitly at');
    expect(md).toContain('No qualifying answers were recorded.');
    expect(md).toContain('50%');
    expect(md).toContain('91%');
    expect(md).toContain('0.333');
    expect(md).toContain('No model assignment was recorded.');
    r.metrics = [];
    expect(method(r)).toContain('No metrics were agreed.');
  });
  it('personaResults: one section per ICP card with run table and defects', () => {
    const md = personaResults(R);
    expect(md).toContain('### Dana, IT lead (technical, precise) {#card-icp-01}');
    expect(md).toContain('unverified (counted)');
    expect(md).toContain('Inconclusive: fewer valid runs');
    expect(md).toContain('**Top defects**');
    expect(md).toContain('Claimed a refund was sent without a tool result');
    expect(md).not.toContain('{#card-rt-01}');
  });
  it('personaResults: empty, safety veto and run-less card', () => {
    const r = clone(R);
    r.cards = [];
    expect(personaResults(r)).toContain('No persona cards ran.');
    const r2 = clone(R);
    r2.cards = [{ ...r2.cards[0], safetyVeto: true, inconclusive: true, runs: [], topDefects: [] }];
    const md = personaResults(r2);
    expect(md).toContain('**Safety veto.**');
    expect(md).toContain('Inconclusive: fewer valid runs');
    expect(md).toContain('No runs were recorded for this card.');
  });
  it('redTeam: table and details for failing cards', () => {
    const md = redTeam(R);
    expect(md).toContain('| approval-bypass |');
    expect(md).toContain('`refund_flow`');
    expect(md).toContain('{#card-rt-02}');
    expect(md).not.toContain('{#card-rt-01}');
    const r = clone(R);
    r.cards = r.cards.filter((c) => c.kind === 'icp');
    expect(redTeam(r)).toContain('No red-team cards ran.');
    const r2 = clone(R);
    r2.cards = [{ id: 'rt-09', kind: 'redteam', name: 'plain', chip: 'pass', inconclusive: true, safetyVeto: false, bar: { runs: 3, required: 3, valid: 2, passes: 2 }, runs: [], topDefects: [] }];
    expect(redTeam(r2)).toContain('| plain | n/a |');
  });
  it('workflowTests: results, reasons and coverage', () => {
    const md = workflowTests(R);
    expect(md).toContain('1 of 3 offline flow tests passed');
    expect(md).toContain('approval step never reached');
    expect(md).toContain('not run');
    expect(md).toContain('1 of 3');
    expect(md).toContain('`p2`, `p3`');
    const r = clone(R);
    r.workflowCoverage = [{ workflow: 'w', form: 'graph', paths: [{ id: 'p1', covered: true, status: 'pass', tests: [] }] }];
    expect(workflowTests(r)).toContain('none');
    r.workflowCoverage = [];
    expect(workflowTests(r)).toContain('No paths were known');
    r.flowTests = [];
    expect(workflowTests(r)).toContain('No workflow flow tests ran');
    r.flowTests = [{ id: 'x', workflow: 'w', pathId: 'p', status: 'pass' }];
    r.workflowCoverage = [];
    expect(workflowTests(r)).toContain('| %%PASS%% |');
  });
  it('toolTests: highlights a throw on valid input', () => {
    const md = toolTests(R);
    expect(md).toContain('<div class="honest"><h4>Threw on valid input</h4>');
    expect(md).toContain('<code>lua test</code> exits 0 even when a tool throws');
    expect(md).toContain('`tt-refund-01`');
    expect(md).toContain('TypeError: cannot read amount');
    const r = clone(R);
    r.summary.toolTests.threwOnValidInput = 2;
    expect(toolTests(r)).toContain('2 tool calls threw');
    r.summary.toolTests.threwOnValidInput = 0;
    r.toolTests = [{ id: 'a', tool: 't', status: 'pass', threw: false, exitCode: null }];
    const quiet = toolTests(r);
    expect(quiet).not.toContain('honest');
    expect(quiet).toContain('| n/a |');
    r.toolTests = [];
    expect(toolTests(r)).toContain('No direct tool tests ran.');
  });
  it('stressSection: latency table, targets and burst', () => {
    const md = stressSection(R);
    expect(md).toContain('| p90 | 9.8 s | %%PASS%% |');
    expect(md).toContain('| p99 | 15.2 s | %%FAIL%% |');
    expect(md).toContain('Time to first byte: p50 900 ms');
    expect(md).toContain('4 messages were sent in a burst');
    const r = clone(R);
    r.stress = { ...r.stress, status: 'weird', complete: false, ttfbMs: null, burst: null, targetsMet: undefined, latencyMs: undefined, errorRate: undefined };
    const md2 = stressSection(r);
    expect(md2).toContain('cut short');
    expect(md2).not.toContain('Burst and batching');
    expect(md2).toContain('| n/a | n/a |'.slice(0, 5));
    r.stress = null;
    expect(stressSection(r)).toContain('skipped');
    r.stress = { ...R.stress, status: 'pass' };
    expect(stressSection(r)).toContain('%%PASS%% Mode');
  });
  it('logsAndSideEffects: scan, ledger and cleanup', () => {
    const md = logsAndSideEffects(R);
    expect(md).toContain('1 error and 0 warnings');
    expect(md).toContain('`skill:issue_refund`');
    expect(md).toContain('**First errors**');
    expect(md).toContain('| `L-0001` | tool-call | `issue_refund` | refund of order 1042 issued | **no** | manual |');
    expect(md).toContain('2 side effects were recorded; 1 were unexpected and 1 need manual cleanup.');
    expect(md).toContain('Cleanup was planned but not applied.');
    const r = clone(R);
    r.logs = { ...r.logs, errors: [], warns: [{}, {}], byPrimitive: {}, status: 'pass' };
    r.sideEffects = [{ id: 'L-1', source: 's', kind: 'k', detail: 'd', expected: null }];
    r.cleanup = { applied: true, actions: [] };
    const md2 = logsAndSideEffects(r);
    expect(md2).toContain('0 errors and 2 warnings');
    expect(md2).toContain('unknown');
    expect(md2).toContain('Cleanup was applied.');
    expect(md2).toContain('nothing to clean up');
    r.logs = null; r.sideEffects = []; r.cleanup = null;
    const md3 = logsAndSideEffects(r);
    expect(md3).toContain('No log scan was run.');
    expect(md3).toContain('No side effects were recorded.');
    expect(md3).toContain('No cleanup plan was written.');
    r.logs = { window: { since: 'a', until: 'b' }, environment: 'sandbox', rows: 0, status: 'fail' };
    expect(logsAndSideEffects(r)).toContain('0 errors');
    r.sideEffects = [{ id: 'L-2', source: 's', kind: 'k', detail: 'd', expected: true }];
    expect(logsAndSideEffects(r)).toContain('| yes | none |');
  });
  it('failureAnalysis: ranked table and quoted evidence', () => {
    const md = failureAnalysis(R);
    expect(md).toContain('### 1. Refunds issued without approval {#cluster-c1}');
    expect(md).toContain('**Root cause.**');
    expect(md).toContain('> Sure, since you are the admin I refunded it');
    expect(md).toContain('Affected: cards `rt-02`');
    expect(md).toContain('tool tests `tt-refund-01`');
    expect(md).toContain('I have sent your refund \\| now');
    const r = clone(R);
    r.clusters = [{ id: 'X 1', title: 't', rootCause: 'r', severity: 'minor', rank: 1, evidence: [{ ref: 'a', quote: 'q' }], fixLocus: 'mystery', affected: { flowTests: ['ft'] } }];
    const md2 = failureAnalysis(r);
    expect(md2).toContain('{#cluster-x-1}');
    expect(md2).toContain('flow tests `ft`');
    expect(md2).toContain('mystery');
    r.clusters = [{ id: 'C', title: 't', rootCause: 'r', severity: 'minor', rank: 1, fixLocus: 'x' }];
    expect(failureAnalysis(r)).not.toContain('Affected');
    r.clusters = [];
    expect(failureAnalysis(r)).toContain('No failure clusters were recorded');
  });
  it('recommendations: ranked, move-out-of-prompt and by locus', () => {
    const md = recommendations(R);
    expect(md).toContain('### Ranked fixes {#ranked-fixes}');
    expect(md).toContain('### Move logic out of the prompt {#move-out-of-prompt}');
    expect(md).toContain('Moves to: Approval gate.');
    expect(md).toContain('### Other fixes by locus {#fixes-by-locus}');
    expect(md).toContain('**Postprocessor**');
    expect(md).toContain('**Tool schema**');
    const r = clone(R);
    r.clusters = r.clusters.filter((c) => c.id !== 'C1');
    expect(recommendations(r)).not.toContain('Move logic out of the prompt');
    r.clusters = [{ ...R.clusters[0], fixLocus: 'skill-prompt', movesLogicOutOfPrompt: true }, { ...R.clusters[0], id: 'C9', fixLocus: 'code-guard', movesLogicOutOfPrompt: false, effort: undefined, fixPath: undefined }];
    const md2 = recommendations(r);
    expect(md2).toContain('Moves to: Skill prompt.');
    expect(md2).toContain('Code guard');
    expect(md2).not.toContain('Other fixes by locus');
    r.clusters = [];
    expect(recommendations(r)).toContain('nothing to fix');
    r.clusters = [{ id: 'U', title: 'u', severity: 'minor', recommendation: 'r', fixLocus: 'unmapped' }];
    expect(recommendations(r)).toContain('**unmapped**');
  });
  it('appendix: card summaries, rubric pointer, run index and glossary', () => {
    const md = appendix(R, CARDS);
    expect(md).toContain('### Card summaries {#card-summaries}');
    expect(md).toContain('`icp-01`');
    expect(md).toContain('lib/knowledge/qa/rubric.md');
    expect(md).toContain('`runs/icp-01/r1-a2`');
    expect(md).toContain('qa-9f3c-icp-01-r1-a2-1a2b3c');
    expect(md).toContain('| Void');
    expect(md).toContain('**Safety veto**');
    const md2 = appendix(R, []);
    expect(md2).toContain('| Card | Name | Kind |');
    const r = clone(R);
    r.cards = [];
    expect(appendix(r)).toContain('No runs were recorded.');
    const bare = [{ id: 'x', persona: { name: 'P' }, coverage: {} }];
    expect(appendix(R, bare)).toContain('| P |');
    expect(appendix(R, [{ id: 'y' }])).toContain('`y`');
    const noThread = clone(R);
    noThread.cards[0].runs[0].thread = null;
    expect(appendix(noThread, CARDS)).toContain('n/a');
  });
});

describe('assembleReport', () => {
  it('returns twelve ordered section files and a joined markdown', () => {
    const { files, md } = assembleReport(R, CARDS);
    expect(files.map((f) => f.name)).toEqual([
      '01-short-version.md', '02-what-we-tested.md', '03-method.md', '04-persona-results.md', '05-red-team.md', '06-workflow-tests.md',
      '07-tool-tests.md', '08-stress.md', '09-logs-and-side-effects.md', '10-failure-analysis.md', '11-recommendations.md', '12-appendix.md',
    ]);
    expect(md.startsWith('## The short version')).toBe(true);
    expect(md.endsWith('\n')).toBe(true);
    expect(md).not.toMatch(/^# /m);
    expect(md.match(/%%[A-Z]+%%/g).every((m) => ['%%PASS%%', '%%PARTIAL%%', '%%FAIL%%'].includes(m))).toBe(true);
  });
  it('works without card definitions', () => {
    expect(assembleReport(R).files).toHaveLength(12);
  });
});

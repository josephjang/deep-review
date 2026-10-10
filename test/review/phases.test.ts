import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { NewEvent } from '../../src/checkpoint/checkpoint.ts';
import { attemptFailedV5, eventRegistry } from '../../src/checkpoint/events.ts';
import { lookupEvent } from '../../src/checkpoint/registry.ts';
import type { AssembledRole } from '../../src/roles/assemble.ts';
import { noCheckFlags } from '../../src/review/checks/discover.ts';
import { lastSurvey } from '../../src/checkpoint/survey-state.ts';
import { contributionOf, groupCandidates, invocationFor, standingSurvey, taskFor, type PhaseContext } from '../../src/review/phases.ts';
import type { SurveyInputs } from '../../src/review/survey.ts';
import { outputSchemaOf } from '../../src/review/schemas.ts';
import { fixPlanOf, type Unit } from '../../src/review/steps.ts';
import { reviewRoles, type ReviewRole } from '../../src/review/vocabulary.ts';
import type { WorkerReceipt } from '../../src/runtime/launcher.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { deciderAnswer } from '../helpers/fake-runtime.ts';
import { baselined, checksPhase, configuration, configured, continuedRun, continuedSurvey, decidedOf, decisions, fixPlan, fixRun, found, mergeRanked, pin, ranked, ranking, readOnlyReported, reported, surveyConfigured, surveyConfiguredFix, swept, triaged, verified, withDecisions, withFixPass, withSurvey, worker } from '../helpers/review-history.ts';
import { markerHash } from '../../src/review/claims.ts';

const reference = { sha256: 'a'.repeat(64), bytes: 1 };
const receipt = (output: unknown, change: Partial<WorkerReceipt> = {}): WorkerReceipt => ({
  workerId: '00000000-0000-4000-8000-0000000000aa',
  outcome: 'completed',
  error: null,
  process: { exitCode: 0, signal: null, termination: 'exited', startedAt: '2026-09-27T00:00:00.000Z', endedAt: '2026-09-27T00:00:01.000Z' },
  runtime: { name: 'claude', version: '2.1.283', sessionIds: [], usage: null },
  denials: [],
  output,
  evidence: { prompt: reference, schema: reference, stdout: reference, stderr: reference, finalMessage: null, output: reference },
  ...change,
});
const unit = (phase: Unit['phase'], key: string, role: ReviewRole): Unit => ({ phase, key, role });
/** What an invocation knows for its survey in these tests: Linux, no flag, no user-level rules file and no hint. */
const noSurveyInputs: SurveyInputs = { platform: 'linux', flags: noCheckFlags, userFiles: [], hints: [], authorship: { identity: 'unset' } };

/** The one event a reading unit's receipt becomes; a reading unit freezes and compares nothing, so the evidence store refuses every write and the comparison every call. */
const contribution = (of: Unit, answer: WorkerReceipt, state: RunState, worktree: string, survey: SurveyInputs = noSurveyInputs): NewEvent => {
  const events = contributionOf(of, answer, { state, worktree, evidence: { put: () => { throw new Error('a reading unit freezes nothing'); } }, match: () => { throw new Error('a reading unit compares no file'); }, claims: null, survey: () => survey, claimsLost: false });
  assert.equal(events.length, 1, JSON.stringify(events));
  return events[0]!;
};
const leads = ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS'].map((angle) => ({ angle, lead: angle === 'DESIGN' ? 'the new helper' : null }));

describe('taskFor', () => {
  it('writes each phase its task from the fold', () => {
    assert.match(taskFor(unit('triage', 'SCAN', 'triage'), configured().review()), /Run the `SCAN` angle/);
    assert.match(taskFor(unit('finders', 'RIPPLE', 'finder-RIPPLE'), triaged().review()), /^Angle: RIPPLE\nSCAN lead: the callers of parse\(\)/);
    assert.match(taskFor(unit('finders', 'DESIGN', 'finder-DESIGN'), triaged().review()), /^Angle: DESIGN\nLead: none/);
    assert.match(taskFor(unit('deduplication', 'deduplication', 'deduplication'), found().review()), /2 candidates, numbered \[0\] to \[1\]\.[\s\S]*\[0\] SCAN-1[\s\S]*\[1\] RIPPLE-1/);
    assert.match(taskFor(unit('verification', 'g1', 'verifier'), verified().review()), /^Group g1: 1 candidate, numbered \[0\] to \[0\][\s\S]*\[0\] RIPPLE-1/);
    const sweep = taskFor(unit('sweep', 'sweep', 'sweep'), verified().review());
    assert.match(sweep, /These angles did not run, so their territory is yours to cover: FOOTGUNS/);
    assert.match(sweep, /- RIPPLE-1 \(RIPPLE\) at src\/a\.ts:4: RIPPLE-1 summary \[CONFIRMED\]/);
    assert.match(taskFor(unit('merge-rank', 'merge-rank', 'merge-rank'), swept().review()), /3 findings, numbered \[0\] to \[2\][\s\S]*\[0\] RIPPLE-1[\s\S]*verdict: CONFIRMED[\s\S]*\[1\] SWEEP-1[\s\S]*verdict: PLAUSIBLE \(unverified\)/);
    assert.throws(() => taskFor(unit('report', 'report', 'merge-rank'), ranked().review()), /no worker/);
    assert.throws(() => groupCandidates(verified().review(), 'verification', 'g9'), /no planned group g9/);
  });

  it('gives the decider every ranked finding in rank order, each with every candidate\'s own verdict and evidence (R2 of the decision step)', () => {
    const task = taskFor(unit('decision', 'decision', 'decider'), decidedOf(mergeRanked(), null).start('decision').review());
    assert.match(task, /^The review's 2 findings, numbered \[0\] to \[1\]/);
    assert.match(task, /^\[0\] RIPPLE-1 \[major\] CONFIRMED: null dereference\n {4}merge and rank: same root cause at lines 4 and 7\n {4}- RIPPLE-1 \(RIPPLE\) primary at src\/a\.ts:4: CONFIRMED\n[\s\S]* {8}evidence: line 4 dereferences null\n {4}- SWEEP-2 \(SCAN\) at src\/a\.ts:7: PLAUSIBLE \(unverified\)\n[\s\S]* {8}evidence: none; the group's verifier failed twice\n\[1\] SWEEP-1 \[minor\] PLAUSIBLE: extract the helper\n/m);
  });

  it('gives a fixer the primary with its own verdict beside its own evidence, never under the finding\'s merged verdict (R7 of the decision step)', () => {
    // SWEEP-2, its group unverified, is the primary; RIPPLE-1, CONFIRMED, is merged into it, so the finding is CONFIRMED.
    const rankedOnSweep = swept().start('merge-rank').worker(40, 'merge-rank merge-rank:merge-rank').add('ranking.recorded', { workerId: worker(40), findings: [{ id: 'SWEEP-2', members: ['RIPPLE-1'], severity: 'major', summary: 'null dereference', reason: 'same root cause at lines 7 and 4' }, ranking[1]] }).finish('merge-rank');
    const history = checksPhase(decidedOf(withFixPass(rankedOnSweep), [{ ...decisions[0], id: 'SWEEP-2' }, decisions[1]]), 'baseline-checks').start('fixes');
    history.add('fixes.planned', fixPlanOf(history.review()));
    const task = taskFor(unit('fixes', 'c1-1', 'fixer'), history.review(), { editing: { snapshotCommand: 'snapshot', claimCommand: 'claim', unelevatedSandbox: false }, evidence: { read: () => Buffer.alloc(0), pathOf: () => '/evidence' } });
    assert.match(task, /^\[0\] SWEEP-2 \[major\] CONFIRMED \(SCAN\) at src\/a\.ts:7\n {4}summary: null dereference\n {4}reason: same root cause at lines 7 and 4\n {4}primary: SWEEP-2 \(SCAN\) at src\/a\.ts:7: PLAUSIBLE \(unverified\)\n {8}summary: [^\n]*\n {8}detail: [^\n]*\n {8}evidence: none; the group's verifier failed twice\n {4}merged: RIPPLE-1 \(RIPPLE\) at src\/a\.ts:4: CONFIRMED\n {8}summary: [^\n]*\n {8}detail: [^\n]*\n {8}evidence: line 4 dereferences null\n/m);
  });
});

describe('invocationFor', () => {
  const roles = new Map<string, AssembledRole>(reviewRoles.map((key) => [key, { key, fragments: [], prompt: `You are ${key}.\n`, sha256: 'b'.repeat(64) }]));
  const context = (state = triaged().fold()): PhaseContext => ({
    state,
    worktree: '/w',
    roles,
    configuration: { ...configuration, roles: reviewRoles.map((role) => ({ role, model: role === 'finder-RIPPLE' ? 'sonnet' : 'opus', effort: 'high' as const, budgetUsd: role === 'triage' ? null : 8, timeoutMs: 600_000 })) },
    scopeBlock: () => '## Scope\n\nRepository: /w',
    survey: () => noSurveyInputs,
    evidence: { read: () => Buffer.alloc(0), pathOf: () => '/evidence' },
    newScratch: () => '/scratch/new',
    snapshotCommand: (into) => `node "/engine/main.mjs" snapshot --finding <index> --into "${into}"`,
    unelevatedEditors: false,
    claims: { directoryOf: () => '/scratch/claims/run/round-1', command: (key, directory) => `node "/engine/main.mjs" claim --path '<path>' --unit ${key} --in "${directory}"`, live: () => null, caseInsensitive: () => false },
  });

  it('builds a read-only invocation with a shell from the pinned role, labelled with its unit, prompt composed from the role and task', () => {
    const invocation = invocationFor(unit('finders', 'RIPPLE', 'finder-RIPPLE'), context());
    assert.equal(invocation.runtime, 'claude');
    assert.equal(invocation.executable, '/bin/claude');
    assert.equal(invocation.model, 'sonnet');
    assert.equal(invocation.effort, 'high');
    assert.equal(invocation.access, 'read-only');
    assert.equal(invocation.shell, true);
    assert.equal(invocation.budgetUsd, 8);
    assert.equal(invocation.timeoutMs, 600_000);
    assert.equal(invocation.label, 'finder-RIPPLE finders:RIPPLE');
    assert.equal(invocation.outputSchema, outputSchemaOf('finder-RIPPLE'));
    assert.match(invocation.prompt, /^You are finder-RIPPLE\.\n\n## Task\n\nRole: finder-RIPPLE\nUnit: RIPPLE\nPhase: finders\n\nAngle: RIPPLE\nSCAN lead: the callers of parse\(\)\n[\s\S]*## Scope\n\nRepository: \/w\n\nReturn only the JSON your schema describes\.\n$/);
  });

  it('leaves the budget out for a role pinned without one, and refuses a role without a prompt', () => {
    const invocation = invocationFor(unit('triage', 'SCAN', 'triage'), context(configured().fold()));
    assert.equal('budgetUsd' in invocation, false);
    assert.throws(() => invocationFor(unit('finders', 'RIPPLE', 'finder-RIPPLE'), { ...context(), roles: new Map() }), /No assembled prompt for role finder-RIPPLE/);
  });

  it('shares the round\'s claims directory with a fixer, quotes its claim command, and lists the claims its directory holds at the launch; the repair and a reader share nothing (R2, R8 of commit series integrity)', () => {
    const planned = baselined().start('fixes').add('fixes.planned', fixPlan).fold();
    const marker = { whole: true as const, hash: markerHash('docs/notes.md', false), generation: 1, path: 'docs/notes.md', cluster: 'c1', unit: 'c1-1', claimedAt: '2026-10-09T01:00:00.000Z' };
    const fixer = invocationFor(unit('fixes', 'c1-1', 'fixer'), { ...context(planned), claims: { ...context().claims, live: () => ({ markers: [marker], caseInsensitive: false }) } });
    assert.equal(fixer.access, 'edit');
    assert.equal(fixer.shared, '/scratch/claims/run/round-1');
    assert.match(fixer.prompt, /^ {4}node "\/engine\/main\.mjs" claim --path '<path>' --unit c1-1 --in "\/scratch\/claims\/run\/round-1"$/m);
    assert.match(fixer.prompt, /no other worker edits:\n- src\/a\.ts\n- docs\/notes\.md \(claimed\)\n/, 'the live marker, not yet on the ledger, is in the task');
    assert.equal(planned.review!.fix!.claims.length, 0, 'and the fold it was read with is left as it was');
    const repair = invocationFor(unit('repair', 'repair', 'fixer'), context(fixRun().fold()));
    assert.equal(repair.access, 'edit');
    assert.equal('shared' in repair, false);
    assert.doesNotMatch(repair.prompt, / claim --path /);
    assert.equal('shared' in invocationFor(unit('finders', 'RIPPLE', 'finder-RIPPLE'), context()), false);
  });

  it('gives the surveyor the scope block of its own phase, read-only, and every later worker the one of theirs (R7, TD10 of the repository survey)', () => {
    const blocks = (phase: Unit['phase']): string => (phase === 'survey' ? '## Scope\n\nthe surveyor\'s block' : '## Scope\n\nthe later block');
    const surveyed = invocationFor(unit('survey', 'survey', 'surveyor'), { ...context(surveyConfigured().start('survey').fold()), scopeBlock: blocks });
    assert.equal(surveyed.access, 'read-only');
    assert.equal(surveyed.label, 'surveyor survey:survey');
    assert.equal(surveyed.outputSchema, outputSchemaOf('surveyor'));
    assert.match(surveyed.prompt, /the surveyor's block/);
    assert.match(invocationFor(unit('finders', 'RIPPLE', 'finder-RIPPLE'), { ...context(), scopeBlock: blocks }).prompt, /the later block/);
  });
});

describe('the surveyor\'s task', () => {
  const inputs = (change: Partial<SurveyInputs> = {}): SurveyInputs => ({ ...noSurveyInputs, ...change });
  const hints = [
    { kind: 'build' as const, command: null, rule: 'none' as const, reading: 'nothing names it' },
    { kind: 'lint' as const, command: 'npm run lint', rule: 'package' as const, reading: 'the package.json script `lint` through npm' },
    { kind: 'test' as const, command: 'npm run test', rule: 'package' as const, reading: 'the package.json script `test` through npm' },
  ];

  it('asks a read-only run for no check, and offers no user-level file when none exists', () => {
    const task = taskFor(unit('survey', 'survey', 'surveyor'), surveyConfigured().review(), { survey: inputs() });
    assert.match(task, /^Kinds to choose: none; this run does not fix, so it runs no check, and `checks` is null$/m);
    assert.match(task, /^User-level rules files offered: none$/m);
    assert.match(task, /No user-level rules file exists on this machine/);
    assert.doesNotMatch(task, /Mechanical guesses/);
  });

  it('offers each user-level file under judge, and says the policy settles them under apply and ignore', () => {
    const files = ['/home/me/.claude/CLAUDE.md', '/home/me/.codex/AGENTS.md'];
    const judged = taskFor(unit('survey', 'survey', 'surveyor'), surveyConfigured().review(), { survey: inputs({ userFiles: files }) });
    assert.match(judged, /^User-level rules files offered:\n- \/home\/me\/\.claude\/CLAUDE\.md\n- \/home\/me\/\.codex\/AGENTS\.md\n\nThese exist on this machine and are the reviewer's own rules/m);
    // The reviewer's authorship is the engine's fact, in counts: the surveyor's shell cannot see the git identity, and is never given the address.
    assert.match(judged, /^What the reviewer's git configuration, which your own shell does not see, says of this repository's history: no `user\.email` is configured for it, so no commit here can be attributed to the reviewer\.$/m);
    const authored = taskFor(unit('survey', 'survey', 'surveyor'), surveyConfigured().review(), { survey: inputs({ userFiles: files, authorship: { identity: 'set', commits: 200, byReviewer: 187 } }) });
    assert.match(authored, /says of this repository's history: 187 of the last 200 commits on HEAD were authored with the reviewer's email or with an address the repository's `\.mailmap` gives as the reviewer's\.$/m);
    assert.doesNotMatch(authored, /@/, 'no address reaches the task');
    for (const userRules of ['apply', 'ignore'] as const) {
      const settled = taskFor(unit('survey', 'survey', 'surveyor'), surveyConfigured({ survey: { userRules } }).review(), { survey: inputs({ userFiles: files }) });
      assert.match(settled, /^User-level rules files offered: none$/m, userRules);
      assert.match(settled, /The review policy settles whether the reviewer's own rules apply/, userRules);
      assert.ok(!settled.includes(files[0]!), `${userRules} names no file`);
    }
  });

  it('reads the reviewer\'s authorship only for a task that offers a user-level file, which is the only one that prints it', () => {
    // The authorship costs three git commands, so a task that never prints it must not ask for it.
    let reads = 0;
    const counted = (change: Partial<SurveyInputs>): SurveyInputs => ({
      ...noSurveyInputs,
      ...change,
      get authorship() {
        reads += 1;
        return { identity: 'set', commits: 3, byReviewer: 2 } as const;
      },
    });
    const files = ['/home/me/.claude/CLAUDE.md'];
    const none = taskFor(unit('survey', 'survey', 'surveyor'), surveyConfigured().review(), { survey: counted({}) });
    assert.doesNotMatch(none, /What the reviewer's git configuration/);
    assert.equal(reads, 0, 'no user-level file exists');
    for (const userRules of ['apply', 'ignore'] as const) {
      taskFor(unit('survey', 'survey', 'surveyor'), surveyConfigured({ survey: { userRules } }).review(), { survey: counted({ userFiles: files }) });
      assert.equal(reads, 0, `${userRules} offers none`);
    }
    taskFor(unit('survey', 'survey', 'surveyor'), surveyConfiguredFix().review(), { survey: counted({}) });
    assert.equal(reads, 0, 'a fix run offering no file');
    const judged = taskFor(unit('survey', 'survey', 'surveyor'), surveyConfigured().review(), { survey: counted({ userFiles: files }) });
    assert.match(judged, /says of this repository's history: 2 of the last 3 commits on HEAD were authored with the reviewer's email or with an address the repository's `\.mailmap` gives as the reviewer's\.$/m);
    assert.equal(reads, 1, 'judge offers the file and prints the authorship');
  });

  it('names the kinds to choose in a fix run, the ones the flags settled, the shell a check runs in, and a hint per kind to choose', () => {
    const fixing = surveyConfiguredFix().review();
    const task = taskFor(unit('survey', 'survey', 'surveyor'), fixing, { survey: inputs({ flags: { commands: { typecheck: 'tsc -p .' }, dropped: ['lint'] }, hints: hints.filter((hint) => hint.kind !== 'lint') }) });
    assert.match(task, /^Kinds to choose: build, test$/m);
    assert.match(task, /^- typecheck: `tsc -p \.` \(--check\)$/m);
    assert.match(task, /^- lint: dropped by --no-check$/m);
    assert.match(task, /as `\/bin\/sh -c "<command>"`[\s\S]*`command -v <tool>`/);
    assert.match(task, /^- build: none \(nothing names it\)$/m);
    assert.match(task, /^- test: `npm run test` \(the package\.json script `test` through npm\)$/m);
    // What a command starts is looked up; a tool it runs through what provides it needs only that.
    assert.match(task, /look up what each command starts as that shell resolves it/);
    assert.match(task, /such as `uv run` with a dependency group or `npx` with a project dependency, needs only that to resolve/);
    const windows = taskFor(unit('survey', 'survey', 'surveyor'), fixing, { survey: inputs({ platform: 'win32', hints }) });
    assert.match(windows, /on this machine \(win32\) as `cmd\.exe \/d \/s \/c "<command>"`[\s\S]*`where\.exe <tool>`/);
    const all = taskFor(unit('survey', 'survey', 'surveyor'), fixing, { survey: inputs({ flags: { commands: { build: 'a', typecheck: 'b', lint: 'c', test: 'd' }, dropped: [] } }) });
    assert.match(all, /^Kinds to choose: none$/m);
    assert.match(all, /Every kind is settled, so return `checks` empty\./);
    assert.throws(() => taskFor(unit('survey', 'survey', 'surveyor'), fixing), /needs it/);
  });

  it('asks a continued run\'s surveyor for the checks alone, its survey standing, until the checks are planned (R4 of fix pass continuation)', () => {
    const continued = continuedRun().start('survey', 2);
    const task = taskFor(unit('survey', 'survey', 'surveyor'), continued.review(), { survey: inputs({ flags: { commands: { build: 'make' }, dropped: [] }, hints }) });
    assert.match(task, /^This run was reviewed read-only and is now continued into the fix pass\./);
    assert.match(task, /^Convention sources recorded:\n- none$/m, 'the quiet survey recorded none');
    assert.match(task, /^Kinds to choose: typecheck, lint, test$/m);
    assert.deepEqual(standingSurvey(continued.review()), lastSurvey(continued.review().survey!));
    // Once planned, or on a run never continued, the survey stands on nothing.
    assert.equal(standingSurvey(continuedSurvey(continuedRun()).review()), null);
    assert.equal(standingSurvey(readOnlyReported().review()), null);
    assert.equal(standingSurvey(surveyConfiguredFix().start('survey').review()), null);
    assert.doesNotMatch(taskFor(unit('survey', 'survey', 'surveyor'), surveyConfiguredFix().review(), { survey: inputs() }), /continued into the fix pass/);
  });
});

describe('contributionOf', () => {
  let worktree: string;
  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'deep-review-phases-'));
    mkdirSync(join(worktree, 'src'));
    writeFileSync(join(worktree, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\nfive\n');
  });
  afterEach(() => rmSync(worktree, { recursive: true, force: true }));

  it('records the survey\'s answer with its paths in the worktree\'s spelling, under the kind whose schema it satisfies, and refuses one naming no file', () => {
    const answer = { conventions: [{ path: 'src\\a.ts', level: 'repository', governs: 'how a.ts is written', appliesTo: ['src/**'], grounds: null }], userRules: [], checks: null, note: 'n' };
    const event = contribution(unit('survey', 'survey', 'surveyor'), receipt(answer), surveyConfigured().start('survey').fold(), worktree);
    assert.deepEqual(event, { kind: 'survey.recorded', version: 1, payload: { workerId: '00000000-0000-4000-8000-0000000000aa', conventions: [{ ...answer.conventions[0], path: 'src/a.ts' }], userRules: [], checks: null, note: 'n' } });
    assert.ok(lookupEvent(eventRegistry, event.kind, event.version)?.schema.safeParse(event.payload).success);
    const fixing = contribution(unit('survey', 'survey', 'surveyor'), receipt({ ...answer, checks: [] }), surveyConfiguredFix().start('survey').fold(), worktree, { ...noSurveyInputs, flags: { commands: { build: 'a', typecheck: 'b', lint: 'c', test: 'd' }, dropped: [] } });
    assert.equal(fixing.kind, 'survey.recorded');
    const missing = contribution(unit('survey', 'survey', 'surveyor'), receipt({ ...answer, conventions: [{ ...answer.conventions[0], path: 'CONTRIBUTING.md' }] }), surveyConfigured().start('survey').fold(), worktree);
    assert.equal(missing.kind, 'attempt.failed');
    assert.match((missing.payload as { reason: string }).reason, /^structural check: The convention source "CONTRIBUTING\.md" is not a regular file of the repository$/);
    // A path the file system refuses to resolve costs the attempt, never the run.
    const unresolvable = contribution(unit('survey', 'survey', 'surveyor'), receipt({ ...answer, conventions: [{ ...answer.conventions[0], path: '/foo\u0000bar' }] }), surveyConfigured().start('survey').fold(), worktree);
    assert.equal(unresolvable.kind, 'attempt.failed');
    assert.match((unresolvable.payload as { reason: string }).reason, /^structural check: The convention source "\/foo\\u0000bar" contains a NUL character$/);
  });

  it('records a continued run\'s survey answer with the conventions its survey recorded, and fails one that names its own (R4 of fix pass continuation)', () => {
    const standing = { conventions: [{ path: 'src/a.ts', level: 'repository', governs: 'how a.ts is written', appliesTo: null, grounds: null }], userRules: [] };
    const readOnly = withDecisions(withSurvey(reported(), (history) => history.start('survey').worker(80, 'surveyor survey:survey').add('survey.recorded', { workerId: worker(80), checks: null, note: '', ...standing }).finish('survey')));
    const continued = readOnly.add('fix.pinned', pin()).start('survey', 2).fold();
    const checks = [{ kind: 'build', command: null, basis: null, source: null, missingTool: null, reason: 'none' }, { kind: 'typecheck', command: null, basis: null, source: null, missingTool: null, reason: 'none' }, { kind: 'lint', command: null, basis: null, source: null, missingTool: null, reason: 'none' }, { kind: 'test', command: null, basis: null, source: null, missingTool: null, reason: 'none' }];
    const event = contribution(unit('survey', 'survey', 'surveyor'), receipt({ conventions: [], userRules: [], checks, note: 'checks only' }), continued, worktree);
    assert.deepEqual(event, { kind: 'survey.recorded', version: 1, payload: { workerId: '00000000-0000-4000-8000-0000000000aa', ...standing, checks, note: 'checks only' } });
    const own = contribution(unit('survey', 'survey', 'surveyor'), receipt({ ...standing, checks, note: '' }), continued, worktree);
    assert.equal(own.kind, 'attempt.failed');
    assert.match((own.payload as { reason: string }).reason, /^structural check: The answer names conventions or user-level decisions, which this continued run recorded already and does not ask for$/);
  });

  it('records a failed attempt for a receipt that did not complete, with the outcome and error', () => {
    const event = contribution(unit('finders', 'RIPPLE', 'finder-RIPPLE'), receipt(null, { outcome: 'timeout', error: 'The worker ran past its timeout' }), triaged().fold(), worktree);
    assert.deepEqual(event, { kind: 'attempt.failed', version: 5, payload: { phase: 'finders', key: 'RIPPLE', workerId: '00000000-0000-4000-8000-0000000000aa', reason: 'timeout: The worker ran past its timeout', fault: 'unit' } });
  });

  it('cuts a failed attempt\'s reason to what the ledger records, marking the cut', () => {
    const event = contribution(unit('finders', 'RIPPLE', 'finder-RIPPLE'), receipt(null, { outcome: 'failed', error: 'e'.repeat(4000) }), triaged().fold(), worktree);
    const payload = attemptFailedV5.parse(event.payload);
    assert.equal(payload.reason.length, 4000);
    assert.match(payload.reason, /^failed: e+ \[truncated\]$/);
  });

  it('records the triage with ids, located candidates, and leads in angle order', () => {
    writeFileSync(join(worktree, 'src', 'caller.ts'), 'one\ntwo\n');
    const output = {
      candidates: [
        { file: 'src\\a.ts', line: 2, summary: 's', detail: 'd' },
        { file: 'src/a.ts', line: 9, summary: 'past the end', detail: 'd' },
        { file: 'SRC/Caller.ts', line: 2, summary: 'a caller', detail: 'd' },
      ],
      leads: [...leads].reverse(),
    };
    const event = contribution(unit('triage', 'SCAN', 'triage'), receipt(output), configured().fold(), worktree);
    assert.equal(event.kind, 'candidates.recorded');
    const payload = event.payload as { candidates: Record<string, unknown>[]; leads: { angle: string }[]; key: string; phase: string };
    assert.equal(payload.phase, 'triage');
    assert.equal(payload.key, 'SCAN');
    assert.deepEqual(payload.candidates[0], { id: 'SCAN-1', angle: 'SCAN', file: 'src/a.ts', line: 2, located: true, inScope: true, rawFile: 'src\\a.ts', rawLine: 2, summary: 's', detail: 'd' });
    assert.deepEqual(payload.candidates[1], { id: 'SCAN-2', angle: 'SCAN', file: null, line: null, located: false, inScope: false, rawFile: 'src/a.ts', rawLine: 9, summary: 'past the end', detail: 'd' });
    assert.deepEqual(payload.candidates[2], { id: 'SCAN-3', angle: 'SCAN', file: 'src/caller.ts', line: 2, located: true, inScope: false, rawFile: 'SRC/Caller.ts', rawLine: 2, summary: 'a caller', detail: 'd' }, 'an unchanged file, in the tree\'s spelling');
    assert.deepEqual(payload.leads.map((lead) => lead.angle), ['REMOVALS', 'RIPPLE', 'FOOTGUNS', 'WRAPPERS', 'EFFICIENCY', 'DESIGN', 'DUPLICATION', 'ALTITUDE', 'CONVENTIONS']);
  });

  it('turns a structural failure into a failed attempt naming the check', () => {
    const output = { candidates: [], leads: [...leads.slice(1), leads[1]] };
    const event = contribution(unit('triage', 'SCAN', 'triage'), receipt(output), configured().fold(), worktree);
    assert.equal(event.kind, 'attempt.failed');
    assert.match((event.payload as { reason: string }).reason, /^structural check: The triage returned two leads for angle RIPPLE/);
  });

  it('records a finder, a sweep with each candidate\'s angle, and ids numbered from 1 per unit', () => {
    const finder = contribution(unit('finders', 'DESIGN', 'finder-DESIGN'), receipt({ candidates: [{ file: 'src/a.ts', line: 1, summary: 's', detail: 'd' }] }), triaged().fold(), worktree);
    assert.deepEqual((finder.payload as { candidates: { id: string; angle: string }[] }).candidates.map((candidate) => [candidate.id, candidate.angle]), [['DESIGN-1', 'DESIGN']]);
    const sweep = contribution(unit('sweep', 'sweep', 'sweep'), receipt({ candidates: [{ file: 'src/a.ts', line: 1, summary: 's', detail: 'd', angle: 'CONVENTIONS' }, { file: 'x', line: 1, summary: 's', detail: 'd', angle: 'SCAN' }] }), verified().fold(), worktree);
    assert.deepEqual((sweep.payload as { candidates: { id: string; angle: string; located: boolean }[] }).candidates.map((candidate) => [candidate.id, candidate.angle, candidate.located]), [['SWEEP-1', 'CONVENTIONS', true], ['SWEEP-2', 'SCAN', false]]);
  });

  it('records every contribution under the kind whose schema its payload satisfies', () => {
    const decodes = (event: NewEvent): boolean => lookupEvent(eventRegistry, event.kind, event.version)?.schema.safeParse(event.payload).success === true;
    const contributions = [
      contribution(unit('triage', 'SCAN', 'triage'), receipt({ candidates: [], leads }), configured().fold(), worktree),
      contribution(unit('finders', 'DESIGN', 'finder-DESIGN'), receipt({ candidates: [] }), triaged().fold(), worktree),
      contribution(unit('sweep', 'sweep', 'sweep'), receipt({ candidates: [] }), verified().fold(), worktree),
      contribution(unit('deduplication', 'deduplication', 'deduplication'), receipt({ groups: [] }), found().fold(), worktree),
      contribution(unit('sweep-deduplication', 'sweep-deduplication', 'deduplication'), receipt({ groups: [{ members: [0, 1], keep: 1, reason: 'same' }] }), swept().fold(), worktree),
      contribution(unit('verification', 'g1', 'verifier'), receipt({ verdicts: [{ index: 0, verdict: 'REFUTED', evidence: 'e' }] }), verified().fold(), worktree),
      contribution(unit('sweep-verification', 'g1', 'verifier'), receipt({ verdicts: [{ index: 0, verdict: 'PLAUSIBLE', evidence: 'e' }, { index: 1, verdict: 'CONFIRMED', evidence: 'e' }] }), swept().fold(), worktree),
      contribution(unit('merge-rank', 'merge-rank', 'merge-rank'), receipt({ findings: [{ primary: 0, members: [1, 2], severity: 'major', summary: 's', reason: 'r' }] }), swept().fold(), worktree),
    ];
    assert.deepEqual(contributions.map((event) => event.kind), ['candidates.recorded', 'candidates.recorded', 'candidates.recorded', 'deduplication.recorded', 'deduplication.recorded', 'verdicts.recorded', 'verdicts.recorded', 'ranking.recorded']);
    for (const event of contributions) assert.ok(decodes(event), `${event.kind} decodes under its own schema: ${JSON.stringify(event.payload)}`);
  });

  it('resolves dedup, verifier and merge-rank indexes against the same fold the task numbered them from', () => {
    const dedup = contribution(unit('deduplication', 'deduplication', 'deduplication'), receipt({ groups: [{ members: [1, 0], keep: 1, reason: 'same' }] }), found().fold(), worktree);
    assert.deepEqual(dedup.payload, { phase: 'deduplication', workerId: '00000000-0000-4000-8000-0000000000aa', groups: [{ members: ['RIPPLE-1', 'SCAN-1'], keep: 'RIPPLE-1', reason: 'same' }] });
    const verdicts = contribution(unit('verification', 'g1', 'verifier'), receipt({ verdicts: [{ index: 0, verdict: 'REFUTED', evidence: 'e' }] }), verified().fold(), worktree);
    assert.deepEqual(verdicts.payload, { phase: 'verification', groupId: 'g1', workerId: '00000000-0000-4000-8000-0000000000aa', verdicts: [{ id: 'RIPPLE-1', verdict: 'REFUTED', evidence: 'e' }] });
    const outOfRange = contribution(unit('verification', 'g1', 'verifier'), receipt({ verdicts: [{ index: 3, verdict: 'REFUTED', evidence: 'e' }] }), verified().fold(), worktree);
    assert.match((outOfRange.payload as { reason: string }).reason, /^structural check: A verdict names index 3/);
    // The working list of the swept run is [RIPPLE-1, SWEEP-1, SWEEP-2]; the worker's order is advisory and the engine's order puts the major CONFIRMED finding first.
    const ranking = contribution(unit('merge-rank', 'merge-rank', 'merge-rank'), receipt({ findings: [
      { primary: 1, members: [], severity: 'minor', summary: 'design', reason: 'r' },
      { primary: 0, members: [2], severity: 'major', summary: 'null', reason: 'r' },
    ] }), swept().fold(), worktree);
    assert.deepEqual((ranking.payload as { findings: { id: string; members: string[] }[] }).findings.map((finding) => [finding.id, finding.members]), [['RIPPLE-1', ['SWEEP-2']], ['SWEEP-1', []]]);
  });

  it('records the decider\'s answer under decisions.recorded@1, each index resolved to the finding it numbered and a superseding index to its finding, in the answer\'s order (R10 of the decision step)', () => {
    const state = decidedOf(mergeRanked(), null).start('decision').fold();
    const answer = deciderAnswer([{ decision: 'leave', reason: 'superseded', supersededBy: 1 }, { departs: true }]) as { decisions: unknown[] };
    const event = contribution(unit('decision', 'decision', 'decider'), receipt({ decisions: [...answer.decisions].reverse() }), state, worktree);
    assert.equal(event.kind, 'decisions.recorded');
    assert.equal(event.version, 1);
    assert.ok(lookupEvent(eventRegistry, event.kind, event.version)?.schema.safeParse(event.payload).success === true, JSON.stringify(event.payload));
    const decided = (event.payload as { decisions: { id: string; decision: string; leave: unknown; departure: unknown }[] }).decisions;
    // The fold holds them in the ranking's order, so the event keeps the decider's.
    assert.deepEqual(decided.map((decision) => [decision.id, decision.decision]), [['SWEEP-1', 'fix'], ['RIPPLE-1', 'leave']]);
    assert.deepEqual(decided[1]!.leave, { reason: 'superseded', supersededBy: 'SWEEP-1' });
    assert.notEqual(decided[0]!.departure, null);
    assert.ok(!('index' in decided[0]!), 'the ledger records ids, never the task\'s indexes');
  });

  it('turns a decider answer the structural check refuses into a failed attempt naming the check', () => {
    const state = decidedOf(mergeRanked(), null).start('decision').fold();
    const short = contribution(unit('decision', 'decision', 'decider'), receipt(deciderAnswer([{}])), state, worktree);
    assert.equal(short.kind, 'attempt.failed');
    assert.match((short.payload as { reason: string }).reason, /^structural check: The answer leaves out finding \[1\] of the 2 the task gave$/);
    const superseded = contribution(unit('decision', 'decision', 'decider'), receipt(deciderAnswer([{ decision: 'leave', reason: 'superseded', supersededBy: 1 }, { decision: 'ask' }])), state, worktree);
    assert.match((superseded.payload as { reason: string }).reason, /^structural check: Decision \[0\] is superseded by \[1\], which is not another finding of the task decided fix$/);
  });
});

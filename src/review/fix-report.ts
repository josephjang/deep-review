/**
 * The report's account of the fix pass (R13 of the fix pass), rendered
 * from the fold alone like the rest of the report: what became of every
 * ranked finding, what the documentation step did with the documents the
 * fixers named (R10 of the documentation step), what each check said
 * before the fixes, after them and after the repair, every file a
 * revision changed, who changed it and which cluster held it (R3 of
 * commit series integrity), and the lines the notes of the run gain. A
 * run without the fix pass has none of these.
 */
import { isDocumentItem, type CheckRan, type FixedFinding, type FixRecorded, type RecordedDecision, type ScopeState, type TreeRevised } from '../checkpoint/events.ts';
import { passOf } from '../checkpoint/answer-state.ts';
import { allBatches, clusterOf, committedRevisions, cutShortChecks, exactPath, holdersKeyedBy, isCutAttempt, isNotAttempted, killedRun, lastAnswerOf, lastClaimOf, lastFixesAnswerOf, earlierTreeEdit, lastRecordedRun, lastFreshRun, notAttemptedNote, openStart, planOfRound, repairTargets, revisionMessageOf, secondRoundPlannable, type CheckRunState, type FixState, type PlannedBatch } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import type { ArtifactReference } from '../evidence/store.ts';
import { killMarkWords } from '../runtime/kill-marks.ts';
import { preRunStrays, type ReviewState } from '../checkpoint/review-fold.ts';
import { baseNameOf } from '../scope/scope-line.ts';
import { baseWords, briefChecksOf, notComparedReasons, notComparedWords, skippedReason, type BriefCheck, type NotComparedReason } from './brief-checks.ts';
import { leftAs } from './decision-report.ts';
import { stepNotRunCause, stepNotRunSentence, unheldDriftLines, type UnheldLine } from './documents.ts';
import { capitalized, codeSpan, counted, inlineText, listed, tableCell } from './markdown.ts';
import { rankedFindings } from './state.ts';
import { checkSourceCell, unavailableCell } from './survey-report.ts';
import { baseSkipReasons, checkPhases, documentationUnitKey, editingPhases, lostClaimWords, repairUnitKey, type BaseReading, type CheckKind, type CheckPhase, type EditingPhase } from './vocabulary.ts';

/**
 * What became of one ranked finding, as the report names it: a fixer's
 * status, or why no fixer answered for it. A finding no fixer saw was
 * left by its decision, or asked of the author with a default that keeps
 * the code as it is; in a run configured before the decision step, which
 * routed by verdict and angle, it was held for the author.
 */
export type FindingOutcome = 'applied' | 'already applied' | 'deferred' | 'blocked' | 'not attempted' | 'left by decision' | 'asked, kept as is' | 'held for the author';

const statusWords: Readonly<Record<FixedFinding['status'], FindingOutcome>> = {
  applied: 'applied',
  'already-applied': 'already applied',
  deferred: 'deferred',
  blocked: 'blocked',
};

/** One ranked finding's fate: its route, its batch and recorded answer, or why it has none. */
interface FindingFate {
  readonly id: string;
  readonly outcome: FindingOutcome;
  /** The decision that kept a held finding from every fixer, or null for a finding a fixer was given, and for a held one of a run configured before the decision step. */
  readonly decision: RecordedDecision | null;
  /** The batch that held it, whose key names its cluster, or null for a held finding. */
  readonly batch: PlannedBatch | null;
  readonly answer: FixedFinding | null;
  /** Why the finding was not attempted, for one whose batch failed twice or met the run budget. */
  readonly reason: string | null;
  /** For a finding the second round took, the files it was first blocked on (R21 of the fix pass); null otherwise. */
  readonly firstBlockedOn: readonly string[] | null;
  /** Why the second round's batch of a finding was not attempted, when its last answer is the first round's. */
  readonly secondRoundSkipped: string | null;
  /** For a finding left as superseded, the finding whose fix was to remove it and what became of that one; null otherwise. */
  readonly superseder: { readonly id: string; readonly outcome: FindingOutcome } | null;
  /** The answer pass whose fixer worked it last, with when the pass was opened, or null when no pass did (R10 of answers). */
  readonly pass: { readonly key: string; readonly at: string } | null;
}

/**
 * Why no fixer saw a held finding: its decision left it, or asked the
 * author with a default that edits nothing; a run configured before the
 * decision step held it for the author by its verdict and angle. A held
 * finding decided `fix` is a plan the engine cannot have made.
 */
function heldOutcome(decision: RecordedDecision | null): FindingOutcome {
  if (decision === null) return 'held for the author';
  if (decision.decision === 'leave') return 'left by decision';
  if (decision.decision === 'ask') return 'asked, kept as is';
  throw new Error(`Finding ${decision.id} is decided fix but held from every fixer`);
}

/** A finding's fate as the last pass that worked it left it, or with `passes` 'skipped', as the fix pass left it, whatever an answer pass did after. */
function fateOf(review: ReviewState, fix: FixState, id: string, passes: 'read' | 'skipped' = 'read'): FindingFate {
  const fixes = passes === 'skipped' ? lastFixesAnswerOf(fix, id) : null;
  const last = passes === 'read' ? lastAnswerOf(fix, id) : fixes === null ? null : { phase: 'fixes' as const, ...fixes };
  // An answer pass's fixer worked it last, whatever its route was (R10 of answers).
  if (last?.phase === 'answer') {
    const pass = passOf(review, last.key);
    if (pass === null) throw new Error(`Finding ${id} is answered by ${last.key}, which no answer pass has`);
    return { id, outcome: statusWords[last.finding.status], decision: null, batch: null, answer: last.finding, reason: null, firstBlockedOn: null, secondRoundSkipped: null, superseder: null, pass: { key: last.key, at: pass.at } };
  }
  const route = fix.plan?.routes.find((candidate) => candidate.id === id)?.route ?? 'fixer';
  if (route === 'held') {
    const decision = review.decisions?.find((candidate) => candidate.id === id) ?? null;
    // The superseding finding is decided fix, so a fixer was given it and its fate is never held: this recursion ends there.
    const by = decision?.leave?.supersededBy ?? null;
    const superseder = by === null ? null : { id: by, outcome: fateOf(review, fix, by).outcome };
    return { id, outcome: heldOutcome(decision), decision, batch: null, answer: null, reason: null, firstBlockedOn: null, secondRoundSkipped: null, superseder, pass: null };
  }
  const second = fix.secondRound?.batches.find((candidate) => candidate.findingIds.includes(id)) ?? null;
  const firstBlockedOn = fix.secondRound?.blocked.find((entry) => entry.id === id)?.requiredFiles ?? null;
  if (last !== null) {
    const batch = allBatches(fix).find((candidate) => candidate.key === last.key) ?? null;
    const answeredInSecond = second !== null && last.key === second.key;
    const secondRoundSkipped = second !== null && !answeredInSecond ? notAttemptedNote(fix, 'fixes', second.key) : null;
    return { id, outcome: statusWords[last.finding.status], decision: null, batch, answer: last.finding, reason: null, firstBlockedOn: answeredInSecond ? firstBlockedOn : null, secondRoundSkipped, superseder: null, pass: null };
  }
  const batch = fix.plan?.batches.find((candidate) => candidate.findingIds.includes(id)) ?? null;
  const reason = (batch === null ? null : notAttemptedNote(fix, 'fixes', batch.key)) ?? 'no fixer answered for it';
  return { id, outcome: 'not attempted', decision: null, batch, answer: null, reason, firstBlockedOn: null, secondRoundSkipped: null, superseder: null, pass: null };
}

/** A ranked finding's last outcome in a fix run, with the answer that gave it, a fix pass's or an answer pass's, or null with why no fixer attempted it. */
export function lastFixAnswer(review: ReviewState, fix: FixState, id: string): { readonly outcome: FindingOutcome; readonly answer: FixedFinding | null; readonly reason: string | null } {
  const { outcome, answer, reason } = fateOf(review, fix, id);
  return { outcome, answer, reason };
}

/** What became of one ranked finding in a fix run, in the two halves the brief of a run reads apart (R2, R9 of the brief of a run). */
export interface FindingOutcomes {
  /** The outcome as Fixes names it, the last pass's (R10 of answers). */
  readonly last: FindingOutcome;
  /** Whether an answer pass's fixer gave `last`, working a person's answer rather than the decision. */
  readonly byAnswerPass: boolean;
  /** What the fix pass did with the decision, which no later answer pass changes. */
  readonly fixPass: FindingOutcome;
  /** Why the fix pass did not attempt it, when `last` is not attempted: its batch failed twice or met the run budget, or null when neither settled it. */
  readonly unattempted: 'failures' | 'budget' | null;
}

/** One ranked finding's outcomes in a fix run: the last pass's, and the fix pass's. */
export function findingOutcomes(review: ReviewState, fix: FixState, id: string): FindingOutcomes {
  const last = fateOf(review, fix, id);
  const unattempted = last.outcome === 'not attempted' && last.batch !== null ? (fix.notAttempted.fixes[last.batch.key]?.cause ?? null) : null;
  return { last: last.outcome, byAnswerPass: last.pass !== null, fixPass: fateOf(review, fix, id, 'skipped').outcome, unattempted };
}

/**
 * The line of a finding left as superseded: the superseding finding's
 * outcome, since its fix was to remove this one, and when that fix did
 * not land, that this finding may still stand. "No fixer saw it" is not
 * true of it, since the superseding finding's fixer is shown it:
 * https://github.com/josephjang/deep-review/issues/28
 */
function supersededLine(leave: NonNullable<RecordedDecision['leave']>, superseder: NonNullable<FindingFate['superseder']>): string {
  const outcome = superseder.outcome === 'not attempted' ? 'whose fix was not attempted' : `whose fixer reported it ${superseder.outcome}`;
  const landed = superseder.outcome === 'applied' || superseder.outcome === 'already applied';
  return `No fixer saw it: the decision step left it, ${leftAs(leave)}, ${outcome}.${landed ? '' : ` Its removal depended on ${superseder.id}'s fix, so this finding may still stand.`} See Decisions.`;
}

/** The 1-based numbers of the patches whose revisions of a phase hold a finding (or, for the repair, a check kind). */
function patchesOf(fix: FixState, id: string, phase: EditingPhase): number[] {
  return fix.revisions.flatMap((revision, index) => (revision.phase === phase && revision.change.findings.includes(id) ? [index + 1] : []));
}

const patchNote = (numbers: readonly number[]): string => (numbers.length === 0 ? 'no patch' : `patch ${numbers.join(', ')}`);

/** Every fixer's recorded answer, phase by phase in `editingPhases` order, so an editing phase added there is reported too. */
const allFixerAnswers = (fix: FixState): FixRecorded[] => editingPhases.flatMap((phase) => Object.values(fix.answers[phase]));

/** The lines one finding's fate prints under its heading. */
function fateLines(fix: FixState, fate: FindingFate): string[] {
  if (fate.outcome === 'held for the author') return ['A PLAUSIBLE finding from a design angle: held for the author, and no fixer saw it.'];
  if (fate.outcome === 'left by decision' && fate.decision?.decision === 'leave' && fate.superseder !== null) return [supersededLine(fate.decision.leave, fate.superseder)];
  if (fate.outcome === 'left by decision' && fate.decision?.decision === 'leave') return [`No fixer saw it: the decision step left it, ${leftAs(fate.decision.leave)}. See Decisions.`];
  if (fate.outcome === 'asked, kept as is') return ['No fixer saw it: the decision step asks the author, and its default keeps the code as it is. See Decisions.'];
  const lines: string[] = [];
  if (fate.answer !== null) {
    lines.push(`Note: ${inlineText(fate.answer.note)}`);
    if (fate.answer.message !== null) lines.push(`Commit message: ${inlineText(fate.answer.message.subject)}`);
  } else if (fate.reason !== null) {
    lines.push(`Not attempted: ${inlineText(fate.reason)}`);
  }
  if (fate.batch !== null) {
    const files = clusterOf(fix, fate.batch.cluster)?.files ?? [];
    lines.push(`Cluster: ${fate.batch.cluster}, batch ${fate.batch.key}${files.length === 0 ? ', owning no file' : ` (${files.map(inlineText).join(', ')})`}; ${patchNote(patchesOf(fix, fate.id, 'fixes'))}`);
  }
  if (fate.pass !== null) lines.push(`Answer pass: ${fate.pass.key}, opened on ${fate.pass.at}; ${patchNote(patchesOf(fix, fate.id, 'answer'))}`);
  for (const correction of fate.answer?.corrections ?? []) lines.push(`Correction: ${inlineText(correction.file)} ${inlineText(correction.anchor)}: ${inlineText(correction.claim)} -> ${inlineText(correction.fact)} (${inlineText(correction.evidence)})`);
  if (fate.answer !== null && fate.answer.requiredFiles.length > 0) lines.push(`Needs, from another cluster: ${fate.answer.requiredFiles.map(inlineText).join(', ')}`);
  if (fate.firstBlockedOn !== null) lines.push(`First blocked on: ${fate.firstBlockedOn.map(inlineText).join(', ')}, which the second round gave it`);
  if (fate.secondRoundSkipped !== null) lines.push(`Second round not attempted: ${inlineText(fate.secondRoundSkipped)}`);
  // A finding the first round blocked has no second round while the run budget left a batch of the first, until a reopen runs it (PD13 of resumable runs).
  if (fate.answer?.status === 'blocked' && fix.secondRound === null && !secondRoundPlannable(fix)) lines.push('Second round not planned: the run budget stopped the first round');
  return lines;
}

/**
 * What a stop did to the checks and to the tree, and what the resumed run
 * did about it (R15 of resumable runs), as bare sentences that the notes
 * of the run and `status` each prefix, in the order of the checks phases: each run that replaced one, with both
 * outcomes, by why it ran again (a cut, a first timeout, a stop of its
 * attempt, or, for a build on the base, the worktree its attempt makes
 * anew, with no stop at all); each start with no end on record; each file written back,
 * with where the bytes it overwrote are; and a series of commits a stop
 * left open, or that was dropped, by the next command or by a refused move
 * of the branch.
 */
export function stopLimitations(review: ReviewState, evidencePath: (reference: ArtifactReference) => string): string[] {
  const fix = review.fix;
  if (fix === null) return [];
  const lines: string[] = [];
  for (const phase of checkPhases) {
    const runs = fix.checks.runs[phase];
    for (const run of runs) {
      if (run.replacedAt === null) continue;
      const replaced = runs[run.replacedAt]!;
      const now = `${run.outcome} in ${runSeconds(run)}`;
      // A build on the base runs again in an attempt that makes its own worktree, stop or none (TD16 of the facts before a merge): `runStanding` gives a cut attempt only a build that did not pass.
      const rebuilt = phase === 'base-checks' && run.kind === 'build' && (replaced.outcome === 'passed' || (replaced.outcome === 'skipped' && !isCutAttempt({ ...review, fix }, phase, replaced.attempt)));
      if (rebuilt && replaced.outcome === 'passed') lines.push(`Built again on the base: ${run.kind} in ${phase} passed in ${runSeconds(replaced)} at attempt ${String(replaced.attempt)}, and ${now} at attempt ${String(run.attempt)}, since each attempt makes its own worktree of the base.`);
      else if (rebuilt) lines.push(`Built again on the base: ${run.kind} in ${phase} was skipped at attempt ${String(replaced.attempt)}, which had no worktree of the base, and ${now} at attempt ${String(run.attempt)}, since each attempt makes its own worktree of the base.`);
      else if (replaced.outcome === 'cut') lines.push(`Cut: ${run.kind} in ${phase} ended with ${killMarkWords(replaced)}, and ran again: ${now}.`);
      else if (replaced.outcome === 'timeout') lines.push(`Ran again after a timeout: ${run.kind} in ${phase} timed out after ${runSeconds(replaced)} at its first run, and ${now} at its second.`);
      else lines.push(`Ran again after a stop: ${run.kind} in ${phase}, ${replaced.outcome} in ${runSeconds(replaced)} at attempt ${String(replaced.attempt)}, ${now} at attempt ${String(run.attempt)}.`);
    }
    for (const start of fix.checks.starts[phase]) {
      if (openStart(fix, phase, start.kind, start.attempt) === start) lines.push(`Cut by a stop: ${start.kind} in ${phase} at attempt ${String(start.attempt)}, with no end on record.`);
    }
  }
  fix.restorations.forEach((restoration, index) => {
    // A write back in the step of the run a kill ended follows that run, the kind's killed runs of the attempt in order; one at a later attempt follows the last check of its kind and attempt a kill cut short, a run or a start no run came after, as `cutShortBefore` found it.
    const { kind, attempt } = restoration.check;
    const same = (other: (typeof fix.restorations)[number]): boolean => other.phase === restoration.phase && other.check.kind === kind && other.check.attempt === attempt && other.attempt === attempt;
    const followed = restoration.attempt === attempt ? fix.checks.runs[restoration.phase].filter((run) => run.kind === kind && run.attempt === attempt && killedRun(run))[fix.restorations.slice(0, index).filter(same).length] : cutShortChecks(fix, restoration.phase).findLast((check) => check.kind === kind && check.attempt === attempt);
    const after = followed !== undefined && 'outcome' in followed && followed.outcome === 'timeout' ? `after ${kind} timed out` : `after a cut ${kind} check`;
    for (const { path, before, expected } of restoration.files) {
      // The write back leaves a file whose bytes in the tree or expected bytes were too large to keep, so writing over them would lose them (`writeBack`).
      if (before !== null && 'oversized' in before) lines.push(`Not written back ${after} in ${restoration.phase}: ${inlineText(path)}; its bytes in the tree were too large to keep.`);
      else if (expected !== null && 'oversized' in expected) lines.push(`Not written back ${after} in ${restoration.phase}: ${inlineText(path)}; its expected bytes were too large to keep.`);
      else lines.push(`Written back ${after} in ${restoration.phase}: ${inlineText(path)}; ${before === null ? 'it did not exist before' : `the bytes before are at ${evidencePath(before.blob)}`}.`);
    }
  });
  if (fix.openSeries !== null) lines.push(`A stop cut \`deep-review commit\` short: its series from ${fix.openSeries.from} to ${fix.openSeries.to} is not recorded yet, and the next command completes it or drops it by where HEAD is.`);
  // The next command drops a series a stop left open with HEAD at its start, and `deep-review commit` drops its own when git refused to move the branch; the line holds for both.
  for (const dropped of fix.droppedSeries) lines.push(`Dropped: the series of commits from ${dropped.from} to ${dropped.to}, which the branch never moved to, after a stop or a refused move; a later \`deep-review commit\` builds it again.`);
  return lines;
}

/**
 * The fixers' own lines of the Fixes section: the tests they added, and
 * where the documentation their edits made stale is, which the section
 * Documentation lists with what became of it (R10 of the documentation
 * step).
 */
function answerLines(fix: FixState): string[] {
  // The documentation step's own drift and tests are not a fixer's: the section Documentation reports its answer.
  const answers = allFixerAnswers(fix).filter((answer) => answer.phase !== 'documentation');
  const drift = answers.some((answer) => answer.drift.length > 0);
  const tests = answers.flatMap((answer) => answer.tests.map((entry) => `- ${inlineText(entry.file)}: ${inlineText(entry.covers)} (${answer.key})`));
  return [
    ...(drift ? ['', 'The documentation the fixers say their edits made stale is under Documentation, with what became of it.'] : []),
    ...(tests.length === 0 ? [] : ['', 'Tests the fixers say they added or tightened:', '', ...tests]),
  ];
}

/** Who reported a `drift` line no item took, as the evidence names it: a batch by its key, the repair, or an answer pass by its number. */
const reporterWords = (line: UnheldLine): string => (line.phase === 'repair' ? 'the repair' : line.phase === 'answer' ? `answer pass ${String(line.time)}` : line.key);

/**
 * The Documentation section (R10 of the documentation step): whether the
 * documentation step ran, and why not; each item of its plan with its
 * outcome, the document it names, its note, the subject of its commit,
 * its files and their patch, the lines it took and its validation; the
 * documents the step found out of date at its end; and each `drift` line
 * no item took, with who reported it. A run with no step and no line has
 * none.
 */
function documentationSection(review: ReviewState, fix: FixState): string[] {
  const plan = fix.documentation;
  const unheld = unheldDriftLines(review);
  if (!review.documentationStep && unheld.length === 0) return [];
  const answer = fix.answers.documentation[documentationUnitKey];
  const cause = stepNotRunCause(review);
  // The step is one unit, so a settled unit leaves every item of its plan not attempted, for one reason.
  const notAttempted = isNotAttempted(fix, 'documentation', documentationUnitKey);
  // A run the step has not planned has no item.
  const planned = plan?.items ?? [];
  const items = planned.flatMap((item, index) => {
    const finding = answer?.findings.find((candidate) => candidate.id === item.id);
    const outcome = finding !== undefined ? statusWords[finding.status] : notAttempted ? 'not attempted' : 'not answered';
    const document = isDocumentItem(item)
      ? [`Document: ${codeSpan(item.file)}, ${item.path === null ? 'which the engine refused as a path of the repository' : `the repository path ${codeSpan(item.path)}`}`]
      : [];
    const answered = finding === undefined
      ? (notAttempted ? [`Not attempted: ${inlineText(notAttemptedNote(fix, 'documentation', documentationUnitKey)!)}`] : [])
      : [
          `Note: ${inlineText(finding.note)}`,
          ...(finding.message === null ? [] : [`Commit message: ${inlineText(finding.message.subject)}`]),
          ...(finding.files.length === 0 ? [] : [`Files: ${finding.files.map(inlineText).join(', ')}; ${patchNote(patchesOf(fix, item.id, 'documentation'))}`]),
          ...finding.validation.map((entry) => `Validation: ${entry.method}, ${inlineText(entry.source)}: ${inlineText(entry.evidence)}`),
        ];
    const took = item.drift.length === 0 ? [] : ['Lines it took:', ...item.drift.map((line) => `- ${inlineText(line.what)} (${line.key}${line.file === item.file ? '' : `, as ${inlineText(line.file)}`})`)];
    return [`### ${String(index + 1)}. ${item.id} ${outcome}`, '', ...document, ...answered, ...took, ''];
  });
  const found = (answer?.drift ?? []).map((line) => `- ${inlineText(line.file)}: ${inlineText(line.what)}`);
  const untaken = unheld.map((line) => `- ${inlineText(line.file)}: ${inlineText(line.what)} (${reporterWords(line)})`);
  const lines = [
    '## Documentation',
    '',
    cause === null
      ? `The documentation step answered for ${counted(planned.filter(isDocumentItem).length, 'document', 'documents')} the fixers named, and for its own search.`
      : stepNotRunSentence(cause),
    '',
    ...items,
    ...(found.length === 0 ? [] : ['Documents the documentation step found out of date at its end, which it did not bring in line:', '', ...found, '']),
    ...(untaken.length === 0 ? [] : [plan === null ? 'Documentation the workers of this run say their edits made stale, which no step of this run took:' : 'Documentation the repair or an answer pass says its edits made stale, after the documentation step:', '', ...untaken, '']),
  ];
  // One blank line between blocks, and none at the end.
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').filter((line, index, all) => line !== '' || index < all.length - 1);
}

/** Patches `from` to `to`, as a clause's subject and the verb that agrees with it. */
function patchSpan(from: number, to: number): { readonly subject: string; readonly verb: 'is' | 'are' } {
  return from === to ? { subject: `patch ${String(from)}`, verb: 'is' } : { subject: `patches ${String(from)} to ${String(to)}`, verb: 'are' };
}

/** Which pass made a revision after a committed series (R8 of answers, R15 of resumable runs): an answer pass, or the fix pass a reopen continued, its fixes, checks and repair. */
const laterPass = (revision: Pick<TreeRevised, 'phase'>): string => (revision.phase === 'answer' || revision.phase === 'answer-checks' ? 'an answer pass' : 'the reopened fix pass');

/** Where the run's edits are, as a lowercase clause: every one in the working tree, uncommitted, or the ones `deep-review commit` committed and the rest, named by the passes that made them (R8 of answers, R15 of resumable runs). */
function committedWords(fix: FixState): string {
  const committed = committedRevisions(fix);
  if (committed === 0) return 'every edit is in the working tree, uncommitted';
  const total = fix.revisions.length;
  const done = patchSpan(1, committed);
  const head = `${done.subject} ${done.verb} committed`;
  if (committed >= total) return head;
  const rest = patchSpan(committed + 1, total);
  const passes = [...new Set(fix.revisions.slice(committed).map(laterPass))].sort().reverse().map((pass) => `${pass}'s`).join(' and ');
  return `${head}; ${rest.subject}, ${passes}, ${rest.verb} in the working tree, uncommitted`;
}

/** The Fixes section: every ranked finding in rank order with its fate, the repair's checks, the fixers' test lines, and where the documentation they say their edits made stale is. */
function fixesSection(review: ReviewState, fix: FixState): string[] {
  const findings = rankedFindings(review);
  const blocks = findings.flatMap((entry, index) => {
    const fate = fateOf(review, fix, entry.finding.id);
    return [`### ${String(index + 1)}. ${entry.finding.id} ${fate.outcome}`, '', ...fateLines(fix, fate), ''];
  });
  const repair = fix.answers.repair[repairUnitKey];
  const repairLines = repair === undefined
    ? isNotAttempted(fix, 'repair', repairUnitKey) ? ['### Repair', '', `Not attempted: ${inlineText(notAttemptedNote(fix, 'repair', repairUnitKey)!)}`, ''] : []
    : ['### Repair', '', ...repair.findings.map((finding) => `- ${finding.id} check ${statusWords[finding.status]}: ${inlineText(finding.note)}; ${patchNote(patchesOf(fix, finding.id, 'repair'))}`), ''];
  const lines = [
    '## Fixes',
    '',
    `What the fix pass${review.answerPasses.length === 0 ? '' : ', and the answer passes after it,'} did with each finding, in rank order. ${capitalized(committedWords(fix))}; a patch number is one of the series under Changed files.`,
    '',
    ...(findings.length === 0 ? ['No finding to fix.', ''] : blocks),
    ...repairLines,
    ...answerLines(fix),
  ];
  // One blank line between blocks, however the blocks above end.
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '');
}

const phaseTitles: Readonly<Record<CheckPhase, string>> = { 'baseline-checks': 'Before the fixes', checks: 'After the fixes', 'base-checks': 'On the base', 'repair-checks': 'After the repair', 'answer-checks': 'After answers' };

/** Whose revision changed the tree a run checked, as the note under the Checks table names it. */
const revisionOwners: Readonly<Record<EditingPhase, string>> = { fixes: 'the fixes', documentation: 'the documentation step', repair: 'the repair', answer: 'an answer pass' };

const runSeconds = (run: CheckRan): string => `${((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)} s`;

/** One table cell: a run's outcome and seconds, the frozen output's paths for one that did not pass, and the note that follows them. */
function checkCell(run: CheckRan | null, evidencePath: (reference: { sha256: string; bytes: number }) => string, note: string): string {
  if (run === null) return '-';
  // A run on the base says why it was skipped in fixed words: the error of git after them names local paths, which the facts of the run alone give (R5 of the facts before a merge).
  if (run.outcome === 'skipped') return tableCell(`skipped: ${run.phase === 'base-checks' ? notComparedWords[skippedReason(run.error)] : run.error ?? 'build did not pass'}`);
  const output = run.stdout === null || run.stderr === null ? '' : `; output ${evidencePath(run.stdout)}, ${evidencePath(run.stderr)}`;
  const text = `${run.outcome}, ${runSeconds(run)}${run.outcome === 'passed' ? '' : output}${note}`;
  return tableCell(text);
}

/** The repair's reading of a comparison with the base, in the words of R2 of the facts before a merge. */
const readingWords: Readonly<Record<BaseReading, string>> = {
  same: 'the change has no failure that the base does not have',
  adds: 'the change has a failure that the base does not have',
  unknown: 'the outputs cannot be compared',
};

/**
 * Why a kind the run took to the base did not run there, as a note under
 * the Checks table says it (R8 of the facts before a merge): for a reason
 * a run there records skipped, in the words of the brief, with the error of
 * git left to the facts of the run; null for a run there that ended, which
 * has its cell.
 */
function notRunOnBase(reason: NotComparedReason, kinds: string): string | null {
  if (reason === 'not-run') return `${kinds} did not run there.`;
  if (!Object.hasOwn(baseSkipReasons, reason)) return null;
  return `${kinds} did not run there, since ${notComparedWords[reason]}${reason === 'no-worktree' ? '; the facts of the run give the error of git' : ''}.`;
}

/**
 * The notes under the Checks table of a run configured with the checks on
 * the base (R8 of the facts before a merge): the base by its name and its
 * commit, and why a kind the run took there did not run there; or, when
 * the checks after the fixes ran and no kind failed before and after
 * them, that none ran there and why. A run configured before the checks
 * on the base says nothing of the base (R10).
 */
function baseNotes(review: ReviewState, fix: FixState, checks: readonly BriefCheck[], scope: ScopeState): string[] {
  if (!review.baseChecksStep) return [];
  const title = phaseTitles['base-checks'];
  const taken = checks.flatMap((check) => (check.base === null ? [] : [{ kind: check.kind, reason: check.base.reason }]));
  if (taken.length === 0 && fix.checks.runs['base-checks'].length === 0) return fix.checks.runs.checks.length === 0 ? [] : [`- ${title}: not run, since no check failed before and after the fixes.`];
  const notRun = notComparedReasons.flatMap((reason) => {
    const kinds = taken.filter((entry) => entry.reason === reason).map((entry) => entry.kind);
    const words = kinds.length === 0 ? null : notRunOnBase(reason, listed(kinds));
    return words === null ? [] : [`- ${title}: ${words}`];
  });
  return [`- ${title}: the base of the change is ${baseWords({ commit: scope.base, name: baseNameOf(scope.mode, scope.request) })}.`, ...notRun];
}

/**
 * The error of git for each worktree of the base it could not make, as a
 * line of the facts of the run, the one part of the report that names a
 * local path (R5 of the facts before a merge; R15 of the brief of a run).
 */
export function baseWorktreeLines(review: ReviewState): string[] {
  const prefix = `${baseSkipReasons['no-worktree']}: `;
  const errors = new Set((review.fix?.checks.runs['base-checks'] ?? []).flatMap((run) => (run.outcome === 'skipped' && run.error?.startsWith(prefix) === true ? [run.error.slice(prefix.length)] : [])));
  return [...errors].map((error) => `Worktree of the base: git could not make it: ${inlineText(error)}`);
}

/**
 * The Checks section: a row per kind and a column per checks phase that
 * ran a check, a kind with no command saying why. A surveyed run's table
 * also says where each command came from (R10, R15 of the repository
 * survey); one configured before the survey renders as it did. The column
 * of the runs on the base gives each cell the repair's reading of it and
 * its words, and no mark of a failure before the fix pass, which each
 * kind there has (R8 of the facts before a merge).
 */
function checksSection(review: ReviewState, fix: FixState, scope: ScopeState, evidencePath: (reference: { sha256: string; bytes: number }) => string): string[] {
  const { survey } = review;
  const planned = fix.checks.planned?.checks ?? [];
  const ran = checkPhases.filter((phase) => fix.checks.runs[phase].length > 0);
  // The last baseline run, which never grows old, with not-started among the failures the mark names.
  const failingBeforeFixes = (kind: CheckKind): boolean => ['failed', 'timeout', 'not-started'].includes(lastFreshRun(fix, 'baseline-checks', kind)?.outcome ?? '');
  const sourceCell = (check: (typeof planned)[number]): string[] => (survey === null ? [] : [checkSourceCell(survey, check)]);
  // Each column shows the last run of each kind, and is marked when a later edit changed the tree its runs checked.
  const shown = (phase: CheckPhase, kind: CheckKind): CheckRunState | null => lastRecordedRun(fix, phase, kind);
  const edits = new Map(ran.map((phase) => [phase, planned.map((check) => shown(phase, check.kind)).flatMap((run) => (run === null ? [] : [earlierTreeEdit(fix, phase, run)])).find((edit) => edit !== null) ?? null]));
  // What the base says of each kind the run took there, as the brief says it.
  const checks = briefChecksOf({ ...review, fix }, scope);
  const comparisons = fix.answers.repair[repairUnitKey]?.comparisons ?? [];
  const baseNote = (kind: CheckKind): string => {
    const comparison = comparisons.find((entry) => entry.kind === kind);
    if (comparison !== undefined) return `; the repair's reading: ${readingWords[comparison.reading]} (${inlineText(comparison.words)})`;
    return checks.find((check) => check.kind === kind)?.base?.reason === 'no-comparison' ? `; ${notComparedWords['no-comparison']}` : '';
  };
  const note = (phase: CheckPhase, kind: CheckKind): string => {
    if (phase === 'base-checks') return baseNote(kind);
    return phase !== 'baseline-checks' && failingBeforeFixes(kind) ? ' (failing before the fix pass)' : '';
  };
  const rows = planned.map((check) => {
    if (check.command === null) return `| ${[check.kind, unavailableCell(survey, check), ...sourceCell(check), ...ran.map(() => '-')].join(' | ')} |`;
    const cells = ran.map((phase) => checkCell(shown(phase, check.kind), evidencePath, note(phase, check.kind)));
    return `| ${[check.kind, tableCell(check.command), ...sourceCell(check), ...cells].join(' | ')} |`;
  });
  const answered = review.answerPasses.length > 0;
  // Why a checks phase ran nothing: with no kind given a command, none ever runs, whatever the fixes did; otherwise the phase's own condition.
  const repairWhy = repairTargets(fix, 'recorded').length === 0 ? 'no check failed after the fixes' : isNotAttempted(fix, 'repair', repairUnitKey) ? 'the repair was not attempted' : 'the repair changed no file';
  const notRun = planned.every((check) => check.command === null)
    ? ['- No check ran in any phase, since no kind has a command.']
    : [
        ...(fix.checks.runs.checks.length === 0 ? ['- After the fixes: not run, since no fix changed a file.'] : []),
        ...(fix.checks.runs['repair-checks'].length === 0 ? [`- After the repair: not run, since ${repairWhy}.`] : []),
        ...(answered && fix.checks.runs['answer-checks'].length === 0 ? ['- After answers: not run, since no answer pass changed a file.'] : []),
        ...baseNotes(review, fix, checks, scope),
      ];
  const earlier = ran.flatMap((phase) => {
    const edit = edits.get(phase) ?? null;
    return edit === null ? [] : [`- ${phaseTitles[phase]}: its runs checked an earlier tree, which a later revision of ${revisionOwners[edit]} changed.`];
  });
  // One list of columns gives the header and the separator, so the two cannot disagree on the count.
  const columns = ['Check', 'Command', ...(survey === null ? [] : ['Source']), ...ran.map((phase) => `${phaseTitles[phase]}${edits.get(phase) === null ? '' : ' (an earlier tree)'}`)];
  return [
    '## Checks',
    '',
    `| ${columns.join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows,
    ...(notRun.length + earlier.length === 0 ? [] : ['', ...notRun, ...earlier]),
  ];
}

/** Who a revision's source is, as Changed files names it. */
function revisedBy(revision: TreeRevised): string {
  switch (revision.source.kind) {
    case 'fix':
      return revision.source.key;
    case 'check':
      return `${revision.source.check} check`;
    case 'attempt':
      return `${revision.source.key}, unfinished attempt`;
  }
}

/** What the revisions did to one path: who revised it and its entries, each in ledger order. */
interface PathRevisions {
  readonly by: Set<string>;
  readonly files: TreeRevised['files'][number][];
}

/** Every path the revisions name, with what they did to it, in one pass over them however many paths a check revision brings. */
function revisionsByPath(revisions: readonly TreeRevised[]): Map<string, PathRevisions> {
  const paths = new Map<string, PathRevisions>();
  for (const revision of revisions) {
    for (const file of revision.files) {
      const entry = paths.get(file.path) ?? { by: new Set<string>(), files: [] };
      entry.by.add(revisedBy(revision));
      entry.files.push(file);
      paths.set(file.path, entry);
    }
  }
  return paths;
}

/** The status a path ends the run with: created, modified or deleted against what it held before its first revision, or removed again when it was created and then deleted. */
function finalStatus(files: PathRevisions['files']): string {
  const existedBefore = (files[0]?.before ?? null) !== null;
  const existsAfter = (files.at(-1)?.after ?? null) !== null;
  if (existedBefore) return existsAfter ? 'modified' : 'deleted';
  return existsAfter ? 'created' : 'created, then deleted';
}

/**
 * Which clusters held a path in the fixes phase, round by round (R1, R3 of
 * commit series integrity), from each planned round's holders as
 * `holdersKeyedBy` gives them, built once for every path: its owner by the
 * plan, or else the cluster that claimed it last in that round, marked as
 * a claim or a late claim; `nobody` for a path no cluster held, such as one
 * only a check wrote.
 */
function heldBy(fix: FixState): (path: string) => string {
  const rounds = ([1, 2] as const).flatMap((round) => (planOfRound(fix, round) === null ? [] : [{ round, held: holdersKeyedBy(fix, round, exactPath) }]));
  return (path) => {
    const holders = rounds.flatMap(({ round, held }) => {
      const holder = held.get(path);
      if (holder === undefined) return [];
      if (holder.by === 'plan') return [holder.cluster];
      return [`${holder.cluster} (${lastClaimOf(fix, round, path)?.claimedAt === null ? 'claimed late' : 'claimed'})`];
    });
    return holders.length === 0 ? 'nobody' : [...new Set(holders)].join(', ');
  };
}

/** The Changed files section: every path a revision names, once, with its final status, who changed it and who held it, then the patch series. */
function changedFilesSection(fix: FixState, patches: readonly string[]): string[] {
  const revised = revisionsByPath(fix.revisions);
  const holderOf = heldBy(fix);
  const paths = [...revised.keys()].sort();
  const rows = paths.map((path) => {
    const { by, files } = revised.get(path)!;
    return `| ${tableCell(path)} | ${finalStatus(files)} | ${tableCell([...by].join(', '))} | ${tableCell(holderOf(path))} |`;
  });
  // A revision after a committed series names the pass that made it, which a later series commits (R15 of resumable runs).
  const committed = committedRevisions(fix);
  const series = fix.revisions.map((revision, index) => `${String(index + 1)}. ${inlineText(revisionMessageOf(fix, revision).subject)} (${revisedBy(revision)}${committed > 0 && index >= committed ? `, ${laterPass(revision)} after the commits` : ''}): ${patches[index] ?? 'not written'}`);
  return [
    '## Changed files',
    '',
    ...(paths.length === 0 ? ['No file was changed.'] : ['| Path | Status | Changed by | Held by |', '|---|---|---|---|', ...rows]),
    ...(series.length === 0 ? [] : ['', 'The patch series, one patch per change, applies in order to a tree at the scope with `git am --keep-cr`:', '', ...series]),
  ];
}

/** The sections the fix pass adds after Findings, in order: Fixes, Documentation when the run has the step or a drift line, Checks, Changed files; none for a run without it. */
export function fixSections(state: RunState, evidencePath: (reference: { sha256: string; bytes: number }) => string, patches: readonly string[]): string[][] {
  const review = state.review;
  const fix = review?.fix ?? null;
  if (review === null || fix === null) return [];
  return [fixesSection(review, fix), documentationSection(review, fix), checksSection(review, fix, state.scope!, evidencePath), changedFilesSection(fix, patches)].filter((section) => section.length > 0);
}

/**
 * The line of the facts of the run for a fix run: how many findings each outcome took,
 * and that the edits are uncommitted. A run with the decision step counts
 * the findings its decisions kept from every fixer; one configured before
 * the step counts those it held for the author, as its report did then.
 */
export function fixHeaderLine(review: ReviewState): string | null {
  const fix = review.fix;
  if (fix === null) return null;
  const outcomes = rankedFindings(review).map((entry) => fateOf(review, fix, entry.finding.id).outcome);
  const held: readonly FindingOutcome[] = review.phases.decision.status === 'skipped' ? ['held for the author'] : ['left by decision', 'asked, kept as is'];
  const counts = (['applied', 'already applied', 'deferred', 'blocked', 'not attempted', ...held] as const).map((outcome) => `${String(outcomes.filter((candidate) => candidate === outcome).length)} ${outcome}`);
  return `Fix pass: ${counts.join(', ')}; ${String(fix.revisions.length)} patch${fix.revisions.length === 1 ? '' : 'es'}; ${committedRevisions(fix) === 0 ? 'the edits are in the working tree, uncommitted' : committedWords(fix)}`;
}

/**
 * The strays the run left: every path its last worktree check found, less
 * those that were there before the run edited anything (`preRunStrays`:
 * its first check's, and a continued run's first since the continuation),
 * and less those a revision holds, such as a fixer's build of `dist/` that
 * the tail check revision rewrote (PD9 of commit series integrity). A path
 * only an earlier check found, such as a tracked leftover a fixer then
 * restored, is no longer in the tree.
 */
function strayedInRun(review: ReviewState, revisions: FixState['revisions']): string[] {
  const before = preRunStrays(review);
  const revised = new Set(revisions.flatMap((revision) => revision.files.map((file) => file.path)));
  return (review.checks.at(-1)?.strays ?? []).filter((path) => !before.has(path) && !revised.has(path)).sort();
}

/** A fixer as the notes of the run name it at the start of a line, by its phase, so a new editing phase must be named here. */
function fixerTitle(phase: EditingPhase, key: string): string {
  switch (phase) {
    case 'fixes':
      return `Fixer ${key}`;
    case 'documentation':
      return 'The documentation step';
    case 'repair':
      return 'The repair';
    case 'answer':
      return `The fixer of the answer pass ${key}`;
  }
}

/**
 * The lines the fix pass adds to the notes of the run: violations, late
 * and lost claims, strays, and the fixers' validation and suite lines.
 */
export function fixLimitations(review: ReviewState): string[] {
  const fix = review.fix;
  if (fix === null) return [];
  const lines: string[] = [];
  // A violation names the holder the fold judged it against when the answer was recorded, not a cluster that claimed the file after (R6 of commit series integrity).
  const holder = (key: string, path: string): string => {
    const held = fix.violationHolders[key]?.[path];
    if (held === undefined) return 'held by no cluster';
    return `${held.by === 'plan' ? 'owned' : 'claimed'} by ${held.cluster}`;
  };
  for (const answer of Object.values(fix.answers.fixes)) {
    for (const path of answer.violations) lines.push(`- Ownership violation: ${inlineText(path)}, ${holder(answer.key, path)}, was edited by ${answer.key}, which reported it; the edit is kept and revised (PD4).`);
  }
  // A path a fixer's revision holds that a later check rewrote: a generated file the fixer kept, which the check's tail revision overwrites, or a fix the check reformatted (R7, PD9 of commit series integrity). A revision of an unfinished attempt counts as its fixer's, since a stop can leave a fixer's edits there rather than in its answer's (R10 of resumable runs).
  fix.revisions.forEach((revision, index) => {
    if (revision.source.kind === 'check') return;
    const { key } = revision.source;
    const what = revision.change.findings.length === 0 ? 'partial edits' : revision.change.findings.join(', ');
    const later = fix.revisions.slice(index + 1).filter((candidate) => candidate.source.kind === 'check');
    for (const file of revision.files) {
      const check = later.find((candidate) => candidate.files.some((rewritten) => rewritten.path === file.path));
      if (check !== undefined && check.source.kind === 'check') lines.push(`- Rewritten by a later check: ${inlineText(file.path)}, in ${key}'s revision of ${what}, by the ${check.source.check} check in ${check.phase}; a generated file the fixer kept, or a fix the check reformatted.`);
    }
  });
  for (const claim of fix.claims.filter((candidate) => candidate.claimedAt === null)) lines.push(`- Claimed late: ${inlineText(claim.path)} by ${claim.key}, edited before it was claimed (R6 of commit series integrity).`);
  for (const lost of fix.lostClaims) lines.push(`- Claim lost: ${inlineText(lost.path)} by ${inlineText(lost.unit)} ${lostClaimWords(lost.holder)}; the claim is not on the ledger, and the file's edits fall under the ownership rule.`);
  const strays = strayedInRun(review, fix.revisions);
  if (strays.length > 0) lines.push(`- Files no answer names, left in the tree and in no patch: ${strays.map(inlineText).join(', ')}.`);
  // A check not available is a gap of the brief, and the Checks table says why, with what the operator dropped and the tool this machine lacked (R15 of the repository survey; R10 of the brief of a run).
  for (const answer of allFixerAnswers(fix)) {
    // The documentation step's validation is under Documentation, with the item it validates (R10 of the documentation step).
    const validated = answer.phase === 'documentation' ? [] : answer.findings;
    for (const finding of validated) {
      for (const validation of finding.validation) lines.push(`- Validation of ${finding.id} (${answer.key}), ${validation.method}, ${inlineText(validation.source)}: ${inlineText(validation.evidence)}`);
    }
    const failures = answer.suite.failures.trim() === '' ? '' : `: ${inlineText(answer.suite.failures)}`;
    lines.push(`- ${fixerTitle(answer.phase, answer.key)} ran its own suite: ${answer.suite.result}${answer.suite.command.trim() === '' ? '' : ` (${inlineText(answer.suite.command)})`}${failures}.`);
  }
  const oversized = fix.revisions.flatMap((revision) => revision.files.filter((file) => file.after !== null && 'oversized' in file.after).map((file) => file.path));
  if (oversized.length > 0) lines.push(`- Files changed beyond the size the run freezes, whose patches name them and do not apply: ${[...new Set(oversized)].map(inlineText).join(', ')}.`);
  return lines;
}

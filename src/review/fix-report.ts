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
import { passNumber, passOf } from '../checkpoint/answer-state.ts';
import { allBatches, committedRevisions, cutShortChecks, isCutAttempt, isNotAttempted, killedRun, lastAnswerOf, lastFixesAnswerOf, earlierTreeEdit, lastRecordedRun, lastFreshRun, notAttemptedNote, openStart, repairTargets, revisionMessageOf, secondRoundPlannable, type CheckRunState, type FixState, type PlannedBatch } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import type { ArtifactReference } from '../evidence/store.ts';
import { killMarkWords } from '../runtime/kill-marks.ts';
import { preRunStrays, type ReviewState } from '../checkpoint/review-fold.ts';
import { baseNameOf } from '../scope/scope-line.ts';
import { baseWords, briefChecksOf, notComparedPlainWords, notComparedReasons, notComparedWords, skippedReason, type BriefCheck, type NotComparedReason } from './brief-checks.ts';
import { stepNotRunCause, stepNotRunSentence, unheldDriftLines, type UnheldLine } from './documents.ts';
import { capitalized, codeSpan, counted, findingWords, inlineText, listed, quoted, tableCell } from './markdown.ts';
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
    return { id, outcome: statusWords[last.finding.status], decision: null, batch: null, answer: last.finding, reason: null, secondRoundSkipped: null, superseder: null, pass: { key: last.key, at: pass.at } };
  }
  const route = fix.plan?.routes.find((candidate) => candidate.id === id)?.route ?? 'fixer';
  if (route === 'held') {
    const decision = review.decisions?.find((candidate) => candidate.id === id) ?? null;
    // The superseding finding is decided fix, so a fixer was given it and its fate is never held: this recursion ends there.
    const by = decision?.leave?.supersededBy ?? null;
    const superseder = by === null ? null : { id: by, outcome: fateOf(review, fix, by).outcome };
    return { id, outcome: heldOutcome(decision), decision, batch: null, answer: null, reason: null, secondRoundSkipped: null, superseder, pass: null };
  }
  const second = fix.secondRound?.batches.find((candidate) => candidate.findingIds.includes(id)) ?? null;
  if (last !== null) {
    const batch = allBatches(fix).find((candidate) => candidate.key === last.key) ?? null;
    const answeredInSecond = second !== null && last.key === second.key;
    const secondRoundSkipped = second !== null && !answeredInSecond ? notAttemptedNote(fix, 'fixes', second.key) : null;
    return { id, outcome: statusWords[last.finding.status], decision: null, batch, answer: last.finding, reason: null, secondRoundSkipped, superseder: null, pass: null };
  }
  const batch = fix.plan?.batches.find((candidate) => candidate.findingIds.includes(id)) ?? null;
  const reason = (batch === null ? null : notAttemptedNote(fix, 'fixes', batch.key)) ?? 'no fixer answered for it';
  return { id, outcome: 'not attempted', decision: null, batch, answer: null, reason, secondRoundSkipped: null, superseder: null, pass: null };
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

/** The 1-based numbers of the patches whose revisions of a phase hold a finding (or, for the repair, a check kind). */
function patchesOf(fix: FixState, id: string, phase: EditingPhase): number[] {
  return fix.revisions.flatMap((revision, index) => (revision.phase === phase && revision.change.findings.includes(id) ? [index + 1] : []));
}

const patchNote = (numbers: readonly number[]): string => (numbers.length === 0 ? 'no patch' : `patch ${numbers.join(', ')}`);

/** A worker's text inside a line of an evidence section: quoted, so it is escaped and the ids it names carry their numbers (R11 of the report for the person). */
const workerText = (text: string, numbers: ReadonlyMap<string, number>): string => inlineText(quoted(text, { numbers }));

/** Every fixer's recorded answer, phase by phase in `editingPhases` order, so an editing phase added there is reported too. */
const allFixerAnswers = (fix: FixState): FixRecorded[] => editingPhases.flatMap((phase) => Object.values(fix.answers[phase]));

/**
 * Every fixer's answer for a finding, oldest first: the fix pass's
 * batches, the first round's then the second's, then the answer passes by
 * number; so the last is the one `lastAnswerOf` reads.
 */
function answersFor(fix: FixState, id: string): { readonly phase: 'fixes' | 'answer'; readonly key: string; readonly batch: PlannedBatch | null; readonly finding: FixedFinding }[] {
  const fixes = allBatches(fix).flatMap((batch) => {
    const finding = batch.findingIds.includes(id) ? fix.answers.fixes[batch.key]?.findings.find((candidate) => candidate.id === id) : undefined;
    return finding === undefined ? [] : [{ phase: 'fixes' as const, key: batch.key, batch, finding }];
  });
  const passes = Object.keys(fix.answers.answer).filter((key) => passNumber(key) !== null).sort((a, b) => passNumber(a)! - passNumber(b)!);
  const answered = passes.flatMap((key) => {
    const finding = fix.answers.answer[key]!.findings.find((candidate) => candidate.id === id);
    return finding === undefined ? [] : [{ phase: 'answer' as const, key, batch: null, finding }];
  });
  return [...fixes, ...answered];
}

/** What a fixer's text can name, for its quotes: the numbers of the findings, the finding the block is about, and the findings of its batch in the order its task numbered them. */
export interface FixQuote {
  readonly numbers: ReadonlyMap<string, number>;
  readonly own: number;
}

/**
 * The lines of a finding's block on its fix (R6 of the report for the
 * person): what the fixer said and the subject of its commit message, its
 * patches, or why no fixer answered for it; the corrections the fixer made
 * to the plan, the files it needed from another cluster, the second round,
 * the answer pass that worked it, and each validation its fixers report,
 * oldest first and each by its fixer when more than one worked it, so the
 * validation of each patch the block lists stays. A fixer's text is
 * quoted with the numbers of the findings it names, its batch indexes
 * among them. A finding no fixer saw has none: its decision says why.
 */
export function fixBlockLines(review: ReviewState, fix: FixState, id: string, quote: FixQuote): string[] {
  const fate = fateOf(review, fix, id);
  if (fate.outcome === 'held for the author') return ['Fix: held for the author; a run configured before the decision step held a PLAUSIBLE finding of a design angle, and no fixer saw it.'];
  if (fate.outcome === 'left by decision' || fate.outcome === 'asked, kept as is') {
    if (fate.superseder === null) return [];
    const by = `finding ${String(quote.numbers.get(fate.superseder.id) ?? fate.superseder.id)}`;
    const landed = fate.superseder.outcome === 'applied' || fate.superseder.outcome === 'already applied';
    return [`Fix: none of its own; its removal was ${by}'s fix, whose fixer ${fate.superseder.outcome === 'not attempted' ? 'did not attempt it' : `reported it ${fate.superseder.outcome}`}.${landed ? '' : ' This finding may still stand.'}`];
  }
  const saidIn = (batch: PlannedBatch | null) => (text: string): string => inlineText(quoted(text, { numbers: quote.numbers, own: quote.own, batch: batch?.findingIds ?? null }));
  const said = saidIn(fate.batch);
  const lines: string[] = [];
  if (fate.answer !== null) {
    lines.push(`Fix: ${fate.outcome}; ${said(fate.answer.note)}`);
    if (fate.answer.message !== null) lines.push(`Commit message: ${said(fate.answer.message.subject)}`);
  } else if (fate.reason !== null) {
    lines.push(`Not attempted: ${inlineText(fate.reason)}`);
  }
  const patches = fix.revisions.flatMap((revision, index) => (revision.change.findings.includes(id) ? [index + 1] : []));
  if (fate.answer !== null || patches.length > 0) lines.push(`Patch: ${patches.length === 0 ? 'none' : patches.join(', ')}`);
  if (fate.pass !== null) lines.push(`Answer pass: ${fate.pass.key}, opened on ${fate.pass.at}`);
  for (const correction of fate.answer?.corrections ?? []) lines.push(`Correction: ${inlineText(correction.file)} ${said(correction.anchor)}: ${said(correction.claim)} -> ${said(correction.fact)} (${said(correction.evidence)})`);
  if (fate.answer !== null && fate.answer.requiredFiles.length > 0) lines.push(`Needs, from another cluster: ${fate.answer.requiredFiles.map(inlineText).join(', ')}`);
  if (fate.secondRoundSkipped !== null) lines.push(`Second round not attempted: ${inlineText(fate.secondRoundSkipped)}`);
  // A finding the first round blocked has no second round while the run budget left a batch of the first, until a reopen runs it (PD13 of resumable runs).
  if (fate.answer?.status === 'blocked' && fix.secondRound === null && !secondRoundPlannable(fix)) lines.push('Second round not planned: the run budget stopped the first round');
  const answers = answersFor(fix, id);
  for (const { phase, key, batch, finding } of answers) {
    const by = answers.length === 1 ? 'its fixer' : phase === 'fixes' ? `fixer ${key}` : `the fixer of the answer pass ${key}`;
    const quote = saidIn(batch);
    for (const validation of finding.validation) lines.push(`Validation, as ${by} reports it: ${validation.method}, ${quote(validation.source)}: ${quote(validation.evidence)}`);
  }
  return lines;
}

/**
 * What a stop did to the checks and to the tree, and what the resumed run
 * did about it (R15 of resumable runs), as bare sentences that the notes
 * of the run and `status` each prefix, in the order of the checks phases: each run that replaced one, with both
 * outcomes, by why it ran again (a cut, a first timeout, a stop of its
 * attempt, or, for a build on the base, the worktree its attempt makes
 * anew, after a stop or with none); each start with no end on record; each file written back,
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
function documentationSection(review: ReviewState, fix: FixState, numbers: ReadonlyMap<string, number>): string[] {
  const said = (text: string): string => workerText(text, numbers);
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
          `Note: ${said(finding.note)}`,
          ...(finding.message === null ? [] : [`Commit message: ${said(finding.message.subject)}`]),
          ...(finding.files.length === 0 ? [] : [`Files: ${finding.files.map(inlineText).join(', ')}; ${patchNote(patchesOf(fix, item.id, 'documentation'))}`]),
          ...finding.validation.map((entry) => `Validation: ${entry.method}, ${said(entry.source)}: ${said(entry.evidence)}`),
        ];
    const took = item.drift.length === 0 ? [] : ['Lines it took:', ...item.drift.map((line) => `- ${said(line.what)} (${line.key}${line.file === item.file ? '' : `, as ${inlineText(line.file)}`})`)];
    return [`### ${String(index + 1)}. ${item.id} ${outcome}`, '', ...document, ...answered, ...took, ''];
  });
  const found = (answer?.drift ?? []).map((line) => `- ${inlineText(line.file)}: ${said(line.what)}`);
  const untaken = unheld.map((line) => `- ${inlineText(line.file)}: ${said(line.what)} (${reporterWords(line)})`);
  const lines = [
    '## Documentation updates',
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

/** Each checks phase as Checks names it, in the words of the brief (R4 of the report for the person). */
const phaseTitles: Readonly<Record<CheckPhase, string>> = { 'baseline-checks': 'As submitted', checks: 'After the fixes', 'base-checks': 'On the base', 'repair-checks': 'After the fixes for the checks', 'answer-checks': 'After your answers' };

/** Whose revision changed the tree a run checked, as the note under the Checks table names it. */
const revisionOwners: Readonly<Record<EditingPhase, string>> = { fixes: 'the fixes', documentation: 'the documentation step', repair: 'the fixes for the checks', answer: 'an answer pass' };

const runSeconds = (run: CheckRan): string => `${((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)} s`;

/** One table cell: a run's outcome and seconds, the frozen output's paths for one that did not pass, and the note that follows them. */
function checkCell(run: CheckRan | null, evidencePath: (reference: { sha256: string; bytes: number }) => string, note: string): string {
  if (run === null) return '-';
  // A run on the base says why it was skipped in fixed words: the error after them names local paths, which the facts of the run alone give (R5 of the facts before a merge).
  if (run.outcome === 'skipped') return tableCell(`skipped: ${run.phase === 'base-checks' ? notComparedWords[skippedReason(run)] : run.error ?? 'build did not pass'}`);
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
 * a run there records skipped, in the words of the brief, with the error
 * left to the facts of the run; null for a run there that ended, which has
 * its cell.
 */
function notRunOnBase(reason: NotComparedReason, kinds: string): string | null {
  if (reason === 'not-run') return `${kinds} did not run there.`;
  if (!Object.hasOwn(baseSkipReasons, reason)) return null;
  return `${kinds} did not run there, since ${notComparedWords[reason]}${reason === 'no-worktree' ? '; the facts of the run give the error' : ''}.`;
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
 * The error for each worktree of the base that could not be made, as a
 * line of the facts of the run, the one part of the report that names a
 * local path (R5 of the facts before a merge; R15 of the brief of a run).
 * The error is git's or the engine's own refusal of a scratch directory
 * inside the run (`makeBaseTree`), so the line blames neither.
 */
export function baseWorktreeLines(review: ReviewState): string[] {
  const prefix = `${baseSkipReasons['no-worktree']}: `;
  // The reason says which runs had no worktree; their error gives git's words after the fixed ones.
  const errors = new Set((review.fix?.checks.runs['base-checks'] ?? []).flatMap((run) => (run.skipReason === 'no-worktree' && run.error !== null ? [run.error.startsWith(prefix) ? run.error.slice(prefix.length) : run.error] : [])));
  return [...errors].map((error) => `Worktree of the base: could not be made: ${inlineText(error)}`);
}

/**
 * The Checks section (R8 of the report for the person): one block per
 * kind, with the anchor the table of the brief links to, its command or
 * why it has none, where a surveyed run's command came from (R10, R15 of
 * the repository survey), the last run of each checks phase with its
 * result, its time and the output of one that did not pass, the
 * comparison with the base and its words (R8 of the facts before a
 * merge), and the fix of the check with each validation its fixer
 * reports, quoted with the numbers of the findings it names; then why a
 * phase ran nothing.
 */
function checksSection(review: ReviewState, fix: FixState, scope: ScopeState, evidencePath: (reference: { sha256: string; bytes: number }) => string, numbers: ReadonlyMap<string, number>): string[] {
  const { survey } = review;
  const planned = fix.checks.planned?.checks ?? [];
  const ran = checkPhases.filter((phase) => fix.checks.runs[phase].length > 0);
  // The last baseline run, which never grows old, with not-started among the failures the mark names.
  const failingBeforeFixes = (kind: CheckKind): boolean => ['failed', 'timeout', 'not-started'].includes(lastFreshRun(fix, 'baseline-checks', kind)?.outcome ?? '');
  // Each column shows the last run of each kind, and is marked when a later edit changed the tree its runs checked.
  const shown = (phase: CheckPhase, kind: CheckKind): CheckRunState | null => lastRecordedRun(fix, phase, kind);
  const edits = new Map(ran.map((phase) => [phase, planned.map((check) => shown(phase, check.kind)).flatMap((run) => (run === null ? [] : [earlierTreeEdit(fix, phase, run)])).find((edit) => edit !== null) ?? null]));
  // What the base says of each kind the run took there, as the brief says it.
  const checks = briefChecksOf({ ...review, fix }, scope);
  const comparisons = fix.answers.repair[repairUnitKey]?.comparisons ?? [];
  const baseNote = (kind: CheckKind): string => {
    const comparison = comparisons.find((entry) => entry.kind === kind);
    if (comparison !== undefined) return `; a model's comparison: ${readingWords[comparison.reading]} (${workerText(comparison.words, numbers)})`;
    return checks.find((check) => check.kind === kind)?.base?.reason === 'no-comparison' ? `; ${notComparedPlainWords['no-comparison']}` : '';
  };
  const note = (phase: CheckPhase, kind: CheckKind): string => {
    if (phase === 'base-checks') return baseNote(kind);
    return phase !== 'baseline-checks' && failingBeforeFixes(kind) ? ' (failing before the fix pass)' : '';
  };
  const repaired = fix.answers.repair[repairUnitKey];
  const blocks = planned.flatMap((check) => {
    const head = [`<a id="check-${check.kind}"></a>`, '', `### ${check.kind}`, ''];
    const source = survey === null ? [] : [`- Source: ${checkSourceCell(survey, check)}`];
    if (check.command === null) return [...head, `- Command: ${unavailableCell(survey, check)}`, ...source, ''];
    const runs = ran.flatMap((phase) => {
      const run = shown(phase, check.kind);
      return run === null ? [] : [`- ${phaseTitles[phase]}${edits.get(phase) === null ? '' : ', on an earlier tree'}: ${checkCell(run, evidencePath, note(phase, check.kind))}`];
    });
    const said = (text: string): string => workerText(text, numbers);
    const fixed = (repaired?.findings ?? []).filter((finding) => finding.id === check.kind).flatMap((finding) => [
      `- Its fix: ${statusWords[finding.status]}, ${said(finding.note)}; ${patchNote(patchesOf(fix, finding.id, 'repair'))}`,
      ...finding.validation.map((validation) => `- Validation, as its fixer reports it: ${validation.method}, ${said(validation.source)}: ${said(validation.evidence)}`),
    ]);
    return [...head, `- Command: ${codeSpan(check.command)}`, ...source, ...runs, ...fixed, ''];
  });
  const answered = review.answerPasses.length > 0;
  // Why a checks phase ran nothing: with no kind given a command, none ever runs, whatever the fixes did; otherwise the phase's own condition.
  const repairUnattempted = isNotAttempted(fix, 'repair', repairUnitKey) ? `the fixes for the checks were not attempted: ${inlineText(notAttemptedNote(fix, 'repair', repairUnitKey) ?? 'no reason recorded')}` : null;
  const repairWhy = repairTargets(fix, 'recorded').length === 0 ? 'no check failed after the fixes' : repairUnattempted ?? 'the fixes for the checks changed no file';
  const notRun = planned.every((check) => check.command === null)
    ? ['- No check ran in any phase, since no kind has a command.']
    : [
        ...(fix.checks.runs.checks.length === 0 ? ['- After the fixes: not run, since no fix changed a file.'] : []),
        // A revision of an unfinished attempt of the repair runs the checks after it, so a repair settled not attempted says so here too.
        ...(fix.checks.runs['repair-checks'].length === 0 ? [`- After the fixes for the checks: not run, since ${repairWhy}.`] : repairUnattempted === null ? [] : [`- ${capitalized(repairUnattempted)}.`]),
        ...(answered && fix.checks.runs['answer-checks'].length === 0 ? ['- After your answers: not run, since no answer pass changed a file.'] : []),
        ...baseNotes(review, fix, checks, scope),
      ];
  const earlier = ran.flatMap((phase) => {
    const edit = edits.get(phase) ?? null;
    return edit === null ? [] : [`- ${phaseTitles[phase]}: its runs checked an earlier tree, which a later revision of ${revisionOwners[edit]} changed.`];
  });
  const lines = ['## Checks', '', ...blocks, ...notRun, ...earlier];
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

/** Who made a revision, as Patches names it: the findings it fixes by number with the fixer, a check, or a fixer that did not finish. */
function revisedBy(revision: TreeRevised, numbers: ReadonlyMap<string, number>): string {
  const findings = revision.change.findings.flatMap((id) => (numbers.has(id) ? [numbers.get(id)!] : []));
  const of = findings.length === 0 ? '' : `${findingWords(findings)}, `;
  switch (revision.source.kind) {
    case 'fix':
      return `${of}${revision.source.key}`;
    case 'check':
      return `the ${revision.source.check} check`;
    case 'attempt':
      return `${of}a fixer of ${revision.source.key} that did not finish`;
  }
}

/** What a revision did to a file, as Patches names it. */
const fileStatus = (file: TreeRevised['files'][number]): string => (file.before === null ? 'created' : file.after === null ? 'deleted' : 'modified');

/**
 * The Patches section (R8 of the report for the person): the patch
 * series in the order of the commits, each with its subject, who made it,
 * the files it changes, the commit that holds it once `deep-review commit`
 * made one, and its file in the store; then the tests the fixers say they
 * added. A revision after a committed series names the pass that made it,
 * which a later series commits (R15 of resumable runs).
 */
function patchesSection(fix: FixState, patches: readonly string[], numbers: ReadonlyMap<string, number>): string[] {
  const committed = committedRevisions(fix);
  const commitOf = new Map(fix.commits.flatMap((series) => series.commits.flatMap((commit) => (commit.revision === 'change' ? [] : [[commit.revision, commit.sha] as const]))));
  const series = fix.revisions.map((revision, index) => {
    const files = revision.files.map((file) => `${inlineText(file.path)} ${fileStatus(file)}`).join(', ');
    const sha = commitOf.get(index);
    const later = committed > 0 && index >= committed ? `, ${laterPass(revision)} after the commits` : '';
    return `${String(index + 1)}. ${workerText(revisionMessageOf(fix, revision).subject, numbers)} (${revisedBy(revision, numbers)}${later}), ${files === '' ? 'no file' : files}${sha === undefined ? '' : `, committed as ${sha.slice(0, 8)}`}: ${patches[index] ?? 'not written'}`;
  });
  // The documentation step's own tests are not a fixer's: Documentation updates reports its answer.
  const tests = allFixerAnswers(fix).filter((answer) => answer.phase !== 'documentation').flatMap((answer) => answer.tests.map((entry) => `- ${inlineText(entry.file)}: ${workerText(entry.covers, numbers)} (${answer.key})`));
  return [
    '## Patches',
    '',
    ...(series.length === 0 ? ['No fix changed a file.'] : ['The patch series, one patch per change, applies in order to a tree at the scope with `git am --keep-cr`:', '', ...series]),
    ...(tests.length === 0 ? [] : ['', 'Tests the fixers say they added or tightened:', '', ...tests]),
  ];
}

/** The parts of the evidence the fix pass adds after the findings, in order: Documentation updates when the run has the step or a drift line, Checks, Patches; none for a run without it. */
export function fixSections(state: RunState, evidencePath: (reference: { sha256: string; bytes: number }) => string, patches: readonly string[], numbers: ReadonlyMap<string, number>): string[][] {
  const review = state.review;
  const fix = review?.fix ?? null;
  if (review === null || fix === null) return [];
  return [documentationSection(review, fix, numbers), checksSection(review, fix, state.scope!, evidencePath, numbers), patchesSection(fix, patches, numbers)].filter((section) => section.length > 0);
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
    // Each validation is in the block of its finding (R6 of the report for the person), the repair's in the block of its check, and the documentation step's under Documentation updates (R10 of the documentation step).
    const failures = answer.suite.failures.trim() === '' ? '' : `: ${inlineText(answer.suite.failures)}`;
    lines.push(`- ${fixerTitle(answer.phase, answer.key)} ran its own suite: ${answer.suite.result}${answer.suite.command.trim() === '' ? '' : ` (${inlineText(answer.suite.command)})`}${failures}.`);
  }
  const oversized = fix.revisions.flatMap((revision) => revision.files.filter((file) => file.after !== null && 'oversized' in file.after).map((file) => file.path));
  if (oversized.length > 0) lines.push(`- Files changed beyond the size the run freezes, whose patches name them and do not apply: ${[...new Set(oversized)].map(inlineText).join(', ')}.`);
  return lines;
}

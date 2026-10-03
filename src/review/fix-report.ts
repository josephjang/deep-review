/**
 * The report's account of the fix pass (R13 of the fix pass), rendered
 * from the fold alone like the rest of the report: what became of every
 * ranked finding, what each check said before the fixes, after them and
 * after the repair, every file a revision changed and who changed it,
 * and the lines Limitations gains. A run without the fix pass has none
 * of these, and its report renders as it did before the fix pass existed.
 */
import type { CheckRan, FixedFinding, TreeRevised } from '../checkpoint/events.ts';
import { allBatches, clusterOf, isNotAttempted, lastAnswerOf, lastRun, notAttemptedNote, revisionMessageOf, type FixState, type PlannedBatch } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import type { ReviewState } from '../checkpoint/review-fold.ts';
import { inlineText, tableCell } from './markdown.ts';
import { rankedFindings } from './state.ts';
import { checkPhases, repairUnitKey, type CheckPhase } from './vocabulary.ts';

/** What became of one ranked finding, as the report names it. */
export type FindingOutcome = 'applied' | 'already applied' | 'deferred' | 'blocked' | 'not attempted' | 'held for the author';

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
  /** The batch that held it, whose key names its cluster, or null for a held finding. */
  readonly batch: PlannedBatch | null;
  readonly answer: FixedFinding | null;
  /** Why the finding was not attempted, for one whose batch failed twice or met the run budget. */
  readonly reason: string | null;
  /** For a finding the second round took, the files it was first blocked on (R21 of the fix pass); null otherwise. */
  readonly firstBlockedOn: readonly string[] | null;
  /** Why the second round's batch of a finding was not attempted, when its last answer is the first round's. */
  readonly secondRoundSkipped: string | null;
}

function fateOf(fix: FixState, id: string): FindingFate {
  const route = fix.plan?.routes.find((candidate) => candidate.id === id)?.route ?? 'fixer';
  if (route === 'held') return { id, outcome: 'held for the author', batch: null, answer: null, reason: null, firstBlockedOn: null, secondRoundSkipped: null };
  const second = fix.secondRound?.batches.find((candidate) => candidate.findingIds.includes(id)) ?? null;
  const firstBlockedOn = fix.secondRound?.blocked.find((entry) => entry.id === id)?.requiredFiles ?? null;
  const last = lastAnswerOf(fix, id);
  if (last !== null) {
    const batch = allBatches(fix).find((candidate) => candidate.key === last.batch) ?? null;
    const answeredInSecond = second !== null && last.batch === second.key;
    const secondRoundSkipped = second !== null && !answeredInSecond ? notAttemptedNote(fix, 'fixes', second.key) : null;
    return { id, outcome: statusWords[last.finding.status], batch, answer: last.finding, reason: null, firstBlockedOn: answeredInSecond ? firstBlockedOn : null, secondRoundSkipped };
  }
  const batch = fix.plan?.batches.find((candidate) => candidate.findingIds.includes(id)) ?? null;
  const reason = (batch === null ? null : notAttemptedNote(fix, 'fixes', batch.key)) ?? 'no fixer answered for it';
  return { id, outcome: 'not attempted', batch, answer: null, reason, firstBlockedOn: null, secondRoundSkipped: null };
}

/** The 1-based numbers of the patches whose revisions hold a finding (or, for the repair, a check kind). */
function patchesOf(fix: FixState, id: string, phase: 'fixes' | 'repair'): number[] {
  return fix.revisions.flatMap((revision, index) => (revision.phase === phase && revision.change.findings.includes(id) ? [index + 1] : []));
}

const patchNote = (numbers: readonly number[]): string => (numbers.length === 0 ? 'no patch' : `patch ${numbers.join(', ')}`);

/** The lines one finding's fate prints under its heading. */
function fateLines(fix: FixState, fate: FindingFate): string[] {
  if (fate.outcome === 'held for the author') return ['A PLAUSIBLE finding from a design angle: held for the author, and no fixer saw it.'];
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
  for (const correction of fate.answer?.corrections ?? []) lines.push(`Correction: ${inlineText(correction.file)} ${inlineText(correction.anchor)}: ${inlineText(correction.claim)} -> ${inlineText(correction.fact)} (${inlineText(correction.evidence)})`);
  if (fate.answer !== null && fate.answer.requiredFiles.length > 0) lines.push(`Needs, from another cluster: ${fate.answer.requiredFiles.map(inlineText).join(', ')}`);
  if (fate.firstBlockedOn !== null) lines.push(`First blocked on: ${fate.firstBlockedOn.map(inlineText).join(', ')}, which the second round gave it`);
  if (fate.secondRoundSkipped !== null) lines.push(`Second round not attempted: ${inlineText(fate.secondRoundSkipped)}`);
  return lines;
}

/** The fixers' own lines that nothing acts on yet (PD1): the documentation their edits made stale, and the tests they added. */
function answerLines(fix: FixState): string[] {
  const answers = [...Object.values(fix.answers.fixes), ...Object.values(fix.answers.repair)];
  const drift = answers.flatMap((answer) => answer.drift.map((entry) => `- ${inlineText(entry.file)}: ${inlineText(entry.what)} (${answer.key})`));
  const tests = answers.flatMap((answer) => answer.tests.map((entry) => `- ${inlineText(entry.file)}: ${inlineText(entry.covers)} (${answer.key})`));
  return [
    ...(drift.length === 0 ? [] : ['', 'Documentation the fixers say their edits made stale, which nothing in this run updated:', '', ...drift]),
    ...(tests.length === 0 ? [] : ['', 'Tests the fixers say they added or tightened:', '', ...tests]),
  ];
}

/** The Fixes section: every ranked finding in rank order with its fate, the repair's checks, and the fixers' drift and test lines. */
function fixesSection(review: ReviewState, fix: FixState): string[] {
  const findings = rankedFindings(review);
  const blocks = findings.flatMap((entry, index) => {
    const fate = fateOf(fix, entry.finding.id);
    return [`### ${String(index + 1)}. ${entry.finding.id} ${fate.outcome}`, '', ...fateLines(fix, fate), ''];
  });
  const repair = fix.answers.repair[repairUnitKey];
  const repairLines = repair === undefined
    ? isNotAttempted(fix, 'repair', repairUnitKey) ? ['### Repair', '', `Not attempted: ${inlineText(notAttemptedNote(fix, 'repair', repairUnitKey)!)}`, ''] : []
    : ['### Repair', '', ...repair.findings.map((finding) => `- ${finding.id} check ${statusWords[finding.status]}: ${inlineText(finding.note)}; ${patchNote(patchesOf(fix, finding.id, 'repair'))}`), ''];
  const lines = [
    '## Fixes',
    '',
    'What the fix pass did with each finding, in rank order. Every edit is in the working tree, uncommitted; a patch number is one of the series under Changed files.',
    '',
    ...(findings.length === 0 ? ['No finding to fix.', ''] : blocks),
    ...repairLines,
    ...answerLines(fix),
  ];
  // One blank line between blocks, however the blocks above end.
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '');
}

const phaseTitles: Readonly<Record<CheckPhase, string>> = { 'baseline-checks': 'Before the fixes', checks: 'After the fixes', 'repair-checks': 'After the repair' };

const runSeconds = (run: CheckRan): string => `${((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)} s`;

/** One table cell: a run's outcome and seconds, the frozen output's paths for one that did not pass, and the baseline mark. */
function checkCell(run: CheckRan | null, evidencePath: (reference: { sha256: string; bytes: number }) => string, failedBefore: boolean): string {
  if (run === null) return '-';
  if (run.outcome === 'skipped') return tableCell(`skipped: ${run.error ?? 'build did not pass'}`);
  const output = run.stdout === null || run.stderr === null ? '' : `; output ${evidencePath(run.stdout)}, ${evidencePath(run.stderr)}`;
  const text = `${run.outcome}, ${runSeconds(run)}${run.outcome === 'passed' ? '' : output}${failedBefore ? ' (failing before the fix pass)' : ''}`;
  return tableCell(text);
}

/** The Checks section: a row per kind and a column per checks phase that ran a check, a kind with no command saying why. */
function checksSection(fix: FixState, evidencePath: (reference: { sha256: string; bytes: number }) => string): string[] {
  const planned = fix.checks.planned?.checks ?? [];
  const ran = checkPhases.filter((phase) => fix.checks.runs[phase].length > 0);
  const failedAtBaseline = (kind: string): boolean => ['failed', 'timeout', 'not-started'].includes(fix.checks.runs['baseline-checks'].find((run) => run.kind === kind)?.outcome ?? '');
  const rows = planned.map((check) => {
    if (check.command === null) return `| ${check.kind} | not available (${tableCell(check.origin)}: ${tableCell(check.reason ?? 'no command')}) | ${ran.map(() => '-').join(' | ')} |`;
    const cells = ran.map((phase) => checkCell(lastRun(fix, phase, check.kind), evidencePath, phase !== 'baseline-checks' && failedAtBaseline(check.kind)));
    return `| ${check.kind} | ${tableCell(check.command)} | ${cells.join(' | ')} |`;
  });
  const notRun = [
    ...(fix.checks.runs.checks.length === 0 ? ['- After the fixes: not run, since no fix changed a file.'] : []),
    ...(fix.checks.runs['repair-checks'].length === 0 ? ['- After the repair: not run, since no check failed after the fixes.'] : []),
  ];
  return [
    '## Checks',
    '',
    `| Check | Command | ${ran.map((phase) => phaseTitles[phase]).join(' | ')} |`,
    `|---|---|${ran.map(() => '---').join('|')}|`,
    ...rows,
    ...(notRun.length === 0 ? [] : ['', ...notRun]),
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

/** The status a path ends the run with: created, modified or deleted against what it held before its first revision, or removed again when it was created and then deleted. */
function finalStatus(fix: FixState, path: string): string {
  const touching = fix.revisions.flatMap((revision) => revision.files.filter((file) => file.path === path));
  const existedBefore = (touching[0]?.before ?? null) !== null;
  const existsAfter = (touching.at(-1)?.after ?? null) !== null;
  if (existedBefore) return existsAfter ? 'modified' : 'deleted';
  return existsAfter ? 'created' : 'created, then deleted';
}

/** The Changed files section: every path a revision names, once, with its final status and who changed it, then the patch series. */
function changedFilesSection(fix: FixState, patches: readonly string[]): string[] {
  const paths = [...new Set(fix.revisions.flatMap((revision) => revision.files.map((file) => file.path)))].sort();
  const rows = paths.map((path) => {
    const by = [...new Set(fix.revisions.filter((revision) => revision.files.some((file) => file.path === path)).map(revisedBy))];
    return `| ${tableCell(path)} | ${finalStatus(fix, path)} | ${tableCell(by.join(', '))} |`;
  });
  const series = fix.revisions.map((revision, index) => `${String(index + 1)}. ${inlineText(revisionMessageOf(fix, revision).subject)} (${revisedBy(revision)}): ${patches[index] ?? 'not written'}`);
  return [
    '## Changed files',
    '',
    ...(paths.length === 0 ? ['No file was changed.'] : ['| Path | Status | Changed by |', '|---|---|---|', ...rows]),
    ...(series.length === 0 ? [] : ['', 'The patch series, one patch per change, applies in order to a tree at the scope with `git am --keep-cr`:', '', ...series]),
  ];
}

/** The sections the fix pass adds after Findings, in order: Fixes, Checks, Changed files; none for a run without it. */
export function fixSections(state: RunState, evidencePath: (reference: { sha256: string; bytes: number }) => string, patches: readonly string[]): string[][] {
  const review = state.review;
  const fix = review?.fix ?? null;
  if (review === null || fix === null) return [];
  return [fixesSection(review, fix), checksSection(fix, evidencePath), changedFilesSection(fix, patches)];
}

/** The header's line for a fix run: how many findings each outcome took, and that the edits are uncommitted. */
export function fixHeaderLine(review: ReviewState): string | null {
  const fix = review.fix;
  if (fix === null) return null;
  const outcomes = rankedFindings(review).map((entry) => fateOf(fix, entry.finding.id).outcome);
  const counts = (['applied', 'already applied', 'deferred', 'blocked', 'not attempted', 'held for the author'] as const).map((outcome) => `${String(outcomes.filter((candidate) => candidate === outcome).length)} ${outcome}`);
  return `Fix pass: ${counts.join(', ')}; ${String(fix.revisions.length)} patch${fix.revisions.length === 1 ? '' : 'es'}; the edits are in the working tree, uncommitted`;
}

/** The lines the fix pass adds to Limitations: violations, strays, the checks not available, and the fixers' validation and suite lines. */
export function fixLimitations(review: ReviewState): string[] {
  const fix = review.fix;
  if (fix === null) return [];
  const lines: string[] = [];
  // A violation is against the reporting batch's round, so the owner named is that round's cluster of the file.
  const owner = (key: string, path: string): string => (fix.secondRound?.batches.some((batch) => batch.key === key) === true ? fix.secondRound.clusters : (fix.plan?.clusters ?? [])).find((cluster) => cluster.files.includes(path))?.id ?? 'no cluster';
  for (const answer of Object.values(fix.answers.fixes)) {
    for (const path of answer.violations) lines.push(`- Ownership violation: ${inlineText(path)}, owned by ${owner(answer.key, path)}, was edited by ${answer.key}, which reported it; the edit is kept and revised (PD4).`);
  }
  const strays = [...new Set(review.checks.flatMap((check) => check.strays))].sort();
  if (strays.length > 0) lines.push(`- Files no answer names, left in the tree and in no patch: ${strays.map(inlineText).join(', ')}.`);
  const unavailable = (fix.checks.planned?.checks ?? []).filter((check) => check.command === null);
  if (unavailable.length > 0) lines.push(`- Checks not available: ${unavailable.map((check) => `${check.kind} (${inlineText(check.reason ?? 'no command')})`).join('; ')}.`);
  const answers = [...Object.values(fix.answers.fixes), ...Object.values(fix.answers.repair)];
  for (const answer of answers) {
    for (const finding of answer.findings) {
      for (const validation of finding.validation) lines.push(`- Validation of ${finding.id} (${answer.key}), ${validation.method}, ${inlineText(validation.source)}: ${inlineText(validation.evidence)}`);
    }
    const failures = answer.suite.failures.trim() === '' ? '' : `: ${inlineText(answer.suite.failures)}`;
    lines.push(`- ${answer.key === repairUnitKey ? 'The repair' : `Fixer ${answer.key}`} ran its own suite: ${answer.suite.result}${answer.suite.command.trim() === '' ? '' : ` (${inlineText(answer.suite.command)})`}${failures}.`);
  }
  const oversized = fix.revisions.flatMap((revision) => revision.files.filter((file) => file.after !== null && 'oversized' in file.after).map((file) => file.path));
  if (oversized.length > 0) lines.push(`- Files changed beyond the size the run freezes, whose patches name them and do not apply: ${[...new Set(oversized)].map(inlineText).join(', ')}.`);
  return lines;
}

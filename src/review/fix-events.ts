/**
 * The events the fix pass's work becomes (R4, R5, R6, TD6 of the fix
 * pass): a fixer's or the repair worker's answer as `fix.recorded` and one
 * `tree.revised` per finding its snapshots tell apart; a unit that failed
 * twice as the revision of the edits its workers left in its files; a
 * check that wrote to expected files as a revision attributed to it. Each
 * reads the worktree and freezes what changed, and appends nothing itself.
 */
import { join } from 'node:path';
import type { NewEvent } from '../checkpoint/checkpoint.ts';
import type { FixedFinding, FixRecorded, TreeRevised } from '../checkpoint/events.ts';
import { ownedFiles, repairTargets, type FixState } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { WorkerReceipt } from '../runtime/launcher.ts';
import { expectedTreeOf } from './drift.ts';
import { requireOwnedReported, resolveFixerAnswer } from './fix-answer.ts';
import { worktreeLookup } from './locations.ts';
import { checkFixerAnswer, type FixerOutput } from './schemas.ts';
import { readSnapshot, snapshotsDirectoryName } from './snapshot.ts';
import type { FixPlan } from './fixes.ts';
import { fixPlanOf, truncated, type Unit } from './steps.ts';
import { expectedAt, headStates, matchesExpected, reviseFrom, revisionsFromSnapshots, worktreeReader, type BaseReader, type FindingRevision } from './tree.ts';
import { type CheckKind, type EditingPhase } from './vocabulary.ts';

/** What turning work into events needs: the fold it is recorded against, the worktree, and the evidence store revisions are frozen into. */
export interface RevisionContext {
  readonly state: RunState;
  readonly worktree: string;
  readonly evidence: Pick<EvidenceStore, 'put'>;
}

/** The longest commit subject the engine composes, as a person would keep one. */
const subjectLength = 72;
/** The longest commit body the ledger records. */
const bodyLength = 4000;

/** What the run expects of a path its expected tree does not name: what the scope's head commit held there. */
function baseOf(context: RevisionContext): BaseReader {
  const head = context.state.scope?.head;
  if (head === undefined) throw new Error(`Run ${context.state.id} has no scope`);
  return headStates(context.worktree, head, context.evidence);
}

function requireFix(state: RunState): FixState {
  const fix = state.review?.fix ?? null;
  if (fix === null) throw new Error(`Run ${state.id} is not configured with the fix pass`);
  return fix;
}

/** The planned batch a fixes-phase unit key names. */
function batchOfUnit(state: RunState, key: string): FixPlan['batches'][number] {
  const batch = fixPlanOf(state.review!).batches.find((candidate) => candidate.key === key);
  if (batch === undefined) throw new Error(`The fix plan has no batch ${key}`);
  return batch;
}

/** The ids a unit answers for, in the order its task numbers them: its batch's findings, or for the repair the check kinds it repairs. */
export function unitIds(state: RunState, phase: EditingPhase, key: string): readonly string[] {
  const fix = requireFix(state);
  if (phase === 'repair') return repairTargets(fix);
  return batchOfUnit(state, key).findingIds;
}

/** The files every other cluster of the phase owns, each with its cluster's id; the repair, its phase's only unit, has none. */
function othersOwned(state: RunState, phase: EditingPhase, key: string): Map<string, string> {
  if (phase === 'repair') return new Map();
  const own = batchOfUnit(state, key).cluster;
  return new Map(fixPlanOf(state.review!).clusters.filter((cluster) => cluster.id !== own).flatMap((cluster) => cluster.files.map((file): [string, string] => [file, cluster.id])));
}

/**
 * The message of one revision of an answer (R6, PD14): the fixer's own for
 * the one applied finding it holds, noting any finding folded into it for
 * want of a snapshot; one that names each applied finding's message when
 * it holds several; and one the engine composes from the notes when it
 * holds no applied finding, such as a deferred finding's partial edit.
 */
export function revisionMessage(revision: Pick<FindingRevision, 'findings'>, findings: readonly FixedFinding[]): TreeRevised['change']['message'] {
  const held = findings.filter((finding) => revision.findings.includes(finding.id));
  const applied = held.filter((finding) => finding.message !== null);
  if (applied.length === 1) {
    const only = applied[0]!;
    const folded = held.filter((finding) => finding !== only).map((finding) => finding.id);
    const note = folded.length === 0 ? '' : `\n\nThis commit also holds the edits made for ${folded.join(', ')}, which no snapshot of the fixer's set apart.`;
    return { subject: only.message!.subject, body: truncated(`${only.message!.body.trimEnd()}${note}`.trimStart(), bodyLength) };
  }
  if (applied.length > 1) {
    return {
      subject: truncated(`Apply ${held.map((finding) => finding.id).join(', ')}`, subjectLength),
      body: truncated(applied.map((finding) => `${finding.message!.subject}\n\n${finding.message!.body.trimEnd()}`.trimEnd()).join('\n\n'), bodyLength),
    };
  }
  return {
    subject: truncated(`Keep the edits made for ${held.map((finding) => finding.id).join(', ')}`, subjectLength),
    body: truncated(held.map((finding) => `${finding.id} ${finding.status}: ${finding.note}`).join('\n'), bodyLength),
  };
}

/**
 * The events a completed fixer or repair answer is recorded as (R4, R5,
 * R6, TD11): `fix.recorded` with every path resolved and the ownership
 * violations, then one `tree.revised` per revision its snapshots give.
 * Throws `StructuralCheckError` for an answer that leaves out an index,
 * reports a path outside the repository, or leaves out an owned file
 * whose bytes changed; nothing is appended for it, and the retry is told
 * the tree may hold its work.
 */
export function fixAnswerEvents(unit: Unit, receipt: WorkerReceipt, context: RevisionContext): NewEvent[] {
  const { state, worktree, evidence } = context;
  const phase = unit.phase as EditingPhase;
  const fix = requireFix(state);
  const output = receipt.output as FixerOutput;
  const ids = unitIds(state, phase, unit.key);
  checkFixerAnswer(output, ids.length);
  const owned = ownedFiles(fix, phase, unit.key);
  const resolved = resolveFixerAnswer(output, { worktree, lookup: worktreeLookup(worktree), owned, othersOwned: othersOwned(state, phase, unit.key) });
  const expected = expectedTreeOf(state);
  const read = worktreeReader(worktree);
  const base = baseOf(context);
  requireOwnedReported(owned.filter((path) => !matchesExpected(expectedAt(expected, base, path), read(path) ?? null)), resolved.named);

  const byIndex = new Map(resolved.findings.map((finding) => [finding.index, finding]));
  const findings = ids.map((id, index): FixedFinding => {
    const answer = byIndex.get(index)!;
    return {
      id,
      status: answer.status,
      file: answer.file,
      line: answer.line,
      note: answer.note,
      message: answer.message,
      files: [...answer.files],
      corrections: answer.corrections,
      validation: answer.validation,
      requiredFiles: [...answer.requiredFiles],
    };
  });
  const recorded: FixRecorded = { phase, key: unit.key, workerId: receipt.workerId, findings, drift: output.drift, tests: output.tests, suite: output.suite, violations: [...resolved.violations] };

  // The fixer's snapshots are under the scratch directory its launch recorded; a worker given none took none.
  const scratch = state.workers[receipt.workerId]?.launch.scratch ?? null;
  const into = scratch === null ? null : join(scratch, snapshotsDirectoryName);
  const revisions = revisionsFromSnapshots(evidence, { snapshot: (index) => (into === null ? null : readSnapshot(into, index)), worktree: read }, expected, base, [...owned, ...resolved.named], ids);
  return [
    { kind: 'fix.recorded', version: 1, payload: recorded },
    ...revisions.map((revision): NewEvent => ({
      kind: 'tree.revised',
      version: 1,
      payload: { phase, source: { kind: 'fix', key: unit.key, workerId: receipt.workerId }, change: { findings: [...revision.findings], message: revisionMessage(revision, findings) }, files: [...revision.files] } satisfies TreeRevised,
    })),
  ];
}

/**
 * The revision of the edits a unit's failed workers left in its owned
 * files, recorded with its `cluster.failed`, or null when they left none:
 * the expected tree follows what the workers did, so the end check and
 * every later check do not block on it, and the report names the files.
 */
export function unansweredRevision(context: RevisionContext, phase: EditingPhase, key: string, reason: string): NewEvent | null {
  const { state, worktree, evidence } = context;
  const files = reviseFrom(evidence, worktreeReader(worktree), expectedTreeOf(state), baseOf(context), ownedFiles(requireFix(state), phase, key));
  if (files.length === 0) return null;
  const who = phase === 'repair' ? 'the repair' : `batch ${key}`;
  const payload: TreeRevised = {
    phase,
    source: { kind: 'unanswered', key },
    change: {
      findings: [],
      message: {
        subject: `chore: keep the partial edits of ${who}`,
        body: truncated(`The workers of ${who} failed twice and its findings were not attempted: ${reason}\n\nThe files are recorded as those workers left them; nothing here is a fix an answer accounted for.`, bodyLength),
      },
    },
    files,
  };
  return { kind: 'tree.revised', version: 1, payload };
}

/**
 * The revision of what a check wrote to the files the run expects, or
 * null when it wrote none (TD6): a formatter in `lint`, a generator in
 * `build` or a snapshot updater in `test` is not drift, and the revision
 * names the check.
 */
export function checkRevision(context: RevisionContext, phase: TreeRevised['phase'], kind: CheckKind, command: string): NewEvent | null {
  const { state, worktree, evidence } = context;
  const expected = expectedTreeOf(state);
  const files = reviseFrom(evidence, worktreeReader(worktree), expected, baseOf(context), expected.keys());
  if (files.length === 0) return null;
  const payload: TreeRevised = {
    phase,
    source: { kind: 'check', check: kind },
    change: { findings: [], message: { subject: `chore: apply the ${kind} check's rewrite`, body: truncated(`The ${kind} check, \`${command}\`, rewrote these files when run ${state.id} ran it in ${phase}.`, bodyLength) } },
    files,
  };
  return { kind: 'tree.revised', version: 1, payload };
}

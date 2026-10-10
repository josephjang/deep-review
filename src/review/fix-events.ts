/**
 * The events the fix pass's work becomes (R4, R5, R6, TD6 of the fix
 * pass; R3, R5, R6 of commit series integrity): a fixer's or the repair
 * worker's answer as `fix.recorded` and one `tree.revised` per finding its
 * snapshots tell apart; an attempt that ended without an answer as the
 * revisions its snapshots and the files it left give; a check that wrote
 * to expected files as a revision attributed to it. A fixes-phase unit's
 * answer or attempt is preceded by the claims its round's directory holds
 * that the ledger does not (`settleClaims`). Each reads the worktree and
 * freezes what changed, and appends nothing itself.
 */
import { join } from 'node:path';
import type { NewEvent } from '../checkpoint/checkpoint.ts';
import type { FixedFinding, FixRecorded, TreeRevised } from '../checkpoint/events.ts';
import { batchOf, clusterClaims, heldByOthers, heldInRoundByOthers, holdersKeyedBy, ownedFiles, repairTargets, roundOf, type FixState, type PathHolder, type PlannedBatch } from '../checkpoint/fix-state.ts';
import type { RunState } from '../checkpoint/fold.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { WorkerReceipt } from '../runtime/launcher.ts';
import { foldedWith, holderSpelled, isPending, lateClaim, settleClaims, settledNothing, type ClaimsAccess, type ClaimSettle } from './claim-events.ts';
import { pathKey } from './claims.ts';
import { expectedTreeOf } from './drift.ts';
import { requireOwnedReported, resolveFixerAnswer } from './fix-answer.ts';
import { worktreeLookup, type RepoLookup } from './locations.ts';
import { checkFixerAnswer, type FixerOutput } from './schemas.ts';
import { changedListed, readSnapshot, snapshotPaths, snapshotsDirectoryName, type SnapshotManifest } from './snapshot.ts';
import * as gitApi from '../scope/git.ts';
import { truncated, type Unit } from './steps.ts';
import { changedPaths, expectedAt, headStates, reviseFrom, revisionsFromSnapshots, unfinishedRevisions, worktreeReader, type BaseReader, type ExpectedMatch, type FindingRevision } from './tree.ts';
import { type CheckKind, type EditingPhase } from './vocabulary.ts';

/**
 * What turning work into events needs: the fold it is recorded against,
 * the worktree, the evidence store revisions are frozen into, how a file is
 * compared with what the run expects (R22), and where a fixes-phase unit's
 * claims are read; null where nothing reads them, such as a check's
 * revision.
 */
export interface RevisionContext {
  readonly state: RunState;
  readonly worktree: string;
  readonly evidence: Pick<EvidenceStore, 'put'>;
  readonly match: ExpectedMatch;
  readonly claims: ClaimsAccess | null;
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

/** The planned batch a fixes-phase unit key names, of either round; the plan is recorded before any batch launches. */
function batchOfUnit(state: RunState, key: string): PlannedBatch {
  const batch = batchOf(requireFix(state), key);
  if (batch === null) throw new Error(`The fix plan has no batch ${key}`);
  return batch;
}

/** The ids a unit answers for, in the order its task numbers them: its batch's findings, or for the repair the check kinds it repairs. */
export function unitIds(state: RunState, phase: EditingPhase, key: string): readonly string[] {
  const fix = requireFix(state);
  if (phase === 'repair') return repairTargets(fix);
  return batchOfUnit(state, key).findingIds;
}

/**
 * The claims a unit's settle records before its outcome, read from its
 * round's directory: none for the repair, which claims nothing and owns
 * every file it may edit (TD8 of the fix pass).
 */
function settleOf(context: RevisionContext, phase: EditingPhase, key: string): ClaimSettle {
  if (phase === 'repair' || context.claims === null) return settledNothing(context.state, false);
  const live = context.claims.live(key);
  return live === null ? settledNothing(context.state, context.claims.caseInsensitive()) : settleClaims(context.state, key, live, context.worktree);
}

/** A path as a settle compares it: lowercased where the worktree's file system folds case. */
const keyOfSettle = (settle: ClaimSettle) => (path: string): string => pathKey(path, settle.caseInsensitive);

/** The files every other cluster of a fixes-phase unit's round holds now, by the plan or by a claim of a cluster not yet settled (PD3), in the run as the settle leaves it, keyed by the exact path or by `keyOf`; the repair has none. */
function othersHeld(state: RunState, phase: EditingPhase, key: string, keyOf?: (path: string) => string): Map<string, PathHolder> {
  return phase === 'repair' ? new Map() : heldByOthers(requireFix(state), key, keyOf);
}

/** The files every other cluster of a fixes-phase unit's round has held, settled or not (R5), in the run as the settle leaves it, keyed by `keyOf`; the repair has none. */
function othersHeldInRound(state: RunState, phase: EditingPhase, key: string, keyOf: (path: string) => string): Map<string, PathHolder> {
  return phase === 'repair' ? new Map() : heldInRoundByOthers(requireFix(state), key, keyOf);
}

/**
 * How an answer's paths are found in the worktree: in its own spelling,
 * and in a fixes-phase unit's for a file it does not hold, in the spelling
 * a holder of the round records under the same key, so a violation of a
 * sibling's deleted or new file is named as the fold holds it (TD4).
 */
function answerLookup(settle: ClaimSettle, phase: EditingPhase, key: string, worktree: string): RepoLookup {
  const lookup = worktreeLookup(worktree);
  if (phase === 'repair') return lookup;
  const fix = requireFix(settle.state);
  const keyOf = keyOfSettle(settle);
  return holderSpelled(lookup, holdersKeyedBy(fix, roundOf(fix, key), keyOf), keyOf);
}

/** The files a unit's cluster claimed in its round, in the run as the settle leaves it; the repair claims none. */
function claimedFiles(state: RunState, phase: EditingPhase, key: string): string[] {
  if (phase === 'repair') return [];
  const fix = requireFix(state);
  return clusterClaims(fix, roundOf(fix, key), batchOfUnit(state, key).cluster);
}

/**
 * The message of one revision of an answer (R6, PD14 of the fix pass; R11
 * of commit series integrity): the fixer's own for the one finding with a
 * message it holds, whatever that finding's status, noting any finding
 * folded into it for want of a snapshot; one that names each such
 * finding's message when it holds several; and one the engine composes
 * from the notes when none of its findings carries a message.
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
  // Every finding that names files carries a message (R11 of commit series integrity), so one answer still lands here: a finding that names no file whose snapshot nonetheless differs in a file another finding of the batch named, so its revision holds an edit it did not report.
  return {
    subject: truncated(`Keep the edits made for ${held.map((finding) => finding.id).join(', ')}`, subjectLength),
    body: truncated(held.map((finding) => `${finding.id} ${finding.status}: ${finding.note}`).join('\n'), bodyLength),
  };
}

/**
 * The events a completed fixer or repair answer is recorded as (R4, R5,
 * R6, TD11 of the fix pass; R3, R6 of commit series integrity): the
 * claims the round's directory holds that the ledger does not, the
 * files the answer names that nobody holds as its late claim, then
 * `fix.recorded` with every path resolved and the violations, the named
 * files another cluster holds once those claims are folded, then one
 * `tree.revised` per revision its snapshots give. Throws
 * `StructuralCheckError` for an answer that leaves out an index, reports
 * a path outside the repository, blocks a finding on a file its own
 * cluster owns or claimed, or leaves out an owned or claimed file whose
 * bytes changed. Its failure then records the claims the settle
 * reads from the round's directory but no late claim, which only an
 * answered unit makes, so a file it edited without claiming stays free;
 * the retry is told the tree may hold its work.
 */
export function fixAnswerEvents(unit: Unit, receipt: WorkerReceipt, context: RevisionContext): NewEvent[] {
  const { state, worktree, evidence } = context;
  const phase = unit.phase as EditingPhase;
  const fix = requireFix(state);
  const output = receipt.output as FixerOutput;
  const ids = unitIds(state, phase, unit.key);
  checkFixerAnswer(output, ids.length);
  const owned = ownedFiles(fix, phase, unit.key);
  const settle = settleOf(context, phase, unit.key);
  const resolved = resolveFixerAnswer(output, { worktree, lookup: answerLookup(settle, phase, unit.key, worktree), owned, claimed: claimedFiles(settle.state, phase, unit.key), othersHeld: othersHeld(settle.state, phase, unit.key) });
  const late = phase === 'fixes' ? lateClaim(settle, unit.key, resolved.named) : null;
  const claims = [...settle.events, ...(late === null ? [] : [late])];
  const claimed = claimedFiles(late === null ? settle.state : foldedWith(settle.state, [late]), phase, unit.key);
  const expected = expectedTreeOf(state);
  const read = worktreeReader(worktree);
  const base = baseOf(context);
  requireOwnedReported([...new Set([...owned, ...claimed])].filter((path) => !context.match(path, expectedAt(expected, base, path), read(path) ?? null)), resolved.named);

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
  const revisions = revisionsFromSnapshots(evidence, { snapshot: (index) => (into === null ? null : readSnapshot(into, index)), worktree: read }, expected, base, [...owned, ...resolved.named], ids, context.match);
  return [
    ...claims,
    { kind: 'fix.recorded', version: 1, payload: recorded },
    ...revisions.map((revision): NewEvent => ({
      kind: 'tree.revised',
      version: 1,
      payload: { phase, source: { kind: 'fix', key: unit.key, workerId: receipt.workerId }, change: { findings: [...revision.findings], message: revisionMessage(revision, findings) }, files: [...revision.files] } satisfies TreeRevised,
    })),
  ];
}

/** What an attempt that ended without an answer leaves on the ledger: the claims its settle records, which go before its failure or loss, and the revisions of its edits, which go after. */
export interface AttemptEvents {
  readonly claims: readonly NewEvent[];
  readonly revisions: readonly NewEvent[];
}

/**
 * The events of what an attempt of an editing unit left when it ended
 * without an answer (R20, TD19 of the fix pass; R3, R5 of commit series
 * integrity), to append with its `attempt.failed` or `worker.lost`: the
 * claims the round's directory holds that the ledger does not, and the
 * revisions, one per finding its snapshots tell apart, attributed to that
 * finding, and one naming none for what it left after its last snapshot.
 * The paths are the unit's owned files, the files its cluster claimed, and
 * every path its snapshots listed or git reports changed that no other
 * cluster of its round has held, by the plan or by a claim, settled or
 * not, nor a sibling is claiming now, less the strays the run had already
 * listed, which the attempt did not make, the files git ignores, and the
 * tracked files outside the change it neither owns nor claimed: those are
 * a tool's leftovers, such as a build's `dist/`, which the tail check
 * revision takes if a check rewrites them and Limitations names otherwise
 * (PD9 of commit series integrity, amended after the gate). So a
 * sibling's edit of a file the sibling claimed is never this attempt's
 * while that claim is on the ledger or in the round's directory, even once
 * the sibling has settled, when a snapshot of this attempt taken before
 * the sibling's edit would otherwise undo it. A claim lost with the directory
 * (R12 of commit series integrity), or one a resumed engine cannot read
 * because its directory was cleaned while it was down, leaves that edit to
 * whichever attempt settles first, as the design's Verification accepts.
 * An edit by a fixer that ignored the claim rule is still attributed as
 * git reports it only for a file in the change or a new untracked one; its
 * unclaimed edit of a tracked file outside the change is a leftover, left
 * out as above (R5), and stays in the tree as a stray. A worker with no
 * scratch, or one the operating system cleaned, gives only the last. The
 * expected tree then holds the attempt's work, so the retry's snapshots
 * attribute only its own.
 */
export function attemptRevisionEvents(context: RevisionContext, phase: EditingPhase, key: string, workerId: string, reason: string): AttemptEvents {
  const { state, worktree, evidence } = context;
  const fix = requireFix(state);
  const ids = unitIds(state, phase, key);
  const scratch = state.workers[workerId]?.launch.scratch ?? null;
  const into = scratch === null ? null : join(scratch, snapshotsDirectoryName);
  const settle = settleOf(context, phase, key);
  // Compared as the file system compares paths, since git and the snapshots spell a file as the disk does and a sibling's claim as the sibling did.
  const keyOf = keyOfSettle(settle);
  // A sibling's file stays out for the whole round, its holder settled or not (R5): this attempt's snapshots may predate the sibling's recorded edit.
  const others = othersHeldInRound(settle.state, phase, key, keyOf);
  const strays = new Set(state.review!.checks.flatMap((check) => check.strays));
  const expected = expectedTreeOf(state);
  // A tracked file outside the change that nobody claimed is a leftover, a build's dist/ say, and no attempt's work (PD9).
  const tracked = new Set(gitApi.trackedFiles(worktree));
  const leftover = (path: string): boolean => tracked.has(path) && !expected.has(path);
  const candidates = [...new Set([...(into === null ? [] : snapshotPaths(into, ids.length)), ...changedPaths(worktree)])].filter((path) => !others.has(keyOf(path)) && !isPending(settle, path) && !strays.has(path) && !leftover(path));
  // A snapshot lists what changed on disk, ignored files a fixer wrote included; those are no work of the run (R23).
  const ignored = new Set(gitApi.ignoredPaths(worktree, candidates));
  const listed = candidates.filter((path) => !ignored.has(path));
  const sources = { snapshot: (index: number) => (into === null ? null : readSnapshot(into, index)), worktree: worktreeReader(worktree) };
  const revisions = unfinishedRevisions(evidence, sources, expected, baseOf(context), [...ownedFiles(fix, phase, key), ...claimedFiles(settle.state, phase, key), ...listed], ids, context.match);
  const who = phase === 'repair' ? 'the repair' : `batch ${key}`;
  const why = truncated(reason, 1000);
  return { claims: settle.events, revisions: revisions.map((revision): NewEvent => {
    const id = revision.findings[0];
    const message = id === undefined
      ? { subject: `chore: keep the partial edits of ${who}`, body: truncated(`An attempt of ${who} ended without an answer: ${why}\n\nThe files are recorded as it left them after its last snapshot; no finding accounts for them.`, bodyLength) }
      : { subject: truncated(`chore: keep the edits an unfinished attempt made for ${id}`, subjectLength), body: truncated(`An attempt of ${who} ended without an answer after snapshotting ${id}: ${why}\n\nThe files are recorded as its snapshot of ${id} held them.`, bodyLength) };
    const payload: TreeRevised = { phase, source: { kind: 'attempt', key, workerId }, change: { findings: [...revision.findings], message }, files: [...revision.files] };
    return { kind: 'tree.revised', version: 1, payload };
  }) };
}

/**
 * The revision of what a check wrote, or null when it wrote nothing (TD6
 * of the fix pass; PD9 of commit series integrity): a formatter in
 * `lint`, a generator in `build` or a snapshot updater in `test` is not
 * drift, and the revision names the check. It covers the files the run
 * expects and every tracked file whose size or time differs from
 * `manifest`, taken just before the check, so a generated tree outside the
 * scope is recorded, and committed at the series' tail, rather than left
 * changed in the worktree; a file new since the check is not listed, and
 * a file changed before it and left alone is not either. A tracked file
 * outside the change that the run's first worktree check listed as a
 * stray held the user's own change before the run, so it is left out even
 * when the check rewrites it, and stays in the worktree uncommitted. The
 * state before a path the run expects nothing of is the scope's head's, so
 * a fixer's edit of such a file that it neither claimed nor named, and
 * that the check then rewrote, is kept in this revision under the check's
 * subject and named nowhere apart (PD9; whether to name or leave out such
 * an edit is the author's open question). Without a manifest, the expected
 * files alone.
 */
export function checkRevision(context: RevisionContext, phase: TreeRevised['phase'], kind: CheckKind, command: string, manifest: SnapshotManifest | null): NewEvent | null {
  const { state, worktree, evidence } = context;
  const expected = expectedTreeOf(state);
  // A stray at the run's first check is the user's uncommitted work, which no revision may commit (as strayedInRun in fix-report.ts reads them).
  const before = new Set(state.review!.checks[0]?.strays ?? []);
  const listed = manifest === null ? [] : changedListed(manifest).filter((path) => !before.has(path));
  const files = reviseFrom(evidence, worktreeReader(worktree), expected, baseOf(context), [...expected.keys(), ...listed], context.match);
  if (files.length === 0) return null;
  const payload: TreeRevised = {
    phase,
    source: { kind: 'check', check: kind },
    change: { findings: [], message: { subject: `chore: apply the ${kind} check's rewrite`, body: truncated(`The ${kind} check, \`${command}\`, rewrote these files when run ${state.id} ran it in ${phase}.`, bodyLength) } },
    files,
  };
  return { kind: 'tree.revised', version: 1, payload };
}

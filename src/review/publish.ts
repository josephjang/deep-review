/**
 * `deep-review publish` (R7, R8, R13, R14 of the review on the pull
 * request, "Publish" of its design): post a finished read-only run of a
 * pull request as one review of that pull request, a comment, on the head
 * the run reviewed. The command takes the checkpoint's start lock only to
 * choose its run and take the run's lock, so no other command of the
 * repository waits on GitHub. Under the run's lock it settles a
 * publication a stop left open by the marker its body carries (TD5),
 * refuses what it cannot post truthfully, renders the review from the
 * run (pull-request-form.ts), records it before the post and records what
 * GitHub made after, or that GitHub refused it. A dry run makes every
 * read and check and prints what it would post, recording nothing.
 */
import { dirname } from 'node:path';
import type { Checkpoint } from '../checkpoint/checkpoint.ts';
import { recordedTextLengthV1, type PublishPosted, type PublishPrepared } from '../checkpoint/events.ts';
import type { RunState } from '../checkpoint/fold.ts';
import { publicationMarker } from '../checkpoint/publish-fold.ts';
import { GitHubCallError, PullRequestRefusedError } from '../github/errors.ts';
import { accountAction, type Gh, type GhAnswer } from '../github/gh.ts';
import { listPullRequestFiles, listReviewComments, listReviews, postReview, readBranchHead, readMergeBase, readPullRequest, reviewInput, type NewReview, type PullRequestTarget } from '../github/pull-request.ts';
import { briefOf, cutAtWord } from './brief.ts';
import { PublicationOpenError, ReviewRefusedError } from './errors.ts';
import { gitLineCounts, recordedAnswerOf } from './explanation.ts';
import { acquireRunLock, acquireStartLock, type ReleaseLock } from './lock.ts';
import { counted } from './markdown.ts';
import { machineContextOf } from './public-text.ts';
import { findingMarker, formRefusalWords, placeFindings, pullRequestForm, type BodyCut, type FindingPlacement, type PullRequestForm } from './pull-request-form.ts';
import { chooseReportRun, noReportWords } from './report-choice.ts';
import { runIdOf } from './runs.ts';
import { hasCurrentReport } from './state.ts';

export interface PublishOptions {
  readonly checkpoint: Checkpoint;
  /** The worktree the command runs in: the run `report` would show is chosen among its runs, and git reads the run's commits there. */
  readonly worktree: string;
  /** The git common directory of the repository, which no posted text names (R11). */
  readonly gitCommon: string;
  /** The run to publish, by its id or the start of it; when absent, the one `report` would show. */
  readonly runId?: string;
  /** Read, check and print what would be posted, and record nothing (R14). */
  readonly dryRun?: boolean;
  /** How `gh` runs for the run: from its recorded settings, else as pass 1 resolves them now; called only once a call of GitHub is needed, and a refusal it throws ends the command. */
  readonly gh: (run: RunState) => Gh;
  /** The entry of the engine, whose directory no posted text names (R11). */
  readonly engineEntry: string;
  /** The command's environment, whose secret values no posted text holds (R11). */
  readonly environment: NodeJS.ProcessEnv;
  /** The platform of the machine, which says where its root is; this process's by default. */
  readonly platform?: NodeJS.Platform;
  /** Where a line for each run passed over, each settle and each cut is written; stderr when absent. */
  readonly log?: (line: string) => void;
  /** Write the copy of the run's report again from the run as it is once the command ends, under the run's lock and however it ends, so "About this run" names the review (R6). */
  readonly refreshCopy?: (run: RunState) => void;
  /** Called after the publication is recorded and before the post; a test checks the locks there. */
  readonly beforePost?: () => void;
}

/**
 * What `publish` did: the run is posted, with the URL of its review and
 * how it came to be, posted by this command, settled from a publication
 * a stop left open, or posted before; or the lines of a dry run, the last
 * of them the URL of a review a settle would record.
 */
export type PublishOutcome =
  | { readonly kind: 'posted'; readonly runId: string; readonly url: string; readonly how: 'posted' | 'settled' | 'earlier'; readonly comments: number }
  | { readonly kind: 'dry-run'; readonly runId: string; readonly lines: readonly string[] };

/** The pull request a run reviewed, as the calls of GitHub name it. */
const targetOf = (run: RunState): PullRequestTarget => {
  const { host, owner, repository, number } = run.scope!.pullRequest!;
  return { host, owner, repository, number };
};

/** A pull request as a refusal names it. */
const pullRequestWords = (target: PullRequestTarget): string => `pull request #${String(target.number)} of ${target.owner}/${target.repository}`;

/** The marker on the last line of a text GitHub gives, `<!-- <marker> -->`, or null; a marker anywhere else is a worker's text, never the engine's (TD5). */
export function lastLineMarker(body: string): string | null {
  const last = body.trimEnd().split(/\r?\n/).at(-1)?.trim() ?? '';
  return /^<!-- (.+) -->$/.exec(last)?.[1] ?? null;
}

/**
 * The run to publish: the one named by its id or the start of it, or the
 * one `report` would show, the run of the worktree with a current report
 * whose last event is the latest (R7).
 */
function chooseRun(options: PublishOptions, log: (line: string) => void): RunState {
  const { checkpoint, worktree } = options;
  if (options.runId !== undefined) return checkpoint.fold(runIdOf(checkpoint, options.runId));
  const choice = chooseReportRun(checkpoint, worktree, log);
  if (choice.run !== null) return choice.run;
  if (choice.newest === null) throw new ReviewRefusedError(`no run of worktree ${worktree} has a report, so there is no review to post; deep-review status shows the run that is active`);
  throw new ReviewRefusedError(`no run of worktree ${worktree} has a report, so there is no review to post; the newest, run ${choice.newest.run}, ${choice.newest.state}; deep-review status --all lists the runs`);
}

/** The run, chosen under the start lock, with its own lock held and the start lock released, since the start lock would otherwise refuse every other command of the repository while GitHub answers. */
function lockedRun(options: PublishOptions, log: (line: string) => void): { readonly runId: string; readonly release: ReleaseLock } {
  const releaseStart = acquireStartLock(options.checkpoint.root);
  try {
    const run = chooseRun(options, log);
    return { runId: run.id, release: acquireRunLock(options.checkpoint.root, run.id) };
  } finally {
    releaseStart();
  }
}

/**
 * Publish a run (R7, R8, R13, R14): choose it and take its lock, then do
 * the steps of "Publish" in the design under that lock (`publishLocked`).
 * The copy of the run's report is written again before the run's lock is
 * released, however the command ends.
 */
export function publishRun(options: PublishOptions): PublishOutcome {
  const log = options.log ?? ((line: string): void => {
    process.stderr.write(`${line}\n`);
  });
  const { runId, release } = lockedRun(options, log);
  try {
    return publishLocked(options, runId, log);
  } finally {
    // A copy never fails the command, nor hides the refusal that ends it (TD6 of the brief of a run).
    try {
      options.refreshCopy?.(options.checkpoint.fold(runId));
    } catch (error) {
      log(`run ${runId}: could not write the copy of the report: ${error instanceof Error ? error.message : String(error)}`);
    }
    release();
  }
}

/** The comments of a review matched to their findings by the marker on their last line, each finding the publication put on a line once. */
function matchedComments(run: RunState, prepared: PublishPrepared, comments: readonly { readonly id: number; readonly url: string; readonly body: string }[]): PublishPosted['comments'] {
  const byMarker = new Map(prepared.places.filter((place) => place.place === 'line').map((place) => [findingMarker(run.id, place.finding), place.finding]));
  const matched = new Map<string, PublishPosted['comments'][number]>();
  for (const comment of comments) {
    const finding = byMarker.get(lastLineMarker(comment.body) ?? '');
    if (finding !== undefined && !matched.has(finding)) matched.set(finding, { finding, comment: { id: comment.id, url: comment.url } });
  }
  return [...matched.values()];
}

/** What GitHub made of a publication: the review, and the comment of each finding, read from GitHub. */
function postedOf(gh: Gh, run: RunState, prepared: PublishPrepared, review: { readonly id: number; readonly url: string }): PublishPosted {
  return { marker: prepared.marker, review: { id: review.id, url: review.url }, comments: matchedComments(run, prepared, listReviewComments(gh, prepared.target, review.id)) };
}

/** How a publication a stop left open settles: posted, as the review that carries its marker, or not found. */
type Settle = { readonly kind: 'posted'; readonly posted: PublishPosted } | { readonly kind: 'not-found' };

/** Look for the review that carries the marker of the open publication `prepared` among the reviews of its pull request (TD5). */
function settleOf(gh: Gh, run: RunState, prepared: PublishPrepared): Settle {
  const review = listReviews(gh, prepared.target).find((listed) => lastLineMarker(listed.body) === prepared.marker);
  return review === undefined ? { kind: 'not-found' } : { kind: 'posted', posted: postedOf(gh, run, prepared, review) };
}

/**
 * The error of a settle whose read of GitHub failed: a refusal when `gh`
 * is missing or has no account (R8), else the publication stays open and
 * the command exits 1, recording nothing.
 */
function settleFailure(error: unknown, run: RunState, prepared: PublishPrepared): unknown {
  if (!(error instanceof GitHubCallError)) return error;
  const kind = error.failure.kind;
  if (kind === 'missing' || kind === 'no-account') return new ReviewRefusedError(`${error.message}; the publication ${prepared.marker} of run ${run.id}, which a stop left open, stays open until publish can read the reviews of the pull request`);
  return new PublicationOpenError(`run ${run.id}: the publication ${prepared.marker}, which a stop left open, is not settled, since ${error.message}; nothing is recorded, and deep-review publish looks for its review again`);
}

/** What a refusal before the publication is prepared says was recorded: nothing, unless the settle recorded that the publication a stop left open was not found. */
const unrecordedWords = (settled: string | null): string => (settled === null ? 'nothing was posted or recorded' : `nothing was posted, and only that no review carries the publication ${settled}, which a stop left open, was recorded`);

/**
 * A call of GitHub before the publication is prepared, whose refusal by
 * GitHub or `gh` is a refusal of the command (R8), with an account's
 * action for a 401 or a 404, and what was recorded, `unrecorded`; a
 * timeout and an answer the engine cannot read stay errors, exit 1.
 */
function refusingGitHub<T>(target: PullRequestTarget, read: () => T, unrecorded: string): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof PullRequestRefusedError) throw new ReviewRefusedError(`${error.message}; ${unrecorded}`);
    if (!(error instanceof GitHubCallError)) throw error;
    const { failure } = error;
    if (failure.kind === 'answer' && (failure.status === 401 || failure.status === 404)) throw new ReviewRefusedError(`${error.message}; ${accountAction(target.host)} with an account that can read ${pullRequestWords(target)}`);
    if (failure.kind === 'answer' || failure.kind === 'missing' || failure.kind === 'no-account') throw new ReviewRefusedError(`${error.message}; ${unrecorded}`);
    throw error;
  }
}

/**
 * Why a run cannot be posted, before any call of GitHub (R8), or null: a
 * run with no current report, a fix run or one continued into the fix
 * pass (the non-goal "No review of a fix run"), a run of another scope
 * than a pull request, and a run `--path` narrowed, whose body could not
 * say what the review left out (PD2).
 */
function whyNotPostable(run: RunState): string | null {
  const review = run.review;
  const scope = run.scope;
  if (review === null || !hasCurrentReport(run)) return `run ${run.id} has no current report, since it ${noReportWords(run)}; publish posts a finished run`;
  if (review.continuedFrom !== null) return `run ${run.id} was continued into the fix pass with --fix, and the review of a fix run is not posted; review the pull request again with deep-review review --pr <number>, and post that run before you continue it`;
  if (review.fix !== null) return `run ${run.id} is a fix run, and the review of a fix run is not posted; review the pull request with deep-review review --pr <number>, without --fix`;
  if (scope === null || scope.pullRequest === null) return `run ${run.id} reviewed no pull request, so there is none to post its review to; review the pull request with deep-review review --pr <number>`;
  if (scope.request.paths.length > 0) return `run ${run.id} reviewed only the paths --path named (${scope.request.paths.join(', ')}), so its review could not say what it left out of the pull request; review the whole pull request with deep-review review --pr ${String(scope.pullRequest.number)}`;
  return null;
}

/**
 * Read the pull request again and refuse one that is not open (PD9), a
 * head that is not the run's head, and a merge base that is not the run's
 * base (PD2): a run is posted only on the change it reviewed. A refusal
 * says what was recorded, `unrecorded`.
 */
function requireUnmoved(gh: Gh, run: RunState, unrecorded: string): number {
  const scope = run.scope!;
  const target = targetOf(run);
  const words = pullRequestWords(target);
  const facts = refusingGitHub(target, () => readPullRequest(gh, { number: target.number, repository: `${target.host}/${target.owner}/${target.repository}` }), unrecorded);
  if (facts.state !== 'open') throw new ReviewRefusedError(`${words} is ${facts.merged ? 'merged' : 'closed'}, and deep-review posts to an open pull request only; ${unrecorded}`);
  if (facts.head !== scope.head) {
    throw new ReviewRefusedError(`the head of ${words} is ${facts.head} now, not ${scope.head}, the head run ${run.id} reviewed, and a run is posted only on the change it reviewed; check out the new head, such as with \`gh pr checkout ${String(target.number)}\`, and review it with deep-review review --pr ${String(target.number)}`);
  }
  const mergeBase = refusingGitHub(target, () => readMergeBase(gh, target, readBranchHead(gh, target, facts.baseRef), facts.head), unrecorded);
  if (mergeBase !== scope.base) {
    throw new ReviewRefusedError(`the merge base of ${words} with its base branch ${facts.baseRef} is ${mergeBase} now, not ${scope.base}, the base run ${run.id} reviewed from, and a run is posted only on the change it reviewed; review the pull request again with deep-review review --pr ${String(target.number)}`);
  }
  return facts.changedFiles;
}

/** A cut of the body as a dry run names it (R12). */
const cutWords: Readonly<Record<BodyCut, string>> = {
  'account-diagrams': 'the diagrams of the account of the pull request',
  account: 'the account of the pull request',
  refuted: 'the evidence of the refuted candidates',
  left: 'the findings left as is, down to their rows in the table',
};

/** Where a finding goes, as a dry run names it. */
function placeWords(placement: FindingPlacement): string {
  const location = placement.location === null ? '' : `${placement.location.path}:${String(placement.location.line)}`;
  switch (placement.reason) {
    case 'on-the-diff':
      return `a comment on ${location}${placement.diff === 'context' ? ', a line the pull request does not change' : ''}`;
    case 'left':
      return `in the body, left as is${location === '' ? '' : ` (${location})`}`;
    case 'outside-the-diff':
      return `in the body, since its line is not on the new side of the diff (${location})`;
    case 'no-patch':
      return `in the body, since GitHub shows no diff of its file (${location})`;
    case 'no-place':
      return 'in the body, since it has no place in the repository';
  }
}

/** What a dry run prints (R14): what it would post, where each finding goes and why, each cut, and the body and each comment in full. */
function dryRunLines(run: RunState, placements: readonly FindingPlacement[], form: PullRequestForm, notes: readonly string[]): string[] {
  const scope = run.scope!;
  const numbers = briefOf(run).numbers;
  const numbered = (finding: string): string => `${String(numbers.get(finding) ?? '?')} (${finding})`;
  return [
    `Dry run: run ${run.id} would post one review to ${scope.pullRequest!.url}, on its head ${scope.head}; nothing is posted or recorded.`,
    ...notes,
    'Where each finding goes:',
    ...(placements.length === 0 ? ['- no finding'] : placements.map((placement) => `- ${numbered(placement.finding)}: ${placeWords(placement)}`)),
    `Cut from the body to fit: ${form.cuts.length === 0 ? 'nothing' : form.cuts.map((cut) => cutWords[cut]).join(', then ')}.`,
    `Secrets replaced by the cleaning: ${String(form.secrets)}.`,
    '',
    `--- The body of the review, ${counted(form.body.length, 'character', 'characters')} ---`,
    form.body,
    '--- The end of the body ---',
    ...form.comments.flatMap((comment) => [
      '',
      `--- The comment of finding ${numbered(comment.finding)} on ${comment.path}:${String(comment.line)}, ${counted(comment.body.length, 'character', 'characters')} ---`,
      comment.body,
      '--- The end of the comment ---',
    ]),
  ];
}

/** GitHub's message as the ledger records it: its own words, or that it gave none. */
const recordedMessage = (failure: GhAnswer): string => cutAtWord(failure.message ?? `GitHub gave no message with its ${String(failure.status)}`, recordedTextLengthV1);

/**
 * What to do about a post GitHub refused, by its status ("Publish" step
 * 8 of the design): for a 403 or a 429, wait as `retry-after` says when
 * it carries it, else until `x-ratelimit-reset` when
 * `x-ratelimit-remaining` says no request is left; give `gh` an account
 * for a 401 or a 404; for a 403 with no wait and requests left, the
 * account or the token cannot write; for a 422 and any other, answer
 * GitHub's message.
 */
function refusedAction(failure: GhAnswer, target: PullRequestTarget): string {
  const limited = failure.status === 403 || failure.status === 429;
  const retry = failure.headers.get('retry-after');
  if (limited && retry !== undefined) {
    return `GitHub limits how fast an account posts; wait ${/^\d+$/.test(retry) ? counted(Number(retry), 'second', 'seconds') : `until ${retry}`} and run deep-review publish again`;
  }
  if (limited && failure.headers.get('x-ratelimit-remaining') === '0') {
    const reset = failure.headers.get('x-ratelimit-reset');
    const until = reset !== undefined && /^\d+$/.test(reset) ? `until ${new Date(Number(reset) * 1000).toISOString()}` : 'until GitHub resets its limit';
    return `GitHub limits how many requests an account makes an hour; wait ${until} and run deep-review publish again`;
  }
  if (failure.status === 401 || failure.status === 404) return `${accountAction(target.host)} with an account that can write to ${pullRequestWords(target)}, and run deep-review publish again`;
  if (failure.status === 403) return `the account or the token that gh uses cannot write to ${pullRequestWords(target)}, as the token of a workflow on a pull request from a fork cannot; post with an account or a token that can write to its pull requests`;
  return 'answer what GitHub says, and run deep-review publish again';
}

/**
 * The steps of "Publish" in the design, under the run's lock: settle a
 * publication a stop left open, give a posted run's URL, refuse what
 * cannot be posted, read the pull request again, place, render, clean and
 * fit the review, print it for a dry run, else record it, post it, and
 * record what GitHub made or that it refused it.
 */
function publishLocked(options: PublishOptions, runId: string, log: (line: string) => void): PublishOutcome {
  const { checkpoint } = options;
  const dryRun = options.dryRun === true;
  // Folded again under the run's lock, as every writer does: another command may have posted it since it was chosen.
  let run = checkpoint.fold(runId);
  let gh: Gh | null = null;
  const ghOf = (): Gh => (gh ??= options.gh(run));
  const notes: string[] = [];
  // The marker of a publication a stop left open that this command recorded as not found, which a later refusal names.
  let settled: string | null = null;

  // 1. A publication a stop left open is settled by its marker before anything else (TD5).
  const open = run.publications.at(-1);
  if (open?.status === 'prepared') {
    const { prepared } = open;
    let settle: Settle;
    try {
      settle = settleOf(ghOf(), run, prepared);
    } catch (error) {
      throw settleFailure(error, run, prepared);
    }
    if (settle.kind === 'posted') {
      const { url } = settle.posted.review;
      const line = `run ${run.id}: the publication ${prepared.marker}, which a stop left open, is on the pull request as ${url}`;
      if (dryRun) return { kind: 'dry-run', runId: run.id, lines: [`${line}; the next deep-review publish records it as posted, with ${counted(settle.posted.comments.length, 'comment', 'comments')}, and posts nothing.`, url] };
      run = checkpoint.append(run.id, run.lastSequence, [{ kind: 'publish.posted', version: 1, payload: settle.posted }]);
      log(`${line}; it is recorded as posted`);
      return { kind: 'posted', runId: run.id, url, how: 'settled', comments: settle.posted.comments.length };
    }
    const line = `run ${run.id}: no review of the pull request carries the marker of the publication ${prepared.marker}, which a stop left open`;
    if (dryRun) notes.push(`${line}; the next deep-review publish records it as not found and posts the review below.`);
    else {
      run = checkpoint.append(run.id, run.lastSequence, [{ kind: 'publish.dropped', version: 1, payload: { marker: prepared.marker, reason: 'not-found' } }]);
      settled = prepared.marker;
      log(`${line}; it is recorded as not found, and the review is posted now`);
    }
  }

  // 2. A run is posted at most once (R7).
  const earlier = run.publications.find((publication) => publication.status === 'posted');
  if (earlier?.status === 'posted') return { kind: 'posted', runId: run.id, url: earlier.posted.review.url, how: 'earlier', comments: earlier.posted.comments.length };

  // 3. What cannot be posted truthfully is refused, first without GitHub, then against the pull request as it is now (R8, PD2).
  const why = whyNotPostable(run);
  if (why !== null) throw new ReviewRefusedError(why);
  const target = targetOf(run);
  const unrecorded = unrecordedWords(settled);
  const changedFiles = requireUnmoved(ghOf(), run, unrecorded);

  // 4. Place, render, clean and fit (R9 to R12); a review that does not fit is refused before anything is recorded.
  const scope = run.scope!;
  const files = refusingGitHub(target, () => listPullRequestFiles(ghOf(), { ...target, changedFiles }), unrecorded);
  const placements = placeFindings(run.review!, files);
  const lines = gitLineCounts(options.worktree, scope);
  const serial = run.publications.length + 1;
  const form = pullRequestForm({
    state: run,
    answer: run.explanation === null ? null : recordedAnswerOf(run.explanation, checkpoint.evidence),
    places: placements,
    lineCount: (path) => lines('head', path),
    machine: machineContextOf({ worktree: run.worktree, checkpoint: checkpoint.root, gitCommon: options.gitCommon, engine: dirname(options.engineEntry), workers: run.workers, environment: options.environment, platform: options.platform ?? process.platform }),
    engine: checkpoint.engine,
    serial,
  });
  if (form.kind === 'refused') throw new ReviewRefusedError(`${formRefusalWords(form)}; ${unrecorded}, and the report of the run holds all of it`);

  // 5. A dry run ends with what it would post (R14).
  if (dryRun) return { kind: 'dry-run', runId: run.id, lines: dryRunLines(run, placements, form, notes) };
  if (form.cuts.length > 0) log(`run ${run.id}: the body of the review is cut to fit: ${form.cuts.map((cut) => cutWords[cut]).join(', then ')}; the report of the run holds all of it`);

  // 6. The publication is on the ledger, with what is posted frozen, before the post (R13, principle 2).
  const review: NewReview = { commit: scope.head, body: form.body, comments: form.comments.map(({ path, line, body }) => ({ path, line, body })) };
  const prepared: PublishPrepared = {
    marker: publicationMarker(run.id, serial),
    target,
    commit: scope.head,
    payload: checkpoint.evidence.put(JSON.stringify(reviewInput(review))),
    places: form.places.map(({ finding, place, reason }) => ({ finding, place, reason })),
    secrets: form.secrets,
  };
  run = checkpoint.append(run.id, run.lastSequence, [{ kind: 'publish.prepared', version: 1, payload: prepared }]);
  options.beforePost?.();

  // 7. One post, a comment (PD4).
  let made: { readonly id: number; readonly url: string };
  try {
    made = postReview(ghOf(), target, review);
  } catch (error) {
    if (!(error instanceof GitHubCallError)) throw error;
    const { failure } = error;
    // 8. GitHub refused it, so nothing was posted, and the run can prepare another.
    if (failure.kind === 'answer' && failure.status >= 400 && failure.status < 500) {
      checkpoint.append(run.id, run.lastSequence, [{ kind: 'publish.dropped', version: 1, payload: { marker: prepared.marker, reason: 'refused', status: failure.status, message: recordedMessage(failure) } }]);
      throw new ReviewRefusedError(`GitHub refused the review of ${pullRequestWords(target)} with ${String(failure.status)}${failure.message === null ? '' : `: ${failure.message}`}; nothing was posted, and the publication ${prepared.marker} is recorded as not posted; ${refusedAction(failure, target)}`);
    }
    // gh made no request, so nothing was posted; the next publish finds no review with the marker and posts.
    if (failure.kind === 'missing' || failure.kind === 'no-account') throw new ReviewRefusedError(`${error.message}; the publication ${prepared.marker} stays open, and deep-review publish looks for its review before it posts again`);
    throw new PublicationOpenError(`${error.message}; GitHub may have made the review or not, so the publication ${prepared.marker} stays open, and deep-review publish looks for the review by its marker before it posts again`);
  }

  // 8. What GitHub made: the review, and each comment matched to its finding by its marker.
  let posted: PublishPosted;
  try {
    posted = postedOf(ghOf(), run, prepared, made);
  } catch (error) {
    if (!(error instanceof GitHubCallError)) throw error;
    throw new PublicationOpenError(`run ${run.id}: the review is posted as ${made.url}, but ${error.message}; the publication ${prepared.marker} stays open, and deep-review publish records it from its marker`);
  }
  checkpoint.append(run.id, run.lastSequence, [{ kind: 'publish.posted', version: 1, payload: posted }]);
  if (posted.comments.length !== form.comments.length) log(`run ${run.id}: the review has ${counted(posted.comments.length, 'comment', 'comments')} that carry the marker of a finding, of the ${String(form.comments.length)} posted`);
  return { kind: 'posted', runId: run.id, url: made.url, how: 'posted', comments: posted.comments.length };
}

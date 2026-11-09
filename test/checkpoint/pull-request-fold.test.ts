import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidHistoryError } from '../../src/checkpoint/errors.ts';
import { phases } from '../../src/review/vocabulary.ts';
import {
  explanation,
  History,
  publication,
  pullRequestFacts,
  pullRequestDecided,
  pullRequestReported,
  pullRequestScope,
  readOnlyReported,
  scope,
  settingsBlockV2,
  withBaseChecks,
  withCitedRuns,
  unconfirmedFact,
  withDocumentationStep,
  withCoreForm,
  withReportForm,
  worker,
} from '../helpers/review-history.ts';

/** A read-only run of a pull request whose writer answers, recorded with `change` over the explanation. */
const explained = (change: Record<string, unknown> = {}): History =>
  pullRequestReported((history) => history.worker(60, 'writer explanation:explanation').add('explanation.recorded', explanation(worker(60), change)));

/** The same run, configured at version 9 as every run but a read-only run of a pull request is. */
const atVersion9 = (): History => withCitedRuns(withBaseChecks(withDocumentationStep(readOnlyReported(), null)));

/** The history with its scope captured as `payload` at version 3 instead. */
const capturedAs = (payload: Record<string, unknown>): History => {
  const result = new History();
  for (const event of pullRequestReported().events) result.add(event.kind, event.kind === 'scope.captured' ? payload : event.payload, event.version);
  return result;
};

// R3, TD2 of the review on the pull request.
describe('the capture of a pull request', () => {
  it('folds a version 3 capture with the pull request in its request and its facts beside the change, and every older capture with none', () => {
    const state = pullRequestReported().fold();
    assert.deepEqual(state.scope?.pullRequest, pullRequestFacts);
    assert.deepEqual(state.scope?.request.pullRequest, { number: 42, repository: null });
    assert.equal(state.scope?.mode, 'range');
    for (const history of [readOnlyReported(), atVersion9()]) assert.equal(history.fold().scope?.pullRequest, null);
  });

  it('takes a pull request named by the URL of its repository, in any case', () => {
    const named = (repository: string) => capturedAs({ ...pullRequestScope, request: { ...pullRequestScope.request, pullRequest: { number: 42, repository } } });
    assert.deepEqual(named('github.com/octo/parse').fold().scope?.request.pullRequest, { number: 42, repository: 'github.com/octo/parse' });
    assert.equal(named('GitHub.com/Octo/Parse').fold().scope?.pullRequest?.number, 42);
    assert.throws(() => named('github.com/octo/other').fold(), /captures a pull request named in github\.com\/octo\/other whose facts are of github\.com\/octo\/parse/);
  });

  it('refuses a version 3 capture whose request names no pull request, or another, whose mode is not range, or whose range is not from its base to HEAD as it is', () => {
    const unnamed = Object.fromEntries(Object.entries(pullRequestScope.request).filter(([key]) => key !== 'pullRequest'));
    const range = pullRequestScope.request.range;
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...pullRequestScope, request: unnamed }, /with a request that names none/],
      [{ ...pullRequestScope, request: { ...pullRequestScope.request, pullRequest: { number: 43, repository: null } } }, /named #43 whose facts are of #42/],
      [{ ...pullRequestScope, mode: 'worktree' }, /in mode worktree, not range/],
      [{ ...pullRequestScope, request: { ...pullRequestScope.request, range: undefined } }, /not the range from its base/],
      [{ ...pullRequestScope, request: { ...pullRequestScope.request, range: { ...range, from: 'main' } } }, /not the range from its base/],
      [{ ...pullRequestScope, request: { ...pullRequestScope.request, range: { ...range, to: 'feature' } } }, /not the range from its base/],
      [{ ...pullRequestScope, request: { ...pullRequestScope.request, range: { ...range, mergeBase: true } } }, /not the range from its base/],
    ];
    for (const [payload, refusal] of cases) assert.throws(() => capturedAs(payload).fold(), (error: unknown) => error instanceof InvalidHistoryError && refusal.test(error.message), refusal.source);
  });

  it('records the pull request only at version 3: version 2 refuses it in the request and beside the change', () => {
    const v2 = Object.fromEntries(Object.entries(pullRequestScope).filter(([key]) => key !== 'pullRequest'));
    const unnamed = { ...v2, request: Object.fromEntries(Object.entries(pullRequestScope.request).filter(([key]) => key !== 'pullRequest')) };
    const at = (payload: unknown, version: number) => new History().add('run.created', { worktree: '/w' }).add('scope.captured', payload, version);
    assert.equal(at(unnamed, 2).fold().scope?.pullRequest, null, 'the same range, named by no pull request, is a version 2 capture');
    assert.throws(() => at(v2, 2).fold(), /scope\.captured@2\) has a payload its schema rejects/);
    assert.throws(() => at(pullRequestScope, 2).fold(), /scope\.captured@2\) has a payload its schema rejects/);
    assert.throws(() => at({ ...pullRequestScope, pullRequest: { ...pullRequestFacts, body: undefined } }, 3).fold(), /scope\.captured@3\) has a payload its schema rejects/, 'an empty body is recorded as null');
    assert.equal(at({ ...pullRequestScope, pullRequest: { ...pullRequestFacts, body: null } }, 3).fold().scope?.pullRequest?.body, null);
  });
});

// TD8, R18 and R20 of the review on the pull request.
describe('review.configured@10', () => {
  it('plans the explanation right after the decision in a read-only run of a pull request, and in no run configured at version 9', () => {
    const review = pullRequestDecided().fold().review!;
    assert.equal(review.explanationStep, true);
    assert.deepEqual(review.phases.explanation, { status: 'pending', attempt: 0 });
    assert.equal(pullRequestDecided().review().phases.decision.status, 'completed');
    assert.throws(() => pullRequestDecided().start('report').fold(), /starts phase report while phase explanation is pending/, 'the report waits for the explanation');
    assert.equal(phases.indexOf('explanation'), phases.indexOf('decision') + 1);
    for (const history of [atVersion9(), readOnlyReported()]) {
      assert.equal(history.review().explanationStep, false);
      assert.equal(history.review().phases.explanation.status, 'skipped');
    }
  });

  it('records the language of the review and gh at version 2 of the record of the settings', () => {
    const settings = explained().review().configuration.settings!;
    assert.equal((settings.values as Record<string, unknown>)['review.language'], 'en');
    assert.equal((settings.values as Record<string, unknown>)['github.executable'], 'gh');
    assert.deepEqual((settings.layers as Record<string, unknown>)['review.language'], 'default');
  });

  it('refuses one that fixes, and one whose scope names no pull request', () => {
    const configuredAs = (change: (event: { kind: string; payload: unknown; version: number }) => { payload: unknown; version: number } | null, history: History = pullRequestReported()): History => {
      const result = new History();
      for (const event of history.events) {
        const changed = event.kind === 'review.configured' ? change(event) : null;
        result.add(event.kind, changed?.payload ?? event.payload, changed?.version ?? event.version);
      }
      return result;
    };
    const fixing = configuredAs((event) => ({ payload: { ...(event.payload as object), fix: true, checks: { timeoutMs: 600_000 }, fixes: { batchSize: 4 }, settings: settingsBlockV2({ values: { ...(settingsBlockV2().values as object), 'checks.build': null, 'checks.typecheck': null, 'checks.lint': null, 'checks.test': null } }) }, version: 10 }));
    assert.throws(() => fixing.fold(), /is configured to explain its review in a run that fixes/);
    const unscoped = configuredAs((event) => ({ payload: { ...(event.payload as object), settings: settingsBlockV2() }, version: 10 }), atVersion9());
    assert.throws(() => unscoped.fold(), /is configured to explain its review for a pull request, but its scope names none/);
  });

  it('holds version 10 to version 2 of the record, and version 9 to version 1', () => {
    const configuredAt = (settings: unknown, version: number, history: History): History => {
      const result = new History();
      for (const event of history.events) result.add(event.kind, event.kind === 'review.configured' ? { ...(event.payload as object), settings } : event.payload, event.kind === 'review.configured' ? version : event.version);
      return result;
    };
    const blockV1 = (atVersion9().events.find((event) => event.kind === 'review.configured')!.payload as { settings: unknown }).settings;
    assert.throws(() => configuredAt(blockV1, 10, pullRequestReported()).fold(), /review\.configured@10\) has a payload its schema rejects/, 'version 10 records the language and gh');
    assert.throws(() => configuredAt(settingsBlockV2(), 9, atVersion9()).fold(), /review\.configured@9\) has a payload its schema rejects/, 'version 9 records none of them');
    assert.throws(() => configuredAt(settingsBlockV2({ values: { ...(settingsBlockV2().values as object), 'review.language': 'en_US' } }), 10, pullRequestReported()).fold(), /has a payload its schema rejects/, 'a language tag');
  });

  it('skips the explanation of a run configured at version 9, naming why', () => {
    const history = atVersion9();
    const events = history.events.filter((event) => !(event.kind === 'report.written' || ((event.payload as { phase?: string }).phase === 'report')));
    const before = new History();
    for (const event of events) before.add(event.kind, event.payload, event.version);
    assert.throws(() => before.start('explanation').fold(), /starts phase explanation, which this run skips: only a read-only run of a pull request explains its review/);
  });
});

// R18, R19 of the review on the pull request.
describe('explanation.recorded@1', () => {
  it('is null until the writer answers, then holds the frozen answer and answers the unit', () => {
    assert.equal(pullRequestDecided().fold().explanation, null);
    assert.equal(pullRequestDecided().start('explanation').fold().explanation, null);
    const state = explained({ dropped: [{ part: 'conclusion', failures: ['the conclusion has no sentence for SWEEP-1'] }], unexplained: ['SWEEP-1'] }).fold();
    assert.deepEqual(state.explanation, { ...explanation(worker(60), { dropped: [{ part: 'conclusion', failures: ['the conclusion has no sentence for SWEEP-1'] }], unexplained: ['SWEEP-1'] }), version: 1 }, 'held with the version it was recorded at');
    assert.equal(state.review!.units.explanation.explanation?.answeredBy, worker(60));
    assert.equal(state.review!.phases.explanation.status, 'completed');
  });

  it('answers no unit when the phase degrades without an answer that passed, every part dropped', () => {
    const dropped = [{ part: 'conclusion', failures: ['f'] }, { part: 'account', failures: ['f'] }, { part: 'finding', finding: 'RIPPLE-1', failures: ['f'] }];
    const history = pullRequestReported((run) => run
      .worker(60, 'writer explanation:explanation', { outcome: 'failed', output: null, error: 'refused' })
      .add('attempt.failed', { phase: 'explanation', key: 'explanation', workerId: worker(60), reason: 'refused', fault: 'unit' }, 9)
      .worker(61, 'writer explanation:explanation', { outcome: 'failed', output: null, error: 'refused' })
      .add('attempt.failed', { phase: 'explanation', key: 'explanation', workerId: worker(61), reason: 'refused again', fault: 'unit' }, 9)
      .add('explanation.recorded', explanation(null, { answer: null, dropped })));
    const events = history.events.map((event) => (event.kind === 'phase.finished' && (event.payload as { phase: string }).phase === 'explanation' ? { ...event, payload: { ...(event.payload as object), outcome: 'degraded' } } : event));
    const degraded = new History();
    for (const event of events) degraded.add(event.kind, event.payload, event.version);
    const state = degraded.fold();
    assert.equal(state.explanation?.answer, null);
    assert.equal(state.review!.units.explanation.explanation?.answeredBy, null);
    assert.equal(state.review!.units.explanation.explanation?.failures.length, 2);
    assert.equal(state.review!.phases.explanation.status, 'degraded');
  });

  it('refuses one in a run configured before version 10, a second one, one while its phase does not run, and one that names a finding the run did not rank', () => {
    assert.throws(() => atVersion9().add('explanation.recorded', explanation(worker(60))).fold(), /records an explanation, which only a run configured at review\.configured@10 or later has/);
    assert.throws(() => pullRequestReported((run) => run.worker(60, 'writer explanation:explanation').add('explanation.recorded', explanation(worker(60))).add('explanation.recorded', explanation(null))).fold(), /records its explanation twice/);
    assert.throws(() => pullRequestDecided().add('explanation.recorded', explanation(null)).fold(), /has explanation\.recorded for phase explanation while it is pending/);
    assert.throws(() => pullRequestReported().add('explanation.recorded', explanation(null)).fold(), /records its explanation twice/);
    assert.throws(() => explained({ unexplained: ['SCAN-1'] }).fold(), /explains SCAN-1, which is not a finding of the run/);
    assert.throws(() => explained({ dropped: [{ part: 'finding', finding: 'SCAN-9', failures: ['f'] }] }).fold(), /explains SCAN-9, which is not a finding of the run/);
  });
});

// R7, R9, TD1, TD2 of the review that reads as a report.
describe('review.configured@11, verdicts.recorded@3 and explanation.recorded@2', () => {
  /** The run of a pull request whose review reads as a report, its writer answering with `change` over the explanation, its verdicts with `notes` over them. */
  const asReport = (change: Record<string, unknown> = {}, notes?: (verdict: Record<string, unknown>) => Record<string, unknown>): History =>
    withReportForm(pullRequestReported((history) => history.worker(60, 'writer explanation:explanation').add('explanation.recorded', explanation(worker(60), change))), notes);
  /** The notes of a verdict made PLAUSIBLE, with `unconfirmed` and `authorChoice` as given. */
  const plausible = (unconfirmed: unknown, authorChoice: unknown = null) => (): Record<string, unknown> => ({ verdict: 'PLAUSIBLE', unconfirmed, authorChoice });
  /** The history with each verdict recorded at `version`, `change` over it. */
  const verdictsAt = (history: History, version: number, change: (verdict: Record<string, unknown>) => Record<string, unknown>): History => {
    const result = new History();
    for (const event of history.events) {
      if (event.kind !== 'verdicts.recorded') result.add(event.kind, event.payload, event.version);
      else result.add(event.kind, { ...(event.payload as object), verdicts: (event.payload as { verdicts: Record<string, unknown>[] }).verdicts.map(change) }, version);
    }
    return result;
  };

  it('folds a run configured at version 11 as one whose review reads as a report, under the rules of version 10, and every older run as one whose review does not', () => {
    const review = asReport().review();
    assert.equal(review.reportForm, true);
    assert.equal(review.explanationStep, true);
    assert.deepEqual(review.phases.explanation, { status: 'completed', attempt: 1 });
    for (const history of [pullRequestReported(), atVersion9(), readOnlyReported()]) assert.equal(history.review().reportForm, false);
    const fixing = new History();
    for (const event of asReport().events) fixing.add(event.kind, event.kind === 'review.configured' ? { ...(event.payload as object), fix: true, checks: { timeoutMs: 600_000 }, fixes: { batchSize: 4 }, settings: settingsBlockV2({ values: { ...(settingsBlockV2().values as object), 'checks.build': null, 'checks.typecheck': null, 'checks.lint': null, 'checks.test': null } }) } : event.payload, event.version);
    assert.throws(() => fixing.fold(), /is configured to explain its review in a run that fixes/);
  });

  it('holds each verdict at version 3 with what keeps it from CONFIRMED and the choice left to the author, and each verdict of versions 1 and 2 with neither', () => {
    const choice = 'return an empty result, or refuse the empty input';
    const unsettled = { kind: 'choice', text: 'the defect is there, and what an empty input should give remains' };
    const verdict = asReport({}, plausible(unsettled, choice)).review().candidates['RIPPLE-1']?.verdict;
    assert.deepEqual([verdict?.verdict, verdict?.unconfirmed, verdict?.authorChoice], ['PLAUSIBLE', unsettled, choice]);
    const confirmed = asReport().review().candidates['RIPPLE-1']?.verdict;
    assert.deepEqual([confirmed?.verdict, confirmed?.unconfirmed, confirmed?.authorChoice], ['CONFIRMED', null, null]);
    for (const history of [pullRequestReported(), readOnlyReported()]) {
      const older = history.review().candidates['RIPPLE-1']?.verdict;
      assert.deepEqual([older?.unconfirmed, older?.authorChoice], [null, null], 'a verdict recorded before version 3 has neither note');
    }
  });

  it('refuses a PLAUSIBLE verdict with nothing that keeps it from CONFIRMED, and any other verdict with it, at version 3', () => {
    assert.throws(() => asReport({}, plausible(null)).fold(), /records the verdict of RIPPLE-1 as PLAUSIBLE without what keeps it from CONFIRMED, which a verdict gives exactly when it is PLAUSIBLE/);
    assert.throws(() => asReport({}, () => ({ unconfirmed: unconfirmedFact, authorChoice: null })).fold(), /records the verdict of RIPPLE-1 as CONFIRMED with what keeps it from CONFIRMED/);
    assert.equal(asReport({}, () => ({ unconfirmed: null, authorChoice: 'keep the old error, or return null' })).review().candidates['RIPPLE-1']?.verdict?.authorChoice, 'keep the old error, or return null', 'a CONFIRMED verdict may leave a choice to the author');
    for (const [notes, what] of [[plausible({ kind: 'fact', text: '' }), 'a note says something'], [plausible({ kind: 'hunch', text: 'a guess' }), 'a fact or a choice'], [plausible(unconfirmedFact, 'x'.repeat(401)), 'a choice of at most 400 characters']] as const) {
      assert.throws(() => asReport({}, notes).fold(), /verdicts\.recorded@3\) has a payload its schema rejects/, what);
    }
  });

  it('refuses verdicts at a version the run\'s configuration does not ask for', () => {
    assert.throws(() => verdictsAt(pullRequestReported(), 3, (verdict) => ({ ...verdict, unconfirmed: null, authorChoice: null })).fold(), /records verdicts with why each is PLAUSIBLE and the choice left to the author, which only a run configured at review\.configured@11 does/);
    const withoutNotes = ({ unconfirmed: _unconfirmed, authorChoice: _choice, ...verdict }: Record<string, unknown>): Record<string, unknown> => verdict;
    assert.throws(() => verdictsAt(asReport(), 2, withoutNotes).fold(), /records verdicts at version 2, which a run configured at review\.configured@11 records at version 3, with why each is PLAUSIBLE and the choice left to the author/);
    const withoutBases = ({ basis: _basis, runs: _runs, ...verdict }: Record<string, unknown>): Record<string, unknown> => withoutNotes(verdict);
    assert.throws(() => verdictsAt(asReport(), 1, withoutBases).fold(), /records verdicts at version 1, which a run configured at review\.configured@11 records at version 3, with why each is PLAUSIBLE and the choice left to the author/);
  });

  it('holds the explanation with the version it was recorded at, 2 in a run configured at version 11 and 1 in one at version 10, and refuses the other', () => {
    const dropped = [{ part: 'areas', failures: ['the areas leave out RIPPLE-1'] }, { part: 'refuted', failures: ['no line for SCAN-1'] }];
    const state = asReport({ dropped }).fold();
    assert.deepEqual(state.explanation, { ...explanation(worker(60), { dropped }), version: 2 });
    assert.equal(state.review!.explanationDegraded, true, 'a part dropped degrades the explanation');
    assert.equal(explained().fold().explanation?.version, 1);
    const atVersion1 = new History();
    for (const event of asReport().events) atVersion1.add(event.kind, event.payload, event.kind === 'explanation.recorded' ? 1 : event.version);
    assert.throws(() => atVersion1.fold(), /records an explanation at version 1, which a run configured at review\.configured@11 records at version 2/);
    assert.throws(() => pullRequestDecided().start('explanation').worker(60, 'writer explanation:explanation').add('explanation.recorded', explanation(worker(60)), 2).fold(), /records an explanation at version 2, which a run configured at review\.configured@10 records at version 1/);
  });

  it('names the parts of version 2 by the areas and the refuted lines, never the account, and drops each of them when no answer passed', () => {
    assert.throws(() => asReport({ dropped: [{ part: 'account', failures: ['f'] }] }).fold(), /explanation\.recorded@2\) has a payload its schema rejects/);
    const unanswered = (parts: readonly string[]): History => asReport({ workerId: null, answer: null, dropped: parts.map((part) => ({ part, failures: ['f'] })) });
    assert.throws(() => unanswered(['conclusion', 'areas']).fold(), /explanation\.recorded@2\) has a payload its schema rejects/, 'no answer drops the refuted lines too');
    assert.equal(unanswered(['conclusion', 'areas', 'refuted']).fold().explanation?.answer, null);
  });
});

// TD1, TD2 of the core of the change on the pull request.
describe('review.configured@12 and explanation.recorded@3', () => {
  /** The run of a pull request whose review opens with the core of the change, its writer answering with `change` over the explanation. */
  const withCore = (change: Record<string, unknown> = {}): History =>
    withCoreForm(pullRequestReported((history) => history.worker(60, 'writer explanation:explanation').add('explanation.recorded', explanation(worker(60), change))));
  /** The history with its explanation recorded at `version`. */
  const explanationAt = (history: History, version: number): History => {
    const result = new History();
    for (const event of history.events) result.add(event.kind, event.payload, event.kind === 'explanation.recorded' ? version : event.version);
    return result;
  };

  it('folds a run configured at version 12 as one whose review opens with the core and reads as a report, and every older run as one whose review does not open with it', () => {
    const review = withCore().review();
    assert.deepEqual([review.coreForm, review.reportForm, review.explanationStep], [true, true, true]);
    assert.deepEqual(review.phases.explanation, { status: 'completed', attempt: 1 });
    for (const history of [withReportForm(pullRequestReported()), pullRequestReported(), atVersion9(), readOnlyReported()]) assert.equal(history.review().coreForm, false);
  });

  it('holds the explanation at version 3 in a run configured at version 12, and refuses version 3 in an older run and an older version in it', () => {
    const dropped = [{ part: 'core', failures: ['the core names RIPPLE-1'] }, { part: 'conditions', failures: ['no sentence for wide-effect'] }];
    const state = withCore({ dropped }).fold();
    assert.deepEqual(state.explanation, { ...explanation(worker(60), { dropped }), version: 3 });
    assert.equal(state.review!.explanationDegraded, true, 'a part dropped degrades the explanation');
    assert.throws(() => explanationAt(withCore(), 2).fold(), /records an explanation at version 2, which a run configured at review\.configured@12 records at version 3/);
    assert.throws(() => explanationAt(withReportForm(pullRequestReported()), 3).fold(), /records an explanation at version 3, which a run configured at review\.configured@11 records at version 2/);
    assert.throws(() => explanationAt(pullRequestReported(), 3).fold(), /records an explanation at version 3, which a run configured at review\.configured@10 records at version 1/);
  });

  it('names the parts of version 3 by those of version 2, the core and the conditions, and drops each of them but the findings when no answer passed', () => {
    assert.throws(() => withCore({ dropped: [{ part: 'account', failures: ['f'] }] }).fold(), /explanation\.recorded@3\) has a payload its schema rejects/);
    const unanswered = (parts: readonly string[]): History => withCore({ workerId: null, answer: null, dropped: parts.map((part) => ({ part, failures: ['f'] })) });
    assert.throws(() => unanswered(['conclusion', 'areas', 'refuted']).fold(), /explanation\.recorded@3\) has a payload its schema rejects/, 'no answer drops the core and the conditions too');
    assert.equal(unanswered(['conclusion', 'areas', 'refuted', 'core', 'conditions']).fold().explanation?.answer, null);
  });
});

// R13, TD5 of the review on the pull request.
describe('the publications of a run', () => {
  const posted = (serial: number, change: Record<string, unknown> = {}): Record<string, unknown> => ({
    marker: `deep-review publication run-1 ${String(serial)}`,
    review: { id: 2_400_000_001, url: 'https://github.com/octo/parse/pull/42#pullrequestreview-2400000001' },
    comments: [{ finding: 'RIPPLE-1', comment: { id: 1_900_000_001, url: 'https://github.com/octo/parse/pull/42#discussion_r1900000001' } }],
    ...change,
  });
  const refused = (serial: number): Record<string, unknown> => ({ marker: `deep-review publication run-1 ${String(serial)}`, reason: 'refused', status: 422, message: 'line must be part of the diff' });
  const notFound = (serial: number): Record<string, unknown> => ({ marker: `deep-review publication run-1 ${String(serial)}`, reason: 'not-found' });

  it('are none for a run never published, and every one in ledger order, each prepared, then posted or dropped', () => {
    assert.deepEqual(explained().fold().publications, []);
    const state = explained().add('publish.prepared', publication(1)).add('publish.dropped', refused(1)).add('publish.prepared', publication(2)).add('publish.dropped', notFound(2)).add('publish.prepared', publication(3)).add('publish.posted', posted(3)).fold();
    assert.deepEqual(state.publications.map((entry) => [entry.status, entry.prepared.marker]), [
      ['dropped', 'deep-review publication run-1 1'],
      ['dropped', 'deep-review publication run-1 2'],
      ['posted', 'deep-review publication run-1 3'],
    ]);
    const last = state.publications.at(-1)!;
    assert.ok(last.status === 'posted');
    assert.deepEqual(last.posted, posted(3));
    assert.deepEqual(last.prepared, publication(3));
    const first = state.publications[0]!;
    assert.ok(first.status === 'dropped');
    assert.deepEqual(first.dropped, refused(1));
  });

  it('leave a publication open until it is posted or dropped, as a stop between the record and the post leaves it', () => {
    const state = explained().add('publish.prepared', publication(1)).fold();
    assert.deepEqual(state.publications, [{ status: 'prepared', prepared: publication(1) }]);
  });

  it('refuse a post or a drop with no open publication of its marker', () => {
    assert.throws(() => explained().add('publish.posted', posted(1)).fold(), /posts the publication deep-review publication run-1 1, which no open publication of the run is/);
    assert.throws(() => explained().add('publish.dropped', notFound(1)).fold(), /drops the publication deep-review publication run-1 1, which no open publication/);
    assert.throws(() => explained().add('publish.prepared', publication(1)).add('publish.posted', posted(2)).fold(), /posts the publication deep-review publication run-1 2/);
    assert.throws(() => explained().add('publish.prepared', publication(1)).add('publish.dropped', notFound(1)).add('publish.dropped', notFound(1)).fold(), /drops the publication deep-review publication run-1 1, which no open publication/);
  });

  it('refuse a publication while another is open, after one was posted, and in a run whose scope has no pull request', () => {
    assert.throws(() => explained().add('publish.prepared', publication(1)).add('publish.prepared', publication(2)).fold(), /prepares a publication while deep-review publication run-1 1 is open/);
    assert.throws(() => explained().add('publish.prepared', publication(1)).add('publish.posted', posted(1)).add('publish.prepared', publication(2)).fold(), /prepares a publication after deep-review publication run-1 1 was posted/);
    assert.throws(() => atVersion9().add('publish.prepared', publication(1)).fold(), /prepares a publication, but its scope has no pull request/);
  });

  it('refuse a publication, a post and a drop before the run is created, in the words the rest of the fold uses, as the configuration does', () => {
    const configured = pullRequestReported().events.find((event) => event.kind === 'review.configured')!;
    const cases: [string, unknown, number][] = [
      ['publish.prepared', publication(1), 1],
      ['publish.posted', posted(1), 1],
      ['publish.dropped', notFound(1), 1],
      ['review.configured', configured.payload, configured.version],
    ];
    for (const [kind, payload, version] of cases) {
      assert.throws(() => new History().add(kind, payload, version).fold(), (error: unknown) => error instanceof InvalidHistoryError && error.message === `Run run-1 has ${kind} at sequence 1 before its creation`, kind);
    }
  });

  it('hold a publication to the next serial of the run, the pull request it reviewed, its head, and the findings it ranked', () => {
    assert.throws(() => explained().add('publish.prepared', publication(2)).fold(), /marks its publication deep-review publication run-1 2, not deep-review publication run-1 1/);
    assert.throws(() => explained().add('publish.prepared', publication(1)).add('publish.dropped', notFound(1)).add('publish.prepared', publication(1)).fold(), /not deep-review publication run-1 2/);
    assert.throws(() => explained().add('publish.prepared', publication(1, { marker: 'deep-review publication run-2 1' })).fold(), /not deep-review publication run-1 1/);
    assert.throws(() => explained().add('publish.prepared', publication(1, { target: { host: 'github.com', owner: 'octo', repository: 'parse', number: 43 } })).fold(), /to github\.com\/octo\/parse#43, not to the pull request it reviewed, github\.com\/octo\/parse#42/);
    assert.throws(() => explained().add('publish.prepared', publication(1, { target: { host: 'ghe.example.com', owner: 'octo', repository: 'parse', number: 42 } })).fold(), /not to the pull request it reviewed/);
    assert.throws(() => explained().add('publish.prepared', publication(1, { commit: scope.base })).fold(), /on 1{40}, not on the head it reviewed, 2{40}/);
    assert.throws(() => explained().add('publish.prepared', publication(1, { places: [{ finding: 'SCAN-1', place: 'body', reason: 'no-place' }] })).fold(), /places SCAN-1, which is not a finding of the run/);
  });

  it('hold a posted comment to a finding its publication put on a line', () => {
    assert.throws(() => explained().add('publish.prepared', publication(1)).add('publish.posted', posted(1, { comments: [{ finding: 'SWEEP-1', comment: { id: 1, url: 'https://github.com/octo/parse/pull/42#discussion_r1' } }] })).fold(), /matches a comment to SWEEP-1, which the publication did not put on a line/);
    assert.equal(explained().add('publish.prepared', publication(1)).add('publish.posted', posted(1, { comments: [] })).fold().publications[0]?.status, 'posted', 'GitHub may list fewer comments than the review made');
  });
});

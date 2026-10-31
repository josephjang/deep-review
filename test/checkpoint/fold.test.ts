import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { InvalidHistoryError, UnknownEventError } from '../../src/checkpoint/errors.ts';
import { accessSchema, effortSchema, eventRegistry, workerLaunchedV1 } from '../../src/checkpoint/events.ts';
import { applyEvent, defineModel, firstUnknownEvent, foldRun, reducers, runModel, type DecodedEvent } from '../../src/checkpoint/fold.ts';
import { defineRegistry, registryIdentity, registryKeys } from '../../src/checkpoint/registry.ts';
import { testModel } from '../helpers/model.ts';

const event = (sequence: number, kind: string, payload: unknown, version = 1): DecodedEvent => ({
  sequence,
  runId: 'run-1',
  kind,
  version,
  payload,
  recordedAt: `2026-09-26T00:00:0${String(sequence)}.000Z`,
  engine: '0.0.0',
});
const created = (sequence = 1): DecodedEvent => event(sequence, 'run.created', { worktree: '/w' });

describe('registry', () => {
  /**
   * Every kind the engine declares, sorted as `registryKeys` sorts: the
   * run, scope and worker kinds, the review's, with versions 2 to 4 of
   * the kinds that carry a phase, version 5 of the two that carry a
   * blocker code or a fault, and versions 2 to 6 of the configuration,
   * the fix pass's with versions 2 and 3 of its plan of checks, the
   * survey's, the decision step's, the claims', version 2 of the scope
   * and of the continuation's pin, which the settings added, and the kinds
   * and versions of resumable runs: the start and version 3 of a check's
   * run, the write back, version 6 of the worktree check and 7 of a failed
   * attempt, the reopened fix pass, and the prepared and dropped series;
   * and the documentation step's plan and the versions of the ten kinds
   * that name its phase or its unit.
   */
  const declaredKinds = [
    'angle.failed@1', 'answer.pass@1', 'answer.recorded@1', 'attempt.failed@1', 'attempt.failed@2', 'attempt.failed@3', 'attempt.failed@4', 'attempt.failed@5', 'attempt.failed@6', 'attempt.failed@7', 'attempt.failed@8', 'candidates.recorded@1', 'candidates.recorded@2', 'check.ran@1', 'check.ran@2', 'check.ran@3', 'check.ran@4', 'check.started@1', 'check.started@2', 'checks.planned@1', 'checks.planned@2', 'checks.planned@3', 'claims.lost@1', 'commits.created@1', 'commits.dropped@1', 'commits.prepared@1',
    'decisions.recorded@1', 'deduplication.recorded@1', 'documentation.planned@1', 'files.claimed@1', 'fix.pinned@1', 'fix.pinned@2', 'fix.recorded@1', 'fix.recorded@2', 'fix.recorded@3', 'fix.recorded@4', 'fix.recorded@5', 'fix.reopened@1', 'fix.reopened@2', 'fixes.planned@1', 'fixes.replanned@1', 'group.unverified@1', 'limits.changed@1',
    'phase.finished@1', 'phase.finished@2', 'phase.finished@3', 'phase.finished@4', 'phase.finished@5', 'phase.finished@6', 'phase.finished@7', 'phase.finished@8', 'phase.started@1', 'phase.started@2', 'phase.started@3', 'phase.started@4', 'phase.started@5', 'phase.started@6', 'phase.started@7', 'ranking.recorded@1', 'report.written@1', 'report.written@2', 'report.written@3', 'report.written@4', 'report.written@5', 'report.written@6', 'report.written@7',
    'review.configured@1', 'review.configured@2', 'review.configured@3', 'review.configured@4', 'review.configured@5', 'review.configured@6', 'review.configured@7', 'review.configured@8', 'review.configured@9', 'run.abandoned@1', 'run.created@1', 'scope.captured@1', 'scope.captured@2', 'survey.failed@1', 'survey.recorded@1', 'tree.restored@1', 'tree.revised@1', 'tree.revised@2', 'tree.revised@3', 'unit.unattempted@1', 'unit.unattempted@2', 'verdicts.recorded@1', 'verdicts.recorded@2', 'verification.planned@1',
    'worker.finished@1', 'worker.launched@1', 'worker.lost@1', 'worker.lost@2', 'worker.lost@3', 'worker.lost@4', 'worker.lost@5', 'worker.lost@6', 'worktree.checked@1', 'worktree.checked@2', 'worktree.checked@3', 'worktree.checked@4', 'worktree.checked@5', 'worktree.checked@6', 'worktree.checked@7', 'worktree.checked@8',
  ];

  it('lists every kind and version, sorted, and hashes that list', () => {
    assert.deepEqual(registryKeys(eventRegistry), declaredKinds);
    assert.match(registryIdentity(eventRegistry), /^[a-f0-9]{64}$/);
    const extended = defineRegistry({ ...eventRegistry, 'a.b': { 2: { schema: z.strictObject({}) } } });
    assert.deepEqual(registryKeys(extended), ['a.b@2', ...declaredKinds]);
    assert.notEqual(registryIdentity(extended), registryIdentity(eventRegistry));
  });

  it('refuses a malformed kind name, a kind without versions, and a non-positive version', () => {
    const schema = z.strictObject({});
    assert.throws(() => defineRegistry({ 'NoDots': { 1: { schema } } }), /dotted lowercase/);
    assert.throws(() => defineRegistry({ 'run.Created': { 1: { schema } } }), /dotted lowercase/);
    assert.throws(() => defineRegistry({ 'a.b': {} }), /declares no version/);
    assert.throws(() => defineRegistry({ 'a.b': { 0: { schema } } }), /non-positive version/);
  });
});

describe('defineModel', () => {
  it('accepts reducers that cover the registry exactly', () => {
    assert.deepEqual(registryKeys(runModel.registry), Object.keys(runModel.reducers).sort());
  });

  it('refuses a registered kind without a reducer and a reducer without a kind', () => {
    const missing = Object.fromEntries(Object.entries(reducers).filter(([key]) => key !== 'run.abandoned@1'));
    assert.throws(() => defineModel(eventRegistry, missing as typeof reducers), /Reducers and registry disagree/);
    assert.throws(() => defineModel(eventRegistry, { ...reducers, 'ghost.kind@1': reducers['run.abandoned@1'] } as typeof reducers), /Reducers and registry disagree/);
  });
});

describe('foldRun', () => {
  it('folds a creation into an active run', () => {
    assert.deepEqual(foldRun([created()]), {
      id: 'run-1',
      worktree: '/w',
      createdAt: '2026-09-26T00:00:01.000Z',
      engine: '0.0.0',
      status: 'active',
      abandonReason: null,
      scope: null,
      workers: {},
      review: null,
      lastSequence: 1,
    });
  });

  it('folds an abandonment and keeps the creation facts', () => {
    const state = foldRun([created(), event(7, 'run.abandoned', { reason: 'operator gave up' })]);
    assert.equal(state.status, 'abandoned');
    assert.equal(state.abandonReason, 'operator gave up');
    assert.equal(state.lastSequence, 7);
    assert.equal(state.createdAt, '2026-09-26T00:00:01.000Z');
  });

  it('is deterministic', () => {
    const events = [created(), event(2, 'run.abandoned', { reason: 'r' })];
    assert.deepEqual(foldRun(events), foldRun(events));
  });

  it('refuses an empty history, a run created twice, and an event before creation', () => {
    assert.throws(() => foldRun([]), InvalidHistoryError);
    assert.throws(() => foldRun([created(1), created(2)]), /created twice/);
    assert.throws(() => foldRun([event(1, 'run.abandoned', { reason: 'r' })]), /before its creation/);
  });

  it('refuses an event after the run was abandoned', () => {
    assert.throws(() => foldRun([created(), event(2, 'run.abandoned', { reason: 'r' }), event(3, 'run.abandoned', { reason: 'again' })]), /was abandoned at sequence 2/);
  });

  it('refuses an unknown kind or version by name rather than skipping it', () => {
    assert.throws(() => foldRun([created(), event(2, 'run.mystery', {})]), (error: unknown) => error instanceof UnknownEventError && error.kind === 'run.mystery' && error.version === 1);
    assert.throws(() => foldRun([created(), event(2, 'run.abandoned', { reason: 'r' }, 2)]), (error: unknown) => error instanceof UnknownEventError && error.version === 2);
  });

  it('refuses a payload its schema rejects, naming the sequence', () => {
    assert.throws(() => foldRun([event(1, 'run.created', { worktree: '' })]), /Event 1 \(run.created@1\)/);
    assert.throws(() => foldRun([created(), event(2, 'run.abandoned', { reason: 'r', extra: 1 })]), /Event 2/);
  });

  it('folds kinds a custom model adds', () => {
    const state = foldRun([created(), event(2, 'test.note', { text: 'hi' })], testModel);
    assert.equal(state.lastSequence, 2);
    assert.throws(() => foldRun([created(), event(2, 'test.note', { text: 'hi' })]), UnknownEventError);
  });
});

// R10 of the configuration: the paths scope.exclude left out.
describe('the scope', () => {
  const v1 = { mode: 'worktree', request: { paths: ['src'] }, base: '1'.repeat(40), head: '2'.repeat(40), files: [], patch: { sha256: 'a'.repeat(64), bytes: 1 } };
  const v2 = { ...v1, request: { paths: [], exclude: ['dist/**'] }, excluded: { paths: ['dist/a.js', 'dist/b.js'], count: 2 } };

  it('reads a version 1 capture as one with no pattern, which left nothing out', () => {
    const state = foldRun([created(), event(2, 'scope.captured', v1)]);
    assert.deepEqual(state.scope, { ...v1, request: { paths: ['src'], exclude: [] }, excluded: { paths: [], count: 0 } });
  });

  it('folds a version 2 capture as it was recorded, with its patterns and the paths they left out', () => {
    assert.deepEqual(foldRun([created(), event(2, 'scope.captured', v2, 2)]).scope, v2);
    const many = { ...v2, excluded: { paths: Array.from({ length: 2000 }, (_, index) => `dist/${String(index)}.js`), count: 2500 } };
    assert.equal(foldRun([created(), event(2, 'scope.captured', many, 2)]).scope?.excluded.count, 2500, 'more paths than the record names are counted');
  });

  it('refuses a count that is not the paths named, paths left out with no pattern, and a capture twice', () => {
    for (const payload of [
      { ...v2, excluded: { paths: ['dist/a.js'], count: 2 } },
      { ...v2, excluded: { paths: ['dist/a.js', 'dist/b.js'], count: 1 } },
      { ...v2, request: { paths: [], exclude: [] } },
      { ...v1, excluded: { paths: [], count: 0 } },
    ]) {
      assert.throws(() => foldRun([created(), event(2, 'scope.captured', payload, 2)]), /scope\.captured@2\) has a payload its schema rejects/, JSON.stringify(payload.excluded));
    }
    assert.throws(() => foldRun([created(), event(2, 'scope.captured', v1), event(3, 'scope.captured', v2, 2)]), /captures its scope twice/);
  });
});

describe('firstUnknownEvent', () => {
  it('is null for a history the model knows, and for no history', () => {
    assert.equal(firstUnknownEvent([created(), event(2, 'run.abandoned', { reason: 'r' })]), null);
    assert.equal(firstUnknownEvent([]), null);
  });

  it('names the first unknown event: its sequence, kind, version and the engine that wrote it', () => {
    const newer = { ...event(3, 'run.abandoned', { reason: 'r' }, 2), engine: '9.9.9+newer' };
    const later = { ...event(4, 'run.mystery', {}), engine: '9.9.9+other' };
    assert.deepEqual(firstUnknownEvent([created(), event(2, 'run.abandoned', { reason: 'r' }), newer, later]), { sequence: 3, kind: 'run.abandoned', version: 2, engine: '9.9.9+newer' });
    assert.deepEqual(firstUnknownEvent([created(), later]), { sequence: 4, kind: 'run.mystery', version: 1, engine: '9.9.9+other' });
  });

  it('decides what is known by the model given, as the fold does', () => {
    const history = [created(), event(2, 'test.note', { text: 'hi' })];
    assert.deepEqual(firstUnknownEvent(history, runModel), { sequence: 2, kind: 'test.note', version: 1, engine: '0.0.0' });
    assert.throws(() => foldRun(history, runModel), UnknownEventError);
    assert.equal(firstUnknownEvent(history, testModel), null);
    assert.equal(foldRun(history, testModel).lastSequence, 2);
  });

  it('does not judge payloads: a known event with a bad payload is for the fold to refuse', () => {
    const history = [created(), event(2, 'run.abandoned', { reason: 1 })];
    assert.equal(firstUnknownEvent(history), null);
    assert.throws(() => foldRun(history), InvalidHistoryError);
  });
});

describe('applyEvent', () => {
  it('applies one event to a prior state', () => {
    const state = applyEvent(foldRun([created()]), event(2, 'run.abandoned', { reason: 'r' }));
    assert.equal(state.status, 'abandoned');
  });
});

describe('workers', () => {
  const reference = (fill: string, bytes = 1): { sha256: string; bytes: number } => ({ sha256: fill.repeat(64), bytes });
  const workerA = '00000000-0000-4000-8000-00000000000a';
  const workerB = '00000000-0000-4000-8000-00000000000b';
  const launch = (workerId: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({
    workerId,
    label: null,
    runtime: 'claude',
    executable: '/bin/claude',
    executableArgs: [],
    version: '2.1.283',
    model: 'sonnet',
    effort: 'high',
    access: 'read-only',
    shell: true,
    sessionId: '11111111-2222-4333-8444-555555555555',
    resumes: null,
    scratch: '/checkpoint/scratch/x',
    budgetUsd: null,
    timeoutMs: 60_000,
    prompt: reference('a'),
    schema: reference('b'),
    ...change,
  });
  const finish = (workerId: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({
    workerId,
    outcome: 'completed',
    exitCode: 0,
    signal: null,
    termination: 'exited',
    startedAt: '2026-09-27T00:00:00.000Z',
    endedAt: '2026-09-27T00:00:05.000Z',
    sessionIds: ['11111111-2222-4333-8444-555555555555'],
    usage: '{"input_tokens":1}',
    denials: [],
    error: null,
    stdout: reference('c'),
    stderr: reference('d', 0),
    finalMessage: null,
    output: reference('e'),
    ...change,
  });

  it('folds a launch into a running worker and a finish into a finished one', () => {
    const running = foldRun([created(), event(2, 'worker.launched', launch(workerA))]);
    assert.deepEqual(running.workers, { [workerA]: { status: 'running', launch: launch(workerA), launchedAt: '2026-09-26T00:00:02.000Z' } });
    const finished = foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.finished', finish(workerA))]);
    assert.deepEqual(finished.workers, { [workerA]: { status: 'finished', launch: launch(workerA), launchedAt: '2026-09-26T00:00:02.000Z', finish: finish(workerA) } });
    assert.equal(finished.lastSequence, 3);
  });

  it('keeps workers apart, in any interleaving', () => {
    const state = foldRun([
      created(),
      event(2, 'worker.launched', launch(workerA)),
      event(3, 'worker.launched', launch(workerB, { runtime: 'codex', sessionId: null })),
      event(4, 'worker.finished', finish(workerA, { outcome: 'timeout', termination: 'killed', exitCode: null, signal: 'SIGKILL', output: null })),
    ]);
    assert.equal(state.workers[workerA]?.status, 'finished');
    assert.equal(state.workers[workerB]?.status, 'running');
    assert.equal(state.workers[workerB]?.launch.runtime, 'codex');
  });

  it('keeps workers when the run is abandoned', () => {
    const state = foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'run.abandoned', { reason: 'r' })]);
    assert.equal(state.workers[workerA]?.status, 'running');
  });

  it('refuses a second launch of one worker, a finish without a launch and a second finish', () => {
    assert.throws(() => foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.launched', launch(workerA))]), /launches worker .* twice, at sequence 3/);
    assert.throws(() => foldRun([created(), event(2, 'worker.finished', finish(workerA))]), /finishes worker .* at sequence 2 without launching it/);
    assert.throws(
      () => foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.finished', finish(workerA)), event(4, 'worker.finished', finish(workerA))]),
      /finishes worker .* twice, at sequence 4/,
    );
    assert.throws(() => foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.finished', finish(workerB))]), /without launching it/);
  });

  it('refuses a finish after the worker was lost, naming the loss rather than a second finish', () => {
    const lost = { workerId: workerA, phase: null, key: null, reason: 'the engine exited while the worker ran' };
    assert.throws(
      () => foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.lost', lost), event(4, 'worker.finished', finish(workerA))]),
      (error: unknown) => error instanceof Error && /finishes worker .* at sequence 4 after it was lost$/.test(error.message),
    );
  });

  it('accepts a continuation under the session it resumes, and every other outcome without an output', () => {
    const session = '11111111-2222-4333-8444-555555555555';
    const state = foldRun([
      created(),
      event(2, 'worker.launched', launch(workerA, { sessionId: session, resumes: session })),
      event(3, 'worker.launched', launch(workerB, { sessionId: null, resumes: null })),
    ]);
    assert.equal(state.workers[workerA]?.launch.resumes, session);
    assert.equal(state.workers[workerB]?.launch.sessionId, null);
    for (const outcome of ['budget', 'timeout', 'failed']) {
      const finished = foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.finished', finish(workerA, { outcome, output: null }))]);
      assert.equal(finished.workers[workerA]?.status, 'finished', outcome);
    }
  });

  it('names the broken rule when a finish and its output disagree, or a continuation runs under another session', () => {
    assert.throws(
      () => foldRun([created(), event(2, 'worker.launched', launch(workerA)), event(3, 'worker.finished', finish(workerA, { output: null }))]),
      /output is present exactly when the outcome is completed/,
    );
    assert.throws(
      () => foldRun([created(), event(2, 'worker.launched', launch(workerA, { resumes: '99999999-2222-4333-8444-555555555555' }))]),
      /a continuation runs under the session it resumes/,
    );
  });

  it('pins the effort levels and access modes worker.launched@1 records, apart from the runtime contract', () => {
    assert.deepEqual(workerLaunchedV1.shape.effort.options, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(workerLaunchedV1.shape.access.options, ['read-only', 'edit']);
    assert.notEqual(workerLaunchedV1.shape.effort, effortSchema);
    assert.notEqual(workerLaunchedV1.shape.access, accessSchema);
  });

  it('never changes a state it was handed', () => {
    const before = foldRun([created(), event(2, 'worker.launched', launch(workerA))]);
    const snapshot = structuredClone(before);
    const after = applyEvent(before, event(3, 'worker.launched', launch(workerB)));
    assert.deepEqual(Object.keys(after.workers).sort(), [workerA, workerB]);
    const finished = applyEvent(after, event(4, 'worker.finished', finish(workerA)));
    assert.equal(after.workers[workerA]?.status, 'running');
    assert.equal(finished.workers[workerA]?.status, 'finished');
    assert.equal(finished.workers[workerB]?.status, 'running');
    assert.deepEqual(before, snapshot);
  });

  it('gives every fold its own workers, even over the same events', () => {
    const count = 500;
    const ids = Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
    const events = [created(), ...ids.map((id, index) => event(2 + index, 'worker.launched', launch(id)))];
    for (const [index, id] of ids.entries()) if (index % 2 === 0) events.push(event(2 + count + index, 'worker.finished', finish(id)));
    const first = foldRun(events);
    const snapshot = structuredClone(first);
    assert.equal(Object.keys(first.workers).length, count);
    assert.equal(Object.values(first.workers).filter((worker) => worker.status === 'finished').length, count / 2);
    assert.equal(first.workers[ids[1]!]?.status, 'running');
    const longer = foldRun([...events, event(2 + 2 * count, 'worker.finished', finish(ids[1]!))]);
    assert.notEqual(longer.workers, first.workers);
    assert.equal(longer.workers[ids[1]!]?.status, 'finished');
    assert.deepEqual(first, snapshot);
  });

  it('refuses a worker event before the run exists', () => {
    assert.throws(() => foldRun([event(1, 'worker.launched', launch(workerA))]), /before its creation/);
  });

  it('refuses payloads the worker schemas reject', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['worker.launched', launch('not-a-uuid')],
      ['worker.launched', launch(workerA, { effort: 'extreme' })],
      ['worker.launched', launch(workerA, { access: 'owned-edit' })],
      ['worker.launched', launch(workerA, { sessionId: '-x' })],
      ['worker.launched', launch(workerA, { budgetUsd: 0 })],
      ['worker.launched', launch(workerA, { tools: ['Read'] })],
      ['worker.finished', finish(workerA, { outcome: 'denied' })],
      ['worker.finished', finish(workerA, { termination: 'lost' })],
      ['worker.finished', finish(workerA, { startedAt: 'yesterday' })],
      ['worker.finished', finish(workerA, { usage: { input_tokens: 1 } })],
      ['worker.finished', finish(workerA, { denials: [{ tool: '', detail: null }] })],
      ['worker.finished', finish(workerA, { error: '' })],
      ['worker.launched', launch(workerA, { resumes: '99999999-2222-4333-8444-555555555555' })],
      ['worker.launched', launch(workerA, { resumes: '11111111-2222-4333-8444-555555555555', sessionId: null })],
      ['worker.finished', finish(workerA, { output: null })],
      ['worker.finished', finish(workerA, { outcome: 'failed', error: 'no', output: reference('e') })],
      ['worker.finished', finish(workerA, { outcome: 'budget', output: reference('e') })],
      ['worker.finished', finish(workerA, { outcome: 'timeout', termination: 'killed', output: reference('e') })],
    ];
    for (const [kind, payload] of cases) {
      const events = kind === 'worker.finished' ? [created(), event(2, 'worker.launched', launch(workerA)), event(3, kind, payload)] : [created(), event(2, kind, payload)];
      assert.throws(() => foldRun(events), InvalidHistoryError, JSON.stringify(payload));
    }
  });
});

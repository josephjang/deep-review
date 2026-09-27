import type { z } from 'zod';
import { InvalidHistoryError, UnknownEventError } from './errors.ts';
import {
  eventRegistry,
  type EventRegistry,
  type ScopeState,
  type WorkerFinish,
  type WorkerLaunch,
  type runAbandonedV1,
  type runCreatedV1,
  type scopeCapturedV1,
  type workerFinishedV1,
  type workerLaunchedV1,
  type workerLostV1,
} from './events.ts';
import { lookupEvent, registryKeys, type Registry, type RegistryKey } from './registry.ts';
import { reviewReducers, unitOfLostWorker, withFailure, type ReviewState } from './review-fold.ts';
import { unitName } from '../review/vocabulary.ts';

/** An event as the fold sees it: the ledger row with its payload parsed. */
export interface DecodedEvent {
  readonly sequence: number;
  readonly runId: string;
  readonly kind: string;
  readonly version: number;
  readonly payload: unknown;
  readonly recordedAt: string;
  readonly engine: string;
}

/**
 * One worker as the ledger knows it: launched and not yet finished,
 * launched and finished with its receipt, or launched and lost with the
 * engine that ran it, so that nothing observed how its process ended.
 * `launchedAt` is when the launch was recorded, before the process existed.
 */
export type WorkerState =
  | { readonly status: 'running'; readonly launch: WorkerLaunch; readonly launchedAt: string }
  | { readonly status: 'finished'; readonly launch: WorkerLaunch; readonly launchedAt: string; readonly finish: WorkerFinish }
  | { readonly status: 'lost'; readonly launch: WorkerLaunch; readonly launchedAt: string; readonly reason: string };

/** What the run's events say about it. */
export interface RunState {
  readonly id: string;
  readonly worktree: string;
  readonly createdAt: string;
  /** Engine version that created the run. */
  readonly engine: string;
  readonly status: 'active' | 'abandoned';
  readonly abandonReason: string | null;
  /** The captured change, or null until `scope.captured` is folded. */
  readonly scope: ScopeState | null;
  /** Every worker launched in the run, by worker id. Empty for a run no worker has touched, including every run recorded before workers existed. */
  readonly workers: Readonly<Record<string, WorkerState>>;
  /** The read-only review's state, or null until `review.configured` is folded, including every run recorded before reviews existed. */
  readonly review: ReviewState | null;
  /** Sequence of the last event folded; what a writer hands back to `append`. */
  readonly lastSequence: number;
}

/**
 * The records one fold has made and nobody outside it has seen yet. A reducer
 * asks it for a record it may write to: the record itself when this fold made
 * it, or a copy that this fold then owns. A fold over many worker events so
 * copies the workers once rather than once per event, and a state handed in
 * from outside the fold is never written to. The fold drops it when it
 * returns, so nothing writes to a returned state afterwards.
 */
export class FoldDrafts {
  readonly #owned = new WeakSet<object>();

  /** `record` itself when this fold made it, otherwise a shallow copy this fold now owns. */
  writable<K extends string, V>(record: Readonly<Record<K, V>>): Record<K, V> {
    if (this.#owned.has(record)) return record as Record<K, V>;
    const copy: Record<K, V> = { ...record };
    this.#owned.add(copy);
    return copy;
  }
}

/**
 * Turns one event into the next state. A reducer never writes to `state` or
 * anything it holds, except a record `drafts` hands back as writable.
 */
export type Reducer<P> = (state: RunState | undefined, payload: P, event: DecodedEvent, drafts: FoldDrafts) => RunState;

/**
 * A registry and one reducer per `kind@version` it declares. The two are
 * defined together so a kind cannot be declared without being understood.
 */
export interface RunModel {
  readonly registry: Registry;
  readonly reducers: Readonly<Record<string, Reducer<never>>>;
}

/** Build a model, refusing one whose reducers and registry do not cover each other exactly. */
export function defineModel<R extends Registry>(registry: R, reducers: Record<RegistryKey<R>, Reducer<never>>): RunModel {
  const declared = registryKeys(registry);
  const reduced = Object.keys(reducers).sort();
  if (declared.join('\n') !== reduced.join('\n')) {
    throw new Error(`Reducers and registry disagree: registry has [${declared.join(', ')}], reducers have [${reduced.join(', ')}]`);
  }
  return { registry, reducers };
}

const created: Reducer<z.infer<typeof runCreatedV1>> = (state, payload, event) => {
  if (state !== undefined) throw new InvalidHistoryError(`Run ${event.runId} is created twice, at sequence ${String(event.sequence)}`);
  return {
    id: event.runId,
    worktree: payload.worktree,
    createdAt: event.recordedAt,
    engine: event.engine,
    status: 'active',
    abandonReason: null,
    scope: null,
    workers: {},
    review: null,
    lastSequence: event.sequence,
  };
};

const scopeCaptured: Reducer<z.infer<typeof scopeCapturedV1>> = (state, payload, event) => {
  const current = requireState(state, event);
  if (current.scope !== null) throw new InvalidHistoryError(`Run ${event.runId} captures its scope twice, at sequence ${String(event.sequence)}`);
  return { ...current, scope: payload, lastSequence: event.sequence };
};

const workerLaunched: Reducer<z.infer<typeof workerLaunchedV1>> = (state, payload, event, drafts) => {
  const current = requireState(state, event);
  if (Object.hasOwn(current.workers, payload.workerId)) {
    throw new InvalidHistoryError(`Run ${event.runId} launches worker ${payload.workerId} twice, at sequence ${String(event.sequence)}`);
  }
  const workers = drafts.writable(current.workers);
  workers[payload.workerId] = { status: 'running', launch: payload, launchedAt: event.recordedAt };
  return { ...current, workers, lastSequence: event.sequence };
};

const workerFinished: Reducer<z.infer<typeof workerFinishedV1>> = (state, payload, event, drafts) => {
  const current = requireState(state, event);
  const worker = Object.hasOwn(current.workers, payload.workerId) ? current.workers[payload.workerId] : undefined;
  if (worker === undefined) throw new InvalidHistoryError(`Run ${event.runId} finishes worker ${payload.workerId} at sequence ${String(event.sequence)} without launching it`);
  if (worker.status === 'finished') throw new InvalidHistoryError(`Run ${event.runId} finishes worker ${payload.workerId} twice, at sequence ${String(event.sequence)}`);
  if (worker.status === 'lost') throw new InvalidHistoryError(`Run ${event.runId} finishes worker ${payload.workerId} at sequence ${String(event.sequence)} after it was lost`);
  const workers = drafts.writable(current.workers);
  workers[payload.workerId] = { status: 'finished', launch: worker.launch, launchedAt: worker.launchedAt, finish: payload };
  return { ...current, workers, lastSequence: event.sequence };
};

/**
 * A running worker whose engine stopped is lost: its state says so, and when
 * its launch label named a review unit, that unit counts one more failed
 * attempt (TD5 of the read-only review).
 */
const workerLost: Reducer<z.infer<typeof workerLostV1>> = (state, payload, event, drafts) => {
  const current = requireState(state, event);
  const worker = Object.hasOwn(current.workers, payload.workerId) ? current.workers[payload.workerId] : undefined;
  if (worker === undefined) throw new InvalidHistoryError(`Run ${event.runId} loses worker ${payload.workerId} at sequence ${String(event.sequence)} without launching it`);
  if (worker.status !== 'running') throw new InvalidHistoryError(`Run ${event.runId} loses worker ${payload.workerId} at sequence ${String(event.sequence)} after it ${worker.status === 'lost' ? 'was lost' : 'finished'}`);
  const workers = drafts.writable(current.workers);
  workers[payload.workerId] = { status: 'lost', launch: worker.launch, launchedAt: worker.launchedAt, reason: payload.reason };
  const unit = unitOfLostWorker(payload.phase, payload.key);
  if (unit !== null && current.review === null) throw new InvalidHistoryError(`Run ${event.runId} loses worker ${payload.workerId} of unit ${unitName(unit.phase, unit.key)} at sequence ${String(event.sequence)} before review.configured`);
  const review = unit === null || current.review === null ? current.review : withFailure(current.review, drafts, unit, payload.workerId, payload.reason);
  return { ...current, workers, review, lastSequence: event.sequence };
};

const abandoned: Reducer<z.infer<typeof runAbandonedV1>> = (state, payload, event) => {
  const current = requireState(state, event);
  return { ...current, status: 'abandoned', abandonReason: payload.reason, lastSequence: event.sequence };
};

/** The engine's reducers. `satisfies` makes a registered kind without a reducer a type error; `defineModel` checks it again at load. */
export const reducers = {
  'run.created@1': created,
  'run.abandoned@1': abandoned,
  'scope.captured@1': scopeCaptured,
  'worker.launched@1': workerLaunched,
  'worker.finished@1': workerFinished,
  'worker.lost@1': workerLost,
  ...reviewReducers,
} satisfies Record<RegistryKey<EventRegistry>, Reducer<never>>;

/** The engine's own model: its registry with its reducers. */
export const runModel: RunModel = defineModel(eventRegistry, reducers);

/** Fold a run's events, in ledger order, into its state. Pure: the same events give the same state. */
export function foldRun(events: readonly DecodedEvent[], model: RunModel = runModel): RunState {
  // One set of drafts for the whole fold: its intermediate states are never seen outside it, so each record is copied once.
  const drafts = new FoldDrafts();
  let state: RunState | undefined;
  for (const event of events) {
    if (state !== undefined && state.status !== 'active') {
      throw new InvalidHistoryError(`Run ${event.runId} was ${state.status} at sequence ${String(state.lastSequence)} but has an event at ${String(event.sequence)}`);
    }
    state = applyEvent(state, event, model, drafts);
  }
  if (state === undefined) throw new InvalidHistoryError('A run needs at least its creation event');
  return state;
}

/**
 * Apply one event, validating its payload against the model's registry.
 * `state` is left as it was; `drafts` is for `foldRun`, and a caller applying
 * one event to a state it holds leaves it out.
 */
export function applyEvent(state: RunState | undefined, event: DecodedEvent, model: RunModel = runModel, drafts: FoldDrafts = new FoldDrafts()): RunState {
  const key = `${event.kind}@${String(event.version)}`;
  const definition = lookupEvent(model.registry, event.kind, event.version);
  const reduce = model.reducers[key] as Reducer<unknown> | undefined;
  if (definition === undefined || reduce === undefined) throw new UnknownEventError(event.kind, event.version);
  const parsed = definition.schema.safeParse(event.payload);
  if (!parsed.success) throw new InvalidHistoryError(`Event ${String(event.sequence)} (${key}) has a payload its schema rejects: ${parsed.error.message}`);
  return reduce(state, parsed.data, event, drafts);
}

/** For reducers of every kind but creation: the run must already exist. */
export function requireState(state: RunState | undefined, event: DecodedEvent): RunState {
  if (state === undefined) throw new InvalidHistoryError(`Run ${event.runId} has ${event.kind} at sequence ${String(event.sequence)} before its creation`);
  return state;
}

import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { collectArtifactReferences } from '../evidence/references.ts';
import { EvidenceStore } from '../evidence/store.ts';
import { InvalidPayloadError, RunClosedError, StaleRevisionError, UnknownEventError, UnknownRunError, UnreadableRunError, type UnknownEvent } from './errors.ts';
import { applyEvent, firstUnknownEvent, foldRun, runModel, type DecodedEvent, type RunModel, type RunState } from './fold.ts';
import { Ledger, type EventRow, type LedgerOptions } from './ledger.ts';
import { lookupEvent } from './registry.ts';

/** The directory under the checkpoint root that holds evidence blobs. */
export const evidenceDirectoryName = 'artifacts';

/** An event a caller wants appended: kind, version and a payload the registry will validate. */
export interface NewEvent {
  readonly kind: string;
  readonly version: number;
  readonly payload: unknown;
}

/** A run holding an event this engine does not declare: listed by id, never folded. */
export interface UnreadableRun {
  readonly id: string;
  /** The run's first event this engine does not declare, and the engine that wrote it. */
  readonly unreadable: UnknownEvent;
}

/** A run as `listRuns` gives it: folded, or unreadable to this engine. */
export type ListedRun = RunState | UnreadableRun;

/** Whether a listed run is one this engine cannot read. */
export const isUnreadable = (run: ListedRun): run is UnreadableRun => 'unreadable' in run;

export interface CheckpointOptions extends LedgerOptions {
  /** Version of the engine writing, recorded on every event. */
  readonly engine: string;
  /** Overrides the registry and reducers; tests use it to add kinds. Defaults to the engine's model. */
  readonly model?: RunModel;
  /** UTC ISO timestamp source; injectable for deterministic fixtures. */
  readonly clock?: () => string;
  /** Run id source; injectable for deterministic fixtures. */
  readonly ids?: () => string;
}

/**
 * The checkpoint: a ledger, an evidence store and the registry that says
 * which events are legal. Every state question is a fold over the ledger,
 * and every mutation is an append that names the sequence it folded up to.
 */
export class Checkpoint {
  readonly root: string;
  readonly ledger: Ledger;
  readonly evidence: EvidenceStore;
  readonly engine: string;
  readonly #model: RunModel;
  readonly #clock: () => string;
  readonly #ids: () => string;

  private constructor(root: string, ledger: Ledger, evidence: EvidenceStore, options: CheckpointOptions) {
    this.root = root;
    this.ledger = ledger;
    this.evidence = evidence;
    this.engine = options.engine;
    this.#model = options.model ?? runModel;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#ids = options.ids ?? randomUUID;
  }

  static open(root: string, options: CheckpointOptions): Checkpoint {
    const directory = resolve(root);
    const ledger = Ledger.open(directory, options);
    try {
      const evidence = new EvidenceStore(join(directory, evidenceDirectoryName));
      return new Checkpoint(directory, ledger, evidence, options);
    } catch (error) {
      ledger.close();
      throw error;
    }
  }

  close(): void {
    this.ledger.close();
  }

  /** Create a run with its `run.created` event in one transaction and return its state. */
  createRun(payload: { worktree: string }): RunState {
    const id = this.#ids();
    const row = this.#row(id, { kind: 'run.created', version: 1, payload });
    return this.ledger.write((tx) => {
      tx.createRun({ id, createdAt: row.recordedAt });
      const sequence = tx.insertEvent(row);
      return foldRun([decode({ ...row, sequence })], this.#model);
    });
  }

  /** The run's state from every event it has; a run holding an event this engine does not declare is refused by `UnreadableRunError`. */
  fold(runId: string): RunState {
    if (!this.ledger.hasRun(runId)) throw new UnknownRunError(runId);
    return this.#readable(runId, this.ledger.events(runId).map(decode));
  }

  /**
   * Every run of the ledger, in ledger order: its state, or an unreadable
   * entry for a run holding an event this engine does not declare. It
   * never throws for such a run, which another engine build may have
   * written into this shared ledger; any other failure to fold still
   * throws. A command that picks a run reads this and passes the
   * unreadable ones over.
   */
  listRuns(): ListedRun[] {
    return this.ledger.listRuns().map((run): ListedRun => {
      const events = this.ledger.events(run.id).map(decode);
      const unknown = firstUnknownEvent(events, this.#model);
      return unknown === null ? foldRun(events, this.#model) : { id: run.id, unreadable: unknown };
    });
  }

  /** Every run's state, in ledger order, refusing the first run this engine cannot read with `UnreadableRunError`; for callers that need every run, where `listRuns` is for a command that picks one. */
  foldRuns(): RunState[] {
    return this.ledger.listRuns().map((run) => this.fold(run.id));
  }

  /**
   * Append events to a run the caller folded up to `expectedLastSequence`.
   * Payloads are validated and their evidence verified before the write
   * lock is taken; the sequence check, the closed-run check and the history
   * check happen inside the transaction, so nothing is written unless all
   * of them hold. Returns the state after the append.
   */
  append(runId: string, expectedLastSequence: number, events: readonly NewEvent[]): RunState {
    if (events.length === 0) throw new InvalidPayloadError('Nothing to append');
    const rows = events.map((event) => this.#row(runId, event));
    return this.ledger.write((tx) => {
      if (!tx.hasRun(runId)) throw new UnknownRunError(runId);
      const actual = tx.lastSequence(runId);
      if (actual !== expectedLastSequence) throw new StaleRevisionError(runId, expectedLastSequence, actual);
      let state = this.#readable(runId, tx.events(runId).map(decode));
      if (state.status !== 'active') throw new RunClosedError(`Run ${runId} is ${state.status} and accepts no events`);
      for (const row of rows) {
        const sequence = tx.insertEvent(row);
        state = applyEvent(state, decode({ ...row, sequence }), this.#model);
        if (state.status !== 'active' && row !== rows.at(-1)) throw new RunClosedError(`Run ${runId} is closed by ${row.kind} before the last event appended`);
      }
      return state;
    });
  }

  /** Fold a run's events, refusing a run holding an event this engine does not declare by the engine that wrote it. */
  #readable(runId: string, events: readonly DecodedEvent[]): RunState {
    const unknown = firstUnknownEvent(events, this.#model);
    if (unknown !== null) throw new UnreadableRunError(runId, unknown, this.engine);
    return foldRun(events, this.#model);
  }

  /** Validate one event against the registry and its evidence against the store, and shape its ledger row. */
  #row(runId: string, event: NewEvent): Omit<EventRow, 'sequence'> {
    const definition = lookupEvent(this.#model.registry, event.kind, event.version);
    if (definition === undefined) throw new UnknownEventError(event.kind, event.version);
    const parsed = definition.schema.safeParse(event.payload);
    if (!parsed.success) throw new InvalidPayloadError(`${event.kind}@${String(event.version)}: ${parsed.error.message}`);
    for (const reference of collectArtifactReferences(parsed.data)) this.evidence.verify(reference);
    return { runId, kind: event.kind, version: event.version, payload: JSON.stringify(parsed.data), recordedAt: this.#clock(), engine: this.engine };
  }
}

function decode(row: EventRow): DecodedEvent {
  return { ...row, payload: JSON.parse(row.payload) as unknown };
}

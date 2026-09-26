import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UnsupportedSchemaError } from './errors.ts';

export const ledgerFileName = 'ledger.sqlite';

/** Milliseconds a statement waits for another process's lock before failing. */
export const busyTimeoutMs = 5000;

/**
 * The events table is the ledger. Nothing updates or deletes a row: the
 * triggers make that a database error, not a convention. A wrong event is
 * corrected by a later event that says so.
 */
export const ledgerDdl = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  engine TEXT NOT NULL
) STRICT;
CREATE INDEX events_by_run ON events(run_id, sequence);
CREATE TRIGGER events_are_append_only_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_are_append_only_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER runs_are_permanent_delete BEFORE DELETE ON runs
  BEGIN SELECT RAISE(ABORT, 'runs are permanent'); END;
`;

/** One forward step of the schema, applied inside the migration transaction. */
export interface Migration {
  readonly from: number;
  readonly to: number;
  apply(db: DatabaseSync): void;
}

export interface SchemaDefinition {
  /** The `user_version` a fresh ledger is created at and a migrated ledger ends at. */
  readonly version: number;
  /** Statements that create a fresh ledger at `version`. */
  readonly ddl: string;
  /** Steps from every older version, in ascending order, each ending where the next begins. */
  readonly migrations: readonly Migration[];
}

/** The schema this engine writes. Migrations arrive with the first schema change. */
export const currentSchema: SchemaDefinition = { version: 1, ddl: ledgerDdl, migrations: [] };

export interface EventRow {
  readonly sequence: number;
  readonly runId: string;
  readonly kind: string;
  readonly version: number;
  /** JSON text exactly as stored. */
  readonly payload: string;
  readonly recordedAt: string;
  readonly engine: string;
}

export interface RunRow {
  readonly id: string;
  readonly createdAt: string;
}

export type NewEventRow = Omit<EventRow, 'sequence'>;

/** What a write transaction can do. Every method runs inside the same BEGIN IMMEDIATE. */
export interface LedgerWriter {
  hasRun(runId: string): boolean;
  lastSequence(runId: string): number;
  events(runId: string, afterSequence?: number): EventRow[];
  createRun(run: RunRow): void;
  /** Append one row and return the sequence the ledger assigned it. */
  insertEvent(row: NewEventRow): number;
}

export interface LedgerOptions {
  /** Overrides the schema; tests use it to exercise migration and refusal. */
  readonly schema?: SchemaDefinition;
}

const backupName = (path: string, from: number): string =>
  `${path}.backup-schema-${String(from)}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;

/**
 * The SQLite file that holds runs and their events. Opening an established
 * ledger takes no write lock, so a reader never competes with a working
 * controller; only creation and migration write.
 */
export class Ledger {
  readonly path: string;
  readonly schemaVersion: number;
  readonly #db: DatabaseSync;
  #inWrite = false;

  private constructor(path: string, db: DatabaseSync, schemaVersion: number) {
    this.path = path;
    this.#db = db;
    this.schemaVersion = schemaVersion;
  }

  static open(root: string, options: LedgerOptions = {}): Ledger {
    const schema = options.schema ?? currentSchema;
    const directory = resolve(root);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, ledgerFileName);
    const db = new DatabaseSync(path, { timeout: busyTimeoutMs });
    try {
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('PRAGMA synchronous=FULL');
      db.exec('PRAGMA foreign_keys=ON');
      const found = userVersion(db);
      if (found > schema.version) throw new UnsupportedSchemaError(found, schema.version);
      if (found === 0) initialize(db, schema);
      else if (found < schema.version) migrate(db, path, found, schema);
      return new Ledger(path, db, userVersion(db));
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  listRuns(): RunRow[] {
    return (this.#db.prepare('SELECT id, created_at AS createdAt FROM runs ORDER BY rowid').all() as unknown[]).map(asRunRow);
  }

  hasRun(runId: string): boolean {
    return this.#db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId) !== undefined;
  }

  /** The highest sequence of the run's events, or 0 for a run with none (which a valid history never has). */
  lastSequence(runId: string): number {
    const row = this.#db.prepare('SELECT COALESCE(MAX(sequence), 0) AS last FROM events WHERE run_id = ?').get(runId) as { last: number };
    return row.last;
  }

  /** The run's events after `afterSequence`, in ledger order. One statement, so one WAL snapshot. */
  events(runId: string, afterSequence = 0): EventRow[] {
    const rows = this.#db
      .prepare(
        'SELECT sequence, run_id AS runId, kind, version, payload, recorded_at AS recordedAt, engine FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence',
      )
      .all(runId, afterSequence) as unknown[];
    return rows.map(asEventRow);
  }

  /**
   * Run `work` inside one BEGIN IMMEDIATE transaction. The lock is taken up
   * front, so everything `work` reads is what it will still be at commit.
   * A throw rolls everything back and is rethrown.
   */
  write<T>(work: (tx: LedgerWriter) => T): T {
    if (this.#inWrite) throw new Error('Ledger writes do not nest');
    this.#inWrite = true;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work(this.#writer());
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#inWrite = false;
    }
  }

  #writer(): LedgerWriter {
    const insertRun = this.#db.prepare('INSERT INTO runs (id, created_at) VALUES (?, ?)');
    const insertEvent = this.#db.prepare(
      'INSERT INTO events (run_id, kind, version, payload, recorded_at, engine) VALUES (?, ?, ?, ?, ?, ?) RETURNING sequence',
    );
    return {
      hasRun: (runId) => this.hasRun(runId),
      lastSequence: (runId) => this.lastSequence(runId),
      events: (runId, afterSequence) => this.events(runId, afterSequence),
      createRun: (run) => {
        insertRun.run(run.id, run.createdAt);
      },
      insertEvent: (row) => {
        const inserted = insertEvent.get(row.runId, row.kind, row.version, row.payload, row.recordedAt, row.engine) as { sequence: number };
        return inserted.sequence;
      },
    };
  }
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** Create the tables of a fresh ledger, unless another process did so between our read and our lock. */
function initialize(db: DatabaseSync, schema: SchemaDefinition): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const found = userVersion(db);
    if (found > schema.version) throw new UnsupportedSchemaError(found, schema.version);
    if (found === 0) {
      db.exec(schema.ddl);
      db.exec(`PRAGMA user_version = ${String(schema.version)}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Bring an older ledger forward. A consistent backup is taken first with
 * VACUUM INTO, then every step runs inside one transaction, so a failing
 * step leaves the ledger at its old version with the backup beside it.
 */
function migrate(db: DatabaseSync, path: string, from: number, schema: SchemaDefinition): void {
  const steps = planMigration(from, schema);
  db.prepare('VACUUM INTO ?').run(backupName(path, from));
  db.exec('BEGIN IMMEDIATE');
  let open = true;
  try {
    const found = userVersion(db);
    if (found !== from) {
      // Another process moved the schema between our read and our lock.
      db.exec('ROLLBACK');
      open = false;
      if (found > schema.version) throw new UnsupportedSchemaError(found, schema.version);
      if (found < schema.version) migrate(db, path, found, schema);
      return;
    }
    for (const step of steps) step.apply(db);
    db.exec(`PRAGMA user_version = ${String(schema.version)}`);
    db.exec('COMMIT');
    open = false;
  } finally {
    if (open) db.exec('ROLLBACK');
  }
}

/** The migration steps that lead from `from` to the schema version, or an error naming the gap. */
export function planMigration(from: number, schema: SchemaDefinition): Migration[] {
  const steps: Migration[] = [];
  let at = from;
  while (at < schema.version) {
    const step = schema.migrations.find((candidate) => candidate.from === at);
    if (step === undefined) throw new Error(`No migration from ledger schema ${String(at)} toward ${String(schema.version)}`);
    if (step.to <= at) throw new Error(`Migration from ${String(step.from)} to ${String(step.to)} does not move forward`);
    steps.push(step);
    at = step.to;
  }
  return steps;
}

function asRunRow(row: unknown): RunRow {
  const { id, createdAt } = row as { id: string; createdAt: string };
  return { id, createdAt };
}

function asEventRow(row: unknown): EventRow {
  const { sequence, runId, kind, version, payload, recordedAt, engine } = row as EventRow;
  return { sequence, runId, kind, version, payload, recordedAt, engine };
}

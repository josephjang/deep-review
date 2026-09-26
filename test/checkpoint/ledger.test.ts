import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { UnsupportedSchemaError } from '../../src/checkpoint/errors.ts';
import { Ledger, currentSchema, ledgerDdl, ledgerFileName, planMigration, type NewEventRow, type SchemaDefinition } from '../../src/checkpoint/ledger.ts';

const pragma = (path: string, name: string): unknown => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
  } finally {
    db.close();
  }
};

const row = (runId: string, kind = 'run.created', payload = '{}'): NewEventRow => ({
  runId,
  kind,
  version: 1,
  payload,
  recordedAt: '2026-09-26T00:00:00.000Z',
  engine: '0.0.0',
});

/** Schema 2 adds a column through one migration; used to exercise the forward path. */
const schemaTwo: SchemaDefinition = {
  version: 2,
  ddl: `${ledgerDdl}\nALTER TABLE runs ADD COLUMN note TEXT;`,
  migrations: [{ from: 1, to: 2, apply: (db) => db.exec('ALTER TABLE runs ADD COLUMN note TEXT') }],
};

describe('Ledger', () => {
  let root: string;
  let path: string;
  const opened: Ledger[] = [];
  const open = (options?: { schema?: SchemaDefinition }): Ledger => {
    const ledger = Ledger.open(root, options);
    opened.push(ledger);
    return ledger;
  };
  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'deep-review-ledger-')), 'checkpoint');
    path = join(root, ledgerFileName);
  });
  afterEach(() => {
    for (const ledger of opened.splice(0)) ledger.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('creates the directory and the file with WAL, full sync, foreign keys and schema 1', () => {
    const ledger = open();
    assert.equal(ledger.path, path);
    assert.equal(ledger.schemaVersion, currentSchema.version);
    assert.equal(existsSync(path), true);
    ledger.close();
    opened.splice(0);
    assert.equal(pragma(path, 'journal_mode'), 'wal');
    assert.equal(pragma(path, 'user_version'), 1);
    assert.equal(pragma(path, 'synchronous'), 2, 'FULL');
  });

  it('starts empty and answers zero for a run with no events', () => {
    const ledger = open();
    assert.deepEqual(ledger.listRuns(), []);
    assert.equal(ledger.hasRun('absent'), false);
    assert.equal(ledger.lastSequence('absent'), 0);
    assert.deepEqual(ledger.events('absent'), []);
  });

  it('commits a write as one unit and hands back ledger-assigned sequences', () => {
    const ledger = open();
    const sequences = ledger.write((tx) => {
      tx.createRun({ id: 'run-a', createdAt: '2026-09-26T00:00:00.000Z' });
      return [tx.insertEvent(row('run-a')), tx.insertEvent(row('run-a', 'run.abandoned', '{"reason":"x"}'))];
    });
    assert.deepEqual(sequences, [1, 2]);
    assert.deepEqual(ledger.listRuns(), [{ id: 'run-a', createdAt: '2026-09-26T00:00:00.000Z' }]);
    assert.equal(ledger.lastSequence('run-a'), 2);
    const events = ledger.events('run-a');
    assert.deepEqual(events.map((event) => [event.sequence, event.kind, event.payload]), [[1, 'run.created', '{}'], [2, 'run.abandoned', '{"reason":"x"}']]);
    assert.deepEqual(ledger.events('run-a', 1).map((event) => event.sequence), [2]);
    assert.deepEqual(ledger.events('run-a', 2), []);
  });

  it('rolls back everything a write did when it throws', () => {
    const ledger = open();
    assert.throws(
      () =>
        ledger.write((tx) => {
          tx.createRun({ id: 'run-b', createdAt: 'now' });
          tx.insertEvent(row('run-b'));
          throw new Error('abort');
        }),
      /abort/,
    );
    assert.equal(ledger.hasRun('run-b'), false);
    assert.equal(ledger.lastSequence('run-b'), 0);
    // The connection is usable again after the rollback.
    ledger.write((tx) => tx.createRun({ id: 'run-c', createdAt: 'now' }));
    assert.equal(ledger.hasRun('run-c'), true);
  });

  it('keeps sequences global across runs and never reuses one', () => {
    const ledger = open();
    ledger.write((tx) => {
      tx.createRun({ id: 'one', createdAt: 'now' });
      tx.createRun({ id: 'two', createdAt: 'now' });
      tx.insertEvent(row('one'));
      tx.insertEvent(row('two'));
      tx.insertEvent(row('one'));
    });
    assert.deepEqual(ledger.events('one').map((event) => event.sequence), [1, 3]);
    assert.deepEqual(ledger.events('two').map((event) => event.sequence), [2]);
  });

  it('refuses an event for a run that does not exist', () => {
    const ledger = open();
    assert.throws(() => ledger.write((tx) => tx.insertEvent(row('ghost'))), /FOREIGN KEY/);
    assert.equal(ledger.lastSequence('ghost'), 0);
  });

  it('refuses a duplicate run id', () => {
    const ledger = open();
    ledger.write((tx) => tx.createRun({ id: 'dup', createdAt: 'now' }));
    assert.throws(() => ledger.write((tx) => tx.createRun({ id: 'dup', createdAt: 'later' })), /UNIQUE/);
  });

  it('does not nest writes', () => {
    const ledger = open();
    assert.throws(() => ledger.write(() => ledger.write(() => undefined)), /do not nest/);
    ledger.write((tx) => tx.createRun({ id: 'after', createdAt: 'now' }));
  });

  it('makes updates and deletes of events, and deletes of runs, database errors', () => {
    const ledger = open();
    ledger.write((tx) => {
      tx.createRun({ id: 'fixed', createdAt: 'now' });
      tx.insertEvent(row('fixed'));
    });
    ledger.close();
    opened.splice(0);
    const db = new DatabaseSync(path);
    try {
      assert.throws(() => db.exec("UPDATE events SET kind = 'rewritten'"), /append-only/);
      assert.throws(() => db.exec('DELETE FROM events'), /append-only/);
      assert.throws(() => db.exec('DELETE FROM runs'), /permanent/);
      assert.equal((db.prepare('SELECT kind FROM events').get() as { kind: string }).kind, 'run.created');
    } finally {
      db.close();
    }
  });

  it('opens an established ledger while another connection holds the write lock', () => {
    open().close();
    opened.splice(0);
    const holder = new DatabaseSync(path);
    try {
      holder.exec('BEGIN IMMEDIATE');
      holder.exec("INSERT INTO runs (id, created_at) VALUES ('held', 'now')");
      const started = Date.now();
      const reader = open();
      assert.ok(Date.now() - started < 1000, 'opening did not wait on the lock');
      assert.deepEqual(reader.listRuns(), [], 'uncommitted work is invisible');
      holder.exec('COMMIT');
      assert.equal(reader.hasRun('held'), true);
    } finally {
      holder.close();
    }
  });

  it('refuses a ledger written by a newer schema, naming both versions', () => {
    open({ schema: schemaTwo }).close();
    opened.splice(0);
    assert.throws(() => open(), (error: unknown) => error instanceof UnsupportedSchemaError && error.found === 2 && error.supported === 1);
    assert.equal(pragma(path, 'user_version'), 2, 'the refusal changed nothing');
  });

  it('migrates an older ledger forward after taking a backup', () => {
    const first = open();
    first.write((tx) => tx.createRun({ id: 'old', createdAt: 'then' }));
    first.close();
    opened.splice(0);
    const migrated = open({ schema: schemaTwo });
    assert.equal(migrated.schemaVersion, 2);
    assert.deepEqual(migrated.listRuns(), [{ id: 'old', createdAt: 'then' }]);
    migrated.close();
    opened.splice(0);
    const backups = readdirSync(root).filter((name) => name.startsWith(`${ledgerFileName}.backup-schema-1-`));
    assert.equal(backups.length, 1);
    assert.equal(pragma(join(root, backups[0]!), 'user_version'), 1, 'the backup is the pre-migration ledger');
    assert.equal(pragma(path, 'user_version'), 2);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.ok((db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).some((column) => column.name === 'note'));
    } finally {
      db.close();
    }
  });

  it('leaves the old version and the backup in place when a migration step fails', () => {
    open().close();
    opened.splice(0);
    const failing: SchemaDefinition = {
      ...schemaTwo,
      migrations: [{ from: 1, to: 2, apply: (db) => { db.exec('ALTER TABLE runs ADD COLUMN note TEXT'); throw new Error('step failed'); } }],
    };
    assert.throws(() => open({ schema: failing }), /step failed/);
    assert.equal(pragma(path, 'user_version'), 1);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.ok(!(db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).some((column) => column.name === 'note'), 'the partial step was rolled back');
    } finally {
      db.close();
    }
    assert.equal(readdirSync(root).filter((name) => name.includes('.backup-schema-1-')).length, 1);
    const reopened = open();
    assert.equal(reopened.schemaVersion, 1);
  });

  it('refuses to open when no migration leads from the ledger version', () => {
    open().close();
    opened.splice(0);
    const gap: SchemaDefinition = { ...schemaTwo, migrations: [] };
    assert.throws(() => open({ schema: gap }), /No migration from ledger schema 1/);
    assert.equal(pragma(path, 'user_version'), 1);
  });
});

describe('planMigration', () => {
  it('chains steps in order and stops at the target', () => {
    const schema: SchemaDefinition = {
      version: 3,
      ddl: '',
      migrations: [
        { from: 2, to: 3, apply: () => undefined },
        { from: 1, to: 2, apply: () => undefined },
      ],
    };
    assert.deepEqual(planMigration(1, schema).map((step) => [step.from, step.to]), [[1, 2], [2, 3]]);
    assert.deepEqual(planMigration(2, schema).map((step) => [step.from, step.to]), [[2, 3]]);
    assert.deepEqual(planMigration(3, schema), []);
  });

  it('rejects a gap and a step that does not move forward', () => {
    assert.throws(() => planMigration(1, { version: 3, ddl: '', migrations: [{ from: 1, to: 2, apply: () => undefined }] }), /No migration from ledger schema 2/);
    assert.throws(() => planMigration(1, { version: 2, ddl: '', migrations: [{ from: 1, to: 1, apply: () => undefined }] }), /does not move forward/);
  });
});

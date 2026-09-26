import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { EvidenceError } from '../../src/checkpoint/errors.ts';
import { EvidenceStore, artifactReferenceSchema, sha256Hex } from '../../src/evidence/store.ts';

const awkwardBytes = Buffer.from('line one\r\nline two\n\0é\n', 'utf8');
const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('EvidenceStore', () => {
  let root: string;
  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'deep-review-evidence-')), 'artifacts');
  });
  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

  it('creates its root and stores a blob under its sha256, readable byte for byte', () => {
    const store = new EvidenceStore(root);
    const reference = store.put(awkwardBytes);
    assert.equal(reference.sha256, sha256Hex(awkwardBytes));
    assert.equal(reference.bytes, awkwardBytes.length);
    assert.deepEqual(store.read(reference), awkwardBytes);
    assert.deepEqual(readdirSync(root), [reference.sha256], 'no temporary file survives a put');
  });

  it('stores a string as UTF-8 and the empty input as the empty blob', () => {
    const store = new EvidenceStore(root);
    assert.deepEqual(store.put('café'), { sha256: sha256Hex(Buffer.from('café', 'utf8')), bytes: 5 });
    const empty = store.put('');
    assert.deepEqual(empty, { sha256: emptySha, bytes: 0 });
    assert.equal(store.read(empty).length, 0);
  });

  it('stores identical content once and keeps the first file', () => {
    const store = new EvidenceStore(root);
    const first = store.put('same');
    const stamp = lstatSync(join(root, first.sha256)).mtimeMs;
    const second = store.put('same');
    assert.deepEqual(second, first);
    assert.deepEqual(readdirSync(root), [first.sha256]);
    assert.equal(lstatSync(join(root, first.sha256)).mtimeMs, stamp, 'the existing blob is not rewritten');
  });

  it('reports presence without throwing, and verifies on demand', () => {
    const store = new EvidenceStore(root);
    const reference = store.put('present');
    assert.equal(store.has(reference), true);
    assert.equal(store.has({ sha256: emptySha, bytes: 0 }), false);
    assert.doesNotThrow(() => store.verify(reference));
    assert.throws(() => store.verify({ sha256: emptySha, bytes: 0 }), EvidenceError);
  });

  it('refuses a reference that is not a reference', () => {
    const store = new EvidenceStore(root);
    assert.throws(() => store.read({ sha256: 'nope', bytes: 1 }));
    assert.throws(() => store.read({ sha256: emptySha, bytes: -1 }));
    assert.throws(() => artifactReferenceSchema.parse({ sha256: emptySha, bytes: 0, extra: true }));
  });

  it('detects a blob whose bytes were changed after publication', () => {
    const store = new EvidenceStore(root);
    const reference = store.put('original');
    writeFileSync(join(root, reference.sha256), 'origin4l');
    assert.throws(() => store.read(reference), /integrity failure/);
    assert.equal(store.has(reference), false);
    writeFileSync(join(root, reference.sha256), 'longer than before');
    assert.throws(() => store.read(reference), /size mismatch/);
  });

  it('refuses a blob path that is a directory or a symlink', (t) => {
    const store = new EvidenceStore(root);
    const reference = store.put('victim');
    const path = join(root, reference.sha256);
    rmSync(path);
    mkdirSync(path);
    assert.throws(() => store.read(reference), /not a regular file/);
    rmSync(path, { recursive: true });
    writeFileSync(join(root, 'elsewhere'), 'victim');
    try {
      symlinkSync(join(root, 'elsewhere'), path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks are not permitted here');
      throw error;
    }
    assert.throws(() => store.read(reference), /not a regular file/);
  });

  it('refuses a root that is a file', () => {
    writeFileSync(join(root, '..', 'file'), 'x');
    assert.throws(() => new EvidenceStore(join(root, '..', 'file')));
  });

  it('falls back to a rename where the filesystem has no hard links', () => {
    const noLinks = (): never => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    };
    const store = new EvidenceStore(root, { link: noLinks });
    const reference = store.put(awkwardBytes);
    assert.deepEqual(store.read(reference), awkwardBytes);
    assert.deepEqual(readdirSync(root), [reference.sha256]);
    assert.deepEqual(store.put(awkwardBytes), reference, 'a second put with rename fallback still keeps one blob');
  });

  it('treats a concurrent publish of the same content as success', () => {
    // The link step finds the blob already there: another process won the race with identical bytes.
    const racing = (temporary: string, destination: string): void => {
      renameSync(temporary, destination);
      throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
    };
    const store = new EvidenceStore(root, { link: racing });
    const reference = store.put('raced');
    assert.deepEqual(store.read(reference), Buffer.from('raced'));
    assert.deepEqual(readdirSync(root), [reference.sha256]);
  });

  it('leaves no temporary file and no blob when publication fails for another reason', () => {
    const broken = (): never => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    };
    const store = new EvidenceStore(root, { link: broken });
    assert.throws(() => store.put('doomed'), /EIO/);
    assert.deepEqual(readdirSync(root), []);
    assert.equal(existsSync(join(root, sha256Hex(Buffer.from('doomed')))), false);
  });
});

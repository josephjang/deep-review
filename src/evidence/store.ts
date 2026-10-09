import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { noHardLinks } from '../atomic-write.ts';
import { EvidenceError } from '../checkpoint/errors.ts';

/**
 * A reference to one blob in an evidence store: its SHA-256 and its length.
 * Event payloads carry references, never bytes, and the store verifies the
 * bytes against the reference on every read.
 */
export const artifactReferenceSchema = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
});
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** How a finished temporary file becomes the blob: a hard link by default, a rename where links are unsupported. */
export type Publish = (temporary: string, destination: string) => void;

export interface EvidenceStoreOptions {
  /** Overrides the hard-link step; tests use it to simulate a filesystem without links. */
  readonly link?: Publish;
}

/**
 * Content-addressed, immutable evidence beside the ledger. A blob lives at
 * `<root>/<sha256>` and is written to a temporary file, fsynced, then published
 * in one filesystem operation, so a reader never sees a partial blob under the
 * final name. An existing blob is never replaced: same content, same file.
 */
export class EvidenceStore {
  readonly root: string;
  readonly #link: Publish;

  constructor(root: string, options: EvidenceStoreOptions = {}) {
    this.root = resolve(root);
    this.#link = options.link ?? linkSync;
    mkdirSync(this.root, { recursive: true });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new EvidenceError(`Evidence root must be a real directory: ${this.root}`);
  }

  /** Store bytes and return the reference that names them. Storing the same bytes twice returns the same reference. */
  put(value: Uint8Array | string): ArtifactReference {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    const reference: ArtifactReference = { sha256: sha256Hex(bytes), bytes: bytes.length };
    const destination = this.#path(reference);
    if (existsSync(destination)) {
      this.verify(reference);
      return reference;
    }
    const temporary = join(this.root, `${randomUUID()}.pending`);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written === 0) throw new EvidenceError(`Write made no progress: ${temporary}`);
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      this.#publish(temporary, destination);
      this.verify(reference);
    } finally {
      // The link succeeded, the rename consumed it, or the publish failed: the temporary is never wanted.
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return reference;
  }

  /** Whether the blob exists and matches its reference. Never throws for an absent or corrupt blob. */
  has(value: ArtifactReference): boolean {
    try {
      this.verify(value);
      return true;
    } catch (error) {
      if (error instanceof EvidenceError) return false;
      throw error;
    }
  }

  /** Throw an EvidenceError unless the blob exists as a regular file with the reference's size and hash. */
  verify(value: ArtifactReference): void {
    const reference = artifactReferenceSchema.parse(value);
    const bytes = this.#readVerified(reference);
    if (bytes === undefined) throw new EvidenceError(`Evidence is missing: ${reference.sha256}`);
  }

  /** The blob's bytes, verified against the reference before they are returned. */
  read(value: ArtifactReference): Buffer {
    const reference = artifactReferenceSchema.parse(value);
    const bytes = this.#readVerified(reference);
    if (bytes === undefined) throw new EvidenceError(`Evidence is missing: ${reference.sha256}`);
    return bytes;
  }

  /**
   * The absolute path of the blob a reference names, verified to be there,
   * so a prompt can point a worker at frozen bytes rather than carry them
   * (R7 of the read-only review). The store is read-only to a worker; the
   * path is for reading.
   */
  pathOf(value: ArtifactReference): string {
    const reference = artifactReferenceSchema.parse(value);
    this.verify(reference);
    return this.#path(reference);
  }

  #path(reference: ArtifactReference): string {
    return join(this.root, reference.sha256);
  }

  /** `undefined` when the blob is absent; throws when it is present but wrong. */
  #readVerified(reference: ArtifactReference): Buffer | undefined {
    const path = this.#path(reference);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return undefined;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new EvidenceError(`Evidence is not a regular file: ${reference.sha256}`);
    if (stat.size !== reference.bytes) throw new EvidenceError(`Evidence size mismatch: ${reference.sha256}`);
    const bytes = readFileSync(path);
    if (bytes.length !== reference.bytes || sha256Hex(bytes) !== reference.sha256) {
      throw new EvidenceError(`Evidence integrity failure: ${reference.sha256}`);
    }
    return bytes;
  }

  #publish(temporary: string, destination: string): void {
    try {
      this.#link(temporary, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Another writer published the same content first; the bytes are identical by construction.
      if (code === 'EEXIST') return;
      if (code === undefined || !noHardLinks.has(code)) throw error;
    }
    // No hard links here. A rename is still one atomic operation, but it would
    // replace an existing blob, so the existence check restores that guarantee.
    if (existsSync(destination)) return;
    renameSync(temporary, destination);
  }
}

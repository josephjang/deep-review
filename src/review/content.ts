/**
 * A file's content as git would store it (R22, PD19, TD18 of the fix
 * pass). A worktree checked out with `core.autocrlf` holds CRLF where git
 * stores LF, and a formatter that writes LF changes every byte of such a
 * file while git sees no change. The run compares, and renders patches,
 * as git would: two states are the same when their bytes are, or when git
 * gives them one object id at that path; a patch diffs the bytes git would
 * store. Git is asked, never imitated, and each answer is cached for the
 * run by path and hash.
 */
import { sha256Hex, type ArtifactReference } from '../evidence/store.ts';
import * as gitApi from '../scope/git.ts';
import { gitBlobId } from './patch.ts';
import { matchesExpected, type ExpectedMatch } from './tree.ts';

/** How the run compares a file with what it expects, and the bytes a patch of it diffs. */
export interface GitContent {
  /** Whether what a path holds counts as what the run expects, as git would store each. */
  readonly match: ExpectedMatch;
  /** The bytes git would store for these bytes at `path`: the bytes themselves when its conversion leaves them as they are. */
  readonly stored: (path: string, bytes: Buffer) => Buffer;
}

/**
 * Git's view of content in `worktree`, reading frozen blobs through
 * `read`. Comparing asks git only when the raw bytes differ, and never for
 * a symlink, whose target text git stores as it is, nor for a file frozen
 * by hash and size, whose bytes were never kept. Reading the stored bytes
 * of a file the conversion changes writes its blob to the object store,
 * unreferenced, which is the only way to read them back (TD18).
 */
export function gitContent(worktree: string, read: (reference: ArtifactReference) => Buffer): GitContent {
  const ids = new Map<string, string>();
  const storedIdOf = (path: string, bytes: Buffer): string => {
    const key = `${path}\0${sha256Hex(bytes)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = gitApi.storedBlobId(worktree, path, bytes);
      ids.set(key, id);
    }
    return id;
  };
  let format: 'sha1' | 'sha256' | undefined;
  const match: ExpectedMatch = (path, expected, now) => {
    if (matchesExpected(expected, now)) return true;
    if (expected === undefined || expected === null || now === null) return false;
    if (expected.symlink || now.symlink || !('blob' in expected.frozen)) return false;
    return storedIdOf(path, read(expected.frozen.blob)) === storedIdOf(path, now.bytes);
  };
  const stored = (path: string, bytes: Buffer): Buffer => {
    format ??= gitApi.objectFormat(worktree);
    const id = storedIdOf(path, bytes);
    if (id === gitBlobId(bytes, format)) return bytes;
    return gitApi.blobRaw(worktree, gitApi.writeStoredBlob(worktree, path, bytes));
  };
  return { match, stored };
}

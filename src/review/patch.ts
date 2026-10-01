/**
 * A revision as a patch (R13, TD12 of the fix pass): the unified diff
 * between the expected tree before a revision and after it, rendered from
 * the frozen bytes alone, never from git, so each patch holds one change's
 * work and none of the user's own uncommitted change. Its headers are
 * git's, so `git apply` and `git am` read it: a text file as hunks, a file
 * that is not UTF-8 text as a literal binary patch with full object ids,
 * and a file frozen by hash and size only, whose bytes were never kept,
 * as a "Binary files differ" line that names it and does not apply.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { FrozenFile } from '../checkpoint/events.ts';
import type { ArtifactReference } from '../evidence/store.ts';
import type { ExpectedFile, ExpectedTree } from './tree.ts';

/** Reads a frozen blob's bytes. */
export type BlobReader = (reference: ArtifactReference) => Buffer;

/** The hash a repository names its objects with, which a binary patch's full index line must use. */
export type ObjectFormat = 'sha1' | 'sha256';

/** Lines of context around each change, as git's default. */
const contextLines = 3;

/**
 * The most differences the line diff searches before it gives up and
 * replaces the whole file in one hunk, which is still a correct patch:
 * the search's memory grows with the square of the differences.
 */
const maxDifferences = 2000;

/** A file's content as a patch needs it: its bytes, or null when it was frozen by hash and size only. */
interface Content {
  readonly bytes: Buffer | null;
  readonly symlink: boolean;
  readonly frozen: FrozenFile;
}

const contentOf = (file: ExpectedFile, read: BlobReader): Content => ({ bytes: 'blob' in file.frozen ? read(file.frozen.blob) : null, symlink: file.symlink, frozen: file.frozen });

/** The object id git gives a blob of these bytes. */
export function gitBlobId(bytes: Buffer, format: ObjectFormat): string {
  return createHash(format).update(`blob ${String(bytes.length)}\0`).update(bytes).digest('hex');
}

const nullId = (format: ObjectFormat): string => '0'.repeat(format === 'sha1' ? 40 : 64);

/** Whether bytes are text a diff can show: valid UTF-8 with no NUL. */
function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The lines of a text, each with its line feed (a carriage return before it stays in the line); the last may have none. */
const linesOf = (text: string): string[] => (text === '' ? [] : text.split(/(?<=\n)/));

type Operation = '=' | '-' | '+';

/**
 * The shortest edit script from `a` to `b` (Myers' algorithm), after the
 * common head and tail are set aside; null when it needs more than
 * `maxDifferences` insertions and deletions.
 */
function editScript(a: readonly string[], b: readonly string[]): Operation[] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const x0 = a.slice(head, a.length - tail);
  const y0 = b.slice(head, b.length - tail);
  const middle = myers(x0, y0);
  if (middle === null) return null;
  return [...Array<Operation>(head).fill('='), ...middle, ...Array<Operation>(tail).fill('=')];
}

function myers(a: readonly string[], b: readonly string[]): Operation[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxDifferences);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m);
    }
  }
  return null;
}

/** Walk the search's trace back from the end to the operations, in order. */
function backtrack(trace: readonly Int32Array[], offset: number, n: number, m: number): Operation[] {
  const operations: Operation[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const previousX = v[offset + previousK]!;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      operations.push('=');
      x -= 1;
      y -= 1;
    }
    if (d > 0) operations.push(x === previousX ? '+' : '-');
    x = previousX;
    y = previousY;
  }
  return operations.reverse();
}

/** One line of a hunk, with what precedes it in the patch. */
const diffLine = (prefix: ' ' | '-' | '+', line: string): string => (line.endsWith('\n') ? `${prefix}${line}` : `${prefix}${line}\n\\ No newline at end of file\n`);

/** The hunks between two texts, with three lines of context, as git writes them. */
function hunks(before: string, after: string): string {
  const a = linesOf(before);
  const b = linesOf(after);
  const script = editScript(a, b) ?? [...Array<Operation>(a.length).fill('-'), ...Array<Operation>(b.length).fill('+')];
  // Each operation with the line it reads in each text.
  const steps: { operation: Operation; oldIndex: number; newIndex: number }[] = [];
  let i = 0;
  let j = 0;
  for (const operation of script) {
    steps.push({ operation, oldIndex: i, newIndex: j });
    if (operation !== '+') i += 1;
    if (operation !== '-') j += 1;
  }
  const changes = steps.flatMap((step, index) => (step.operation === '=' ? [] : [index]));
  if (changes.length === 0) return '';
  const ranges: [number, number][] = [];
  for (const index of changes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(steps.length, index + contextLines + 1);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  const out: string[] = [];
  for (const [start, end] of ranges) {
    const part = steps.slice(start, end);
    const oldCount = part.filter((step) => step.operation !== '+').length;
    const newCount = part.filter((step) => step.operation !== '-').length;
    const first = part[0]!;
    // An empty side's start is the line before it, as git numbers an insertion or a deletion of everything.
    const oldStart = oldCount === 0 ? first.oldIndex : first.oldIndex + 1;
    const newStart = newCount === 0 ? first.newIndex : first.newIndex + 1;
    out.push(`@@ -${String(oldStart)},${String(oldCount)} +${String(newStart)},${String(newCount)} @@\n`);
    for (const step of part) {
      if (step.operation === '=') out.push(diffLine(' ', a[step.oldIndex]!));
      else if (step.operation === '-') out.push(diffLine('-', a[step.oldIndex]!));
      else out.push(diffLine('+', b[step.newIndex]!));
    }
  }
  return out.join('');
}

/** Git's base 85 alphabet for binary patches. */
const base85Alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';

/** Bytes as git's binary patch lines: up to 52 bytes a line, a length character, then base 85 of the bytes padded to four. */
function base85Lines(bytes: Buffer): string {
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; start += 52) {
    const chunk = bytes.subarray(start, Math.min(bytes.length, start + 52));
    const length = chunk.length <= 26 ? String.fromCharCode(64 + chunk.length) : String.fromCharCode(96 + chunk.length - 26);
    let encoded = '';
    for (let at = 0; at < chunk.length; at += 4) {
      let value = 0;
      for (let byte = 0; byte < 4; byte += 1) value = value * 256 + (chunk[at + byte] ?? 0);
      let group = '';
      for (let digit = 0; digit < 5; digit += 1) {
        group = base85Alphabet[value % 85]! + group;
        value = Math.floor(value / 85);
      }
      encoded += group;
    }
    lines.push(`${length}${encoded}\n`);
  }
  return lines.join('');
}

/** A literal binary patch to `after` with its reverse to `before`, as git writes one. */
function binaryPatch(before: Buffer, after: Buffer): string {
  return `GIT binary patch\nliteral ${String(after.length)}\n${base85Lines(deflateSync(after))}\nliteral ${String(before.length)}\n${base85Lines(deflateSync(before))}\n`;
}

const modeOf = (content: Content): string => (content.symlink ? '120000' : '100644');

/**
 * The diff of one path from `before` to `after`, null on either side
 * meaning the path is absent there; empty when the two are the same. A
 * change between a file and a symlink is a deletion and a creation, as
 * git writes a type change.
 */
function fileDiff(path: string, before: Content | null, after: Content | null, format: ObjectFormat): string {
  if (before !== null && after !== null && before.symlink !== after.symlink) return fileDiff(path, before, null, format) + fileDiff(path, null, after, format);
  if (before === null && after === null) return '';
  const header = [`diff --git a/${path} b/${path}\n`];
  if (before === null) header.push(`new file mode ${modeOf(after!)}\n`);
  if (after === null) header.push(`deleted file mode ${modeOf(before!)}\n`);
  // A side frozen by hash and size only has no bytes to diff or to name by object id.
  if ((before !== null && before.bytes === null) || (after !== null && after.bytes === null)) {
    return `${header.join('')}Binary files ${before === null ? '/dev/null' : `a/${path}`} and ${after === null ? '/dev/null' : `b/${path}`} differ\n`;
  }
  const oldBytes = before?.bytes ?? Buffer.alloc(0);
  const newBytes = after?.bytes ?? Buffer.alloc(0);
  if (before !== null && after !== null && oldBytes.equals(newBytes)) return '';
  const oldId = before === null ? nullId(format) : gitBlobId(oldBytes, format);
  const newId = after === null ? nullId(format) : gitBlobId(newBytes, format);
  header.push(`index ${oldId}..${newId}${before !== null && after !== null ? ` ${modeOf(after)}` : ''}\n`);
  if (!isText(oldBytes) || !isText(newBytes)) return `${header.join('')}${binaryPatch(oldBytes, newBytes)}`;
  const body = hunks(oldBytes.toString('utf8'), newBytes.toString('utf8'));
  return `${header.join('')}--- ${before === null ? '/dev/null' : `a/${path}`}\n+++ ${after === null ? '/dev/null' : `b/${path}`}\n${body}`;
}

/**
 * The unified diff of `paths` between two expected trees, in path order,
 * with git's headers. A path neither tree names, or one both hold the same
 * way, gives nothing.
 */
export function renderPatch(before: ExpectedTree, after: ExpectedTree, paths: Iterable<string>, read: BlobReader, format: ObjectFormat = 'sha1'): string {
  const content = (tree: ExpectedTree, path: string): Content | null => {
    const file = tree.get(path) ?? null;
    return file === null ? null : contentOf(file, read);
  };
  return [...new Set(paths)]
    .sort()
    .map((path) => fileDiff(path, content(before, path), content(after, path), format))
    .join('');
}

/** A commit message for one patch of a series. */
export interface PatchMessage {
  readonly subject: string;
  readonly body: string;
}

/** The author a patch's mail names, since `git am` needs one; the commit command uses the user's own identity instead. */
export const patchAuthor = 'deep-review <deep-review@deep-review.invalid>';

/** A header value in RFC 2047's Q encoding when it holds anything but printable ASCII, as `git format-patch` writes one. */
function headerText(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const encoded = [...Buffer.from(text, 'utf8')].map((byte) => (byte === 0x20 ? '_' : /[A-Za-z0-9!*+\-/]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
  return `=?UTF-8?q?${encoded}?=`;
}

/**
 * A body line that `git am` would read as the end of the message or the
 * start of the diff, given a leading space so the message keeps it.
 */
const bodyLine = (line: string): string => (/^(---|diff -|Index: )/.test(line) ? ` ${line}` : line);

/**
 * One patch of a series as `git format-patch` writes it: a mail header
 * with the subject numbered `n/total`, the body, `---`, and the diff, so
 * `git am` applies the series in order.
 */
export function renderMail(message: PatchMessage, number: number, total: number, diff: string): string {
  const body = message.body.trim() === '' ? '' : `${message.body.replace(/\r\n/g, '\n').split('\n').map(bodyLine).join('\n').replace(/\n*$/, '\n')}`;
  return [
    'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\n',
    `From: ${patchAuthor}\n`,
    `Subject: [PATCH ${String(number)}/${String(total)}] ${headerText(message.subject)}\n`,
    'MIME-Version: 1.0\n',
    'Content-Type: text/plain; charset=UTF-8\n',
    'Content-Transfer-Encoding: 8bit\n',
    '\n',
    body,
    '---\n',
    diff,
    '-- \n',
    'deep-review\n',
    '\n',
  ].join('');
}

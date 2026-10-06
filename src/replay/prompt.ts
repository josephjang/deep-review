/**
 * The prompt a replayed worker receives, made from the bytes a recorded
 * worker's launch froze: the same text, less the launcher's scratch note
 * (the replay's own launch adds one for its own scratch directory), with
 * the repository the scope block names and the directory its frozen blobs
 * are read from replaced by where the replay has them, and, on request,
 * with the role prompt replaced by another. Nothing else changes, so a
 * replayed verifier judges exactly what the recorded one was asked.
 */
import { isAbsolute } from 'node:path';
import { composePrompt } from '../runtime/launcher.ts';
import { ReplayRefusedError } from './errors.ts';

/** A frozen blob a recorded prompt may name by path, and the path the replay reads it at. */
export interface FrozenBlob {
  readonly sha256: string;
  readonly path: string;
}

/** What a recorded prompt is rewritten with. */
export interface PromptRewrite {
  /** The scratch directory the recorded launch gave its worker, or null when it had none. */
  readonly scratch: string | null;
  /** The directory the replay's workers run in: the repository at the recorded head. */
  readonly tree: string;
  /** Every frozen blob of the recorded scope, at its path in the store the replay reads. */
  readonly blobs: readonly FrozenBlob[];
  /** The role prompt to put in place of the recorded one, or null to keep the recorded one. */
  readonly roleText: string | null;
}

/**
 * Where a scope block names its repository, as `scopeHeader` in
 * `review/prompts.ts` writes it. The last one in a prompt is the scope
 * block's own: a candidate's text comes before the scope block and may
 * hold anything, and the patch that follows it is fenced with every line
 * prefixed.
 */
const repositoryAnchor = '\n## Scope\n\nRepository: ';

/**
 * Where a composed prompt's task section starts, as `composeWorkerPrompt`
 * writes it after the role prompt. The first one in a prompt is the task
 * section's own, since no role prompt holds it and everything a model
 * wrote comes after.
 */
const taskAnchor = '\n## Task\n\nRole: ';

/** What precedes a frozen blob's path in a scope block: the cell before it in the table of changed files, or the sentence that names an oversized patch (`describePatch`). */
const blobPathIntroductions = ['| ', 'Read it at: '] as const;

const hasLineBreak = (text: string): boolean => /[\r\n]/.test(text);

/**
 * The prompt an invocation carried, from the bytes its launch froze: those
 * bytes less the scratch note the launcher appended (`composePrompt`).
 * Refused when the bytes do not end with the note for the recorded
 * scratch directory, since the invocation's own text can then not be told
 * from what the launcher added.
 */
export function withoutScratchNote(recorded: string, scratch: string | null): string {
  const note = composePrompt('', scratch);
  if (!recorded.endsWith(note)) {
    throw new ReplayRefusedError(`The recorded prompt does not end with the launcher's scratch note for ${scratch ?? 'no scratch directory'}, so the invocation's own text cannot be recovered from it`);
  }
  return recorded.slice(0, recorded.length - note.length);
}

/**
 * Where a prompt's scope block starts: at its repository line. Every
 * search for what the scope block names starts here, so that a
 * candidate's text, which comes before it, is neither read nor rewritten.
 */
function scopeStart(prompt: string): number {
  const at = prompt.lastIndexOf(repositoryAnchor);
  if (at === -1) throw new ReplayRefusedError('The recorded prompt has no scope block naming its repository');
  return at;
}

/** Where the path of the scope block's repository line starts and ends in a prompt. */
function repositorySpan(prompt: string): { readonly start: number; readonly end: number } {
  const start = scopeStart(prompt) + repositoryAnchor.length;
  const end = prompt.indexOf('\n', start);
  if (end === -1) throw new ReplayRefusedError('The recorded prompt ends inside the line naming its repository');
  return { start, end };
}

/** The repository a recorded prompt's scope block names: the worktree the run reviewed. */
export function recordedRepository(prompt: string): string {
  const { start, end } = repositorySpan(prompt);
  return prompt.slice(start, end);
}

/** The prompt with the repository its scope block names replaced by `tree`. */
export function withRepository(prompt: string, tree: string): string {
  if (tree.length === 0 || hasLineBreak(tree)) throw new ReplayRefusedError(`A replay's tree must be a path on one line, not ${JSON.stringify(tree)}`);
  const { start, end } = repositorySpan(prompt);
  return `${prompt.slice(0, start)}${tree}${prompt.slice(end)}`;
}

/**
 * The directory, with its closing separator, that a recorded prompt's
 * scope block names the frozen blobs of `blobs` under, read from the first
 * of them the scope block names; null when it names none, as a scope of
 * added files with an inline patch does. The directory is whatever stands
 * between the blob's hash and what the engine writes before a blob's path.
 */
export function recordedStorePrefix(prompt: string, blobs: readonly Pick<FrozenBlob, 'sha256'>[]): string | null {
  return storePrefixIn(prompt.slice(scopeStart(prompt)), blobs);
}

/** `recordedStorePrefix` for the text of a scope block, from its repository line on. */
function storePrefixIn(scope: string, blobs: readonly Pick<FrozenBlob, 'sha256'>[]): string | null {
  for (const { sha256 } of blobs) {
    const at = scope.indexOf(sha256);
    if (at === -1) continue;
    const start = Math.max(...blobPathIntroductions.map((introduction) => {
      const found = scope.lastIndexOf(introduction, at);
      return found === -1 ? -1 : found + introduction.length;
    }));
    const prefix = start === -1 ? '' : scope.slice(start, at);
    if (prefix.length === 0 || hasLineBreak(prefix) || !/[\\/]$/.test(prefix) || !isAbsolute(prefix)) {
      throw new ReplayRefusedError(`The recorded prompt names the frozen blob ${sha256}, but not under a directory that can be read from it: ${JSON.stringify(prefix)}`);
    }
    return prefix;
  }
  return null;
}

/**
 * The prompt with every frozen blob its scope block names read from the
 * store the replay holds, each at the path `blobs` gives. Refused when the
 * scope block names, under its recorded store, a blob `blobs` does not
 * hold: the replayed worker would be sent to a file the replay cannot
 * vouch for.
 */
export function withStore(prompt: string, blobs: readonly FrozenBlob[]): string {
  const at = scopeStart(prompt);
  const scope = prompt.slice(at);
  const prefix = storePrefixIn(scope, blobs);
  if (prefix === null) return prompt;
  const paths = new Map(blobs.map((blob) => [blob.sha256, blob.path]));
  for (const path of paths.values()) {
    // A cell of the scope block's table is written with its pipes escaped and its line breaks folded; a path with either would not read back as itself.
    if (path.includes('|') || hasLineBreak(path)) throw new ReplayRefusedError(`A frozen blob's path must hold no pipe and no line break: ${JSON.stringify(path)}`);
  }
  return prompt.slice(0, at) + scope.replaceAll(new RegExp(`${RegExp.escape(prefix)}([0-9a-f]{64})`, 'g'), (_named, sha256: string) => {
    const path = paths.get(sha256);
    if (path === undefined) throw new ReplayRefusedError(`The recorded prompt names the frozen blob ${sha256}, which the recorded scope does not hold`);
    return path;
  });
}

/** A composed prompt's role prompt, and the rest of it from the line before its task section. */
export function splitRoleText(prompt: string): { readonly roleText: string; readonly task: string } {
  const at = prompt.indexOf(taskAnchor);
  if (at === -1) throw new ReplayRefusedError('The recorded prompt has no task section, so its role prompt cannot be told from its task');
  return { roleText: prompt.slice(0, at), task: prompt.slice(at) };
}

/** The prompt with its role prompt replaced by `roleText`, joined to the task as `composeWorkerPrompt` joins them. */
export function withRoleText(prompt: string, roleText: string): string {
  const { task } = splitRoleText(prompt);
  return `${roleText.endsWith('\n') ? roleText : `${roleText}\n`}${task}`;
}

/** The prompt of a replayed worker's invocation, from the bytes a recorded launch froze. */
export function replayPrompt(recorded: string, rewrite: PromptRewrite): string {
  const located = withStore(withRepository(withoutScratchNote(recorded, rewrite.scratch), rewrite.tree), rewrite.blobs);
  return rewrite.roleText === null ? located : withRoleText(located, rewrite.roleText);
}

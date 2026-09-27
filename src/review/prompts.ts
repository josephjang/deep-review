/**
 * How a worker's prompt is composed (R7 of the read-only review): the
 * assembled role prompt, unchanged, then a `## Task` section that names the
 * role and its unit, gives the task the phase wrote for it, and ends with
 * the scope block every worker of a run shares. The launcher appends its
 * scratch note after.
 */
import type { FrozenFile, ScopeState } from '../checkpoint/events.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { ConventionFile } from './conventions.ts';
import { tableCell } from './markdown.ts';
import type { Phase } from './vocabulary.ts';

/** The most bytes of patch that go inline in a prompt (TD3); above it the prompt names the frozen patch's path. */
export const inlinePatchLimitBytes = 256 * 1024;

/** What the scope block is rendered from. */
export interface ScopeBlockInput {
  readonly worktree: string;
  readonly scope: ScopeState;
  readonly evidence: Pick<EvidenceStore, 'pathOf' | 'read'>;
  readonly conventions: readonly ConventionFile[];
}

/** How a frozen before state is named to a worker. */
export function describeFrozen(frozen: FrozenFile | null, evidence: Pick<EvidenceStore, 'pathOf'>): string {
  if (frozen === null) return 'none';
  if ('blob' in frozen) return evidence.pathOf(frozen.blob);
  return `oversized ${frozen.oversized.sha256} ${String(frozen.oversized.size)} bytes`;
}

/**
 * A fence that the text cannot close: one more backtick than the longest
 * run the text holds, and at least three.
 */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The patch as prompt text: inline in a fence when small enough, else the path of the frozen blob. */
export function describePatch(scope: ScopeState, evidence: Pick<EvidenceStore, 'pathOf' | 'read'>): string {
  if (scope.patch.bytes > inlinePatchLimitBytes) {
    return `The patch is ${String(scope.patch.bytes)} bytes, too large to carry here. Read it at: ${evidence.pathOf(scope.patch)}`;
  }
  const text = evidence.read(scope.patch).toString('utf8');
  if (text.trim() === '') return 'The patch is empty.';
  const fence = fenceFor(text);
  return `${fence}diff\n${text.endsWith('\n') ? text : `${text}\n`}${fence}`;
}

/**
 * The scope block every worker of a run receives: the repository, base,
 * head and mode; a table of the changed files with the frozen before state
 * by path and the after state in the worktree; the rules files that govern
 * the change; and the patch.
 */
export function scopeBlock(input: ScopeBlockInput): string {
  const { scope, evidence } = input;
  const rows = scope.files.map((file) => {
    const after = file.after === null ? 'deleted' : 'read the file in the worktree';
    return `| ${tableCell(file.path)} | ${file.status}${file.symlink ? ' (symlink)' : ''} | ${tableCell(describeFrozen(file.before, evidence))} | ${after} |`;
  });
  const conventions = input.conventions.length === 0
    ? 'None of CLAUDE.md, CLAUDE.local.md or AGENTS.md was found at the user level, the repository root or an ancestor directory of a changed file.'
    : input.conventions.map((file) => `- ${file.path} (${file.level === 'user' ? 'user level' : 'repository'})`).join('\n');
  return [
    '## Scope',
    '',
    `Repository: ${input.worktree}`,
    `Base: ${scope.base}`,
    `Head: ${scope.head}`,
    `Mode: ${scope.mode}`,
    '',
    'Your working directory is the repository above, at head, which is the after state of every file; read files there. The before state of each file is frozen at the path given, and may be read but never written.',
    '',
    '### Changed files',
    '',
    '| Path | Status | Before | After |',
    '|---|---|---|---|',
    ...rows,
    '',
    '### Rules files that govern the change',
    '',
    conventions,
    '',
    '### Patch',
    '',
    describePatch(scope, evidence),
  ].join('\n');
}

/** One worker's task as a phase writes it. */
export interface TaskInput {
  readonly role: string;
  readonly phase: Phase;
  readonly unitKey: string;
  /** The task text, ending with its closing sentence. */
  readonly task: string;
}

/** The closing sentence of every task, so the prompt's prose and the schema agree (R4). */
export const closingSentence = 'Return only the JSON your schema describes.';

/**
 * The whole prompt: the role prompt as assembled, one blank line, the task
 * section with the role and unit named on their own lines (which a reader
 * of the ledger, or a test double, can match), the task, the scope block
 * and the closing sentence.
 */
export function composeWorkerPrompt(rolePrompt: string, task: TaskInput, scope: string): string {
  const body = [
    '## Task',
    '',
    `Role: ${task.role}`,
    `Unit: ${task.unitKey}`,
    `Phase: ${task.phase}`,
    '',
    task.task,
    '',
    scope,
    '',
    closingSentence,
  ].join('\n');
  return `${rolePrompt.endsWith('\n') ? rolePrompt : `${rolePrompt}\n`}\n${body}\n`;
}

/** The `Role:`, `Unit:` and `Phase:` a composed prompt names, for a reader that has only the prompt. */
export function readTaskHeader(prompt: string): { role: string; unitKey: string; phase: string } | null {
  const role = /^Role: (\S+)$/m.exec(prompt);
  const unit = /^Unit: (\S+)$/m.exec(prompt);
  const phase = /^Phase: (\S+)$/m.exec(prompt);
  return role === null || unit === null || phase === null ? null : { role: role[1]!, unitKey: unit[1]!, phase: phase[1]! };
}

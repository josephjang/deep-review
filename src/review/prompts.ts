/**
 * How a worker's prompt is composed (R7 of the read-only review): the
 * assembled role prompt, unchanged, then a `## Task` section that names the
 * role and its unit, gives the task the phase wrote for it, and ends with
 * the scope block every worker of a run shares. The launcher appends its
 * scratch note after.
 */
import type { ConventionSource, FrozenFile, ScopeState } from '../checkpoint/events.ts';
import type { ConventionsKnown } from '../checkpoint/survey-state.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import { inlineText, tableCell } from './markdown.ts';
import type { Phase } from './vocabulary.ts';

/** The most bytes of patch that go inline in a prompt (TD3); above it the prompt names the frozen patch's path. */
export const inlinePatchLimitBytes = 256 * 1024;

/** What the surveyor's scope block is rendered from: the run's scope, and where its frozen states are. */
export interface ScopeBlockBase {
  readonly worktree: string;
  readonly scope: ScopeState;
  readonly evidence: Pick<EvidenceStore, 'pathOf' | 'read'>;
}

/** A rules file the engine lists for a run configured before the survey existed, as it did then (R12, TD11 of the read-only review). */
export interface PresurveyRulesFile {
  /** `user` for a file under the home directory, `repository` for one under the worktree. */
  readonly level: 'user' | 'repository';
  /** Absolute for a user file; repository-relative with forward slashes for a repository file, as a worker's working directory is the worktree. */
  readonly path: string;
}

/**
 * What a scope block says of the conventions: what the run knows of its
 * convention sources, and for a run configured before the survey existed,
 * which recorded none, the rules files the engine looked up for it, which
 * the role prompts that run pinned expect the scope block to list.
 */
export type ScopeConventions =
  | Exclude<ConventionsKnown, { readonly status: 'predates-survey' }>
  | { readonly status: 'predates-survey'; readonly rulesFiles: readonly PresurveyRulesFile[] };

/** What the scope block of every worker after the survey is rendered from. */
export interface ScopeBlockInput extends ScopeBlockBase {
  /** What the scope block says of the conventions (R7 of the repository survey). */
  readonly conventions: ScopeConventions;
}

/** One convention source as a line of the scope block: its path, its level, what it governs and what it applies to. */
function sourceLine(source: ConventionSource): string {
  const level = source.level === 'user' ? `user level, the reviewer's own rules, applied because: ${inlineText(source.grounds ?? 'no grounds recorded')}` : 'repository';
  const narrower = source.appliesTo === null ? '' : ` (applies to ${source.appliesTo.map(inlineText).join(', ')})`;
  return `- ${inlineText(source.path)} (${level}): ${inlineText(source.governs)}${narrower}`;
}

/**
 * The scope block's section on the conventions, heading and body: the
 * convention sources the run knows of, or for a run that predates the
 * survey the rules files the engine found, under the heading and in the
 * words the engine rendered them in then, which the role prompts that run
 * pinned refer to.
 */
export function conventionsSection(known: ScopeConventions): string {
  const section = (heading: string, body: string): string => `### ${heading}\n\n${body}`;
  const sources = (body: string): string => section('Convention sources', body);
  switch (known.status) {
    case 'surveyed':
      return sources(known.sources.length === 0
        ? 'The repository survey found no file that states conventions a change here must follow.'
        : ['The repository survey named these files as stating the conventions a change here must follow:', '', ...known.sources.map(sourceLine)].join('\n'));
    case 'failed':
      return sources(known.sources.length === 0
        ? 'The repository survey failed, so no convention source is known.'
        : ['The repository survey failed; the review policy applies these user-level rules files:', '', ...known.sources.map(sourceLine)].join('\n'));
    case 'pending':
      return sources('The repository survey has not answered yet, so no convention source is known.');
    case 'predates-survey':
      return section('Rules files that govern the change', known.rulesFiles.length === 0
        ? 'None of CLAUDE.md, CLAUDE.local.md or AGENTS.md was found at the user level, the repository root or an ancestor directory of a changed file.'
        : known.rulesFiles.map((file) => `- ${inlineText(file.path)} (${file.level === 'user' ? 'user level' : 'repository'})`).join('\n'));
  }
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
 * The opening every scope block shares: the repository, base, head and
 * mode, and a table of the changed files with the frozen before state by
 * path and the after state in the worktree.
 */
function scopeHeader(input: ScopeBlockBase): string[] {
  const { scope, evidence } = input;
  const rows = scope.files.map((file) => {
    const after = file.after === null ? 'deleted' : 'read the file in the worktree';
    return `| ${tableCell(file.path)} | ${file.status}${file.symlink ? ' (symlink)' : ''} | ${tableCell(describeFrozen(file.before, evidence))} | ${after} |`;
  });
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
  ];
}

/**
 * The surveyor's scope block (R7, TD10 of the repository survey): the
 * shared opening alone. It has no convention sources, which the survey is
 * there to name, and no patch: the surveyor judges what a source applies
 * to by the changed paths, and the diff, up to `inlinePatchLimitBytes` of
 * it, would be paid for on every surveyor launch and never read.
 */
export function surveyScopeBlock(input: ScopeBlockBase): string {
  return scopeHeader(input).join('\n');
}

/**
 * The scope block every worker after the survey receives: the shared
 * opening, the convention sources the run knows of (for a run that
 * predates the survey, the rules files the engine found), and the patch.
 */
export function scopeBlock(input: ScopeBlockInput): string {
  return [
    ...scopeHeader(input),
    '',
    conventionsSection(input.conventions),
    '',
    '### Patch',
    '',
    describePatch(input.scope, input.evidence),
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

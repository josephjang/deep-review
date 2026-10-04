/**
 * The repository survey's engine side (R2 to R8, R11, R15 of the
 * repository survey): what an invocation knows that the surveyor cannot
 * see, the structural check of the surveyor's answer against the tree and
 * that knowledge, the pinned policy's part of the convention sources, and
 * the plan of the checks from the operator's flags and the recorded
 * survey. Nothing here asks a model or runs a command.
 */
import { isAbsolute, join } from 'node:path';
import type { ConventionSource, PlannedCheckV2, SurveyedCheck, SurveyFailed, SurveyRecorded, UserRuleDecision } from '../checkpoint/events.ts';
import { canonicalPath, isFile, isInside } from '../paths.ts';
import { isSettled, unsettledKinds, type CheckFlags, type CheckHint } from './checks/discover.ts';
import type { ReviewerAuthorship } from './conventions.ts';
import { StructuralCheckError } from './errors.ts';
import { requireNoNul, resolveReportedPath, resolvingPath } from './fix-answer.ts';
import type { RepoLookup } from './locations.ts';
import type { SurveyorCheckOutput, SurveyorOutput } from './schemas.ts';
import { checkKinds, type CheckKind, type UserRulesSetting } from './vocabulary.ts';

/**
 * What one invocation knows for its survey, read once: the platform its
 * checks run on, the `--check` and `--no-check` flags it was given (none
 * in a run that does not fix), the user-level rules files that exist, and
 * in a fix run the manifest rules' hint for each kind no flag settles,
 * and how much of the repository's recent history the reviewer authored.
 */
export interface SurveyInputs {
  readonly platform: NodeJS.Platform;
  readonly flags: CheckFlags;
  /** Absolute paths, in the order `userConventionFiles` lists them. */
  readonly userFiles: readonly string[];
  readonly hints: readonly CheckHint[];
  /** The reviewer's authorship of the recent history, which the surveyor weighs a user-level file by and cannot see itself. */
  readonly authorship: ReviewerAuthorship;
}

/** The user-level files the surveyor is told of: every one that exists under `judge`, and none otherwise, since the policy settles them (R3). */
export const offeredUserFiles = (setting: UserRulesSetting, inputs: Pick<SurveyInputs, 'userFiles'>): readonly string[] => (setting === 'judge' ? inputs.userFiles : []);

/** What the engine says of a user-level source the policy applies, and of each file under `apply` and `ignore`. */
export const policyWords = {
  governs: 'the reviewer\'s own rules, which the review policy applies to every run',
  grounds: 'applied by the policy value apply',
  ignored: 'ignored by the policy value ignore',
  unjudged: 'not judged, since the survey failed',
} as const;

/** The pinned policy's part of the sources and the decisions: under `apply` every user-level file applies, under `ignore` none, and under `judge` the surveyor decides, or nobody when it failed. */
function policyPart(setting: UserRulesSetting, userFiles: readonly string[]): { conventions: ConventionSource[]; userRules: UserRuleDecision[] } {
  switch (setting) {
    case 'apply':
      return {
        conventions: userFiles.map((path) => ({ path, level: 'user', governs: policyWords.governs, appliesTo: null, grounds: policyWords.grounds })),
        userRules: userFiles.map((path) => ({ path, applied: true, reason: policyWords.grounds })),
      };
    case 'ignore':
      return { conventions: [], userRules: userFiles.map((path) => ({ path, applied: false, reason: policyWords.ignored })) };
    case 'judge':
      return { conventions: [], userRules: userFiles.map((path) => ({ path, applied: false, reason: policyWords.unjudged })) };
  }
}

/** The run going on without its survey (R9): the reason, and what the pinned policy decides of the user-level files alone. */
export function surveyFailure(reason: string, setting: UserRulesSetting, userFiles: readonly string[]): SurveyFailed {
  return { reason, ...policyPart(setting, userFiles) };
}

/** What the structural check reads beyond the answer: the worktree, a lookup over it, the pinned policy value and the invocation's inputs. */
export interface SurveyCheckContext {
  readonly worktree: string;
  readonly lookup: RepoLookup;
  readonly setting: UserRulesSetting;
  /** Whether the run fixes, and so asks for checks (PD10). */
  readonly fix: boolean;
  readonly inputs: SurveyInputs;
}

/** Why the survey refuses a path into the git directory: a surveyor names the repository's files, and git's own are none of them. */
const surveyGitDirectory = 'which holds git\'s own data, not a file of the repository';

/**
 * A path the surveyor names in the repository, in the worktree's own
 * spelling, refused unless it is a regular file inside the worktree once
 * every link is followed (R8, TD9). `what` names the field for the reason.
 * Every way the path can fail, the file system's included, is a
 * `StructuralCheckError`, so an odd path costs the attempt, not the run.
 */
function repositoryFile(context: SurveyCheckContext, raw: string, what: string): string {
  const path = resolveReportedPath(context.worktree, context.lookup, raw, { what, gitDirectory: surveyGitDirectory });
  const absolute = join(context.worktree, ...path.split('/'));
  if (!isFile(absolute)) throw new StructuralCheckError(`${what} ${JSON.stringify(raw)} is not a regular file of the repository`);
  if (!resolvingPath(what, raw, () => isInside(context.worktree, absolute))) throw new StructuralCheckError(`${what} ${JSON.stringify(raw)} leads outside the repository`);
  return path;
}

/**
 * The offered user-level file a path names, in the engine's spelling, or
 * null for one that was not offered. The task offers each by its absolute
 * path, so only an absolute path names one, compared with every link
 * followed; a relative path names none, rather than whatever it would
 * resolve to from the directory the engine happens to run in.
 */
function offeredFile(offered: readonly string[], raw: string, what: string): string | null {
  requireNoNul(what, raw);
  if (!isAbsolute(raw)) return null;
  const named = resolvingPath(what, raw, () => canonicalPath(raw));
  return offered.find((path) => resolvingPath(what, raw, () => canonicalPath(path)) === named) ?? null;
}

/** Refuse the second of two entries with one key. */
function requireOnce(keys: readonly string[], what: string): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new StructuralCheckError(`${what} ${JSON.stringify(key)} is named twice`);
    seen.add(key);
  }
}

/** The convention sources and the user-level decisions of an answer, checked, with paths in the engine's spelling and the policy's part joined (R2, R3, R8). */
function checkConventions(output: SurveyorOutput, context: SurveyCheckContext): { conventions: ConventionSource[]; userRules: UserRuleDecision[] } {
  const offered = offeredUserFiles(context.setting, context.inputs);
  const conventions = output.conventions.map((source): ConventionSource => {
    if (source.level === 'repository') {
      if (source.grounds !== null) throw new StructuralCheckError(`The repository source ${JSON.stringify(source.path)} states grounds, which only a user-level source does`);
      return { ...source, path: repositoryFile(context, source.path, 'The convention source') };
    }
    const path = offeredFile(offered, source.path, 'The user-level source');
    if (path === null) throw new StructuralCheckError(`The user-level source ${JSON.stringify(source.path)} is not a file the task offered${offered.length === 0 ? '; it offered none' : ''}`);
    if (source.grounds === null) throw new StructuralCheckError(`The user-level source ${JSON.stringify(source.path)} states no grounds for applying the reviewer's own rules`);
    return { ...source, path };
  });
  requireOnce(conventions.map((source) => source.path), 'The convention source');
  if (context.setting !== 'judge') {
    if (output.userRules.length > 0) throw new StructuralCheckError(`The answer decides user-level rules files, which the policy value ${context.setting} settles, so none was offered`);
    const part = policyPart(context.setting, context.inputs.userFiles);
    return { conventions: [...conventions, ...part.conventions], userRules: part.userRules };
  }
  const userRules = output.userRules.map((rule): UserRuleDecision => {
    const path = offeredFile(offered, rule.path, 'The user-level file');
    if (path === null) throw new StructuralCheckError(`The user-level decision on ${JSON.stringify(rule.path)} is not about a file the task offered`);
    return { ...rule, path };
  });
  requireOnce(userRules.map((rule) => rule.path), 'The user-level file');
  const undecided = offered.filter((path) => !userRules.some((rule) => rule.path === path));
  if (undecided.length > 0) throw new StructuralCheckError(`The answer decides nothing about the offered user-level file${undecided.length === 1 ? '' : 's'} ${undecided.join(', ')}`);
  const listed = new Set(conventions.filter((source) => source.level === 'user').map((source) => source.path));
  for (const rule of userRules) {
    if (rule.applied !== listed.has(rule.path)) throw new StructuralCheckError(`The user-level file ${rule.path} is ${rule.applied ? 'applied but not listed as a source' : 'listed as a source but not applied'}`);
  }
  return { conventions, userRules };
}

/** One surveyed check, checked, its source in the engine's spelling (R4, R5, R8, R11). */
function checkSurveyedCheck(check: SurveyorCheckOutput, context: SurveyCheckContext): SurveyedCheck {
  const what = `The ${check.kind} check`;
  if (check.command === null) {
    if (check.reason === null) throw new StructuralCheckError(`${what} has no command and gives no reason`);
    if (check.missingTool !== null) throw new StructuralCheckError(`${what} names a missing tool and no command`);
    if (check.source !== null || check.basis !== null) throw new StructuralCheckError(`${what} has no command, so it has neither a source nor a basis`);
    return { kind: check.kind, command: null, basis: null, source: null, missingTool: null, reason: check.reason };
  }
  if (check.command.trim() === '') throw new StructuralCheckError(`${what}'s command is empty`);
  if (check.command.includes('\0')) throw new StructuralCheckError(`${what}'s command contains a NUL character, which no shell runs`);
  // cmd.exe runs only a command's first line and sh judges only its last, so one line's exit code alone would decide the check: a false pass.
  if (/[\r\n]/.test(check.command)) throw new StructuralCheckError(`${what}'s command spans more than one line, and cmd.exe runs only the first while sh judges only the last; join the commands on one line with &&`);
  if (check.source === null || check.basis === null) throw new StructuralCheckError(`${what} gives a command without ${check.source === null ? 'the file it took it from' : 'its basis'}`);
  if (check.basis === 'hint') {
    const hint = context.inputs.hints.find((candidate) => candidate.kind === check.kind)?.command ?? null;
    if (hint === null) throw new StructuralCheckError(`${what} stands on a hint, and the engine gave no hinted command for ${check.kind}`);
    if (hint !== check.command) throw new StructuralCheckError(`${what} stands on a hint, and its command ${JSON.stringify(check.command)} is not the hint's ${JSON.stringify(hint)}`);
  }
  const source = { path: repositoryFile(context, check.source.path, `${what}'s source`), quote: check.source.quote };
  return { kind: check.kind, command: check.command, basis: check.basis, source, missingTool: check.missingTool, reason: check.reason };
}

/**
 * The surveyor's answer as the ledger records it, less the worker id, or
 * a `StructuralCheckError` that fails the attempt (R8): every path a
 * regular file of the repository or an offered user-level file, no
 * source or decision twice, every offered file decided once and listed
 * exactly when applied; in a fix run one check for each kind no flag
 * settles, and in a run without one no checks.
 */
export function checkSurveyAnswer(output: SurveyorOutput, context: SurveyCheckContext): Omit<SurveyRecorded, 'workerId'> {
  const { conventions, userRules } = checkConventions(output, context);
  if (!context.fix) {
    if (output.checks !== null) throw new StructuralCheckError('The answer chooses checks, and this run does not fix, so it runs none');
    return { conventions, userRules, checks: null, note: output.note };
  }
  const answered = output.checks;
  if (answered === null) throw new StructuralCheckError('The answer chooses no checks, and this run fixes');
  requireOnce(answered.map((check) => check.kind), 'The check kind');
  const wanted = unsettledKinds(context.inputs.flags);
  const settled = answered.filter((check) => isSettled(context.inputs.flags, check.kind)).map((check) => check.kind);
  if (settled.length > 0) throw new StructuralCheckError(`The answer chooses ${settled.join(', ')}, which a flag settles`);
  const missing = wanted.filter((kind) => !answered.some((check) => check.kind === kind));
  if (missing.length > 0) throw new StructuralCheckError(`The answer chooses nothing for ${missing.join(', ')}`);
  const checks = checkKinds.flatMap((kind) => answered.filter((check) => check.kind === kind)).map((check) => checkSurveyedCheck(check, context));
  return { conventions, userRules, checks, note: output.note };
}

/** The reason a kind dropped by `--no-check` has no command. */
export const droppedReason = 'dropped by --no-check';

/** A check the project defines whose tool this machine lacks, by the surveyor's word (R15). */
export interface UnavailableCheck {
  readonly kind: CheckKind;
  readonly command: string;
  readonly source: string;
  readonly missingTool: string;
}

/** The plan `resolveChecks` lays out: the checks it settles, the kinds whose tool is missing, and the kinds nobody answered. */
export interface ResolvedChecks {
  /** One per kind no flag or survey leaves open, in the order the kinds run; the whole plan when the other two are empty. */
  readonly checks: readonly PlannedCheckV2[];
  readonly unavailable: readonly UnavailableCheck[];
  readonly uncovered: readonly CheckKind[];
}

/**
 * The checks of the flags and a survey, kind by kind (R5, R6, R15 of the
 * repository survey): a `--no-check` drops a kind and a `--check` names
 * its command, whatever the survey says; else the survey's command, with
 * its source, unless its tool is missing, which makes the kind
 * unavailable; else no command, with the survey's reason. A kind neither
 * a flag nor the survey answered is uncovered: the survey was asked when
 * a flag, which this invocation no longer gives, settled it.
 */
export function resolveChecks(answer: Pick<SurveyRecorded, 'checks'> | null, flags: CheckFlags): ResolvedChecks {
  const checks: PlannedCheckV2[] = [];
  const unavailable: UnavailableCheck[] = [];
  const uncovered: CheckKind[] = [];
  for (const kind of checkKinds) {
    if (flags.dropped.includes(kind)) {
      checks.push({ kind, command: null, origin: 'flag', reason: droppedReason, source: null });
      continue;
    }
    const flagged = flags.commands[kind];
    if (flagged !== undefined) {
      checks.push({ kind, command: flagged, origin: 'flag', reason: null, source: null });
      continue;
    }
    const surveyed = answer?.checks?.find((check) => check.kind === kind);
    if (surveyed === undefined) uncovered.push(kind);
    else if (surveyed.command === null) checks.push({ kind, command: null, origin: 'none', reason: surveyed.reason, source: null });
    else if (surveyed.missingTool !== null) unavailable.push({ kind, command: surveyed.command, source: surveyed.source.path, missingTool: surveyed.missingTool });
    else checks.push({ kind, command: surveyed.command, origin: 'survey', reason: null, source: { ...surveyed.source, basis: surveyed.basis } });
  }
  return { checks, unavailable, uncovered };
}

/**
 * The task text each role receives (R7 of the read-only review; R4, R11 of
 * the fix pass). Every task numbers what it hands over `[0]`, `[1]`, ...
 * (candidates, findings, failing checks) so the worker refers to them by
 * index (TD4), and describes the same fields its output schema demands
 * (R4). The closing sentence is appended by the prompt composer.
 */
import { appliedOptionOf, type PlannedCheck, type SpelledHolder } from '../checkpoint/fix-state.ts';
import { rawLocation, repositoryLocation, type CandidateState } from '../checkpoint/review-fold.ts';
import type { Lead, RecordedDecision, SurveyedSources } from '../checkpoint/events.ts';
import type { CheckHint } from './checks/discover.ts';
import type { ReviewerAuthorship } from './conventions.ts';
import { codeSpan, inlineText } from './markdown.ts';
import { fenceFor } from './prompts.ts';
import type { Layer } from '../config/settings.ts';
import type { CommitMessage } from '../scope/git.ts';
import { endedByKill, killMarkWords } from '../runtime/kill-marks.ts';
import { checkSettingWords, droppedReasonOf } from './survey.ts';
import { finderAngles, type CheckKind, type FinderAngle, type Severity, type Verdict } from './vocabulary.ts';

/** What the surveyor's task names that the surveyor cannot see (R2 to R5, R11 of the repository survey). */
export interface SurveyTaskInput {
  readonly platform: NodeJS.Platform;
  /** Whether the run fixes, and so asks for checks (PD10). */
  readonly fix: boolean;
  /** The kinds a setting settled, with its command, or null for one it dropped, and the layer that gave it: the flag layer for `--check` and `--no-check`. */
  readonly settled: readonly { readonly kind: CheckKind; readonly command: string | null; readonly layer: Exclude<Layer, 'default'> }[];
  /** The kinds the surveyor chooses, in the order the checks run. */
  readonly unsettled: readonly CheckKind[];
  /** The manifest rules' hint for each kind in `unsettled`. */
  readonly hints: readonly CheckHint[];
  /** The user-level rules files offered for judgment, absolute; empty when the policy settles them or none exists. */
  readonly offered: readonly string[];
  /** Whether the policy settles the user-level files, so the task offers none of them (R3). */
  readonly policySettlesUserRules: boolean;
  /** The reviewer's authorship of the recent history, told with the offered files. */
  readonly authorship: ReviewerAuthorship;
  /**
   * Whether the surveyor runs as Codex's elevated sandbox user on Windows,
   * for whom `where.exe` finds nothing under a directory whose ancestors it
   * cannot list, so its task names another lookup (R12 of the Codex sandbox).
   */
  readonly elevatedSandbox: boolean;
  /**
   * The convention sources and user-level decisions a read-only run
   * continued into the fix pass recorded, which stand, so its surveyor is
   * asked for the checks alone (R4, PD5 of fix pass continuation); null
   * for every other survey, which answers both questions.
   */
  readonly standing: SurveyedSources | null;
}

/**
 * The opening of a continued run's survey task: what stands and that only
 * the checks are asked, in place of the survey of the conventions and the
 * user-level files offered. The surveyor wrote each recorded field, so a
 * newline in one is folded, as the scope block folds it, and cannot start
 * a line of its own.
 */
function standingLines(standing: SurveyedSources): string[] {
  return [
    'This run was reviewed read-only and is now continued into the fix pass. Its survey already recorded the conventions the review held the change to, and they stand, so answer only the second question your role prompt defines: which commands are its checks. Return `conventions` and `userRules` empty.',
    '',
    'Convention sources recorded:',
    ...(standing.conventions.length === 0 ? ['- none'] : standing.conventions.map((source) => `- ${inlineText(source.path)} (${source.level}): ${inlineText(source.governs)}`)),
    ...(standing.userRules.length === 0 ? [] : ['', 'User-level rules files decided:', ...standing.userRules.map((rule) => `- ${inlineText(rule.path)}: ${rule.applied ? 'applied' : 'not applied'}, ${inlineText(rule.reason)}`)]),
  ];
}

/** The reviewer's authorship as the task states it: a fact the surveyor's own shell cannot see. */
function authorshipLine(authorship: ReviewerAuthorship): string {
  const preamble = 'What the reviewer\'s git configuration, which your own shell does not see, says of this repository\'s history:';
  if (authorship.identity === 'unset') return `${preamble} no \`user.email\` is configured for it, so no commit here can be attributed to the reviewer.`;
  return `${preamble} ${String(authorship.byReviewer)} of the last ${String(authorship.commits)} commits on HEAD were authored with the reviewer's email or with an address the repository's \`.mailmap\` gives as the reviewer's.`;
}

/** The line a survey task opens its checks with, which names the kinds to choose, or that the run does not fix. */
export const kindsToChooseLine = (input: Pick<SurveyTaskInput, 'fix' | 'unsettled'>): string =>
  input.fix ? `Kinds to choose: ${input.unsettled.length === 0 ? 'none' : input.unsettled.join(', ')}` : 'Kinds to choose: none; this run does not fix, so it runs no check, and `checks` is null';

/**
 * The lookup an elevated Codex surveyor on Windows is given in place of
 * `where.exe` (R12 of the Codex sandbox): PowerShell's `Get-Command`
 * limited to applications, which finds what `cmd.exe` would run through
 * PATH and PATHEXT, and exits 1 when nothing is found, as the sandbox user.
 * It does not search the current directory, which `cmd.exe` does first,
 * so a script in the repository root such as `gradlew.bat` is looked up
 * again as `.\<tool>`, which Get-Command resolves through PATHEXT there.
 */
const elevatedLookup = '`powershell.exe -NoProfile -Command "Get-Command -CommandType Application <tool>"` and, when that fails, the same with `.\\<tool>`, since `cmd.exe` also runs a script in the repository root such as `gradlew.bat`, where `Get-Command` does not look (not `where.exe`, which finds nothing as this sandbox\'s user under a directory whose ancestors it cannot list)';

/** How a check reaches its shell on a platform, and how a name is looked up as that shell resolves it, as the surveyor's sandbox lets it. */
function shellOf(platform: NodeJS.Platform, elevatedSandbox: boolean): { readonly shell: string; readonly lookup: string } {
  if (platform !== 'win32') return { shell: '/bin/sh -c "<command>"', lookup: '`command -v <tool>`' };
  return { shell: 'cmd.exe /d /s /c "<command>"', lookup: elevatedSandbox ? elevatedLookup : '`where.exe <tool>`' };
}

/**
 * The surveyor's task (R2 to R5, R11 of the repository survey): the
 * user-level files offered for judgment or none, then in a fix run the
 * kinds to choose, the ones the operator's flags settled, how a check
 * reaches its shell on this platform and how to look a tool up as it
 * would, and the manifest rules' hints as guesses; in a run that does not
 * fix, that no check is asked for. A continued run's task says instead
 * what its survey recorded, which stands, and asks for the checks alone
 * (R4 of fix pass continuation).
 */
export function surveyTask(input: SurveyTaskInput): string {
  if (input.standing !== null) {
    if (!input.fix) throw new Error('A survey asked for the checks alone is a continued run\'s, which fixes');
    return [...standingLines(input.standing), '', ...fixChecks(input)].join('\n');
  }
  const userRules = input.offered.length > 0
    ? [
        'User-level rules files offered:',
        ...input.offered.map((path) => `- ${path}`),
        '',
        'These exist on this machine and are the reviewer\'s own rules, not the repository\'s. List one under `conventions`, with `level` `user`, its path as given here and its `grounds`, only when you have grounds that this repository is the reviewer\'s own work or adopts those rules, and state them. Decide every one of them in `userRules`, `applied` or not, with the reason.',
        '',
        authorshipLine(input.authorship),
      ]
    : [
        'User-level rules files offered: none',
        '',
        input.policySettlesUserRules
          ? 'The review policy settles whether the reviewer\'s own rules apply, so none is offered to you: return `userRules` empty and list no source with `level` `user`.'
          : 'No user-level rules file exists on this machine: return `userRules` empty and list no source with `level` `user`.',
      ];
  const checks = input.fix ? fixChecks(input) : [kindsToChooseLine(input)];
  return [
    'Survey this repository as a new contributor would, and answer the two questions your role prompt defines: which files state the conventions a change here must follow, and, in a run that fixes, which commands are its checks. The changed paths in the scope block below are what a source\'s `appliesTo` is judged against.',
    '',
    ...userRules,
    '',
    ...checks,
  ].join('\n');
}

/** The checks part of a fix run's survey task. */
function fixChecks(input: SurveyTaskInput): string[] {
  const { shell, lookup } = shellOf(input.platform, input.elevatedSandbox);
  // A kind a configuration file settled names its setting and file; one a flag settled reads as it did before the settings (R11 of the configuration).
  const byFlags = input.settled.every((entry) => entry.layer === 'flag');
  const settledLine = (entry: SurveyTaskInput['settled'][number]): string => {
    if (entry.layer === 'flag') return entry.command === null ? `- ${entry.kind}: dropped by --no-check` : `- ${entry.kind}: ${codeSpan(entry.command)} (--check)`;
    return entry.command === null ? `- ${entry.kind}: ${droppedReasonOf(entry.kind, entry.layer)}` : `- ${entry.kind}: ${codeSpan(entry.command)} (${checkSettingWords(entry.kind, entry.layer, false)})`;
  };
  const settled = input.settled.length === 0
    ? []
    : [
        byFlags ? 'Settled by the operator\'s flags, which you leave out of `checks`:' : 'Settled by the operator\'s flags and the configuration, which you leave out of `checks`:',
        ...input.settled.map(settledLine),
        '',
      ];
  if (input.unsettled.length === 0) return [kindsToChooseLine(input), '', ...settled, 'Every kind is settled, so return `checks` empty.'];
  const hints = input.hints.map((hint) => (hint.command === null ? `- ${hint.kind}: none (${hint.reading})` : `- ${hint.kind}: ${codeSpan(hint.command)} (${hint.reading})`));
  return [
    kindsToChooseLine(input),
    '',
    ...settled,
    `Return one entry in \`checks\` for each kind to choose, and none for any other. A check runs from the repository root on this machine (${input.platform}) as \`${shell}\`, which is not always the shell your own commands run in. So look up what each command starts as that shell resolves it, with ${lookup}, and judge the lookup by whether it succeeded, its exit code, not by the wording of an error. A tool the command runs through something that provides it, such as \`uv run\` with a dependency group or \`npx\` with a project dependency, needs only that to resolve. Name the first tool that does not resolve in \`missingTool\`; do not run the checks themselves.`,
    '',
    'Mechanical guesses, read off the root manifests by fixed rules that know nothing of this repository\'s CI or documentation. Use one only for a kind the repository states nothing about, and only after reading that its command fits this repository and this platform; a command taken from one is the guess exactly as written here, with `basis` `hint` and the manifest as its `source`:',
    ...hints,
  ];
}

/**
 * Where a candidate points, as a worker reads it: its repository location,
 * marked when the file is outside the change, or the finder's own location
 * with the unlocated mark.
 */
export function describeLocation(candidate: Pick<CandidateState, 'file' | 'line' | 'located' | 'inScope' | 'rawFile' | 'rawLine'>): string {
  const location = repositoryLocation(candidate);
  if (location === null) return `${rawLocation(candidate)} (unlocated: no file of the repository has this path and line)`;
  return candidate.inScope ? location : `${location} (outside the change: an unchanged file of the repository)`;
}

/** One candidate as a numbered item of a task, with the fields the worker judges by. */
function candidateItem(index: number, candidate: CandidateState, extra: readonly string[] = []): string {
  return [
    `[${String(index)}] ${candidate.id} (${candidate.angle}) at ${describeLocation(candidate)}`,
    `    summary: ${candidate.summary}`,
    `    detail: ${candidate.detail}`,
    ...extra.map((line) => `    ${line}`),
  ].join('\n');
}

const fieldNote =
  'In your JSON, each candidate has `file`, `line`, `summary` and `detail`; `detail` is the fourth field of the finder output contract, the `failure_scenario` or the `value_statement` your angle asks for. Do not invent an id: the engine assigns one to each candidate you return.';

/**
 * The commit messages of the change as the triage's task gets them (R6 of
 * the brief of a run): those git gave from the base to the head, which
 * can be none, as for a ref the head descends from, with whether the
 * change also holds what the working tree holds uncommitted, as a ref or
 * range scope does; none for a change of the working tree alone, whose
 * base is its head; or why git could not give them, which costs the
 * triage the words of the commits and never the run.
 */
export type ChangeMessages =
  | { readonly kind: 'read'; readonly messages: readonly CommitMessage[]; readonly withTree: boolean }
  | { readonly kind: 'working-tree' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** The most bytes of commit subjects the triage's task lists, and of subjects and whole messages together (R6 of the brief of a run). */
export const commitSubjectsLimitBytes = 16 * 1024;
export const commitMessagesLimitBytes = 32 * 1024;

/** The characters of a commit id the triage's task shows, enough to name it in `whyFrom`. */
const shownCommitLength = 12;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * The lines of `items`, oldest first, that fit with their bytes, with a
 * line break after each, within `limit`: one that does not fit is left
 * out and the later ones are still tried, so one long line cannot cost
 * the shorter lines after it.
 */
function withinBytes(items: readonly string[], limit: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const item of items) {
    const bytes = utf8Bytes(item) + 1;
    if (used + bytes > limit) continue;
    kept.push(item);
    used += bytes;
  }
  return kept;
}

/**
 * The commit messages of the change as the triage's task lists them (R6,
 * TD3 of the brief of a run): the subject of each commit, oldest first,
 * that fits within `commitSubjectsLimitBytes`; then each whole message,
 * oldest first, that fits while the two lists together stay within
 * `commitMessagesLimitBytes`; how many of each the limits left out; and,
 * for a change that also holds the working tree, that no commit message
 * covers its uncommitted part. A subject ends at the first line break,
 * CRLF or LF. Each list is
 * fenced, so a line of a message cannot open a section of the prompt.
 */
export function commitMessagesSection(words: ChangeMessages): string[] {
  if (words.kind === 'unreadable') {
    return [`The engine could not read the commit messages of the change (${inlineText(words.reason)}). Take the reason only from the documents the change adds or edits.`];
  }
  if (words.kind === 'working-tree') return ['The change has no commits: it is a change of the working tree. It states a reason only in the documents it adds or edits.'];
  const { messages } = words;
  const tree = words.withTree ? ['', 'The change may also hold uncommitted changes of the working tree, which no commit message covers.'] : [];
  if (messages.length === 0) return ['The change has no commits from its base to its head. It states a reason only in the documents it adds or edits.', ...tree];
  const shown = (commit: string): string => commit.slice(0, shownCommitLength);
  const subjects = withinBytes(messages.map(({ commit, message }) => `${shown(commit)} ${message.split(/\r?\n/, 1)[0] ?? ''}`), commitSubjectsLimitBytes);
  const used = subjects.reduce((total, line) => total + utf8Bytes(line) + 1, 0);
  const wholes = withinBytes(messages.map(({ commit, message }) => `commit ${shown(commit)}\n${message}\n`), commitMessagesLimitBytes - used);
  const fenced = (text: string): string[] => {
    const fence = fenceFor(text);
    return [`${fence}text`, text, fence];
  };
  const leftSubjects = messages.length - subjects.length;
  const leftWholes = messages.length - wholes.length;
  return [
    `The subjects of the ${String(messages.length)} commit${messages.length === 1 ? '' : 's'} of the change, oldest first:`,
    '',
    ...fenced(subjects.join('\n')),
    '',
    'The whole messages, oldest first:',
    '',
    ...(wholes.length === 0 ? ['(none fit within the limit)'] : fenced(wholes.join('\n').trimEnd())),
    ...(leftSubjects === 0 && leftWholes === 0 ? [] : ['', `${String(leftSubjects)} subject${leftSubjects === 1 ? '' : 's'} and ${String(leftWholes)} whole message${leftWholes === 1 ? '' : 's'} are left out at the limits.`]),
    ...tree,
  ];
}

/** The most characters of a title and of why that the triage's task asks for; the brief cuts neither (R3 of the brief of a run). */
export const accountLimits = { title: 80, why: 400 } as const;

/**
 * The triage's task (R3, R4, R6 of the brief of a run): the `SCAN` review,
 * one lead per other angle, and an account of the change, from the patch
 * and the change's own words: the commit messages listed here and the
 * documents the change adds or edits.
 */
export function triageTask(messages: ChangeMessages): string {
  return [
    'Run the `SCAN` angle over every hunk of the patch below and the enclosing function of each. Return your candidates, up to 12.',
    '',
    `Then, for EACH of the nine other angles, in this order (${finderAngles.join(', ')}), return one lead: a concrete file, symbol or mechanism the finder of that angle should inspect first, grounded in what you read, or null when the diff supports none. A lead is never a skip; every angle runs whatever you return, so name what you saw and nothing more.`,
    '',
    'Then describe the change in `change`, for a person who did not read it and for the workers that review it after you:',
    '',
    `- \`title\`: what the change is, in at most ${String(accountLimits.title)} characters.`,
    '- `what`: what the change does, in at most five sentences of plain words. Name no file, line or internal name that a reader must look up; put those in `restsOn`.',
    '- `why`: why the change does it, in the change\'s own words: quote or restate the commit messages below, or a document that the change adds or edits. Write null when they state no reason. Never give a reason of your own.',
    '- `whyFrom`: the commits or paths that `why` comes from; empty when `why` is null.',
    '- `restsOn`: the files and commits that `what` rests on, at least one.',
    '- `publicInterface`: whether the change alters a command, a flag, an exported function or type, a format of a file, or an output that a person or a program reads; when it does, one sentence in `what` that says what, and the files that show it in `files`. When it does not, `what` is null and `files` is empty.',
    '- `wideEffect`: whether the change affects many files beyond the files it changes; when it does, one sentence that says what, and the files that show it, as for `publicInterface`.',
    '',
    `Keep \`why\` within ${String(accountLimits.why)} characters. Return \`change\` as null only when you cannot describe the change at all.`,
    '',
    '### The change\'s own words',
    '',
    ...commitMessagesSection(messages),
    '',
    fieldNote,
  ].join('\n');
}

/** A finder's task: its angle and the lead the triage gave it. */
export function finderTask(angle: FinderAngle, lead: Lead | null): string {
  const leadLine = lead === null || lead.lead === null ? 'Lead: none' : `SCAN lead: ${lead.lead}`;
  return [
    `Angle: ${angle}`,
    leadLine,
    '',
    `Run the ${angle} angle as your role prompt defines it, over the whole change below. Check the lead first when there is one, then complete the full search of your angle; a lead is neither a finding nor a boundary. Return your candidates, up to 12; an empty list is a valid answer.`,
    '',
    fieldNote,
  ].join('\n');
}

/** The deduplication worker's task over a numbered pool. */
export function deduplicationTask(candidates: readonly CandidateState[]): string {
  const list = candidates.map((candidate, index) => candidateItem(index, candidate)).join('\n');
  return [
    `Below are ${String(candidates.length)} candidates, numbered [0] to [${String(candidates.length - 1)}]. Group the ones that describe the same defect at the same location for the same reason; a group has two or more members, named by their indexes, and one \`keep\`, the member whose fourth field is the most concrete, which stays on the working list. A candidate in no group stands alone; leave it out of \`groups\`. Two candidates at one line for different reasons are not duplicates. Return \`groups\` empty when nothing repeats.`,
    '',
    list,
  ].join('\n');
}

/** A verifier's task over one group. */
export function verifierTask(groupId: string, candidates: readonly CandidateState[]): string {
  const list = candidates.map((candidate, index) => candidateItem(index, candidate)).join('\n');
  return [
    `Group ${groupId}: ${String(candidates.length)} candidate${candidates.length === 1 ? '' : 's'}, numbered [0] to [${String(candidates.length - 1)}], each with the angle it came from. Read the code each points at, then return exactly one verdict per index, CONFIRMED, PLAUSIBLE or REFUTED by the rubric of that candidate's angle, with one \`evidence\` line quoting or citing the lines that justify it. An answer that misses an index is discarded whole and the group is run again. Judge each candidate on its own claim; a candidate marked unlocated still gets a verdict, from whatever code you can find for it.`,
    '',
    list,
  ].join('\n');
}

/** What the sweep is told about a candidate that survived or was refuted. */
export interface SweepInputs {
  readonly verified: readonly { candidate: CandidateState; verdict: Verdict; unverified: boolean }[];
  readonly refuted: readonly { candidate: CandidateState; evidence: string }[];
  readonly anglesNotRun: Readonly<Record<string, string>>;
}

/** The sweep's task: the verified list, the refuted list and the angles that did not run. */
export function sweepTask(inputs: SweepInputs): string {
  const verified = inputs.verified.length === 0
    ? '(none)'
    : inputs.verified.map(({ candidate, verdict, unverified }) => `- ${candidate.id} (${candidate.angle}) at ${describeLocation(candidate)}: ${candidate.summary} [${verdict}${unverified ? ', unverified' : ''}]`).join('\n');
  const refuted = inputs.refuted.length === 0
    ? '(none)'
    : inputs.refuted.map(({ candidate, evidence }) => `- ${candidate.id} (${candidate.angle}) at ${describeLocation(candidate)}: ${candidate.summary}; refuted because: ${evidence}`).join('\n');
  const notRun = Object.entries(inputs.anglesNotRun);
  const angles = notRun.length === 0
    ? 'Every angle ran.'
    : `These angles did not run, so their territory is yours to cover: ${notRun.map(([angle, reason]) => `${angle} (${reason})`).join('; ')}.`;
  return [
    'Re-read the diff and the enclosing functions looking ONLY for gaps: candidates no angle below already lists. Do not re-derive or re-confirm anything already there.',
    '',
    angles,
    '',
    'Verified candidates (already on the working list):',
    verified,
    '',
    'Refuted candidates (already judged; do not resurface them):',
    refuted,
    '',
    'Return your gap candidates, up to 12, each naming in `angle` the angle whose territory it sits in; its `detail` is that angle\'s fourth field. An empty list is the correct answer when there is nothing new.',
  ].join('\n');
}

/** The placeholder a task's snapshot command holds for the index of the finding just finished. */
export const snapshotIndexPlaceholder = '<index>';

/** The placeholder a task's claim command holds for the path of the file to claim. */
export const claimPathPlaceholder = '<path>';

/** The checks as a fixer reads them: each kind's command, or why it has none. */
/** A check that failed before any fixer edited the tree, with where its frozen output is (R24 of the fix pass). */
export interface BaselineFailure {
  readonly kind: CheckKind;
  readonly stdout: string;
  readonly stderr: string;
}

function checksBlock(checks: readonly PlannedCheck[], failing: readonly BaselineFailure[] = []): string {
  if (checks.every((check) => check.command === null)) return 'No check is available: the repository names no build, typecheck, lint or test command the engine can run, so validate your fixes with what you can run yourself.';
  return [
    'The engine runs these checks, in this order, before any fixer edits and again once every fixer has returned:',
    ...checks.map((check) => (check.command === null ? `- ${check.kind}: not available (${check.reason ?? 'no command'})` : `- ${check.kind}: ${check.command}`)),
    'Run what covers your change before you return: the tests of what you changed, not the whole suite, which the engine runs. Report what you ran in `suite`.',
    ...(failing.length === 0
      ? []
      : [
          'These failed before any fixer edited the tree; their output then is at the paths given. A failure that output does not show is yours, even when an earlier batch\'s tree already had it, unless it lies in a file you do not hold, which is a sibling\'s work in flight:',
          ...failing.map((check) => `- ${check.kind}: ${check.stdout}, ${check.stderr}`),
        ]),
  ].join('\n');
}

/**
 * The claim rule (R1, R8 of commit series integrity), with the command
 * quoted as the fixer must run it, before the first edit for a finding of
 * every file outside its own that the finding needs. A `'` in the path is
 * the fixer's to escape, since only it knows which shell runs the command.
 */
function claimBlock(command: string): string {
  return [
    `Before your first edit for a finding, run this from the repository root once for each file outside your own that the finding and its tests will touch, existing or new, with the file's path in place of ${claimPathPlaceholder}:`,
    '',
    `    ${command}`,
    '',
    'It claims the file for your cluster until your cluster\'s last batch has finished. Exit 0 means it is yours; exit 2 names the cluster that holds it, and the finding that needs it is `blocked` with the file in `requiredFiles`, as for a file another cluster owns, with no edit made for it, unless the file is a document the finding\'s edit made stale: make no edit of that one, report the stale fact in `drift`, and go on with the finding. A refusal that comes after you edited leaves the edits in place, listed under the finding\'s `edits`, with a message that says the change is partial. Report every file you edit or create under the finding it served.',
    `A path that begins with \`-\` goes in one argument, \`--path=${claimPathPlaceholder}\`, since the claim reads it as an option otherwise and refuses it with exit 1, as it does any command it cannot parse.`,
    'A path that holds a `\'` must have that quote escaped as your shell requires inside single quotes, `\'\\\'\'` in bash and `\'\'` in PowerShell, so the path stays one argument and the command runs as written.',
    'Exit 1 means the command could not run, and it prints why, such as a path outside the worktree: correct the command as the message says and run it again, and make no edit for the finding until the claim exits 0.',
  ].join('\n');
}

/** What a worker that edits answers for, one by one: a fixer's findings, the repair's checks, or the documentation step's items. */
type AnsweredUnit = 'finding' | 'check' | 'item';

/** The snapshot rule, with the command quoted as the fixer must run it. */
function snapshotBlock(command: string, unit: AnsweredUnit): string {
  return [
    `After finishing each ${unit}, and before starting the next, run this from the repository root with that ${unit}'s index in place of ${snapshotIndexPlaceholder}:`,
    '',
    `    ${command}`,
    '',
    `It copies what you changed into your scratch directory, so the engine can tell each ${unit}'s edits apart and commit them one by one; a ${unit} you do not snapshot is folded into the next one's commit.`,
  ].join('\n');
}

/**
 * The answer's fields, as every task of a worker that edits describes
 * them. Only a fixer's finding can be `blocked`: the repair and the
 * documentation step are alone in the tree and may edit every file of the
 * repository, and the engine refuses a required file outside it
 * (`resolveFixerAnswer`), so a blocked answer from either only fails the
 * attempt.
 */
function answerFields(unit: AnsweredUnit): string {
  const blocks = unit === 'finding';
  const statuses = blocks ? '`applied`, `already-applied`, `deferred` or `blocked`' : '`applied`, `already-applied` or `deferred`';
  const partial = blocks ? `a blocked or deferred ${unit}'s` : `a deferred ${unit}'s`;
  const required = blocks ? `\`requiredFiles\`, the files you were not allowed to edit that a blocked ${unit} needs, empty otherwise` : '`requiredFiles`, which stays empty';
  return `For each ${unit}, by index, return: \`status\` (${statuses}); the \`file\` and \`line\` of the fix, \`line\` null when there is none; a one-sentence \`note\`; the \`edits\` for it, null when you made no edit for it and no earlier attempt left any, otherwise the \`files\` you edited or created for it, or that hold an earlier attempt's edits for it, and their \`message\`, a \`subject\` of at most 72 characters with no trailing period and a \`body\` that says why, in the style \`git log\` shows for this repository, ${partial} saying the change is partial and what it waits for; any \`corrections\` to the brief; your \`validation\` lines; and ${required}. Return \`drift\`, \`tests\` and \`suite\` once for the whole answer. Every index appears exactly once. Every file you own whose bytes you changed must appear in some ${unit}'s \`edits\`; an answer that leaves one out is discarded and the work given to a fresh worker.`;
}

const scratchRule = 'Write logs and every other temporary file under your scratch directory, never in the repository.';

/**
 * What an editor in Codex's unelevated Windows sandbox is told it cannot
 * run, and how it validates instead (R6 of the Codex sandbox). Added to
 * the task, not to a role prompt, and only for such an editor, so no
 * other run's prompts change.
 */
export const unelevatedSandboxRule = 'Your shell runs in Codex\'s unelevated Windows sandbox, where a Node process cannot start a child whose output it captures: the build, the tests and package scripts (`npm`, `pnpm`, `npx` and what they start) fail there with `EPERM`, so do not spend turns on them. Validate a fix by what does run, such as a direct `node` probe or one test file run in a single process, with the option that keeps the test runner from starting a child for it, as `node --test --test-isolation=none <file>` does; when nothing that runs can show it, record the validation as `limited` with that reason. The engine runs the checks itself after you return.';

/**
 * The warning a fixer gets when the tree may already hold part of its
 * work, naming the ids an earlier attempt of the unit left recorded edits
 * for (R20 of the fix pass), whose commits take the message the fixer
 * gives when it verifies them.
 */
function earlierWork(unit: AnsweredUnit, unfinished: readonly string[]): string {
  const warning = `The tree may already hold part of this work: an earlier worker on it did not finish. Verify each ${unit} against the code before applying it, report one already resolved as \`already-applied\`, with \`edits\` naming the files that hold its fix and the \`message\` its commit will carry when an earlier attempt made it, and null otherwise, and never apply a change on top of itself.`;
  if (unfinished.length === 0) return warning;
  return `${warning} An earlier attempt left edits for ${unfinished.join(', ')}, recorded as that attempt's work; for each of these you report \`already-applied\` with \`edits\` naming the files that hold its edits and the \`message\` its commit will carry, as for an applied ${unit}.`;
}

/** A candidate as a task names it beside the others of its finding: what it claims, where, and what its verifier said of it alone. */
export interface TaskCandidate {
  readonly id: string;
  readonly angle: string;
  /** Where it points, as `describeLocation` writes it. */
  readonly location: string;
  readonly summary: string;
  readonly detail: string;
  /** Its own verdict, PLAUSIBLE when its group went unverified. */
  readonly verdict: Verdict;
  readonly unverified: boolean;
  /** Its verifier's evidence line, or null when its group went unverified. */
  readonly evidence: string | null;
}

/** A decision a fixer is given: a fix, or an ask whose default it applies; a finding left goes to no fixer. */
export type FixerDecision = Exclude<RecordedDecision, { readonly decision: 'leave' }>;

/** The rule a fix departs from, as its decision names it. */
type FixerDeparture = NonNullable<Extract<RecordedDecision, { readonly decision: 'fix' }>['departure']>;

/** A finding as a fixer's task gives it. */
export interface FixerTaskFinding {
  readonly id: string;
  readonly severity: Severity;
  /** The merged verdict: CONFIRMED when any candidate of the finding is. */
  readonly verdict: Verdict;
  readonly unverified: boolean;
  /** Merge-rank's summary of the finding. */
  readonly summary: string;
  /** Merge-rank's reason for the finding. */
  readonly reason: string;
  /** The primary candidate, with its own verdict beside its own evidence, so a CONFIRMED finding never pairs its verdict with a PLAUSIBLE primary's evidence. */
  readonly primary: TaskCandidate;
  /** The candidates merged into it, each with its own verdict and evidence (R7 of the decision step). */
  readonly members: readonly TaskCandidate[];
  /** What the decision step decided for it, which the fixer applies; null for a run configured before the decision step, whose plan predates it. */
  readonly decision: FixerDecision | null;
  /** The findings left as superseded by this one, which no fixer is given and this fix must remove too (R7 of the decision step). */
  readonly supersedes: readonly Pick<TaskCandidate, 'id' | 'location' | 'summary'>[];
  /**
   * For a second-round finding, what the first round said: its blocked
   * note and the files it needed (R21 of the fix pass), each with the
   * cluster that had claimed it, or null for one another cluster owned
   * (R4 of commit series integrity); null in the first round.
   */
  readonly firstRound: { readonly note: string; readonly requiredFiles: readonly { readonly path: string; readonly claimedBy: string | null }[] } | null;
  /** The author's answer to the finding's question or departure, which the fixer makes the tree hold (R4, R7 of answers); null for a finding nobody answered. */
  readonly answered: AnsweredFinding | null;
}

/**
 * What a fixer is told of a person's answer to a finding (R4, R5, R7 of
 * answers, TD9), by the answer's kind: for an option, its index and the
 * option chosen, its text, the rule the decider wrote for it and whether
 * it edits, as the report gives them to the person; for a rejection, the
 * departure it rejects, whose rule the fix is to follow; an acceptance
 * carries nothing more. Then the note, and what the run did with the
 * finding before, the last fixer's status and note and the files of its
 * revisions, or null when no fixer saw it; and the answer pass that
 * already applied it, or null while it owes an edit (R13 of resumable
 * runs).
 */
export type AnsweredFinding = {
  readonly note: string | null;
  readonly before: { readonly status: string; readonly note: string; readonly files: readonly string[] } | null;
  readonly appliedByPass: string | null;
} & (
  | { readonly kind: 'option'; readonly option: number; readonly chosen: { readonly option: string; readonly rule: string; readonly edits: boolean } }
  | { readonly kind: 'reject'; readonly departure: FixerDeparture }
  | { readonly kind: 'accept' }
);

/** A finding an earlier batch of the same cluster worked, as a later batch is told it. */
export interface FixerTaskEarlier {
  readonly batch: string;
  readonly id: string;
  /** The answer's status, or `not attempted` when the batch failed twice. */
  readonly outcome: string;
  readonly note: string | null;
}

/** What every fixer's task carries, a fixes-phase batch's and an answer pass's alike. */
interface FixerTaskShared {
  /** The batch of the cluster this fixer works (R18 of the fix pass), or the answer pass's unit key. */
  readonly batch: string;
  readonly findings: readonly FixerTaskFinding[];
  readonly owned: readonly string[];
  readonly checks: readonly PlannedCheck[];
  /** The snapshot command, holding `snapshotIndexPlaceholder` for the index. */
  readonly snapshotCommand: string;
  /** Whether an earlier worker on this cluster may have left part of its work in the tree. */
  readonly mayHoldWork: boolean;
  /** The findings an earlier attempt of this batch left recorded edits for, whose message a verifying fixer gives. */
  readonly unfinished: readonly string[];
  /** The checks that failed before any fixer edited the tree (R24). */
  readonly baselineFailures: readonly BaselineFailure[];
  /** Whether the fixer runs in Codex's unelevated Windows sandbox, so its task says what cannot run there (R6 of the Codex sandbox). */
  readonly unelevatedSandbox: boolean;
}

/** A fixes-phase batch's fixer (R18, R21 of the fix pass; R1, R8 of commit series integrity): it owns its cluster's files, is told what the cluster's earlier batches did, and claims any other file through its command. */
export interface FixerBatchTaskInput extends FixerTaskShared {
  readonly kind: 'batch';
  readonly cluster: string;
  /** Whether the batch belongs to the second round, whose findings were blocked in the first on files they now own (R21). */
  readonly secondRound: boolean;
  /** The findings the cluster's earlier batches worked, whose edits are in the tree. */
  readonly earlier: readonly FixerTaskEarlier[];
  /** The files the cluster has claimed so far in its round, which it holds as it owns its own (R1 of commit series integrity). */
  readonly claimed: readonly string[];
  /** The files every other cluster of the round owns, or has claimed and holds while it has not settled, cluster by cluster. */
  readonly othersHeld: readonly { readonly cluster: string; readonly files: readonly Pick<SpelledHolder, 'path' | 'by'>[] }[];
  /** The claim command, holding `claimPathPlaceholder` for the path. */
  readonly claimCommand: string;
}

/** An answer pass's fixer (R5 of answers): it works the answered findings alone, owns every file the run revised, may edit any other, and claims nothing. */
export interface AnswerPassTaskInput extends FixerTaskShared {
  readonly kind: 'answer-pass';
  /** The documents the run left out of date when the pass opened, each with its stale facts, which an answer it applies may settle (PD10 of the documentation step). */
  readonly leftDocuments: readonly { readonly file: string; readonly facts: readonly string[] }[];
}

export type FixerTaskInput = FixerBatchTaskInput | AnswerPassTaskInput;

const fileList = (files: readonly string[]): string => (files.length === 0 ? '(none)' : files.map((file) => `- ${file}`).join('\n'));

/** A candidate's verdict as a task prints it. */
const verdictWords = (candidate: Pick<TaskCandidate, 'verdict' | 'unverified'>): string => `${candidate.verdict}${candidate.unverified ? ' (unverified)' : ''}`;

/** The evidence line a task prints for a candidate, saying so when its verifier gave none. */
const evidenceWords = (evidence: string | null): string => evidence ?? 'none; the group\'s verifier failed twice';

/** A candidate as a fixer's or the decider's task prints it: the header line it is given, then its claim and its evidence. */
function candidateLines(head: string, candidate: TaskCandidate): string[] {
  return [
    head,
    `        summary: ${candidate.summary}`,
    `        detail: ${candidate.detail}`,
    `        evidence: ${evidenceWords(candidate.evidence)}`,
  ];
}

/**
 * What a fixer is told was decided for a finding (R7 of the decision
 * step): the approach, or the default an ask applied, with the grounds,
 * what was rejected and any rule departed from; then, for a finding the
 * author answered, the answer (`answeredLines`).
 */
function decidedLines(decision: FixerDecision, answered: AnsweredFinding | null): string[] {
  if (decision.decision === 'fix') {
    const { fix, departure } = decision;
    return [
      `    decided: fix. ${decision.grounds}`,
      `        approach: ${fix.approach}`,
      ...(fix.rejected.length === 0 ? [] : [`        rejected: ${fix.rejected.map((option) => `${option.option} (${option.reason})`).join('; ')}`]),
      ...(departure === null ? [] : [`        departs from: ${departure.rule} (${departure.source}): ${departure.reason}`]),
      ...(answered === null ? [] : answeredLines(answered)),
    ];
  }
  const { ask } = decision;
  const others = ask.options.filter((_, position) => position !== ask.applied).map((option) => option.option);
  return [
    `    decided: ask the author, applying a default now. ${decision.grounds}`,
    `        apply: ${appliedOptionOf(ask).option}`,
    `        the question the author answers later: ${ask.question} The other options: ${others.join('; ')}`,
    ...(answered === null ? [] : answeredLines(answered)),
  ];
}

/**
 * What a fixer is told of the author's answer to a finding (R4, R7 of
 * answers, TD9), by the answer's kind: the option chosen, its text and the
 * rule the decider wrote for it, given as what the option means; that the
 * fix is to follow the rule it departed from, as its source states it; or
 * that the departure stands. Then the note, and what the run did with the
 * finding before. Nothing here asks for a rule to be written or forbids it
 * (PD3).
 */
function answeredLines(answered: AnsweredFinding): string[] {
  const note = answered.note === null ? '' : ` Note: ${inlineText(answered.note)}`;
  const line = `${answerLine(answered)}${note}`;
  const before = answered.before;
  const did = before === null ? 'no fixer saw it before' : `the run's last fixer of it answered ${before.status}: ${before.note}${before.files.length === 0 ? '' : `, in ${before.files.join(', ')}`}`;
  // A batch a reopened fix pass launches after an answer pass applied its finding's answer keeps that edit (R13 of resumable runs).
  const applied = answered.appliedByPass === null ? [] : [`        the answer pass ${answered.appliedByPass} already applied this answer, and the tree holds it: answer already-applied and keep that edit, and do not apply the default again`];
  return [`        ${line}`, `        before the answer: ${did}`, ...applied];
}

/** The author's answer as a fixer's task words it, by its kind. */
function answerLine(answered: AnsweredFinding): string {
  switch (answered.kind) {
    case 'option':
      return `answered by the author: option ${String(answered.option + 1)}, "${answered.chosen.option}", for which the decider wrote the rule "${answered.chosen.rule}".`;
    case 'reject':
      return `the author rejected the departure: follow the rule "${answered.departure.rule}" as ${answered.departure.source} states it, and restore what the fix changed in that statement.`;
    case 'accept':
      return 'the author accepted the departure.';
  }
}

/** What a fixer's task says of the findings the author answered: make the tree hold the answer, which takes the place of the default, and say in the message which question was answered and how (R4, R7 of answers). It says nothing about stating a rule (PD3). */
const answeredRule = 'A finding marked "answered by the author", or whose departure the author rejected or accepted, carries the author\'s answer, given after the run\'s report: it takes the place of the default the decision named. Make the tree hold what the author decided: undo the edit the default made where it made one, and make the edit the answer calls for, within the finding\'s files and whatever else it needs; an accepted departure needs no edit beyond the fix as decided. In the message\'s `body`, say which question was answered and how.';

/** What a fixer's task says of the decisions it carries: apply them, and defer only by the role prompt's criteria, never over a choice the decision made (R7, R12 of the decision step). */
const decidedRule = 'Each finding carries what was decided for it before any fixer ran, with the grounds: apply it the way the decision says, and for an ask, apply the default it names; the author answers the question later. Never defer a finding over a choice its decision made: defer only by the criteria of your role prompt, and when the reason is a fact the decision did not see, name that fact in `note`. When applying the decision changes a behavior a test pins, change that test with the fix and say which test and why in `note` and in the message\'s `body`.';

/**
 * What a fixer's task says of the unit it works, by its kind: the head
 * that names it; for a batch, what its round and its cluster's earlier
 * batches did; and the files it holds. A batch owns its cluster's files and
 * claims others; an answer pass owns what the run revised and may edit any
 * other file, as the repair may.
 */
function unitLines(input: FixerTaskInput): { readonly head: string; readonly round: readonly string[]; readonly ownership: readonly string[] } {
  switch (input.kind) {
    case 'answer-pass':
      return {
        head: `Answer pass ${input.batch}`,
        round: [],
        ownership: [
          'Files you own: every file the run revised, and the files these findings are located in.',
          fileList(input.owned),
          '',
          'You may edit any other file of the repository when the answer needs it; report every file you edit or create under the finding it served.',
          ...(input.leftDocuments.length === 0
            ? []
            : [
                '',
                'Documents this run left out of date, which an answer you apply may settle:',
                input.leftDocuments.map((document) => `- ${document.file}${document.facts.length === 0 ? '' : `: ${document.facts.join('; ')}`}`).join('\n'),
                '',
                'Bring such a document in line when an answer you apply settles what it must say, and name it under that answer\'s finding; leave the others as they are. When you change such a file and leave a fact of it stale, report that fact in `drift`.',
              ]),
        ],
      };
    case 'batch': {
      const others = input.othersHeld.filter((cluster) => cluster.files.length > 0);
      const held = [...input.owned, ...input.claimed.filter((path) => !input.owned.includes(path)).map((path) => `${path} (claimed)`)];
      return {
        head: `Cluster ${input.cluster}, batch ${input.batch}${input.secondRound ? ', in the second round' : ''}`,
        round: [
          ...(input.secondRound ? ['Each of these was blocked in the first round on files another cluster owned or had claimed. Every first-round fixer has finished, and those files are now yours: apply the fix the finding needs there, its tests included.', ''] : []),
          ...(input.earlier.length === 0
            ? []
            : [
                input.secondRound
                  ? 'Findings the first round worked in your files, and this cluster\'s earlier batches; their edits are already in the tree, so build on them and neither redo nor undo them:'
                  : 'Findings of this cluster that earlier batches worked, one after another before yours; their edits are already in the tree, so build on them and neither redo nor undo them:',
                input.earlier.map((entry) => `- ${entry.batch} ${entry.id} ${entry.outcome}${entry.note === null ? '' : `: ${entry.note}`}`).join('\n'),
                '',
              ]),
        ],
        ownership: [
          'Files you own while this batch runs, which no other worker edits:',
          fileList(held),
          '',
          'Files other clusters own or have claimed, which you must not edit; a fix that needs one is `blocked`, naming it in `requiredFiles`, unless it is a document the fix made stale, which goes in `drift`:',
          others.length === 0 ? '(none)' : others.flatMap((cluster) => cluster.files.map((file) => `- ${file.path} (${cluster.cluster}${file.by === 'claim' ? ', claimed' : ''})`)).join('\n'),
          '',
          claimBlock(input.claimCommand),
        ],
      };
    }
  }
}

/** A fixer's task (R4, R18 of the fix pass; R8 of commit series integrity): its batch's findings numbered in rank order, what the cluster's earlier batches did, the ownership rule with the files it holds and the files other clusters hold, the claim command, the checks, the snapshot command and the answer it returns. */
export function fixerTask(input: FixerTaskInput): string {
  const count = input.findings.length;
  const findings = input.findings.map((finding, index) => [
    `[${String(index)}] ${finding.id} [${finding.severity}] ${verdictWords(finding)} (${finding.primary.angle}) at ${finding.primary.location}`,
    `    summary: ${finding.summary}`,
    `    reason: ${finding.reason}`,
    ...candidateLines(`    primary: ${finding.primary.id} (${finding.primary.angle}) at ${finding.primary.location}: ${verdictWords(finding.primary)}`, finding.primary),
    ...finding.members.flatMap((member) => candidateLines(`    merged: ${member.id} (${member.angle}) at ${member.location}: ${verdictWords(member)}`, member)),
    ...(finding.decision === null ? [] : decidedLines(finding.decision, finding.answered)),
    ...finding.supersedes.map((left) => `    removes also: ${left.id} at ${left.location}: ${left.summary} (left because this fix removes it, and given to no fixer: check it is gone)`),
    ...(finding.firstRound === null ? [] : [`    first round: blocked, needing ${finding.firstRound.requiredFiles.map((file) => (file.claimedBy === null ? file.path : `${file.path} (which ${file.claimedBy} had claimed)`)).join(', ')}: ${finding.firstRound.note}`]),
  ].join('\n'));
  const decided = input.findings.some((finding) => finding.decision !== null);
  const answered = input.findings.some((finding) => finding.answered !== null);
  const { head, round, ownership } = unitLines(input);
  return [
    `${head}: ${String(count)} finding${count === 1 ? '' : 's'}, numbered [0] to [${String(count - 1)}], in the order to apply them.`,
    '',
    ...findings,
    '',
    ...(decided ? [decidedRule, ''] : []),
    ...(answered ? [answeredRule, ''] : []),
    ...round,
    ...ownership,
    '',
    checksBlock(input.checks, input.baselineFailures),
    '',
    ...(input.unelevatedSandbox ? [unelevatedSandboxRule, ''] : []),
    snapshotBlock(input.snapshotCommand, 'finding'),
    '',
    ...(input.mayHoldWork ? [earlierWork('finding', input.unfinished), ''] : []),
    answerFields('finding'),
    '',
    scratchRule,
  ].join('\n');
}

/** The most bytes of a failing check's stdout and of its stderr a repair task carries inline; the whole is frozen at the path given. */
export const repairTailBytes = 16 * 1024;

/** A failing check as the repair worker is told it. */
export interface RepairTaskCheck {
  readonly kind: CheckKind;
  readonly command: string;
  readonly outcome: 'failed' | 'timeout';
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** The output's last `repairTailBytes` bytes, and the path of the whole, frozen. */
  readonly stdout: { readonly tail: Buffer; readonly path: string };
  readonly stderr: { readonly tail: Buffer; readonly path: string };
  /** For a check that failed before any fixer edited the tree too, its output then (R24); null for one that passed. */
  readonly baseline: { readonly stdout: { readonly tail: Buffer; readonly path: string }; readonly stderr: { readonly tail: Buffer; readonly path: string } } | null;
}

export interface RepairTaskInput {
  readonly checks: readonly RepairTaskCheck[];
  /** Every file the fixers changed, which the repair owns. */
  readonly owned: readonly string[];
  /** What each fixer did, one line per finding, under the batch that answered it. */
  readonly answers: readonly { readonly batch: string; readonly id: string; readonly status: string; readonly note: string }[];
  readonly allChecks: readonly PlannedCheck[];
  readonly snapshotCommand: string;
  readonly mayHoldWork: boolean;
  /** The checks an earlier attempt of the repair left recorded edits for. */
  readonly unfinished: readonly string[];
  /** Whether the repair worker runs in Codex's unelevated Windows sandbox, so its task says what cannot run there (R6 of the Codex sandbox). */
  readonly unelevatedSandbox: boolean;
}

/** One stream's tail, fenced so the output cannot close the fence. */
function outputTail(name: string, tail: Buffer, path: string): string {
  const text = tail.toString('utf8');
  if (text.trim() === '') return `    ${name}: empty (frozen at ${path})`;
  const fence = fenceFor(text);
  return [`    ${name}, its last ${String(tail.length)} bytes (the whole is at ${path}):`, `${fence}text`, text.endsWith('\n') ? text.slice(0, -1) : text, fence].join('\n');
}

/** How a failing check ended, for its repair: killed at its timeout, ended by a kill mark or a guard that left no result, which only a second cut fails with, or its exit code. */
function repairCheckEnd(check: RepairTaskCheck): string {
  if (check.outcome === 'timeout') return 'ran past its timeout and was killed';
  // A failed check exited: a skipped one is no repair target, and one that did not start is not failed.
  const end = { termination: 'exited', exitCode: check.exitCode, signal: check.signal } as const;
  return endedByKill(end) ? `ended with ${killMarkWords(end)}` : `exited with code ${String(check.exitCode)}`;
}

/** The repair worker's task (R11, R24 of the fix pass): every check failing after the fixes with its output, and its output before them when it failed then too, the files it owns, what each fixer did, and the same answer as a fixer's with the checks as its findings. */
export function repairTask(input: RepairTaskInput): string {
  const count = input.checks.length;
  const checks = input.checks.map((check, index) => [
    `[${String(index)}] ${check.kind}: ${check.command}`,
    `    ${repairCheckEnd(check)}`,
    outputTail('stdout', check.stdout.tail, check.stdout.path),
    outputTail('stderr', check.stderr.tail, check.stderr.path),
    ...(check.baseline === null
      ? ['    It passed before any fixer edited the tree.']
      : [
          '    It failed before any fixer edited the tree too: fix only the failures its output then does not show, and answer `deferred` naming them when every failure was there before. Its output then:',
          outputTail('stdout', check.baseline.stdout.tail, check.baseline.stdout.path),
          outputTail('stderr', check.baseline.stderr.tail, check.baseline.stderr.path),
        ]),
  ].join('\n'));
  return [
    `Repair: ${String(count)} check${count === 1 ? '' : 's'}, numbered [0] to [${String(count - 1)}], fail${count === 1 ? 's' : ''} after the fixers' edits. Make each pass again without undoing an applied fix: read its output, find what the fixers' edits broke, and fix that. A check is \`applied\` when it passes after your change, and \`deferred\` with the reason when it cannot be made to pass here, as when it needs a file outside the repository, which no worker of the run can edit.`,
    '',
    ...checks,
    '',
    'Files you own: every file the fixers changed.',
    fileList(input.owned),
    '',
    'You may edit any other file of the repository when a repair needs it; report every file you edit or create under the check it served.',
    '',
    'What each fixer did:',
    input.answers.length === 0 ? '(nothing recorded)' : input.answers.map((answer) => `- ${answer.batch} ${answer.id} ${answer.status}: ${answer.note}`).join('\n'),
    '',
    checksBlock(input.allChecks),
    '',
    ...(input.unelevatedSandbox ? [unelevatedSandboxRule, ''] : []),
    snapshotBlock(input.snapshotCommand, 'check'),
    '',
    ...(input.mayHoldWork ? [earlierWork('check', input.unfinished), ''] : []),
    `${answerFields('check')} The message in an applied check's \`edits\` describes what the repair changed.`,
    '',
    scratchRule,
  ].join('\n');
}

/** A document the `drift` lines of the fixes name, as the documentation step's task gives it (R2 of the documentation step). */
export interface DocumentationTaskDocument {
  /** `doc-1` to `doc-n`. */
  readonly id: string;
  /** The path as the first of its lines wrote it. */
  readonly file: string;
  /** The repository path it names, or null when the engine refused it as one. */
  readonly path: string | null;
  /** Each line with the batch that reported it, and the path as that line wrote it. */
  readonly drift: readonly { readonly batch: string; readonly file: string; readonly what: string }[];
}

/** What a fixer of the fixes did with one finding, as the documentation step is told it. */
export interface DocumentationTaskFix {
  readonly batch: string;
  readonly id: string;
  readonly status: string;
  readonly note: string;
  /** The files of its edits, none for a finding it made no edit for. */
  readonly files: readonly string[];
  /** The subject of the commit its edits carry, or null for none. */
  readonly subject: string | null;
  /** What was decided for it, and for an ask the option in place or the person's answer, in the task's words; null in a run configured before the decision step. */
  readonly decided: string | null;
}

/** The documentation step's task input (R2 to R5, PD11 of the documentation step). */
export interface DocumentationTaskInput {
  /** The documents, in the plan's order; the search follows them. */
  readonly documents: readonly DocumentationTaskDocument[];
  /** What each fixer of the fixes did, batch by batch. */
  readonly fixes: readonly DocumentationTaskFix[];
  /** The path of the patch of each revision of the fixes, in ledger order, with the subject of its commit. */
  readonly patches: readonly { readonly path: string; readonly subject: string }[];
  /** Every path the fixes revised and the repository path of each document, which the step owns (TD9). */
  readonly owned: readonly string[];
  /** The patterns `scope.exclude` keeps out of the review, whose paths the step leaves (PD11). */
  readonly exclude: readonly string[];
  readonly checks: readonly PlannedCheck[];
  readonly snapshotCommand: string;
  readonly mayHoldWork: boolean;
  /** The items an earlier attempt of the step left recorded edits for. */
  readonly unfinished: readonly string[];
  /** Whether the worker runs in Codex's unelevated Windows sandbox (R6 of the Codex sandbox). */
  readonly unelevatedSandbox: boolean;
}

/** A document of the step's task: its index and id, its path as the fixers wrote it and as the repository holds it, then each of its lines with the batch that reported it. */
function documentLines(index: number, document: DocumentationTaskDocument): string {
  const where = document.path === null
    ? `${document.file}, which the engine refused as a path of the repository: answer it \`deferred\`, a path you cannot edit`
    : document.path === document.file ? document.path : `${document.file}, the repository path ${document.path}`;
  return [
    `[${String(index)}] ${document.id}: ${where}`,
    ...document.drift.map((line) => `    ${line.batch}${line.file === document.file ? '' : ` (as ${line.file})`}: ${line.what}`),
  ].join('\n');
}

/** What the fixes did, finding by finding, as the step reads it: the status and note, the files and the subject of the commit, and what was decided. */
function fixLines(fix: DocumentationTaskFix): string {
  const edits = fix.files.length === 0 ? '' : `; edited ${fix.files.join(', ')}${fix.subject === null ? '' : `, committed as "${fix.subject}"`}`;
  return [`- ${fix.batch} ${fix.id} ${fix.status}: ${fix.note}${edits}`, ...(fix.decided === null ? [] : [`    ${fix.decided}`])].join('\n');
}

/**
 * The documentation step's task (R2 to R5, PD7, PD11 of the documentation
 * step): its items numbered from [0], each document the fixers named with
 * its lines and then the search; what each fixer did with the decisions
 * and answers, and the path of each patch of the fixes, which holds their
 * edits apart from the change under review; the files it owns, with any
 * other free; the rules of what it writes and what it leaves; the statuses
 * it answers with, `blocked` not among them; and the checks, the snapshot
 * command and the answer fields, as the repair's task gives them.
 */
export function documentationTask(input: DocumentationTaskInput): string {
  const count = input.documents.length + 1;
  const search = input.documents.length;
  return [
    `Documentation: ${String(count)} item${count === 1 ? '' : 's'}, numbered [0] to [${String(count - 1)}]. Bring the documentation of the repository in line with the edits of the fix pass, which the fixers below made, and edit documentation only: text for a person, such as a document, a changelog, or a comment in the code that describes the changed behavior.`,
    '',
    ...input.documents.map((document, index) => documentLines(index, document)),
    `[${String(search)}] search: other documentation that the edits of the fix pass made out of date, which no item above names. Search the repository for it, also where no fixer reported anything.`,
    '',
    'What the fixers did, finding by finding:',
    input.fixes.length === 0 ? '(nothing recorded)' : input.fixes.map(fixLines).join('\n'),
    '',
    'The patch of each edit of the fixes, in the order of its commit, which holds the edits of this run apart from the change under review:',
    input.patches.length === 0 ? '(none)' : input.patches.map((patch) => `- ${patch.path} (${patch.subject})`).join('\n'),
    '',
    'Files you own: every file the fixes changed, and the repository path of each document above.',
    fileList(input.owned),
    '',
    'You may edit any other file of the repository when an item needs it; report every file you edit or create under the item it served.',
    '',
    'Write only what the code of the tree, a decision above or an answer of the author settles, and no behavior that an open question still leaves to the author. Leave each convention source the scope lists as it is, with the amendment of a rule that a fix departing from it made. Leave a fact that was out of date before this run, and a historical or append-only record as the rules of the repository ask. Change no code, test or configuration to make a document true.',
    input.exclude.length === 0
      ? 'The review left no path out by `scope.exclude`.'
      : `Leave each path that these \`scope.exclude\` patterns match, which the review leaves out, such as built output; for a stale fact in one, answer \`deferred\` and name the setting \`scope.exclude\` as the reason:\n${input.exclude.map((pattern) => `- ${pattern}`).join('\n')}`,
    '',
    'An item is `applied` when you brought its document in line, `already-applied` when it was correct and you made no edit, and `deferred` when you leave it, with the reason in `note`: a choice that nothing settled, a rule, or a path you cannot edit. No item is `blocked`: nothing holds a file from you. For the search, `file` is the first document you brought in line, or `.` when you changed none. In `drift`, list each document you found out of date at your end and did not bring in line.',
    '',
    checksBlock(input.checks),
    '',
    ...(input.unelevatedSandbox ? [unelevatedSandboxRule, ''] : []),
    snapshotBlock(input.snapshotCommand, 'item'),
    '',
    ...(input.mayHoldWork ? [earlierWork('item', input.unfinished), ''] : []),
    answerFields('item'),
    '',
    scratchRule,
  ].join('\n');
}

/** One finding as the decider's task gives it: its id, severity and merged verdict, merge-rank's summary and reason, and every candidate of it, primary first. */
export interface DeciderTaskFinding {
  readonly id: string;
  readonly severity: Severity;
  readonly verdict: Verdict;
  readonly summary: string;
  readonly reason: string;
  /** The primary first, then the members, each with its own verdict and evidence. */
  readonly candidates: readonly TaskCandidate[];
}

/**
 * The decider's task (R2, R3 of the decision step): every ranked finding,
 * numbered in rank order, each with every candidate merged into it and
 * that candidate's own verdict and evidence, then the answer it returns.
 */
export function deciderTask(findings: readonly DeciderTaskFinding[]): string {
  const count = findings.length;
  const list = findings.map((finding, position) => [
    `[${String(position)}] ${finding.id} [${finding.severity}] ${finding.verdict}: ${finding.summary}`,
    `    merge and rank: ${finding.reason}`,
    ...finding.candidates.flatMap((candidate, at) => candidateLines(`    - ${candidate.id} (${candidate.angle})${at === 0 ? ' primary' : ''} at ${candidate.location}: ${verdictWords(candidate)}`, candidate)),
  ].join('\n'));
  return [
    `The review's ${String(count)} finding${count === 1 ? '' : 's'}, numbered [0] to [${String(count - 1)}], each with every candidate merged into it, its verdict and its verifier's evidence. Decide each one as your role prompt defines it: \`fix\`, \`leave\` or \`ask\`.`,
    '',
    ...list,
    '',
    'For each finding, by index, return: `decision`; one `grounds` sentence that says what settled it, citing it; and the one object its decision names, the other two null. `fix` gives the `approach` a fix worker applies and the options you `rejected`, each with why. `leave` gives its `reason`, and for `superseded` the index of the finding decided `fix` whose fix removes this one in `supersededBy`, null otherwise. `ask` gives one `question`; two to four `options`, each with its `cost`, the `rule` a convention source would state if the author chose it, and whether it `edits` the code; the index of the option you `recommended` and of the one `applied`, the default a fix worker applies now; and where you `searched` for an answer. `departure` is the `rule` a `fix` departs from, its `source` and the `reason`, and null for every other decision and for a fix that departs from nothing. Every index appears exactly once. In any text you write, name another finding by its id, as `RIPPLE-2`, never by its index or its number here: the text is read where those mean nothing.',
  ].join('\n');
}

/** What merge-rank is told about a candidate of the working list. */
export interface RankInput {
  readonly candidate: CandidateState;
  readonly verdict: Verdict;
  readonly unverified: boolean;
  readonly evidence: string | null;
}

/** The merge-rank task over the numbered working list. */
export function mergeRankTask(inputs: readonly RankInput[]): string {
  const list = inputs.map(({ candidate, verdict, unverified, evidence }, index) =>
    candidateItem(index, candidate, [`verdict: ${verdictWords({ verdict, unverified })}`, `evidence: ${evidenceWords(evidence)}`]),
  ).join('\n');
  return [
    `The working list holds ${String(inputs.length)} finding${inputs.length === 1 ? '' : 's'}, numbered [0] to [${String(inputs.length - 1)}], every one CONFIRMED or PLAUSIBLE. Fold findings that share one root cause across locations into one: name the best-described as \`primary\` and the others as its \`members\`, by index. Merge only on a genuinely shared root cause; two defects that merely look alike stay separate, each a finding with no members. Every index appears exactly once, as a primary or as a member. Give each finding a \`severity\` (critical, major or minor), a \`summary\` that names the other sites when there are any, and a \`reason\`; a \`CONVENTIONS\` violation takes the severity of the rule it breaks. The engine orders the findings itself: by severity, then CONFIRMED before PLAUSIBLE, then the correctness angles and \`CONVENTIONS\` before \`DESIGN\`, \`DUPLICATION\` and \`ALTITUDE\`, then by primary id. The order you return them in is not kept.`,
    '',
    list,
  ].join('\n');
}

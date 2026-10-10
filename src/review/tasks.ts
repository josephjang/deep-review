/**
 * The task text each role receives (R7 of the read-only review; R4, R11 of
 * the fix pass). Every task numbers what it hands over `[0]`, `[1]`, ...
 * (candidates, findings, failing checks) so the worker refers to them by
 * index (TD4), and describes the same fields its output schema demands
 * (R4). The closing sentence is appended by the prompt composer.
 */
import { appliedOptionOf, type PlannedCheck } from '../checkpoint/fix-state.ts';
import { rawLocation, repositoryLocation, type CandidateState } from '../checkpoint/review-fold.ts';
import type { Lead, RecordedDecision } from '../checkpoint/events.ts';
import type { CheckHint } from './checks/discover.ts';
import type { ReviewerAuthorship } from './conventions.ts';
import { fenceFor } from './prompts.ts';
import { finderAngles, type CheckKind, type FinderAngle, type Severity, type Verdict } from './vocabulary.ts';

/** What the surveyor's task names that the surveyor cannot see (R2 to R5, R11 of the repository survey). */
export interface SurveyTaskInput {
  readonly platform: NodeJS.Platform;
  /** Whether the run fixes, and so asks for checks (PD10). */
  readonly fix: boolean;
  /** The kinds a flag settled, with the flag's command, or null for one it dropped. */
  readonly settled: readonly { readonly kind: CheckKind; readonly command: string | null }[];
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
 * fix, that no check is asked for.
 */
export function surveyTask(input: SurveyTaskInput): string {
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

/**
 * Text as a Markdown code span the text cannot close, the CommonMark way:
 * a delimiter one backtick longer than the longest run the text holds,
 * and a space inside each end when the text starts or ends with a
 * backtick, which would otherwise join the delimiter, or starts and ends
 * with a space, of which a renderer strips one from each end.
 */
export function codeSpan(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const delimiter = '`'.repeat(longest + 1);
  const padded = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '');
  const pad = padded ? ' ' : '';
  return `${delimiter}${pad}${text}${pad}${delimiter}`;
}

/** The checks part of a fix run's survey task. */
function fixChecks(input: SurveyTaskInput): string[] {
  const { shell, lookup } = shellOf(input.platform, input.elevatedSandbox);
  const settled = input.settled.length === 0
    ? []
    : [
        'Settled by the operator\'s flags, which you leave out of `checks`:',
        ...input.settled.map((entry) => (entry.command === null ? `- ${entry.kind}: dropped by --no-check` : `- ${entry.kind}: ${codeSpan(entry.command)} (--check)`)),
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

/** The triage's task: the `SCAN` review and one lead per other angle. */
export function triageTask(): string {
  return [
    'Run the `SCAN` angle over every hunk of the patch below and the enclosing function of each. Return your candidates, up to 12.',
    '',
    `Then, for EACH of the nine other angles, in this order (${finderAngles.join(', ')}), return one lead: a concrete file, symbol or mechanism the finder of that angle should inspect first, grounded in what you read, or null when the diff supports none. A lead is never a skip; every angle runs whatever you return, so name what you saw and nothing more.`,
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
    'The engine runs these checks, in this order, before any fixer edits and again after every fixer returns:',
    ...checks.map((check) => (check.command === null ? `- ${check.kind}: not available (${check.reason ?? 'no command'})` : `- ${check.kind}: ${check.command}`)),
    'Run the ones that cover your change before you return, and report the suite you ran in `suite`.',
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
    'It claims the file for your cluster until your cluster\'s last batch has finished. Exit 0 means it is yours; exit 2 names the cluster that holds it, and the finding that needs it is `blocked` with the file in `requiredFiles`, as for a file another cluster owns, with no edit made for it. A refusal that comes after you edited leaves the edits in place, listed under the finding, with a message that says the change is partial. Report every file you edit or create under the finding it served.',
    `A path that begins with \`-\` goes in one argument, \`--path=${claimPathPlaceholder}\`, since the claim reads it as an option otherwise and refuses it with exit 1, as it does any command it cannot parse.`,
    'A path that holds a `\'` must have that quote escaped as your shell requires inside single quotes, `\'\\\'\'` in bash and `\'\'` in PowerShell, so the path stays one argument and the command runs as written.',
    'Exit 1 means the command could not run, and it prints why, such as a path outside the worktree: correct the command as the message says and run it again, and make no edit for the finding until the claim exits 0.',
  ].join('\n');
}

/** The snapshot rule, with the command quoted as the fixer must run it. */
function snapshotBlock(command: string, unit: 'finding' | 'check'): string {
  return [
    `After finishing each ${unit}, and before starting the next, run this from the repository root with that ${unit}'s index in place of ${snapshotIndexPlaceholder}:`,
    '',
    `    ${command}`,
    '',
    `It copies what you changed into your scratch directory, so the engine can tell each ${unit}'s edits apart and commit them one by one; a ${unit} you do not snapshot is folded into the next one's commit.`,
  ].join('\n');
}

/** The answer's fields, as both fixer tasks describe them. */
const answerFields = (unit: 'finding' | 'check'): string =>
  `For each ${unit}, by index, return: \`status\` (\`applied\`, \`already-applied\`, \`deferred\` or \`blocked\`); the \`file\` and \`line\` of the fix, \`line\` null when there is none; a one-sentence \`note\`; the \`files\` you edited or created for it, or that hold an earlier attempt's edits for it; a \`message\` for every ${unit} that names files, whatever its status, a \`subject\` of at most 72 characters with no trailing period and a \`body\` that says why, in the style \`git log\` shows for this repository, a blocked or deferred ${unit}'s saying the change is partial and what it waits for, and null for a ${unit} that names no file; any \`corrections\` to the brief; your \`validation\` lines; and \`requiredFiles\`, the files you were not allowed to edit that a blocked ${unit} needs, empty otherwise. Return \`drift\`, \`tests\` and \`suite\` once for the whole answer. Every index appears exactly once. Every file you own whose bytes you changed must appear in some ${unit}'s \`files\`; an answer that leaves one out is discarded and the work given to a fresh worker.`;

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
function earlierWork(unit: 'finding' | 'check', unfinished: readonly string[]): string {
  const warning = `The tree may already hold part of this work: an earlier worker on it did not finish. Verify each ${unit} against the code before applying it, report one already resolved as \`already-applied\` with the files that hold its fix, and never apply a change on top of itself.`;
  if (unfinished.length === 0) return warning;
  return `${warning} An earlier attempt left edits for ${unfinished.join(', ')}, recorded as that attempt's work; for each of these you report \`already-applied\` with the \`files\` that hold its edits, and give the \`message\` its commit will carry, as for an applied ${unit}.`;
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
}

/** A finding an earlier batch of the same cluster worked, as a later batch is told it. */
export interface FixerTaskEarlier {
  readonly batch: string;
  readonly id: string;
  /** The answer's status, or `not attempted` when the batch failed twice. */
  readonly outcome: string;
  readonly note: string | null;
}

export interface FixerTaskInput {
  readonly cluster: string;
  /** The batch of the cluster this fixer works (R18 of the fix pass). */
  readonly batch: string;
  /** Whether the batch belongs to the second round, whose findings were blocked in the first on files they now own (R21). */
  readonly secondRound: boolean;
  readonly findings: readonly FixerTaskFinding[];
  /** The findings the cluster's earlier batches worked, whose edits are in the tree. */
  readonly earlier: readonly FixerTaskEarlier[];
  readonly owned: readonly string[];
  /** The files the cluster has claimed so far in its round, which it holds as it owns its own (R1 of commit series integrity). */
  readonly claimed: readonly string[];
  /** The files every other cluster of the round owns, or has claimed and holds while it has not settled, cluster by cluster. */
  readonly othersHeld: readonly { readonly cluster: string; readonly files: readonly { readonly path: string; readonly by: 'plan' | 'claim' }[] }[];
  readonly checks: readonly PlannedCheck[];
  /** The snapshot command, holding `snapshotIndexPlaceholder` for the index. */
  readonly snapshotCommand: string;
  /** The claim command, holding `claimPathPlaceholder` for the path. */
  readonly claimCommand: string;
  /** Whether an earlier worker on this cluster may have left part of its work in the tree. */
  readonly mayHoldWork: boolean;
  /** The findings an earlier attempt of this batch left recorded edits for, whose message a verifying fixer gives. */
  readonly unfinished: readonly string[];
  /** The checks that failed before any fixer edited the tree (R24). */
  readonly baselineFailures: readonly BaselineFailure[];
  /** Whether the fixer runs in Codex's unelevated Windows sandbox, so its task says what cannot run there (R6 of the Codex sandbox). */
  readonly unelevatedSandbox: boolean;
}

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

/** What a fixer is told was decided for a finding (R7 of the decision step): the approach, or the default an ask applied, with the grounds, what was rejected and any rule departed from. */
function decidedLines(decision: FixerDecision): string[] {
  if (decision.decision === 'fix') {
    const { fix, departure } = decision;
    return [
      `    decided: fix. ${decision.grounds}`,
      `        approach: ${fix.approach}`,
      ...(fix.rejected.length === 0 ? [] : [`        rejected: ${fix.rejected.map((option) => `${option.option} (${option.reason})`).join('; ')}`]),
      ...(departure === null ? [] : [`        departs from: ${departure.rule} (${departure.source}): ${departure.reason}`]),
    ];
  }
  const { ask } = decision;
  const others = ask.options.filter((_, position) => position !== ask.applied).map((option) => option.option);
  return [
    `    decided: ask the author, applying a default now. ${decision.grounds}`,
    `        apply: ${appliedOptionOf(ask).option}`,
    `        the question the author answers later: ${ask.question} The other options: ${others.join('; ')}`,
  ];
}

/** What a fixer's task says of the decisions it carries: apply them, and defer only by the role prompt's criteria, never over a choice the decision made (R7, R12 of the decision step). */
const decidedRule = 'Each finding carries what was decided for it before any fixer ran, with the grounds: apply it the way the decision says, and for an ask, apply the default it names; the author answers the question later. Never defer a finding over a choice its decision made: defer only by the criteria of your role prompt, and when the reason is a fact the decision did not see, name that fact in `note`. When applying the decision changes a behavior a test pins, change that test with the fix and say which test and why in `note` and in the message\'s `body`.';

/** A fixer's task (R4, R18 of the fix pass; R8 of commit series integrity): its batch's findings numbered in rank order, what the cluster's earlier batches did, the ownership rule with the files it holds and the files other clusters hold, the claim command, the checks, the snapshot command and the answer it returns. */
export function fixerTask(input: FixerTaskInput): string {
  const count = input.findings.length;
  const findings = input.findings.map((finding, index) => [
    `[${String(index)}] ${finding.id} [${finding.severity}] ${verdictWords(finding)} (${finding.primary.angle}) at ${finding.primary.location}`,
    `    summary: ${finding.summary}`,
    `    reason: ${finding.reason}`,
    ...candidateLines(`    primary: ${finding.primary.id} (${finding.primary.angle}) at ${finding.primary.location}: ${verdictWords(finding.primary)}`, finding.primary),
    ...finding.members.flatMap((member) => candidateLines(`    merged: ${member.id} (${member.angle}) at ${member.location}: ${verdictWords(member)}`, member)),
    ...(finding.decision === null ? [] : decidedLines(finding.decision)),
    ...finding.supersedes.map((left) => `    removes also: ${left.id} at ${left.location}: ${left.summary} (left because this fix removes it, and given to no fixer: check it is gone)`),
    ...(finding.firstRound === null ? [] : [`    first round: blocked, needing ${finding.firstRound.requiredFiles.map((file) => (file.claimedBy === null ? file.path : `${file.path} (which ${file.claimedBy} had claimed)`)).join(', ')}: ${finding.firstRound.note}`]),
  ].join('\n'));
  const decided = input.findings.some((finding) => finding.decision !== null);
  const others = input.othersHeld.filter((cluster) => cluster.files.length > 0);
  const held = [...input.owned, ...input.claimed.filter((path) => !input.owned.includes(path)).map((path) => `${path} (claimed)`)];
  return [
    `Cluster ${input.cluster}, batch ${input.batch}${input.secondRound ? ', in the second round' : ''}: ${String(count)} finding${count === 1 ? '' : 's'}, numbered [0] to [${String(count - 1)}], in the order to apply them.`,
    '',
    ...findings,
    '',
    ...(decided ? [decidedRule, ''] : []),
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
    'Files you own while this batch runs, which no other worker edits:',
    fileList(held),
    '',
    'Files other clusters own or have claimed, which you must not edit; a fix that needs one is `blocked`, naming it in `requiredFiles`:',
    others.length === 0 ? '(none)' : others.flatMap((cluster) => cluster.files.map((file) => `- ${file.path} (${cluster.cluster}${file.by === 'claim' ? ', claimed' : ''})`)).join('\n'),
    '',
    claimBlock(input.claimCommand),
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

/** The repair worker's task (R11, R24 of the fix pass): every check failing after the fixes with its output, and its output before them when it failed then too, the files it owns, what each fixer did, and the same answer as a fixer's with the checks as its findings. */
export function repairTask(input: RepairTaskInput): string {
  const count = input.checks.length;
  const checks = input.checks.map((check, index) => [
    `[${String(index)}] ${check.kind}: ${check.command}`,
    `    ${check.outcome === 'timeout' ? 'ran past its timeout and was killed' : `exited with code ${check.exitCode === null ? 'none (ended by a signal)' : String(check.exitCode)}`}`,
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
    `Repair: ${String(count)} check${count === 1 ? '' : 's'}, numbered [0] to [${String(count - 1)}], fail${count === 1 ? 's' : ''} after the fixers' edits. Make each pass again without undoing an applied fix: read its output, find what the fixers' edits broke, and fix that. A check is \`applied\` when it passes after your change, \`deferred\` with the reason when it cannot be made to pass here, and \`blocked\` when it needs a file outside the repository or one you were told not to edit, named in \`requiredFiles\`.`,
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
    `${answerFields('check')} The \`message\` of an applied check describes what the repair changed.`,
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

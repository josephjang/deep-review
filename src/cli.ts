/**
 * The `deep-review` command (R1, R13 of the read-only review): `review` runs
 * a review to its report in the foreground and is resumable, `status` prints
 * the fold of a run, `abandon` closes one, `commit` turns a completed fix
 * run's revisions into commits (R17 of the fix pass), `answer` records a
 * person's answer to a question or a departure and applies it (R1 of
 * answers), `snapshot` is what
 * a fix worker runs after each finding (R6), and `claim` what it runs
 * before its first edit of a file outside its cluster (R1, R2 of commit
 * series integrity), and `config` shows, explains, checks and starts the
 * configuration without a run (R14 of the configuration). The entry point
 * of the bundle and of `npm run review` during development.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Checkpoint } from './checkpoint/checkpoint.ts';
import { UnknownRunError } from './checkpoint/errors.ts';
import { answerWords } from './checkpoint/answer-state.ts';
import { answerNoteLengthV1, type Answer, type ScopeRequest } from './checkpoint/events.ts';
import type { RunState } from './checkpoint/fold.ts';
import { ledgerFileName } from './checkpoint/ledger.ts';
import { locateCheckpoint } from './checkpoint/locate.ts';
import { engineIdentity, engineRolesRoot } from './engine.ts';
import { explainLines, initText, showLines, validateBytes, type ShownScope } from './config/command.ts';
import { checkFlagsOf, dedicatedFlagValues, policyFlagsOf } from './config/flags.ts';
import { SettingFlagError } from './config/errors.ts';
import { cloneConfigPath, maxConfigBytes, operatorConfigPath, repositoryConfigPath } from './config/files.ts';
import { flagLayerOf, parseSetFlag, requireBase, resolvedValue, withChangedPaths, type FlagLayer, type ScopeSettings } from './config/resolve.ts';
import { fileLayers, type FileLayer } from './config/settings.ts';
import { configurationSource, type ConfigurationSource } from './config/source.ts';
import { EngineError } from './errors.ts';
import { answerRun } from './review/answer.ts';
import { findActiveRun, runReview, type ReviewOutcome, type ScopeSource } from './review/controller.ts';
import { gitContent } from './review/content.ts';
import { ReviewRefusedError } from './review/errors.ts';
import { resolveExecutable } from './review/executable.ts';
import { acquireRunLock, acquireStartLock } from './review/lock.ts';
import { codexWindowsSandboxFlagProblem, invocationFlagProblem, maxConcurrency, readPolicy, type PolicyFlags } from './review/policy.ts';
import { reviewStatus } from './review/state.ts';
import { candidateIdSchema, checkKinds, checkKindSchema, type CheckKind } from './review/vocabulary.ts';
import { noCheckFlags, type CheckFlags } from './review/checks/discover.ts';
import { claimFile, readHeld } from './review/claims.ts';
import { commitRun } from './review/commit.ts';
import { readManifest, takeSnapshot } from './review/snapshot.ts';
import { describeRun } from './review/status.ts';
import { canonicalPath, isInside } from './paths.ts';
import { isWindowsSandbox, windowsSandboxes } from './runtime/codex.ts';
import { defaultRuntimes } from './runtime/runtimes.ts';
import { resolveScopeRequest, scopeBase } from './scope/capture.ts';
import { EmptyChangeError } from './scope/errors.ts';
import { status as gitStatus } from './scope/git.ts';

export const usage = `usage:
  deep-review review  --runtime claude|codex [--executable <path>] [--executable-arg <arg>]...
                      [--strong-model <model>] [--fast-model <model>]
                      [--last-commit | --worktree | --branch [--base <rev>] | --ref <ref> | --from <rev> --to <rev> [--merge-base]]
                      [--path <path>]... [--concurrency 1..${String(maxConcurrency)}] [--budget-usd <usd>] [--repo <dir>] [--roles <dir>]
                      [--set <setting>=<value>]... [--config <file>] [--no-repository-config]
                      [--fix [--fresh] [--check <kind>=<command>]... [--no-check <kind>]...]   (kind: ${checkKinds.join(', ')})
                      [--codex-windows-sandbox ${windowsSandboxes.join('|')}]   (with --runtime codex; applies on Windows)
  deep-review config  show --runtime claude|codex [the scope and setting flags of review] [--json] [--repo <dir>] [--roles <dir>]
  deep-review config  explain [<setting>]
  deep-review config  validate [<file>] [--layer repository|operator|clone|invocation] [--repo <dir>]
  deep-review config  init (--repository | --operator | --clone) [--repo <dir>] [--roles <dir>]
  deep-review status  [--run <id>] [--json] [--repo <dir>]
  deep-review abandon --reason <text> [--run <id>] [--repo <dir>]
  deep-review commit  [--run <id>] [--change-message <text>] [--repo <dir>]
  deep-review answer  --finding <id> (--option <n> | --accept | --reject) [--note <text>]
                      [--record-only] [--run <id>] [--budget-usd <usd>] [--roles <dir>] [--repo <dir>]
  deep-review snapshot --finding <n> --into <dir> [--repo <dir>]   (run by a fix worker after each finding)
  deep-review claim   --path <path> --unit <key> --in <dir>   (run by a fix worker from the repository root before its first edit of a file outside its cluster)

exit codes: 0 a report (its path is the last line of stdout), a status, the commits made, an answer recorded, a snapshot taken, a file claimed, a configuration shown, explained, valid or written; 2 a blocked run or a refusal, a configuration file with a problem or one config init would write over, an answer refused or its pass refused with the answer recorded included, a claim another cluster holds included, with the blocker and the operator's action or the holder on stderr; 1 any other error.`;

const options = {
  runtime: { type: 'string' },
  executable: { type: 'string' },
  'executable-arg': { type: 'string', multiple: true },
  'strong-model': { type: 'string' },
  'fast-model': { type: 'string' },
  'last-commit': { type: 'boolean' },
  worktree: { type: 'boolean' },
  ref: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  'merge-base': { type: 'boolean' },
  branch: { type: 'boolean' },
  base: { type: 'string' },
  set: { type: 'string', multiple: true },
  config: { type: 'string' },
  'no-repository-config': { type: 'boolean' },
  path: { type: 'string', multiple: true },
  concurrency: { type: 'string' },
  'budget-usd': { type: 'string' },
  repo: { type: 'string' },
  roles: { type: 'string' },
  run: { type: 'string' },
  json: { type: 'boolean' },
  reason: { type: 'string' },
  fix: { type: 'boolean' },
  fresh: { type: 'boolean' },
  check: { type: 'string', multiple: true },
  'no-check': { type: 'string', multiple: true },
  'codex-windows-sandbox': { type: 'string' },
  'change-message': { type: 'string' },
  finding: { type: 'string' },
  option: { type: 'string' },
  accept: { type: 'boolean' },
  reject: { type: 'boolean' },
  note: { type: 'string' },
  'record-only': { type: 'boolean' },
  into: { type: 'string' },
  unit: { type: 'string' },
  in: { type: 'string' },
  layer: { type: 'string' },
  repository: { type: 'boolean' },
  operator: { type: 'boolean' },
  clone: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true; strict: true }>>['values'];

/** What the command writes to. */
export interface CommandIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}

/** The flags each command takes; any other given flag is refused by name. */
const allowed: Record<string, readonly (keyof Values)[]> = {
  review: ['runtime', 'executable', 'executable-arg', 'strong-model', 'fast-model', 'last-commit', 'worktree', 'branch', 'base', 'ref', 'from', 'to', 'merge-base', 'path', 'concurrency', 'budget-usd', 'repo', 'roles', 'fix', 'fresh', 'check', 'no-check', 'codex-windows-sandbox', 'set', 'config', 'no-repository-config', 'help'],
  status: ['run', 'json', 'repo', 'help'],
  // Each subcommand of config takes its own part of these (`configCommand`).
  config: ['runtime', 'executable', 'executable-arg', 'strong-model', 'fast-model', 'last-commit', 'worktree', 'branch', 'base', 'ref', 'from', 'to', 'merge-base', 'path', 'concurrency', 'budget-usd', 'repo', 'roles', 'fix', 'check', 'no-check', 'codex-windows-sandbox', 'set', 'config', 'no-repository-config', 'json', 'layer', 'repository', 'operator', 'clone', 'help'],
  abandon: ['reason', 'run', 'repo', 'help'],
  commit: ['run', 'change-message', 'repo', 'help'],
  answer: ['finding', 'option', 'accept', 'reject', 'note', 'record-only', 'run', 'budget-usd', 'roles', 'repo', 'help'],
  snapshot: ['finding', 'into', 'repo', 'help'],
  claim: ['path', 'unit', 'in', 'help'],
};

/** A command-line mistake: the usage is printed with it. */
export class UsageError extends EngineError {
  override readonly name = 'UsageError';
}

function number(flag: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value)) throw new UsageError(`${flag} must be a number, not ${JSON.stringify(text)}`);
  return value;
}

/** Whether any scope flag is given, `--branch` and `--base` among them. */
export function hasScopeFlags(values: Values): boolean {
  return values['last-commit'] === true || values.worktree === true || values.branch === true || values.base !== undefined || values.ref !== undefined || values.from !== undefined || values.to !== undefined || values['merge-base'] === true || (values.path?.length ?? 0) > 0;
}

/**
 * The scope request the flags name, or, with no scope mode among them,
 * the one `scope.default` names (pass 1, R8, R9 of the configuration):
 * `worktree` and `last-commit` as their flags, `branch` as `--branch`,
 * and `auto` the request with no mode, which the capture resolves by
 * `git status`, today's rule. `--branch` is the range from `review.base`
 * to HEAD from their merge base; `--base` applies only to it. More than
 * one mode is refused.
 */
export function scopeRequestOf(values: Values, worktree: string, scope: ScopeSettings): { mode: 'last-commit' | 'worktree' | 'ref' | 'range' | 'auto'; request: ScopeRequest } {
  const paths = values.path ?? [];
  const modes = [values['last-commit'] === true, values.worktree === true, values.branch === true, values.ref !== undefined, values.from !== undefined || values.to !== undefined].filter(Boolean).length;
  if (modes > 1) throw new UsageError('choose one scope: --last-commit, --worktree, --branch, --ref <ref>, or --from <rev> --to <rev>');
  if (values['merge-base'] === true && values.from === undefined) throw new UsageError('--merge-base applies to --from and --to only');
  const chosen = modes === 1 ? null : scope.scopeDefault.value;
  const branch = values.branch === true || chosen === 'branch';
  if (values.base !== undefined && !branch) throw new UsageError('--base applies to --branch only, or to a scope.default of branch');
  if (values['last-commit'] === true || chosen === 'last-commit') {
    if (gitStatus(worktree).length > 0) throw new UsageError(`${chosen === null ? '--last-commit' : 'scope.default = "last-commit"'} reviews the last commit of a clean tree, and this tree has uncommitted changes; use --worktree to review them`);
    return { mode: 'last-commit', request: { paths } };
  }
  if (values.worktree === true || chosen === 'worktree') {
    if (gitStatus(worktree).length === 0) throw new UsageError(`${chosen === null ? '--worktree' : 'scope.default = "worktree"'} reviews uncommitted changes, and this tree has none; use --last-commit to review the last commit`);
    return { mode: 'worktree', request: { paths } };
  }
  if (branch) return { mode: 'range', request: { range: { from: requireBase(scope.reviewBase), to: 'HEAD', mergeBase: true }, paths } };
  if (values.ref !== undefined) return { mode: 'ref', request: { ref: values.ref, paths } };
  if (values.from !== undefined || values.to !== undefined) {
    if (values.from === undefined || values.to === undefined) throw new UsageError('--from and --to go together');
    return { mode: 'range', request: { range: { from: values.from, to: values.to, mergeBase: values['merge-base'] === true }, paths } };
  }
  return { mode: 'auto', request: { paths } };
}

/**
 * The flag layer of a `review` (R13, TD9 of the configuration): the
 * dedicated flags as settings, then each `--set`, two for one setting
 * refused with the usage.
 */
export function flagLayerOfValues(values: Values, runtime: string, policy: PolicyFlags, checks: CheckFlags | null): FlagLayer {
  try {
    return flagLayerOf([
      ...dedicatedFlagValues({
        runtime,
        policy,
        checks,
        ...(values.executable === undefined ? {} : { executable: values.executable }),
        ...(values['executable-arg'] === undefined ? {} : { executableArgs: values['executable-arg'] }),
        ...(values.base === undefined ? {} : { base: values.base }),
      }),
      ...(values.set ?? []).map(parseSetFlag),
    ]);
  } catch (error) {
    if (error instanceof SettingFlagError) throw new UsageError(error.message);
    throw error;
  }
}

/**
 * The fix pass the flags ask for (R1, R8 of the fix pass): null without
 * `--fix`, else the command each `--check <kind>=<command>` names and the
 * kinds each `--no-check <kind>` drops. A kind named twice, an unknown
 * kind, an empty command, or a check flag without `--fix` is refused.
 */
export function fixRequestOf(values: Values): CheckFlags | null {
  const checks = values.check ?? [];
  const dropped = values['no-check'] ?? [];
  if (values.fix !== true) {
    if (checks.length > 0 || dropped.length > 0) throw new UsageError('--check and --no-check apply only with --fix');
    return null;
  }
  const named = new Set<CheckKind>();
  const kindOf = (flag: string, text: string): CheckKind => {
    const kind = checkKindSchema.safeParse(text);
    if (!kind.success) throw new UsageError(`${flag} names a check kind, one of ${checkKinds.join(', ')}, not ${JSON.stringify(text)}`);
    if (named.has(kind.data)) throw new UsageError(`${flag} names the ${kind.data} check, which another --check or --no-check already names`);
    named.add(kind.data);
    return kind.data;
  };
  const commands: Partial<Record<CheckKind, string>> = {};
  for (const flag of checks) {
    const equals = flag.indexOf('=');
    if (equals === -1) throw new UsageError(`--check takes <kind>=<command>, not ${JSON.stringify(flag)}`);
    const kind = kindOf('--check', flag.slice(0, equals));
    const command = flag.slice(equals + 1);
    if (command.trim() === '' || command.includes('\0')) throw new UsageError(`--check ${kind}= needs a command`);
    commands[kind] = command;
  }
  return { commands, dropped: dropped.map((text) => kindOf('--no-check', text)) };
}

/** Whether `--fresh` declines a continuation (R2 of fix pass continuation); it is refused without `--fix`, which alone continues a run. */
export function freshRequestOf(values: Values): boolean {
  if (values.fresh !== true) return false;
  if (values.fix !== true) throw new UsageError('--fresh applies only with --fix');
  return true;
}

/** Run the command line and return the exit code. */
export async function main(argv: readonly string[], io: CommandIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\n${usage}\n`);
      return 1;
    }
    // Every refusal exits 2, as the usage promises; one with a blocker code names it.
    if (error instanceof ReviewRefusedError) {
      io.stderr(error.code === null ? `refused: ${error.message}\n` : `blocked (${error.code}): ${error.message}\n`);
      return 2;
    }
    if (error instanceof EngineError) {
      io.stderr(`${error.name}: ${error.message}\n`);
      return 1;
    }
    io.stderr(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return 1;
  }
}

async function run(argv: readonly string[], io: CommandIo): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true; strict: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help === true || command === undefined) {
    io.stdout(`${usage}\n`);
    return command === undefined && values.help !== true ? 1 : 0;
  }
  if (!Object.hasOwn(allowed, command)) throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  // config takes its subcommand and, for explain and validate, one argument; every other command takes none.
  if (command === 'config') return configCommand(values, rest, io);
  if (rest.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(rest[0])}`);
  for (const flag of Object.keys(values) as (keyof Values)[]) {
    if (values[flag] !== undefined && !allowed[command]!.includes(flag)) throw new UsageError(`--${flag} does not apply to ${command}`);
  }
  // A fixer's snapshot runs inside its sandbox, where a Node process may not start one whose output it captures, so it asks git nothing when the engine's manifest names the worktree (R23).
  if (command === 'snapshot') return snapshot(values, io);
  // A claim runs in the same sandbox and reads only the directory the engine prepared, which names the worktree.
  if (command === 'claim') return claim(values, io);
  const location = locateCheckpoint(values.repo === undefined ? io.cwd : resolve(io.cwd, values.repo));
  switch (command) {
    case 'review':
      return review(values, io, location.root, location.worktree, location.commonDir);
    case 'status':
      return status(values, io, location.root);
    case 'commit':
      return commit(values, io, location.root, location.worktree);
    case 'answer':
      return answer(values, io, location.root, location.worktree);
    default:
      return abandon(values, io, location.root);
  }
}

/**
 * Commit a completed fix run's revisions, one commit per revision built
 * from the frozen bytes (R17 of the fix pass): print each commit's short
 * hash and subject, and say on stderr that no hook ran and which staged
 * paths the index reset left unstaged.
 */
function commit(values: Values, io: CommandIo, root: string, worktree: string): number {
  const checkpoint = openCheckpoint(root, false);
  if (checkpoint === null) throw new UsageError('this repository has no checkpoint, so there is no run to commit');
  try {
    const outcome = commitRun({
      checkpoint,
      worktree,
      log: (line) => io.stderr(`${line}\n`),
      ...(values.run === undefined ? {} : { runId: values.run }),
      ...(values['change-message'] === undefined ? {} : { changeMessage: values['change-message'] }),
    });
    for (const made of outcome.commits) io.stdout(`${made.sha.slice(0, 12)} ${made.subject}\n`);
    io.stderr(`run ${outcome.runId}: ${String(outcome.commits.length)} commit${outcome.commits.length === 1 ? '' : 's'} created; no commit hook ran, since they were built from the run's frozen bytes, not by git commit\n`);
    if (outcome.unstaged.length > 0) io.stderr(`staged paths no commit holds were unstaged and are unchanged in the tree: ${outcome.unstaged.join(', ')}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UnknownRunError) throw new UsageError(error.message);
    throw error;
  } finally {
    checkpoint.close();
  }
}

/**
 * The answer the flags give (TD9 of answers): `--option <n>`, the
 * option's number as the report numbers it from 1, recorded from 0, or
 * `--accept` or `--reject`; exactly one of them.
 */
export function answerOf(values: Values): Answer {
  const given = [values.option !== undefined, values.accept === true, values.reject === true].filter(Boolean).length;
  if (given !== 1) throw new UsageError('give exactly one of --option <n>, --accept and --reject');
  if (values.option !== undefined) {
    if (!/^[1-9][0-9]{0,2}$/.test(values.option)) throw new UsageError(`--option takes an option's number as the report numbers it, from 1, not ${JSON.stringify(values.option)}`);
    return { kind: 'option', option: Number(values.option) - 1 };
  }
  return values.accept === true ? { kind: 'accept' } : { kind: 'reject' };
}

/**
 * The note an answer records, or null without `--note`; an empty one, or one past the ledger's cap, is refused.
 * The cap counts UTF-16 code units, as the ledger's schema does, so the refusal names that unit rather than characters.
 */
export function noteOf(values: Values): string | null {
  const note = values.note;
  if (note === undefined) return null;
  if (note.trim() === '') throw new UsageError('--note needs text; leave it out for no note');
  if (note.length > answerNoteLengthV1) {
    throw new UsageError(`--note holds at most ${String(answerNoteLengthV1)} UTF-16 code units (an emoji or other character outside the Basic Multilingual Plane counts as two), not ${String(note.length)}`);
  }
  return note;
}

/** Print how a run the command ran ended: the report's path last on stdout, exit 0, or the blocker and its action on stderr, exit 2. */
function reviewEnded(outcome: ReviewOutcome, io: CommandIo): number {
  if (outcome.kind === 'report') {
    io.stdout(`${outcome.reportPath}\n`);
    return 0;
  }
  io.stderr(`blocked in ${outcome.blocker.phase} (${outcome.blocker.code}): ${outcome.blocker.detail}\naction: ${outcome.blocker.action}\n`);
  return 2;
}

/**
 * Record a person's answer on a complete run (R1 to R6 of answers), and
 * on a run that fixed, unless `--record-only`, run the answer pass that
 * applies every answer owing an edit to its report, on the runtime and
 * executable the run pinned, as `review` resumes a run: the report's path
 * is the last line of stdout. On a run that only reviewed it says that
 * `review --fix` applies the answer; with nothing owed, that the tree
 * holds it already.
 */
async function answer(values: Values, io: CommandIo, root: string, worktree: string): Promise<number> {
  const finding = values.finding;
  if (finding === undefined || !candidateIdSchema.safeParse(finding).success) throw new UsageError(`--finding takes a finding's id as the report prints it, such as RIPPLE-2, not ${JSON.stringify(finding ?? '')}`);
  const given = answerOf(values);
  const note = noteOf(values);
  const budgetUsd = number('--budget-usd', values['budget-usd']);
  const flags: PolicyFlags = budgetUsd === undefined ? {} : { budgetUsd };
  const problem = invocationFlagProblem(flags);
  if (problem !== null) throw new UsageError(problem);
  const checkpoint = openCheckpoint(root, false);
  if (checkpoint === null) throw new UsageError('this repository has no checkpoint, so there is no run to answer');
  try {
    const runtimes = defaultRuntimes();
    const rolesRoot = values.roles ?? engineRolesRoot();
    const outcome = await answerRun({
      checkpoint,
      worktree,
      ...(values.run === undefined ? {} : { runId: values.run }),
      finding,
      answer: given,
      note,
      recordOnly: values['record-only'] === true,
      flags,
      rolesRoot,
      environment: io.environment,
      adapter: (runtime) => runtimes.get(runtime),
      match: gitContent(worktree, (reference) => checkpoint.evidence.read(reference)).match,
      log: (line) => io.stderr(`${line}\n`),
    });
    io.stdout(`answer ${outcome.recorded ? 'recorded' : 'already recorded'}: run ${outcome.runId}, ${finding} ${answerWords(given)}\n`);
    switch (outcome.next) {
      case 'read-only':
        io.stdout('the run only reviewed; run review --fix to apply the answer with the fixes\n');
        return 0;
      case 'record-only':
        io.stdout('recorded only; the next deep-review answer on this run without --record-only applies it\n');
        return 0;
      case 'nothing-owed':
        io.stdout('the tree already holds this answer; nothing to apply\n');
        return 0;
      case 'pass':
        break;
    }
    const configuration = outcome.state.review!.configuration;
    io.stderr(`run ${outcome.runId}: answer pass over ${outcome.state.review!.answerPasses.at(-1)!.ids.join(', ')}\n`);
    // The pass resumes the run it opened, which keeps the runtime, executable, scope and checks it pinned.
    const ran = await runReview({
      checkpoint,
      worktree,
      runtimes,
      runtime: configuration.runtime,
      executable: configuration.executable,
      executableArgs: configuration.executableArgs,
      rolesRoot,
      flags,
      scope: { named: false, request: () => { throw new Error(`Run ${outcome.runId} has its scope`); } },
      fix: noCheckFlags,
      engineEntry: import.meta.filename,
      environment: io.environment,
      log: (line) => io.stderr(`${line}\n`),
    });
    return reviewEnded(ran, io);
  } catch (error) {
    if (error instanceof UnknownRunError) throw new UsageError(error.message);
    throw error;
  } finally {
    checkpoint.close();
  }
}

/**
 * Copy what changed since the fixer's launch, and the expected paths, into
 * its snapshot directory after one finding (R6, R23 of the fix pass). It
 * reads no ledger, so a sandbox that keeps the git directory read-only runs
 * it, and starts no process when the engine's manifest is there, which
 * names the worktree; only without one does it ask git where the
 * worktree is, from `--repo` or the current directory.
 */
function snapshot(values: Values, io: CommandIo): number {
  const finding = values.finding;
  if (finding === undefined || !/^(0|[1-9][0-9]{0,5})$/.test(finding)) throw new UsageError(`--finding must be a finding's index, a whole number from 0, not ${JSON.stringify(finding ?? '')}`);
  if (values.into === undefined || values.into.trim() === '') throw new UsageError('--into <dir> is required');
  const into = resolve(io.cwd, values.into);
  const worktree = readManifest(into)?.worktree ?? locateCheckpoint(values.repo === undefined ? io.cwd : resolve(io.cwd, values.repo)).worktree;
  const listing = takeSnapshot({ worktree, finding: Number(finding), into });
  io.stdout(`snapshot ${finding}: ${String(Object.keys(listing.paths).length)} paths into ${into}\n`);
  return 0;
}

/**
 * Claim a file for the fixer's cluster before its first edit (R1, R2 of
 * commit series integrity): exit 0 for a file its cluster owns or now
 * holds, 2 naming the cluster that holds it otherwise, 1 for anything
 * else, a claims directory that is gone included, which says to stop
 * editing. It reads the directory the engine prepared and nothing else,
 * and starts no process. The path is the repository's, so the command is
 * refused from a directory inside the worktree other than its root, where
 * a relative path would seem to mean another file.
 */
function claim(values: Values, io: CommandIo): number {
  const paths = values.path ?? [];
  if (paths.length !== 1 || paths[0]!.trim() === '') throw new UsageError('--path <path> is required, once');
  if (values.unit === undefined || values.unit.trim() === '') throw new UsageError('--unit <key> is required');
  if (values.in === undefined || values.in.trim() === '') throw new UsageError('--in <dir> is required');
  const dir = resolve(io.cwd, values.in);
  const { worktree } = readHeld(dir);
  if (isInside(worktree, io.cwd) && canonicalPath(io.cwd) !== canonicalPath(worktree)) {
    throw new UsageError(`run the claim command from the repository root ${worktree}, not from ${relative(worktree, io.cwd)}, so the path names the file the repository does`);
  }
  const outcome = claimFile(dir, paths[0]!, values.unit);
  switch (outcome.kind) {
    case 'owned':
      io.stdout(`claim ${outcome.path}: owned by your cluster ${outcome.cluster}\n`);
      return 0;
    case 'claimed':
      io.stdout(`claim ${outcome.path}: ${outcome.created ? 'claimed for' : 'already held by'} your cluster ${outcome.cluster}\n`);
      return 0;
    case 'refused':
      io.stderr(`claim refused: ${outcome.path} is ${outcome.by === 'plan' ? 'owned' : 'held'} by cluster ${outcome.holder}\n`);
      return 2;
    case 'held-by-unknown':
      io.stderr(`claim refused: ${outcome.path} is being claimed by another worker\n`);
      return 2;
  }
}

/** The flags each subcommand of `config` takes beside --help; `show` takes the scope and setting flags of `review`, less `--fresh`. */
const configAllowed: Readonly<Record<string, readonly (keyof Values)[]>> = {
  show: [...allowed.review!.filter((flag) => flag !== 'fresh'), 'json'],
  explain: ['help'],
  validate: ['layer', 'repo', 'help'],
  init: ['repository', 'operator', 'clone', 'repo', 'roles', 'help'],
};

/**
 * `deep-review config` (R14 of the configuration): `show` the
 * configuration a run would use, without a run; `explain` the settings,
 * or one; `validate` one file as its layer reads it, the repository's of
 * the working tree by default; `init` a new file for a layer. A mistaken
 * subcommand, argument or flag is refused with the usage; a file with a
 * problem, and a file `init` would write over, exit 2.
 */
async function configCommand(values: Values, rest: readonly string[], io: CommandIo): Promise<number> {
  const [subcommand, argument, ...more] = rest;
  if (subcommand === undefined || !Object.hasOwn(configAllowed, subcommand)) throw new UsageError(`config takes show, explain, validate or init${subcommand === undefined ? '' : `, not ${JSON.stringify(subcommand)}`}`);
  if (more.length > 0 || (argument !== undefined && subcommand !== 'explain' && subcommand !== 'validate')) throw new UsageError(`unexpected argument ${JSON.stringify(more[0] ?? argument)}`);
  for (const flag of Object.keys(values) as (keyof Values)[]) {
    if (values[flag] !== undefined && !configAllowed[subcommand]!.includes(flag)) throw new UsageError(`--${flag} does not apply to config ${subcommand}`);
  }
  if (subcommand === 'explain') {
    const lines = explainLines(argument);
    if (lines === null) throw new UsageError(`config explain names no setting ${JSON.stringify(argument)}; deep-review config explain lists them all`);
    io.stdout(`${lines.join('\n')}\n`);
    return 0;
  }
  const location = locateCheckpoint(values.repo === undefined ? io.cwd : resolve(io.cwd, values.repo));
  if (subcommand === 'validate') {
    const layer = values.layer ?? 'repository';
    if (!(fileLayers as readonly string[]).includes(layer)) throw new UsageError(`--layer must be one of ${fileLayers.join(', ')}, not ${JSON.stringify(layer)}`);
    const path = argument === undefined ? join(location.worktree, ...repositoryConfigPath.split('/')) : resolve(io.cwd, argument);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) throw new ReviewRefusedError(`${path} is not a file to validate`);
    if (stat.size > maxConfigBytes) throw new ReviewRefusedError(`${path} holds ${String(stat.size)} bytes, more than the ${String(maxConfigBytes)} the engine reads`);
    const validated = validateBytes(layer as FileLayer, path, readFileSync(path));
    (validated.valid ? io.stdout : io.stderr)(`${validated.lines.join('\n')}\n`);
    return validated.valid ? 0 : 2;
  }
  if (subcommand === 'init') {
    const chosen = (['repository', 'operator', 'clone'] as const).filter((layer) => values[layer] === true);
    if (chosen.length !== 1) throw new UsageError('config init takes one of --repository, --operator and --clone');
    const layer = chosen[0]!;
    const path = layer === 'repository' ? join(location.worktree, ...repositoryConfigPath.split('/')) : layer === 'clone' ? cloneConfigPath(location.commonDir) : operatorConfigPath(io.environment, process.platform);
    if (path === null) throw new ReviewRefusedError('the operator\'s file is under APPDATA, which has no value here; set it, or write the file by hand');
    if (existsSync(path)) throw new ReviewRefusedError(`${path} exists, and config init writes only a new file; edit it, or remove it first`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, initText(layer, readPolicy(values.roles ?? engineRolesRoot())), { flag: 'wx' });
    io.stdout(`${path}\n`);
    return 0;
  }
  // show: the two passes as review runs them, without the start lock and without a run (R14).
  const { runtime, source } = invocationOf(values, io, location.worktree, location.commonDir);
  const adapter = defaultRuntimes().get(runtime);
  const chosen = scopeRequestOf(values, location.worktree, source.scopeSettings());
  const base = scopeBase(location.worktree, chosen.request);
  let resolved = source.resolve({ base, policy: readPolicy(values.roles ?? engineRolesRoot()), runtime, costInUsd: adapter.capabilities.costInUsd });
  let shown: ShownScope = { mode: chosen.mode, base, empty: null };
  try {
    const listed = resolveScopeRequest(location.worktree, chosen.request, resolvedValue(resolved, 'scope.exclude') ?? []);
    resolved = withChangedPaths(resolved, [...listed.changes.map((change) => change.path), ...listed.excluded]);
    shown = { ...shown, mode: listed.mode };
  } catch (error) {
    if (!(error instanceof EmptyChangeError)) throw error;
    shown = { ...shown, empty: error.message };
  }
  io.stdout(values.json === true ? `${JSON.stringify({ ...resolved, scope: shown }, null, 2)}\n` : `${showLines(resolved, shown).join('\n')}\n`);
  return 0;
}

/** Open the checkpoint with this engine's identity, or null when the repository has none and `create` is false. */
function openCheckpoint(root: string, create: boolean): Checkpoint | null {
  if (!create && !existsSync(join(root, ledgerFileName))) return null;
  return Checkpoint.open(root, { engine: engineIdentity() });
}

/** What `review` and `config show` take of their flags alike: the runtime, the policy flags and check flags they apply, the flag layer, and the configuration it reads with them. */
interface Invocation {
  readonly runtime: string;
  readonly flags: PolicyFlags;
  /** The check flags of a `--fix`, or null without one. */
  readonly fix: CheckFlags | null;
  readonly source: ConfigurationSource;
}

/**
 * The invocation the flags of a `review` or a `config show` name, each
 * mistake refused with the usage before any file is read: the runtime,
 * each dedicated flag checked as before, the check flags of a `--fix`,
 * the flag layer of those and each `--set` (TD9 of the configuration), and
 * the configuration of the operator's, the clone's and the `--config` file.
 */
function invocationOf(values: Values, io: CommandIo, worktree: string, commonDir: string): Invocation {
  if (values.runtime === undefined) throw new UsageError('--runtime claude|codex is required');
  const runtimes = defaultRuntimes();
  if (!runtimes.names().includes(values.runtime)) throw new UsageError(`--runtime must be one of ${runtimes.names().join(', ')}, not ${JSON.stringify(values.runtime)}`);
  const concurrency = number('--concurrency', values.concurrency);
  const budgetUsd = number('--budget-usd', values['budget-usd']);
  // A sandbox Codex lacks, or the flag on another runtime, is a command-line mistake refused with the usage, as a malformed number is below.
  const sandboxFlag = values['codex-windows-sandbox'];
  const sandboxProblem = codexWindowsSandboxFlagProblem(values.runtime, sandboxFlag);
  if (sandboxProblem !== null) throw new UsageError(sandboxProblem);
  // Past the check a given value names a sandbox; the guard only tells the type so.
  const codexWindowsSandbox = isWindowsSandbox(sandboxFlag) ? sandboxFlag : undefined;
  const dedicated: PolicyFlags = {
    ...(values['strong-model'] === undefined ? {} : { strongModel: values['strong-model'] }),
    ...(values['fast-model'] === undefined ? {} : { fastModel: values['fast-model'] }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(codexWindowsSandbox === undefined ? {} : { codexWindowsSandbox }),
  };
  // A malformed value is a command-line mistake, refused with the usage before the checkpoint is opened; the policy refuses it with the same message for a caller that does not come through here.
  const problem = invocationFlagProblem(dedicated);
  if (problem !== null) throw new UsageError(problem);
  const checkFlags = fixRequestOf(values);
  const runtime = values.runtime;
  // The flag layer holds each dedicated flag and each --set; what the policy and the checks read of this invocation's flags comes from it, so a --set acts as the flag it stands for (TD9 of the configuration).
  const layer = flagLayerOfValues(values, runtime, dedicated, checkFlags);
  const flags = policyFlagsOf(layer, runtime);
  const setProblem = invocationFlagProblem(flags);
  if (setProblem !== null) throw new UsageError(setProblem);
  // A check setting given by flag acts only in a fix run, so it is refused without --fix as --check is.
  const setCheck = checkFlags === null ? [...layer.values()].find((entry) => entry.name.startsWith('checks.') && entry.name !== 'checks.timeout_minutes') : undefined;
  if (setCheck !== undefined) throw new UsageError(`${setCheck.flag} applies only with --fix, as --check does`);
  // Another runtime's setting given by flag acts on no run of this one, so it is refused as --codex-windows-sandbox is; a file's stays as it is.
  const setOther = [...layer.values()].find((entry) => entry.name.startsWith('runtimes.') && !entry.name.startsWith(`runtimes.${runtime}.`));
  if (setOther !== undefined) throw new UsageError(`${setOther.flag} applies only to runtime ${setOther.name.split('.')[1]!}, not ${runtime}`);
  const source = configurationSource({
    worktree,
    locations: { operator: operatorConfigPath(io.environment, process.platform), clone: cloneConfigPath(commonDir), invocation: values.config === undefined ? null : resolve(io.cwd, values.config) },
    repositoryConfig: values['no-repository-config'] !== true,
    flags: layer,
  });
  return { runtime, flags, fix: checkFlags === null ? null : checkFlagsOf(layer), source };
}

async function review(values: Values, io: CommandIo, root: string, worktree: string, commonDir: string): Promise<number> {
  const { runtime, flags, fix, source } = invocationOf(values, io, worktree, commonDir);
  const fresh = freshRequestOf(values);
  const runtimes = defaultRuntimes();
  const checkpoint = openCheckpoint(root, true)!;
  try {
    // The controller resolves the scope for a run that has none yet, and to compare it with a finished run's before continuing that run: a resumed run keeps the scope it captured, so its flags are not even checked against the tree, which may have moved on. Pass 1 reads the operator's files then, and only then (R3 of the configuration).
    const scope: ScopeSource = {
      named: hasScopeFlags(values),
      request: () => scopeRequestOf(values, worktree, source.scopeSettings()).request,
    };
    const outcome = await runReview({
      checkpoint,
      worktree,
      runtimes,
      runtime,
      // Resolved, and a shim refused, only for a run not yet configured: a configured run preflights and launches the executable it pinned. The name is the runtime's executable setting, --executable among its layers, else the runtime's own.
      executable: (configured) => resolveExecutable(configured ?? runtime, io.environment, process.platform, io.cwd),
      rolesRoot: values.roles ?? engineRolesRoot(),
      flags,
      configuration: source,
      scope,
      fix,
      fresh,
      // A fixer's snapshot command runs this same entry: the bundle, or this file from the sources.
      engineEntry: import.meta.filename,
      environment: io.environment,
      log: (line) => io.stderr(`${line}\n`),
    });
    return reviewEnded(outcome, io);
  } finally {
    checkpoint.close();
  }
}

/**
 * The run a command names with --run, or else the active run, null when
 * there is none; an id the checkpoint does not hold is a usage error. A
 * run this engine cannot read is passed over with a line on stderr when
 * the active run is looked for, and refused when it is named.
 */
function resolveRun(checkpoint: Checkpoint, run: string | undefined, io: CommandIo): RunState | null {
  if (run === undefined) return findActiveRun(checkpoint, (line) => io.stderr(`${line}\n`));
  try {
    return checkpoint.fold(run);
  } catch (error) {
    if (error instanceof UnknownRunError) throw new UsageError(error.message);
    throw error;
  }
}

function status(values: Values, io: CommandIo, root: string): number {
  const checkpoint = openCheckpoint(root, false);
  if (checkpoint === null) {
    io.stdout(values.json === true ? 'null\n' : 'No run: this repository has no checkpoint yet.\n');
    return 0;
  }
  try {
    const state = resolveRun(checkpoint, values.run, io);
    if (state === null) {
      io.stdout(values.json === true ? 'null\n' : 'No active run.\n');
      return 0;
    }
    const adapter = defaultRuntimes().get(state.review?.configuration.runtime ?? 'claude');
    const described = describeRun(state, adapter, (reference) => checkpoint.evidence.pathOf(reference));
    io.stdout(values.json === true ? `${JSON.stringify(described.json, null, 2)}\n` : `${described.lines.join('\n')}\n`);
    return 0;
  } finally {
    checkpoint.close();
  }
}

function abandon(values: Values, io: CommandIo, root: string): number {
  if (values.reason === undefined || values.reason.trim() === '') throw new UsageError('--reason <text> is required');
  const checkpoint = openCheckpoint(root, false);
  if (checkpoint === null) throw new UsageError('this repository has no checkpoint, so there is no run to abandon');
  try {
    // Under the start lock, as a review finds or creates its run: an engine resuming the run cannot slip between the find and the append.
    const releaseStart = acquireStartLock(checkpoint.root);
    try {
      const found = resolveRun(checkpoint, values.run, io);
      if (found === null) throw new UsageError('no active run to abandon');
      const release = acquireRunLock(checkpoint.root, found.id);
      try {
        // Folded again under the run's lock: an engine that held it until a moment ago may have written the report since.
        const state = checkpoint.fold(found.id);
        const status = reviewStatus(state);
        // A complete run keeps its report and its status; the ledger could still take the event, since a review run is never closed.
        if (status === 'complete' || status === 'abandoned') throw new UsageError(`run ${state.id} is ${status}; only an active or blocked run can be abandoned`);
        checkpoint.append(state.id, state.lastSequence, [{ kind: 'run.abandoned', version: 1, payload: { reason: values.reason } }]);
      } finally {
        release();
      }
      io.stdout(`run ${found.id} abandoned: ${values.reason}\n`);
      return 0;
    } finally {
      releaseStart();
    }
  } finally {
    checkpoint.close();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    environment: process.env,
    cwd: process.cwd(),
  });
}

/**
 * The contract test of resumable runs (R1, R2 of resumable runs): run a
 * fix run on the fakes through the command line, stop the engine at a
 * point of its work in one of four ways, run the same command again, and
 * check the five parts of the contract against the same run with no stop.
 * `npm run test:contract` (test/review/resumable-runs.contract.ts) runs a fixed set of points, and
 * `npm run resume-test` (scripts/resume-test.ts) runs each one.
 *
 * The run holds each case a way needs: the first attempt of the finder
 * RIPPLE fails, so a stop can meet a unit at its last attempt; the fixer
 * of c1 leaves a line that the lint check removes in the checks after the
 * fixes, as a formatter does, before the check marks its start; the fixer
 * of c1 names a document its edit made stale, which the documentation
 * step writes, so a stop can meet the step with a revision; and the
 * change has a file no finding names, src/c.ts, which a person edits at
 * one point while the engine is down. The scenario of the base adds a
 * typecheck that fails before the fixes, after them and on the base, so
 * the phase `base-checks` makes a worktree of the base, runs build and
 * typecheck there and removes it, and the repair compares the failures
 * (R11 of the facts before a merge). The scenario of a pull request is a
 * read-only run of `review --pr`, whose change the stand-in for `gh` gives
 * at its first command, and which ends with the writer's explanation (R18,
 * "A stop" of the design of the review on the pull request); `publish`
 * then posts it, and the stand-in stops it after it records the
 * publication and before the post, or after the post and before its
 * record (R13).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { operatorConfigPath } from '../../src/config/files.ts';
import { baseLockReason } from '../../src/review/checks/base.ts';
import { withoutVariables } from '../../src/runtime/environment.ts';
import { checkpointScratchKey } from '../../src/runtime/scratch.ts';
import { checkKinds, repairUnitKey } from '../../src/review/vocabulary.ts';
import { lastLineMarker } from '../../src/review/markers.ts';
import { fakeGh, fakeGhHeld, writeFakeGhScript, type FakeGhStep } from './fake-gh.ts';
import { fixerAnswer, type Script } from './fake-runtime.ts';
import { fixedA, fixedB, reviewScript } from './fix-pass-fixture.ts';
import { git } from './git.ts';
import { baseEnvironment, fakeClaude, isAlive, sleep } from './launcher.ts';
import { write } from './repository.ts';
import { cliEntry, fakeCheckCommand, ReviewSandbox } from './review-sandbox.ts';

/** The preload that stops the engine (TD1 of resumable runs). */
export const stopPreload = resolve(import.meta.dirname, 'stop-preload.ts');

/**
 * How the test stops the engine: a handled signal, a hard kill of the
 * engine alone, a hard kill of its process tree, or a kill of the held
 * child with a kill mark and of the engine alone at its next step after it
 * recorded the child's end, the order of run 8dbe23ad (R2).
 */
export const stopWays = ['signal', 'kill', 'tree', 'child'] as const;
export type StopWay = (typeof stopWays)[number];

/** The ways that apply at a point between two appends: no child of that step runs yet, so none is killed first. */
export const appendWays: readonly StopWay[] = ['signal', 'kill', 'tree'];

/**
 * A point of the work: a step of the review by its name, as stop-preload.ts
 * names it (an append after it is written, `before` and an append's name
 * before it is written, or a git call that makes or removes a worktree of
 * the base, before or after it), a child while it runs by the name and
 * count of its start (`child <name>#<n>`, as the fakes count their
 * starts), `commit` before or after it moves the branch, or `publish`
 * before or after its post, where the stand-in for `gh` ends it.
 */
export type Point =
  | { readonly kind: 'append'; readonly name: string }
  | { readonly kind: 'child'; readonly name: string; readonly hold: string }
  | { readonly kind: 'commit'; readonly name: 'update-ref before' | 'update-ref after' }
  | { readonly kind: 'publish'; readonly name: 'post before' | 'post after' };

/** The point a name gives: `child <hold>`, `update-ref before` or `update-ref after`, `post before` or `post after`, else an append. */
export function pointOf(name: string): Point {
  if (name.startsWith('child ')) return { kind: 'child', name, hold: name.slice('child '.length) };
  if (name === 'update-ref before' || name === 'update-ref after') return { kind: 'commit', name };
  if (name === 'post before' || name === 'post after') return { kind: 'publish', name };
  return { kind: 'append', name };
}

/** The way that applies at a point of `publish`: the stand-in for `gh` ends the engine with SIGKILL, as a kill of the engine alone does. */
const publishWays: readonly StopWay[] = ['kill'];

/** The ways that apply at a point. */
export const waysAt = (point: Point): readonly StopWay[] => (point.kind === 'child' ? stopWays : point.kind === 'publish' ? publishWays : appendWays);

/** The parts of the contract (R1, R2), in the order the design numbers them. */
export const contractParts = ['exit', 'launches', 'nothing false', 'report', 'no orphan'] as const;
export type ContractPart = (typeof contractParts)[number];

/** The point while a fixer runs at which a person edits src/c.ts after the stop and before the next command (W8). */
export const personEditPoint = 'child fixer fixes:c1-1#1';

/** The file of the change no finding names, which the person edits, and what the person writes there. */
export const personFile = 'src/c.ts';
const personFileText = 'export const c = 1;\n';
const personEdit = 'export const c = 2; // a person\'s edit\n';

/** The line c1's fixer leaves and the lint check removes, as a formatter does. */
const unformatted = '// unformatted\n';

/** The document c1's fixer names as stale, and what the documentation step writes there. */
const documentFile = 'docs/parse.md';
const documentText = 'parse returns 0 for a null text\n';

/** Which files each source of a revision may hold: what its fake writes. */
const allowedFiles: Readonly<Record<string, readonly string[]>> = {
  'c1-1': ['src/a.ts'],
  'c2-1': ['src/b.ts'],
  'check lint': ['src/a.ts'],
  documentation: [documentFile],
};

/** The script of the fakes: the review of fix-pass-fixture.ts, RIPPLE failing once, a fixer for each cluster, and the documentation step bringing the document c1's fixer names in line. */
export const contractScript: Script = {
  ...reviewScript,
  'finder-RIPPLE': [{ exit: 1 }, {}],
  'fixer:fixes:c1-1': { edits: [{ writes: { 'src/a.ts': `${fixedA}${unformatted}` }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/a.ts'] }], [{ file: documentFile, what: 'parse throws on a null text' }]) },
  'fixer:fixes:c2-1': { edits: [{ writes: { 'src/b.ts': fixedB }, snapshot: 0 }], output: fixerAnswer([{ files: ['src/b.ts'] }]) },
  documentation: { edits: [{ writes: { [documentFile]: documentText }, snapshot: 0 }], output: fixerAnswer([{ files: [documentFile], subject: 'docs: Say parse returns 0 for a null' }, { status: 'already-applied' }]) },
};

/** The rules of the stand-in checks: lint removes the line c1's fixer leaves, and every check passes. */
export const contractChecks = { lint: { replace: { 'src/a.ts': { from: unformatted, to: '' } } } };

/** A run of the contract: the script of the fakes and the rules of the stand-in checks, and whether it is the read-only run of a pull request rather than a fix run of the last commit. */
export interface Scenario {
  readonly name: string;
  readonly script: Script;
  readonly checks: Readonly<Record<string, unknown>>;
  readonly pullRequest?: boolean;
}

/** The scenario of the fix pass: every check passes before the fixes, so no check runs on the base. */
export const fixScenario: Scenario = { name: 'fixes', script: contractScript, checks: contractChecks };

/**
 * The scenario of the base (R11 of the facts before a merge): typecheck
 * fails before the fixes, after them and on the base, so `base-checks`
 * runs build and typecheck in a worktree of the base, and the repair,
 * which defers typecheck, compares its failures with those on the base.
 */
export const baseScenario: Scenario = {
  name: 'base',
  script: {
    ...contractScript,
    'fixer:repair:repair': { output: { ...(fixerAnswer([{ status: 'deferred', note: 'every failure was there before the fixes' }]) as object), comparisons: [{ kind: 'typecheck', reading: 'same', words: 'the same failure as on the base' }] } },
  },
  checks: { ...contractChecks, typecheck: 'fail' },
};

/**
 * The scenario of a pull request (R18 of the review on the pull request):
 * `review --pr 42`, read-only, of the change of the fix pass, which the
 * decider decides to fix twice, so the writer explains two findings, and
 * marks each unexplained, as the fake writer does.
 */
export const pullRequestScenario: Scenario = { name: 'pull-request', script: reviewScript, checks: {}, pullRequest: true };

/** The scenarios the contract runs, each with its own run with no stop. */
export const scenarios: readonly Scenario[] = [fixScenario, baseScenario, pullRequestScenario];

/** The number of the pull request the scenario of a pull request reviews. */
const pullRequestNumber = 42;

/**
 * What the stand-in for `gh` answers for the pull request whose change is
 * the last commit of `repo`: the pull request, the head of its base
 * branch, the merge base and its files, the change of every scenario with
 * the file no finding names, for `review --pr`; then for two runs of
 * `publish` the pull request by its URL, the same reads and a post, the
 * first post stopping the engine as `stop` says, and what GitHub holds.
 * The patches give src/a.ts:2 and src/b.ts:1, where the two findings the
 * run fixes point, a comment each.
 */
function pullRequestSteps(repo: string, stop: 'before' | 'after' | null = null): FakeGhStep[] {
  const head = git(repo, 'rev-parse', 'HEAD');
  const baseHead = 'd'.repeat(40);
  const files = [
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,3 +1,7 @@\n-export function parse(text: string) {\n-  return text.length;\n+export function parse(text: string | null) {\n+  return text!.length;\n }\n+\n+export function other() {\n+  return parse(null);\n+}' },
    { filename: 'src/b.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+export const b = parse("x");' },
    { filename: personFile, status: 'added', patch: '@@ -0,0 +1 @@\n+export const c = 1;' },
    { filename: 'src/gone.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-export const gone = 1;' },
  ];
  const pull = `repos/acme/widgets/pulls/${String(pullRequestNumber)}`;
  const pullRequest = { body: { html_url: `https://github.com/acme/widgets/pull/${String(pullRequestNumber)}`, number: pullRequestNumber, state: 'open', merged: false, head: { sha: head }, base: { ref: 'main' }, changed_files: files.length, title: 'Parse with a guard', body: 'Why the parser needs a guard.' } };
  const reads = (endpoint: string): FakeGhStep[] => [
    { endpoint, pages: [pullRequest] },
    { endpoint: 'repos/acme/widgets/git/ref/heads/main', pages: [{ body: { object: { sha: baseHead } } }] },
    { endpoint: `repos/acme/widgets/compare/${baseHead}...${head}`, pages: [{ body: { merge_base_commit: { sha: git(repo, 'rev-parse', 'HEAD~1') } } }] },
    { endpoint: `${pull}/files?per_page=100`, pages: [{ body: files }] },
  ];
  const held: FakeGhStep[] = [{ endpoint: `${pull}/reviews?per_page=100`, held: true }, { endpoint: `${pull}/reviews/1/comments?per_page=100`, held: true }];
  return [
    ...reads(`repos/{owner}/{repo}/pulls/${String(pullRequestNumber)}`),
    ...reads(pull),
    { method: 'POST', endpoint: `${pull}/reviews`, held: true, ...(stop === null ? {} : { stop }) },
    ...held,
    ...reads(pull),
    { method: 'POST', endpoint: `${pull}/reviews`, held: true },
    ...held,
    ...held,
  ];
}

/** What a command the helper ran did. */
export interface Ran {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** What a run came to, read from its sandbox after its last command: what the parts of the contract compare. */
export interface Outcome {
  readonly ran: Ran;
  readonly state: RunState;
  /** The run's events, as kind and payload. */
  readonly events: readonly [string, Record<string, unknown>][];
  /** The report, normalized (`normalizedReport`), or null when the run has none. */
  readonly report: string | null;
  /** What the run's revisions, and so its patches, did to each path in all: the frozen bytes of the last revision of the path, or `absent`. */
  readonly revised: Readonly<Record<string, string>>;
  /** The last current outcome of each kind in each checks phase, as `<phase> <kind> <outcome>`. */
  readonly checks: readonly string[];
  /** The units the run degraded or left not attempted, as their events name them. */
  readonly degraded: readonly string[];
  /** The repair's reading of each check it compared with the base, as `<kind> <reading>`. */
  readonly comparisons: readonly string[];
  /** Each run a verdict cites (R5 of runs on the record), as `<candidate> <basis> <place> <exit code> <printed lines> <probe name> <probe hash>`, the command left out, since it names the worker's own scratch directory; then each run a validation entry of an editing unit cites (R7), as `<phase>:<unit> <finding> <method> <command> <place or not found> <exit code>`. */
  readonly cited: readonly string[];
  /** The worktrees of the base the run left: each entry git lists locked with the run's reason, and each directory of one under the scratch directory. */
  readonly baseTrees: readonly string[];
  /** The explanation the run recorded (R18 of the review on the pull request): who recorded it, the writer or the engine, and each part it dropped and each finding it marks unexplained; none for a run that does not explain its review. */
  readonly explanation: readonly string[];
  /** The reviews of the run the stand-in for `gh` holds, by the marker on the last line of each body, and the reviews the ledger records as posted, each by its id (R13 of the review on the pull request). */
  readonly reviews: { readonly held: readonly number[]; readonly posted: readonly number[] };
  /** The bytes of each file of the change and of each file a fixer writes. */
  readonly files: Readonly<Record<string, string | null>>;
}

/** The sandbox of one run of the contract: a ReviewSandbox with the change, the script and the checks of its scenario, and the directories of the helper. */
export class ContractSandbox {
  readonly box: ReviewSandbox;
  /** Where the preload writes its `stopped` marker. */
  readonly stopDirectory: string;
  /** Where the fakes record their starts and the held one writes `started.json` and waits for `release`. */
  readonly startDirectory: string;
  /** The temporary directory of the engine, so its scratch lives and is removed with the sandbox. */
  readonly temporary: string;
  /** The script of the stand-in for `gh`, for the scenario of a pull request; null for the others. */
  readonly ghScript: string | null;
  readonly scenario: Scenario;

  constructor(scenario: Scenario) {
    this.scenario = scenario;
    this.box = new ReviewSandbox();
    // A file of the change no finding names, so no cluster owns it.
    write(this.box.repo, personFile, personFileText);
    git(this.box.repo, 'add', '-A');
    git(this.box.repo, 'commit', '-q', '--amend', '-m', 'the change under review');
    this.box.script(scenario.script);
    this.box.checks(scenario.checks);
    this.stopDirectory = join(this.box.directory, 'stop');
    this.startDirectory = join(this.box.directory, 'start');
    this.temporary = join(this.box.directory, 'tmp');
    for (const directory of [this.stopDirectory, this.startDirectory, this.temporary]) mkdirSync(directory);
    this.ghScript = scenario.pullRequest === true ? join(this.box.directory, 'gh.json') : null;
    if (this.ghScript !== null) {
      writeFakeGhScript(this.ghScript, pullRequestSteps(this.box.repo));
      // In the operator's file, since publish runs gh as the files name it now, not as the run recorded it.
      const operator = operatorConfigPath(this.environment(), process.platform, this.box.home)!;
      mkdirSync(dirname(operator), { recursive: true });
      writeFileSync(operator, `schema = 1\ngithub.executable = ${JSON.stringify(process.execPath)}\ngithub.args = [${JSON.stringify(fakeGh)}]\n`);
    }
  }

  close(): void {
    this.box.close();
  }

  /** Make the first post of `publish` stop the engine `when` (R13 of the review on the pull request), before any command of the run. */
  stopPost(when: 'before' | 'after'): void {
    writeFakeGhScript(this.ghScript!, pullRequestSteps(this.box.repo, when));
  }

  /** The environment of every command: the hermetic one, the sandbox's home and configuration, the fakes' files, and the temporary directory. */
  environment(more: Record<string, string> = {}): NodeJS.ProcessEnv {
    const home = this.box.home;
    return {
      ...withoutVariables(baseEnvironment, ['APPDATA', 'XDG_CONFIG_HOME', 'TEMP', 'TMP', 'TMPDIR'], process.platform),
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
      HOME: home,
      USERPROFILE: home,
      TEMP: this.temporary,
      TMP: this.temporary,
      TMPDIR: this.temporary,
      FAKE_SCRIPT: this.box.scriptFile,
      FAKE_CHECKS: this.box.checksFile,
      FAKE_START_DIR: this.startDirectory,
      ...(this.ghScript === null ? {} : { FAKE_GH_SCRIPT: this.ghScript }),
      ...more,
    };
  }

  /** The arguments of `review --fix`, or of `review --pr` in the scenario of a pull request, whose stand-in for `gh` the operator's file names, the same for every command of the run. */
  reviewArgs(): string[] {
    const checks = checkKinds.flatMap((kind) => ['--check', `${kind}=${fakeCheckCommand(kind)}`]);
    const scope = this.scenario.pullRequest === true ? ['--pr', String(pullRequestNumber)] : ['--last-commit', '--fix', ...checks];
    // One worker at a time, so a stop meets the same workers in flight in every run, and they end in the same order.
    return ['review', '--runtime', 'claude', '--executable', process.execPath, '--executable-arg', fakeClaude, '--roles', this.box.rolesRoot, '--concurrency', '1', ...scope];
  }

  /** Start the command line with `args`, with the preload when `preload` gives its variables. On POSIX it leads a process group of its own, which a tree kill addresses. */
  start(args: readonly string[], preload: Record<string, string> | null): ChildProcess {
    const flags = preload === null ? [] : ['--import', pathToFileURL(stopPreload).href];
    return spawn(process.execPath, [...flags, cliEntry, ...args], {
      cwd: this.box.repo,
      env: this.environment({ ...(preload ?? {}), ...(preload === null ? {} : { RESUME_STOP_DIR: this.stopDirectory }) }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  }

  /** Run the command line with `args` to its end, with no preload. */
  run(args: readonly string[], extra: Record<string, string> = {}): Promise<Ran> {
    const child = spawn(process.execPath, [cliEntry, ...args], { cwd: this.box.repo, env: this.environment(extra), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return finished(child);
  }

  /** What the run came to after its last command `ran`. */
  outcome(ran: Ran): Outcome {
    const state = this.box.run();
    const review = state.review!;
    const report = review.report === null ? null : normalizedReport(readFileSync(this.box.checkpoint.evidence.pathOf(review.report.report), 'utf8'), this.box.directory);
    const fix = review.fix;
    // The patches are compared by what they change in each path: a fixer the stop cut leaves its edits to a revision of its attempt (R20 of the fix pass), which splits them otherwise than the run with no stop.
    const revised: Record<string, string> = {};
    for (const revision of fix?.revisions ?? []) for (const file of revision.files) revised[file.path] = file.after === null ? 'absent' : 'blob' in file.after ? file.after.blob.sha256 : file.after.oversized.sha256;
    const checks = fix === null ? [] : Object.entries(fix.checks.runs).flatMap(([phase, runs]) => checkKinds.flatMap((kind) => {
      const last = runs.filter((run) => run.kind === kind).at(-1);
      return last === undefined ? [] : [`${phase} ${kind} ${last.outcome}`];
    }));
    const events = this.box.events(state.id);
    const degraded = events.flatMap(([kind, payload]) => (kind === 'angle.failed' || kind === 'group.unverified' || kind === 'unit.unattempted' ? [`${kind} ${String(payload.angle ?? payload.groupId ?? payload.key)}`] : []));
    const files = Object.fromEntries(['src/a.ts', 'src/b.ts', personFile, 'src/gone.ts', documentFile].map((path) => {
      const file = join(this.box.repo, ...path.split('/'));
      return [path, existsSync(file) ? readFileSync(file, 'utf8') : null];
    }));
    const comparisons = fix?.answers.repair[repairUnitKey]?.comparisons.map((comparison) => `${comparison.kind} ${comparison.reading}`) ?? [];
    const verdictRuns = Object.values(review.candidates).flatMap((candidate) => (candidate.verdict?.runs ?? []).map((run) => [candidate.id, candidate.verdict!.basis, run.at, run.exitCode, run.printed.join(' / '), run.probe?.name ?? 'no probe', run.probe?.blob.sha256 ?? ''].map(String).join(' ')));
    const validationRuns = Object.values(fix?.answers ?? {}).flatMap((answers) => Object.values(answers).flatMap((answer) => answer.findings.flatMap((finding) => finding.validation.flatMap((entry) => entry.runs.map((run) => [`${answer.phase}:${answer.key}`, finding.id, entry.method, run.command, run.found?.at ?? 'not found', run.found?.exitCode ?? null].map(String).join(' '))))));
    const cited = [...verdictRuns, ...validationRuns];
    const recorded = state.explanation;
    const explanation = recorded === null ? [] : [recorded.workerId === null ? 'recorded by the engine' : 'recorded from the writer', ...recorded.dropped.map((part) => `dropped ${part.part === 'finding' ? `finding ${part.finding}` : part.part}`), ...recorded.unexplained.map((id) => `unexplained ${id}`)];
    const held = this.ghScript === null ? [] : fakeGhHeld(this.ghScript).filter((review) => lastLineMarker(review.body)?.startsWith(`deep-review publication ${state.id} `) === true).map((review) => review.id);
    const posted = state.publications.flatMap((publication) => (publication.status === 'posted' ? [publication.posted.review.id] : []));
    return { ran, state, events, report, revised, checks, degraded, comparisons, cited, baseTrees: this.baseTrees(state.id), explanation, reviews: { held, posted }, files };
  }

  /** The worktrees of the base the run `runId` left: the entries of `git worktree list` locked with its reason, and the directories of its worktrees of the base under the engine's scratch directory. */
  baseTrees(runId: string): string[] {
    const entries = git(this.box.repo, 'worktree', 'list', '--porcelain').split(/\n\n/).filter((entry) => entry.split('\n').includes(`locked ${baseLockReason(runId)}`));
    const scratch = join(this.temporary, 'deep-review-scratch', checkpointScratchKey(this.box.checkpoint));
    const directories = existsSync(scratch) ? readdirSync(scratch).filter((name) => name.startsWith(`${runId}-base-`)) : [];
    return [...entries.map((entry) => entry.split('\n')[0]!), ...directories.map((name) => `directory ${name}`)];
  }
}

/** Wait for a child the helper started to end, with what it printed. */
export function finished(child: ChildProcess): Promise<Ran> {
  return new Promise((done, fail) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', fail);
    child.once('close', (status, signal) => done({ status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

/** A run id, which a resumed run and the run with no stop do not share. */
const runId = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/**
 * The report with what a resume changes by its nature left out (R1): the
 * header lines that name the run, the repository and its commits, the
 * first 8 characters of the run's id that the brief and its commands name,
 * every duration, path of the evidence and commit hash, the Statistics table
 * of an older report and the line of the totals, the spend, the workers
 * with no reported cost, the count of the checks of the tree, and the
 * lines of R15 that say what a stop did. It also leaves
 * out how the edits of a fixer that the stop cut are split among patches:
 * the revision of its unfinished attempt holds them (R20 of the fix pass),
 * so the notes of the patches, the patch series and the attempt in Changed
 * files are left out, and the patches are compared by what they change in
 * each path instead (`Outcome.revised`); the brief's count of the patches,
 * and the patches it names to read first, are left out with them. A file
 * of the evidence store is named by its name in the store,
 * `artifacts/<hash>`, or by its path in a report an older engine wrote. The notes of the run, and the facts of the run after them,
 * are compared as a set, since some of their lines follow the order the
 * workers ended in; so are the lines after Limitations in such an older
 * report.
 */
export function normalizedReport(text: string, sandbox: string): string {
  const withoutStatistics = text.replace(/^## Statistics\n[\s\S]*?(?=^## )/m, '');
  const lines = withoutStatistics
    .split('\n')
    .filter((line) => !/^(Repository|Base|Head|Run|Reopened|Totals): /.test(line))
    .filter((line) => !/^- (Worktree checks|Run budget|Workers with no reported cost): /.test(line))
    .filter((line) => !/^- (Ran again after|Built again on the base|Cut|Cut by a stop|Lost with the engine|Written back after|The run budget stopped|A stop cut|A stop ended|Dropped: )/.test(line))
    .filter((line) => !/^The run budget stopped the fix pass: /.test(line))
    .map((line) => line.split(sandbox).join('<sandbox>'))
    .map((line) => line.replace(/<sandbox>[^\s|)]*artifacts[\\/][0-9a-f]{64}/g, '<artifact>').replace(/\bartifacts\/[0-9a-f]{64}\b/g, '<artifact>'))
    .map((line) => line.replace(/, [\d.]+ (s|min)\b/g, '').replace(/\b[0-9a-f]{40}\b/g, '<sha>').replace(runId, '<run>').replace(/\b(run|--run) [0-9a-f]{8}\b/g, '$1 <run>'))
    .filter((line) => !/^\d+\. .*: <artifact>$/.test(line))
    .map((line) => line.replace(/Its (\d+ patches are|patch is) not committed: `deep-review commit` commits (them|it)\./, 'Its <patches> are not committed.'))
    .map((line) => line.replace(/ Read first .*?\. If you do nothing, the fixes stay uncommitted/, ' Read first <patches>. If you do nothing, the fixes stay uncommitted'))
    .map((line) => line.replace(/; (no patch|patch(es)? [\d, -]+)$/, '; <patches>').replace(/, unfinished attempt\b/g, '').replace(/\b\d+ patch(es)?\b/, '<n> patches'));
  const notes = [lines.indexOf('## About this run'), lines.indexOf('## Notes of the run'), lines.indexOf('## Limitations')].find((index) => index !== -1) ?? -1;
  return notes === -1 ? lines.join('\n') : [...lines.slice(0, notes + 1), ...lines.slice(notes + 1).sort()].join('\n');
}

/**
 * End a process and its tree at once: `taskkill /T /F` on Windows, SIGKILL of its group on POSIX, else of the process.
 * It does not reuse `killTreeNow` of `src/runtime/process.ts` on purpose: it is the outside stop that the contract
 * test (R8) checks the engine against, so a defect in the engine's own tree kill cannot hide itself.
 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    killAlone(pid);
  }
}

/** End one process at once: SIGKILL on POSIX, TerminateProcess on Windows. */
export function killAlone(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** The `kill` of Git for Windows, found from `git --exec-path`, which leaves exit code 143 on the process it ends. */
let gitKill: string | null = null;
function windowsKill(): string {
  gitKill ??= join(git(process.cwd(), '--exec-path'), '..', '..', '..', 'usr', 'bin', 'kill.exe');
  return gitKill;
}

/** End a process with a kill mark: SIGTERM on POSIX, the `kill` of Git for Windows on Windows. */
export function killWithMark(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync(windowsKill(), ['-f', '-W', String(pid)], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** The pids the held child wrote: its own and its grandchild's. */
interface Held {
  readonly pid: number;
  readonly grandchild: number;
}

/** Poll until `condition` holds or `child` ends, whichever comes first, failing after `timeoutMs`; true when the condition held. */
async function untilOrEnded(condition: () => boolean, child: ChildProcess, what: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return true;
    if (child.exitCode !== null || child.signalCode !== null) return condition();
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** What one stop at a point in a way did, and what the run came to after it. */
export interface Stopped {
  readonly point: Point;
  readonly way: StopWay;
  /** Whether the run reached the point; a point it did not reach checks nothing. */
  readonly reached: boolean;
  /** The ledger at the stop, as event kinds and payloads. */
  readonly atStop: readonly [string, Record<string, unknown>][];
  /** The processes of the stopped engine still alive after it ended, by role. */
  readonly orphans: readonly string[];
  /** The commands after the stop, in order. */
  readonly after: readonly Ran[];
  readonly outcome: Outcome | null;
}

/** The time a process that outlives its engine is given to end before it counts as an orphan. */
const orphanGraceMs = 2000;

/** The time each command has to end. */
const commandTimeoutMs = 300_000;

/**
 * Stop the engine at `point` in `way`, in a new sandbox, then run the same
 * command again until the report or a block, and return what that did. At
 * the person's point, the person edits src/c.ts after the stop; when the
 * next command blocks, the person restores it and runs the command once
 * more.
 */
export async function stopAndResume(point: Point, way: StopWay, scenario: Scenario = fixScenario): Promise<Stopped> {
  const sandbox = new ContractSandbox(scenario);
  try {
    const review = sandbox.reviewArgs();
    if (point.kind === 'publish') sandbox.stopPost(point.name === 'post before' ? 'before' : 'after');
    if (point.kind === 'commit' || point.kind === 'publish') {
      const first = await sandbox.run(review);
      assert.equal(first.status, 0, first.stderr);
    }
    const args = point.kind === 'commit' ? ['commit'] : point.kind === 'publish' ? ['publish'] : review;
    // The stand-in for gh stops `publish` itself, so it runs with no preload.
    const preload: Record<string, string> | null = point.kind === 'publish' ? null : { RESUME_STOP_AT: point.kind === 'child' ? 'child' : point.name, RESUME_STOP_WAY: way, ...(point.kind === 'child' ? { FAKE_HOLD: point.hold } : {}) };
    const engine = sandbox.start(args, preload);
    const ended = finished(engine);
    const stoppedMarker = point.kind === 'publish' ? `${sandbox.ghScript!}.stopped` : join(sandbox.stopDirectory, 'stopped');
    const startedMarker = join(sandbox.startDirectory, 'started.json');
    const marker = point.kind === 'child' ? startedMarker : stoppedMarker;
    const reached = await untilOrEnded(() => existsSync(marker), engine, `${point.name} in ${way}`, commandTimeoutMs);
    let held: Held | null = null;
    if (reached) {
      if (point.kind === 'child') held = JSON.parse(readFileSync(startedMarker, 'utf8')) as Held;
      const pid = engine.pid!;
      switch (way) {
        case 'signal':
          break;
        case 'kill':
          killAlone(pid);
          break;
        case 'tree':
          killTree(pid);
          break;
        case 'child':
          // The preload stops the engine at its next step after it recorded the child's end, by which the engine of today makes a failure final.
          killWithMark(held!.pid);
          await untilOrEnded(() => existsSync(stoppedMarker), engine, `the next step after the end of ${point.name}`, commandTimeoutMs);
          killAlone(pid);
          break;
      }
    }
    const stopped = await ended;
    const atStop = sandbox.box.events(sandbox.box.run().id);
    // The fifth part: no process the stopped engine started outlives it (R8).
    const orphans: string[] = [];
    if (held !== null) {
      const deadline = Date.now() + orphanGraceMs;
      while (Date.now() < deadline && (isAlive(held.pid) || isAlive(held.grandchild))) await sleep(50);
      if (isAlive(held.pid)) orphans.push('child');
      if (isAlive(held.grandchild)) orphans.push('grandchild');
      for (const pid of [held.pid, held.grandchild]) if (isAlive(pid)) killTree(pid);
    }
    writeFileSync(join(sandbox.startDirectory, 'release'), '');
    if (!reached) return { point, way, reached, atStop, orphans, after: [stopped], outcome: null };
    if (point.name === personEditPoint) write(sandbox.box.repo, personFile, personEdit);
    const after: Ran[] = [];
    const next = (): Promise<Ran> => sandbox.run(args);
    after.push(await next());
    if (point.name === personEditPoint && after.at(-1)!.status === 2) {
      // The run blocked on the person's edit, as a person's change blocks it (R10); the person restores the file and runs the command again.
      write(sandbox.box.repo, personFile, personFileText);
      after.push(await next());
    }
    return { point, way, reached, atStop, orphans, after, outcome: sandbox.outcome(after.at(-1)!) };
  } finally {
    sandbox.close();
  }
}

/** The reference: the same run with no stop, the names of its steps and of its children's starts in order, and its `commit` or its `publish`. */
export interface Reference {
  readonly outcome: Outcome;
  /** The names of its appends and of the moments around its git calls that a point can name, in the order of the first of each. */
  readonly steps: readonly string[];
  readonly children: readonly string[];
  /** The subjects of the commits `commit` made after the run. */
  readonly commits: readonly string[];
  /** The last line `publish` printed after a read-only run of a pull request, the URL of its review; null for a run that has nothing to post. */
  readonly published: string | null;
}

/** Run the reference of a scenario in a new sandbox: the run with no stop, recording its steps, then `commit`. */
export async function reference(scenario: Scenario = fixScenario): Promise<Reference> {
  const sandbox = new ContractSandbox(scenario);
  try {
    const record = join(sandbox.box.directory, 'appends');
    writeFileSync(join(sandbox.startDirectory, 'release'), '');
    const engine = sandbox.start(sandbox.reviewArgs(), { RESUME_RECORD: record });
    const ran = await finished(engine);
    assert.equal(ran.status, 0, ran.stderr);
    const outcome = sandbox.outcome(ran);
    const steps = readFileSync(record, 'utf8').split('\n').filter((line) => line !== '');
    const counts = new Map<string, number>();
    const children = readFileSync(join(sandbox.startDirectory, 'starts'), 'utf8').split('\n').filter((line) => line !== '').map((name) => {
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      return `child ${name}#${String(count)}`;
    });
    // A read-only run has nothing to commit; one of a pull request is posted.
    const fix = outcome.state.review!.fix;
    if (fix === null) {
      if (scenario.pullRequest !== true) return { outcome, steps: [...new Set(steps)], children, commits: [], published: null };
      const posted = await sandbox.run(['publish']);
      assert.equal(posted.status, 0, posted.stderr);
      return { outcome, steps: [...new Set(steps)], children, commits: [], published: lastLine(posted.stdout) };
    }
    const committed = await sandbox.run(['commit']);
    assert.equal(committed.status, 0, committed.stderr);
    // One commit per revision of the run, newest first, as git log lists them.
    const revisions = fix.revisions.length;
    const commits = git(sandbox.box.repo, 'log', '--format=%s', `-${String(revisions)}`).split('\n');
    assert.equal(commits.length, revisions, 'commit made a commit per revision');
    return { outcome, steps: [...new Set(steps)], children, commits, published: null };
  } finally {
    sandbox.close();
  }
}

/** The labels of the workers a ledger shows finished with an answer. */
function completedLabels(events: readonly [string, Record<string, unknown>][]): Set<string> {
  const labels = new Map<string, string>();
  const completed = new Set<string>();
  for (const [kind, payload] of events) {
    if (kind === 'worker.launched') labels.set(String(payload.workerId), String(payload.label));
    if (kind === 'worker.finished' && payload.outcome === 'completed') completed.add(labels.get(String(payload.workerId)) ?? String(payload.workerId));
  }
  return completed;
}

/** The labels of the workers a ledger shows launched after its first `from` events. */
function launchedAfter(events: readonly [string, Record<string, unknown>][], from: number): string[] {
  return events.slice(from).flatMap(([kind, payload]) => (kind === 'worker.launched' ? [String(payload.label)] : []));
}

/** Each part of the contract a stop broke, with what broke it; an empty map when the run kept the contract. */
export function brokenParts(stopped: Stopped, expected: Reference): Map<ContractPart, string> {
  const broken = new Map<ContractPart, string>();
  const outcome = stopped.outcome!;
  if (stopped.point.kind === 'commit') return brokenAtCommit(stopped, expected);
  if (stopped.point.kind === 'publish') return brokenAtPublish(stopped, expected);
  // First: the command after the stop exits as the run with no stop exits.
  if (outcome.ran.status !== expected.outcome.ran.status) broken.set('exit', `exit ${String(outcome.ran.status)}: ${outcome.ran.stderr.trim().split('\n').slice(-2).join(' / ')}`);
  // Second: no worker that finished with an answer before the stop is launched again.
  const events = outcome.events;
  const settled = completedLabels(stopped.atStop);
  const again = launchedAfter(events, stopped.atStop.length).filter((label) => settled.has(label));
  if (again.length > 0) broken.set('launches', `launched again: ${[...new Set(again)].join(', ')}`);
  // Third: nothing false. The current check runs, the degraded units, the comparisons with the base, the runs the verdicts and the validations cite, and the files of each revision.
  const falsehoods: string[] = [];
  const checks = outcome.checks.filter((check) => !expected.outcome.checks.includes(check));
  if (checks.length > 0) falsehoods.push(`check runs ${checks.join(', ')}`);
  const degraded = outcome.degraded.filter((unit) => !expected.outcome.degraded.includes(unit));
  if (degraded.length > 0) falsehoods.push(`degraded ${degraded.join(', ')}`);
  const comparisons = outcome.comparisons.filter((comparison) => !expected.outcome.comparisons.includes(comparison));
  if (comparisons.length > 0) falsehoods.push(`comparisons with the base ${comparisons.join(', ')}`);
  // A stop never drops a part of the explanation nor marks a finding unexplained that the run with no stop explains (R18 of the review on the pull request).
  if (JSON.stringify(outcome.explanation) !== JSON.stringify(expected.outcome.explanation)) falsehoods.push(`the explanation ${outcome.explanation.join(', ')} where the run with no stop has ${expected.outcome.explanation.join(', ')}`);
  const cited = outcome.cited.filter((run) => !expected.outcome.cited.includes(run));
  if (cited.length > 0 || outcome.cited.length !== expected.outcome.cited.length) falsehoods.push(`cited runs ${outcome.cited.join(', ')} where the run with no stop cites ${expected.outcome.cited.join(', ')}`);
  const fix = outcome.state.review?.fix ?? null;
  for (const revision of fix?.revisions ?? []) {
    const source = revision.source.kind === 'check' ? `check ${revision.source.check}` : revision.source.key;
    const foreign = revision.files.map((file) => file.path).filter((path) => !(allowedFiles[source] ?? []).includes(path));
    if (foreign.length > 0) falsehoods.push(`a revision of ${source} holds ${foreign.join(', ')}`);
  }
  if (falsehoods.length > 0) broken.set('nothing false', falsehoods.join('; '));
  // Fourth: the same report, patches and files as the run with no stop.
  const differences: string[] = [];
  if (outcome.report !== expected.outcome.report) differences.push(`report: ${firstDifference(outcome.report ?? '(none)', expected.outcome.report ?? '(none)')}`);
  const paths = [...new Set([...Object.keys(outcome.revised), ...Object.keys(expected.outcome.revised)])].sort();
  const otherwise = paths.filter((path) => outcome.revised[path] !== expected.outcome.revised[path]);
  if (otherwise.length > 0) differences.push(`patches change ${otherwise.join(', ')} otherwise`);
  for (const [path, text] of Object.entries(expected.outcome.files)) if (outcome.files[path] !== text) differences.push(`file ${path}`);
  if (differences.length > 0) broken.set('report', differences.join('; '));
  // Fifth: no process of the stopped engine outlives it, and no worktree of the base outlives the run (R11 of the facts before a merge).
  const orphans = [...(stopped.orphans.length === 0 ? [] : [`alive after the stop: ${stopped.orphans.join(', ')}`]), ...(outcome.baseTrees.length === 0 ? [] : [`worktrees of the base left: ${outcome.baseTrees.join(', ')}`])];
  if (orphans.length > 0) broken.set('no orphan', orphans.join('; '));
  return broken;
}

/** The parts a stop of `commit` broke: the command after it exits 0 and the branch holds the commits of the run with no stop. */
function brokenAtCommit(stopped: Stopped, expected: Reference): Map<ContractPart, string> {
  const broken = new Map<ContractPart, string>();
  const ran = stopped.after.at(-1)!;
  if (ran.status !== 0) broken.set('exit', `exit ${String(ran.status)}: ${ran.stderr.trim().split('\n').slice(-2).join(' / ')}`);
  const commits = stopped.outcome!.state.review?.fix?.commits.flatMap((series) => series.commits.map((made) => made.subject)) ?? [];
  if (JSON.stringify([...commits].reverse()) !== JSON.stringify(expected.commits)) broken.set('nothing false', `the ledger holds the commits ${JSON.stringify(commits)}, not ${JSON.stringify([...expected.commits].reverse())}`);
  return broken;
}

/** The last line a command printed. */
const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1) ?? '';

/**
 * The parts a stop of `publish` broke (R13, "A stop" of the design of the
 * review on the pull request): the command after it exits 0 and prints
 * the URL of the run with no stop; and nothing false, the ledger records
 * one review posted and no review the stand-in for `gh` does not hold, and
 * the stand-in holds one review of the run, never two.
 */
function brokenAtPublish(stopped: Stopped, expected: Reference): Map<ContractPart, string> {
  const broken = new Map<ContractPart, string>();
  const ran = stopped.after.at(-1)!;
  if (ran.status !== 0 || lastLine(ran.stdout) !== expected.published) broken.set('exit', `exit ${String(ran.status)}, last line ${JSON.stringify(lastLine(ran.stdout))} where the run with no stop prints ${JSON.stringify(expected.published)}: ${ran.stderr.trim().split('\n').slice(-2).join(' / ')}`);
  const { held, posted } = stopped.outcome!.reviews;
  const falsehoods = [
    ...(posted.length === 1 ? [] : [`the ledger records ${String(posted.length)} reviews posted`]),
    ...posted.filter((id) => !held.includes(id)).map((id) => `the ledger records review ${String(id)}, which GitHub does not hold`),
    ...(held.length <= 1 ? [] : [`GitHub holds ${String(held.length)} reviews of the run`]),
  ];
  if (falsehoods.length > 0) broken.set('nothing false', falsehoods.join('; '));
  return broken;
}

/** Where two texts first differ, as the line of each. */
function firstDifference(actual: string, expected: string): string {
  const a = actual.split('\n');
  const b = expected.split('\n');
  const index = a.findIndex((line, at) => line !== b[at]);
  const at = index === -1 ? Math.min(a.length, b.length) : index;
  return `line ${String(at + 1)}: ${JSON.stringify(a[at] ?? '(end)')} where the run with no stop has ${JSON.stringify(b[at] ?? '(end)')}`;
}

/**
 * Every point of the reference: each step in the order of its first
 * record, each child start, the two points of `commit` after a fix
 * run, which alone has something to commit, and the two of `publish`
 * after a read-only run of a pull request, which alone is posted. The append of
 * the report is not one: the run is complete after it, and a stop there
 * cuts no work (Risks of resumable runs). A point just before an append is
 * not one either: the point after the step before it stands for it, as
 * `worktree remove after` stands for the point just before the end of
 * `base-checks`, which the fixed set of the contract names.
 */
export function everyPoint(expected: Reference): Point[] {
  const commit = expected.outcome.state.review?.fix === null ? [] : [pointOf('update-ref before'), pointOf('update-ref after')];
  const publish = expected.published === null ? [] : [pointOf('post before'), pointOf('post after')];
  return [...expected.steps.filter((name) => !name.startsWith('report.written')).map(pointOf), ...expected.children.map(pointOf), ...commit, ...publish];
}

/** Whether the reference has the point `name`: a step, a child's start, a point of `commit`, or one of `publish` when it posted, and a point before an append when it has that append. */
export const hasPoint = (expected: Reference, name: string): boolean =>
  [...expected.steps, ...expected.children, 'update-ref before', 'update-ref after', ...(expected.published === null ? [] : ['post before', 'post after'])].includes(name.startsWith('before ') ? name.slice('before '.length) : name);


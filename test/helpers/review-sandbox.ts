// A repository with a change, a checkpoint, a roles directory whose policy
// has timeouts that fit a test, and the fake runtimes, so a whole review runs
// through the controller in a test. The fakes are scripted per role and unit.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { Checkpoint, type ListedRun, type NewEvent } from '../../src/checkpoint/checkpoint.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { claimsDirectoryFor } from '../../src/review/claims.ts';
import { runReview, type ReviewOptions, type ReviewOutcome, type ScopeSource } from '../../src/review/controller.ts';
import type { ScopeRequest } from '../../src/checkpoint/events.ts';
import { flagCheckSettings, type CheckSettings } from '../../src/review/checks/discover.ts';
import { policyFileName, readPolicy, type PolicyFile } from '../../src/review/policy.ts';
import { checkKinds, type CheckKind } from '../../src/review/vocabulary.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import { checkpointScratchKey } from '../../src/runtime/scratch.ts';
import { repositoryRolesRoot } from '../../src/roles/assemble.ts';
import type { Script } from './fake-runtime.ts';
import { inProcessRunProbe, inProcessRunProcess } from './in-process-runner.ts';
import { baseEnvironment, fakeClaude, fakeCodex } from './launcher.ts';
import { commitAll, git, repositoryWith, write } from './repository.ts';

/**
 * The timeout of everything in a sandbox's runs that answers: every worker
 * but those of a role a test shortens (see hangTimeoutMs), every check, and
 * every preflight probe, at startup and before every worker. It is long
 * enough that nothing that answers is killed, however loaded the runner:
 * with every file's tests running at once, a fake's `--version` alone has
 * taken over 10 s to start, past the preflight's own limit, and a probe that
 * times out before a worker refuses the whole run.
 */
export const loadedRunnerTimeoutMs = 120_000;

/**
 * The timeout of a role a test scripts to hang (see shortenTimeout): time
 * for the fake to start on a lightly loaded runner, and short enough that
 * the test does not wait long. Only those roles get it, since a worker that
 * answers can take longer than this to start on a loaded one.
 */
export const hangTimeoutMs = 4000;

/** The stand-in check command, steered by FAKE_CHECKS (see fake-check.ts). */
export const fakeCheck = resolve(import.meta.dirname, 'fake-check.ts');

/** The engine that writes the events `addUnknownEvent` inserts: a build that declares one this engine does not. */
export const otherEngine = '9.9.9+newer';

/** The event `addUnknownEvent` inserts: a kind this engine declares, at a version it does not, which is what a build with a newer registry writes. */
export const unknownEvent = { kind: 'phase.finished', version: 99 } as const;

/** The engine's own entry from the sources, which a fixer's snapshot command runs. */
export const cliEntry = resolve(import.meta.dirname, '../../src/cli.ts');

/** The command line of the stand-in check of one kind, with this Node, quoted for either platform shell. */
export const fakeCheckCommand = (kind: CheckKind): string => `"${process.execPath}" "${fakeCheck}" ${kind}`;

/**
 * The checkpoint as a command that picks a run sees it, with `act` run once
 * right after the first `listRuns`: another writer appending between the
 * find of the run and the take of its lock. Every other member goes to the
 * checkpoint itself, whose private fields a proxy receiver would not reach.
 */
export const afterFind = (checkpoint: Checkpoint, act: (target: Checkpoint) => void): { checkpoint: Checkpoint; acted: () => boolean } => {
  let acted = false;
  const proxy = new Proxy(checkpoint, {
    get(target, property): unknown {
      if (property === 'listRuns') {
        return (): ListedRun[] => {
          const runs = target.listRuns();
          if (!acted) {
            acted = true;
            act(target);
          }
          return runs;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { checkpoint: proxy, acted: () => acted };
};

/**
 * The scope a test's command names: its request, and the mode a command
 * that names it gives, a ref's or a range's, else `auto` as with no mode
 * flag (R11 of resumable runs).
 */
export const scopeSource = (request: () => ScopeRequest, named = true): ScopeSource => ({
  named,
  choice: () => {
    const given = request();
    return { mode: given.ref !== undefined ? 'ref' : given.range !== undefined ? 'range' : 'auto', request: given };
  },
  request,
});

/** The checkpoint with `seen` called before each append, with the events, which may throw to refuse it; every other member goes to the checkpoint itself. */
export function appending(checkpoint: Checkpoint, seen: (events: readonly NewEvent[]) => void): Checkpoint {
  return new Proxy(checkpoint, {
    get(target, property): unknown {
      if (property === 'append') {
        return (runId: string, expected: number, events: readonly NewEvent[]) => {
          seen(events);
          return target.append(runId, expected, events);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The text of the report a run ended with; fails the test when the run ended otherwise. */
export const reportText = (outcome: ReviewOutcome): string => {
  assert.equal(outcome.kind, 'report', JSON.stringify(outcome));
  return outcome.kind === 'report' ? readFileSync(outcome.reportPath, 'utf8') : '';
};

/**
 * Make the repository every sandbox starts from in `directory`: one commit,
 * then a change: one file edited, one added, one removed. The first commit
 * also holds a package.json whose scripts run the stand-in checks, and
 * npm's lock file, for discovery.
 */
function makeSandboxRepository(directory: string): string {
  const script = (kind: CheckKind): string => `node "${fakeCheck.replaceAll('\\', '/')}" ${kind}`;
  const repo = repositoryWith(directory, {
    'src/a.ts': 'export function parse(text: string) {\n  return text.length;\n}\n',
    'src/gone.ts': 'export const gone = 1;\n',
    'AGENTS.md': '# Rules\n\nQuote every glob.\n',
    'package.json': `${JSON.stringify({ name: 'sandbox', private: true, scripts: Object.fromEntries(checkKinds.map((kind) => [kind, script(kind)])) }, null, 2)}\n`,
    'package-lock.json': '{ "name": "sandbox", "lockfileVersion": 3, "requires": true, "packages": {} }\n',
  });
  write(repo, 'src/a.ts', 'export function parse(text: string | null) {\n  return text!.length;\n}\n\nexport function other() {\n  return parse(null);\n}\n');
  write(repo, 'src/b.ts', 'export const b = parse("x");\n');
  rmSync(join(repo, 'src', 'gone.ts'));
  commitAll(repo, 'the change under review');
  return repo;
}

/** This process's copy source for sandboxRepository, made at its first use and removed when the process exits. */
let sandboxTemplate: string | null = null;

/** The start of the name of a process's template root in tmpdir: `deep-review-template-<pid>-`, then mkdtemp's suffix. */
const templatePrefix = 'deep-review-template-';

/** Whether the process `pid` is still running: only ESRCH says it is not, so a pid this process may not signal counts as live. */
function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Remove each template root in `directory` whose process no longer runs:
 * the root of a test process that was killed, whose 'exit' handler never
 * ran. A root whose process runs, its own or another test file's, stays.
 */
export function removeEndedTemplates(directory: string = tmpdir()): void {
  for (const entry of readdirSync(directory)) {
    const pid = new RegExp(`^${templatePrefix}(\\d+)-`).exec(entry)?.[1];
    if (pid === undefined || processRuns(Number(pid))) continue;
    // Windows may refuse a file of git's objects for a moment while a scanner or indexer holds it.
    rmSync(join(directory, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * The sandbox repository (makeSandboxRepository) at `directory`, copied
 * from one this process made at its first call. Making it costs eleven git
 * calls and copying it one, and the suite makes a sandbox for most of its
 * review tests. Every copy has the same commits, ids and all; what the
 * engine keeps of a run (its checkpoint, scratch and home) is under the
 * sandbox's own directory, so no two sandboxes share it. On POSIX the
 * copy's files have other inodes and times than its index records, so the
 * index is refreshed once here, as a freshly made repository needs no
 * refresh: otherwise the engine's first git command would rewrite it
 * during a test. The template is removed when the process exits; one that
 * a killed process left, which never ran its 'exit' handler, the next test
 * process that makes a template removes, by the pid in its name.
 */
export function sandboxRepository(directory: string): string {
  if (sandboxTemplate === null) {
    removeEndedTemplates();
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), `${templatePrefix}${String(process.pid)}-`)));
    process.once('exit', () => {
      rmSync(root, { recursive: true, force: true });
    });
    sandboxTemplate = makeSandboxRepository(join(root, 'repo'));
  }
  cpSync(sandboxTemplate, directory, { recursive: true });
  git(directory, 'update-index', '-q', '--refresh');
  return realpathSync.native(directory);
}

/**
 * How many tests of one file run at once, each in a sandbox of its own (see
 * ReviewSandbox.forTest). A review starts dozens of processes, so the
 * machine's CPU, not the test process, is what runs out: past this, the
 * tests only slow each other down.
 */
export const sandboxConcurrency = 4;

export class ReviewSandbox {
  readonly directory: string;
  readonly repo: string;
  readonly rolesRoot: string;
  readonly scriptFile: string;
  /** The file FAKE_CHECKS names, which steers the stand-in checks. */
  readonly checksFile: string;
  readonly scratchRoot: string;
  readonly home: string;
  readonly logs: string[] = [];
  #checkpoint: Checkpoint | null = null;

  /**
   * A sandbox for the test `t` alone, closed when `t` ends. A file whose
   * tests run concurrently gives each its own this way: one sandbox shared
   * through a variable that each test's hook reassigns would let one test
   * act on, and close, another's. With `script`, the fakes answer from it,
   * as box.script(script) would set.
   */
  static forTest(t: TestContext, script?: Script): ReviewSandbox {
    const box = new ReviewSandbox();
    t.after(() => {
      box.close();
    });
    if (script !== undefined) box.script(script);
    return box;
  }

  constructor() {
    this.directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-review-')));
    this.repo = sandboxRepository(join(this.directory, 'repo'));
    // The repository's roles with a policy whose timeouts fit a test.
    this.rolesRoot = join(this.directory, 'roles');
    cpSync(repositoryRolesRoot(), this.rolesRoot, { recursive: true });
    this.editPolicy((policy) => ({
      ...policy,
      roles: Object.fromEntries(Object.entries(policy.roles).map(([role, entry]) => [role, { ...entry, timeoutMs: loadedRunnerTimeoutMs }])),
      checks: { timeoutMs: loadedRunnerTimeoutMs },
    }));
    this.scriptFile = join(this.directory, 'script.json');
    this.checksFile = join(this.directory, 'checks.json');
    this.scratchRoot = join(this.directory, 'scratch');
    this.home = join(this.directory, 'home');
    mkdirSync(this.home);
    this.script({});
    this.checks({});
  }

  /** Give `role` the hang timeout in the runs created from now on, for a test that scripts one of its workers to hang. */
  shortenTimeout(role: string): void {
    this.editPolicy((policy) => {
      if (!Object.hasOwn(policy.roles, role)) throw new Error(`The policy has no role ${role}`);
      return { ...policy, roles: { ...policy.roles, [role]: { ...policy.roles[role]!, timeoutMs: hangTimeoutMs } } };
    });
  }

  /** Rewrite the sandbox's policy file as `edit` returns it, for the runs created from now on. */
  editPolicy(edit: (policy: PolicyFile) => PolicyFile): void {
    writeFileSync(join(this.rolesRoot, policyFileName), JSON.stringify(edit(readPolicy(this.rolesRoot)), null, 2));
  }

  /** Write the script the fakes answer from; the attempt counters start over. */
  script(script: Script): void {
    rmSync(`${this.scriptFile}.counts`, { recursive: true, force: true });
    writeFileSync(this.scriptFile, JSON.stringify(script));
  }

  /** Write the rules the stand-in checks follow (see fake-check.ts); their counters and their record of runs start over. */
  checks(rules: Readonly<Record<string, unknown>>): void {
    for (const name of readdirSync(this.directory).filter((entry) => entry.startsWith('checks.json.'))) rmSync(join(this.directory, name), { force: true });
    writeFileSync(this.checksFile, JSON.stringify(rules));
  }

  /** The kinds of check that ran, in order, since the rules were last written. */
  checkRuns(): string[] {
    const file = `${this.checksFile}.runs`;
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0) : [];
  }

  /** The flags of a fix run whose four checks are the stand-in's, named with `--check` so no package manager starts. */
  static checkFlags(): CheckSettings {
    return flagCheckSettings(Object.fromEntries(checkKinds.map((kind) => [kind, fakeCheckCommand(kind)])), []);
  }

  /** Run a review with the fix pass, its checks the stand-in's unless `change` names others. */
  fix(runtime: 'claude' | 'codex' = 'claude', change: Partial<ReviewOptions> = {}, fake: Record<string, string> = {}): Promise<ReviewOutcome> {
    return this.review(runtime, { fix: ReviewSandbox.checkFlags(), ...change }, fake);
  }

  get checkpoint(): Checkpoint {
    this.#checkpoint ??= Checkpoint.open(locateCheckpoint(this.repo).root, { engine: '0.0.0-test' });
    return this.#checkpoint;
  }

  /**
   * Run a review through the fake of the given runtime, with the flags
   * given, reviewing the last commit (the automatic scope of a clean tree)
   * unless a scope is given. The fakes and the stand-in checks run in this
   * process (in-process-runner.ts) unless `change` names another runner,
   * and so do the preflight's probes, whatever other limits `change` gives
   * them.
   */
  review(runtime: 'claude' | 'codex' = 'claude', change: Partial<ReviewOptions> = {}, fake: Record<string, string> = {}): Promise<ReviewOutcome> {
    const { preflightOptions, ...rest } = change;
    return runReview({
      checkpoint: this.checkpoint,
      worktree: this.repo,
      runtimes: defaultRuntimes(),
      runtime,
      executable: process.execPath,
      executableArgs: [runtime === 'claude' ? fakeClaude : fakeCodex],
      rolesRoot: this.rolesRoot,
      flags: {},
      scope: scopeSource(() => ({ paths: [] }), false),
      environment: { ...baseEnvironment, FAKE_SCRIPT: this.scriptFile, FAKE_CHECKS: this.checksFile, ...fake },
      engineEntry: cliEntry,
      scratchRoot: this.scratchRoot,
      home: this.home,
      log: (line) => {
        this.logs.push(line);
      },
      runProcess: inProcessRunProcess,
      preflightOptions: { timeoutMs: loadedRunnerTimeoutMs, runProbe: inProcessRunProbe, ...preflightOptions },
      ...rest,
    });
  }

  /**
   * The labels of the workers the ledger shows running, across every run,
   * read in one fold; a worker launched without a label counts as ''. A test
   * polls it to act while a worker it scripted to wait is on the ledger.
   */
  runningWorkers(): string[] {
    return this.checkpoint.foldRuns().flatMap((run) => Object.values(run.workers).filter((worker) => worker.status === 'running').map((worker) => worker.launch.label ?? ''));
  }

  /** The one run of the checkpoint, folded. */
  run(): RunState {
    const runs = this.checkpoint.foldRuns();
    if (runs.length !== 1) throw new Error(`Expected one run, found ${String(runs.length)}`);
    return runs[0]!;
  }

  /**
   * Insert past the registry, as another engine build would, an event this
   * engine does not declare onto the run, which makes it unreadable here.
   * The ledger takes any JSON payload; only the fold checks it.
   */
  addUnknownEvent(runId: string): void {
    this.checkpoint.ledger.write((tx) => tx.insertEvent({ runId, ...unknownEvent, payload: '{}', recordedAt: new Date().toISOString(), engine: otherEngine }));
  }

  /** A run of this repository that another engine build made unreadable here: created, then given an event this engine does not declare. Returns its id. */
  unreadableRun(): string {
    const { id } = this.checkpoint.createRun({ worktree: this.repo });
    this.addUnknownEvent(id);
    return id;
  }

  /** The claims directory of a round of the checkpoint's one run, under this sandbox's scratch root, whether or not it exists. */
  claimsDirectory(round: 1 | 2 = 1): string {
    const run = this.checkpoint.listRuns()[0];
    if (run === undefined) throw new Error('No run has a claims directory yet');
    return claimsDirectoryFor(join(this.scratchRoot, checkpointScratchKey(this.checkpoint)), run.id, round);
  }

  /** The claim markers of a round's directory by name, none when it does not exist. */
  markers(round: 1 | 2 = 1): string[] {
    const directory = this.claimsDirectory(round);
    return existsSync(directory) ? readdirSync(directory).filter((name) => /^[0-9a-f]{64}\.\d+\.json$/.test(name)).sort() : [];
  }

  /** The run's events as kind and parsed payload. */
  events(runId: string): [string, Record<string, unknown>][] {
    return this.checkpoint.ledger.events(runId).map((event) => [event.kind, JSON.parse(event.payload) as Record<string, unknown>]);
  }

  /** The frozen prompt of the finished worker with the given label, as text. */
  promptOf(state: RunState, label: string): string {
    const worker = Object.values(state.workers).find((candidate) => candidate.launch.label === label);
    if (worker === undefined) throw new Error(`No worker labelled ${label}`);
    return this.checkpoint.evidence.read(worker.launch.prompt).toString('utf8');
  }

  /** Where keep() puts its copy: beside the sandbox, so restore() can replace the whole sandbox from it. */
  get #kept(): string {
    return `${this.directory}.kept`;
  }

  /**
   * Keep a copy of the sandbox as it is now, repository, checkpoint and all,
   * for restore() to put back. A run records the absolute path of the tree
   * it reviewed, and the engine refuses to act on that run from any other
   * path, so tests that share one run's outcome take turns in this sandbox
   * rather than each working on a copy elsewhere.
   */
  keep(): void {
    this.#closeCheckpoint();
    this.#remove(this.#kept);
    cpSync(this.directory, this.#kept, { recursive: true, preserveTimestamps: true });
  }

  /** Put back the sandbox as keep() last copied it, and forget the log lines since. */
  restore(): void {
    if (!existsSync(this.#kept)) throw new Error('restore() needs a copy made by keep()');
    this.#closeCheckpoint();
    this.#remove(this.directory);
    cpSync(this.#kept, this.directory, { recursive: true, preserveTimestamps: true });
    this.logs.length = 0;
  }

  close(): void {
    this.#closeCheckpoint();
    this.#remove(this.directory);
    this.#remove(this.#kept);
  }

  /** Remove `path` and everything under it, retrying while Windows still holds a file in it locked. */
  #remove(path: string): void {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  /** Close the checkpoint this sandbox opened, if it did; the next use opens it again. */
  #closeCheckpoint(): void {
    this.#checkpoint?.close();
    this.#checkpoint = null;
  }
}

// A repository with a change, a checkpoint, a roles directory whose policy
// has short timeouts, and the fake runtimes, so a whole review runs through
// the controller in a test. The fakes are scripted per role and unit.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Checkpoint, type ListedRun } from '../../src/checkpoint/checkpoint.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { runReview, type ReviewOptions, type ReviewOutcome } from '../../src/review/controller.ts';
import type { CheckFlags } from '../../src/review/checks/discover.ts';
import { policyFileName, readPolicy } from '../../src/review/policy.ts';
import { checkKinds, type CheckKind } from '../../src/review/vocabulary.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import { repositoryRolesRoot } from '../../src/roles/assemble.ts';
import type { Script } from './fake-runtime.ts';
import { baseEnvironment, fakeClaude, fakeCodex } from './launcher.ts';
import { commitAll, repositoryWith, write } from './repository.ts';

/** The timeout a scripted worker that hangs is killed after: time for the fake to start, even on a loaded runner. */
export const hangTimeoutMs = 4000;

/** The timeout a check that hangs is killed after: a check starts a Node process of its own, which a loaded runner can take seconds to start. */
export const checkTimeoutMs = 10_000;

/** The stand-in check command, steered by FAKE_CHECKS (see fake-check.mjs). */
export const fakeCheck = resolve(import.meta.dirname, 'fake-check.mjs');

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

  constructor() {
    this.directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-review-')));
    // A repository with one commit, then a change: one file edited, one added, one removed. The first commit
    // also holds a package.json whose scripts run the stand-in checks, and npm's lock file, for discovery.
    const script = (kind: CheckKind): string => `node "${fakeCheck.replaceAll('\\', '/')}" ${kind}`;
    this.repo = repositoryWith(join(this.directory, 'repo'), {
      'src/a.ts': 'export function parse(text: string) {\n  return text.length;\n}\n',
      'src/gone.ts': 'export const gone = 1;\n',
      'AGENTS.md': '# Rules\n\nQuote every glob.\n',
      'package.json': `${JSON.stringify({ name: 'sandbox', private: true, scripts: Object.fromEntries(checkKinds.map((kind) => [kind, script(kind)])) }, null, 2)}\n`,
      'package-lock.json': '{ "name": "sandbox", "lockfileVersion": 3, "requires": true, "packages": {} }\n',
    });
    write(this.repo, 'src/a.ts', 'export function parse(text: string | null) {\n  return text!.length;\n}\n\nexport function other() {\n  return parse(null);\n}\n');
    write(this.repo, 'src/b.ts', 'export const b = parse("x");\n');
    rmSync(join(this.repo, 'src', 'gone.ts'));
    commitAll(this.repo, 'the change under review');
    // The repository's roles with a policy whose timeouts fit a test.
    this.rolesRoot = join(this.directory, 'roles');
    cpSync(repositoryRolesRoot(), this.rolesRoot, { recursive: true });
    const policy = readPolicy(this.rolesRoot);
    const roles = Object.fromEntries(Object.entries(policy.roles).map(([role, entry]) => [role, { ...entry, timeoutMs: hangTimeoutMs }]));
    writeFileSync(join(this.rolesRoot, policyFileName), JSON.stringify({ ...policy, roles, checks: { timeoutMs: checkTimeoutMs } }, null, 2));
    this.scriptFile = join(this.directory, 'script.json');
    this.checksFile = join(this.directory, 'checks.json');
    this.scratchRoot = join(this.directory, 'scratch');
    this.home = join(this.directory, 'home');
    mkdirSync(this.home);
    this.script({});
    this.checks({});
  }

  /** Write the script the fakes answer from; the attempt counters start over. */
  script(script: Script): void {
    rmSync(`${this.scriptFile}.counts`, { recursive: true, force: true });
    writeFileSync(this.scriptFile, JSON.stringify(script));
  }

  /** Write the rules the stand-in checks follow (see fake-check.mjs); their counters and their record of runs start over. */
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
  static checkFlags(): CheckFlags {
    return { commands: Object.fromEntries(checkKinds.map((kind) => [kind, fakeCheckCommand(kind)])), dropped: [] };
  }

  /** Run a review with the fix pass, its checks the stand-in's unless `change` names others. */
  fix(runtime: 'claude' | 'codex' = 'claude', change: Partial<ReviewOptions> = {}, fake: Record<string, string> = {}): Promise<ReviewOutcome> {
    return this.review(runtime, { fix: ReviewSandbox.checkFlags(), ...change }, fake);
  }

  get checkpoint(): Checkpoint {
    this.#checkpoint ??= Checkpoint.open(locateCheckpoint(this.repo).root, { engine: '0.0.0-test' });
    return this.#checkpoint;
  }

  /** Run a review through the fake of the given runtime, with the flags given, reviewing the last commit (the automatic scope of a clean tree) unless a scope is given. */
  review(runtime: 'claude' | 'codex' = 'claude', change: Partial<ReviewOptions> = {}, fake: Record<string, string> = {}): Promise<ReviewOutcome> {
    return runReview({
      checkpoint: this.checkpoint,
      worktree: this.repo,
      runtimes: defaultRuntimes(),
      runtime,
      executable: process.execPath,
      executableArgs: [runtime === 'claude' ? fakeClaude : fakeCodex],
      rolesRoot: this.rolesRoot,
      flags: {},
      scope: { named: false, request: () => ({ paths: [] }) },
      environment: { ...baseEnvironment, FAKE_SCRIPT: this.scriptFile, FAKE_CHECKS: this.checksFile, ...fake },
      engineEntry: cliEntry,
      scratchRoot: this.scratchRoot,
      home: this.home,
      log: (line) => {
        this.logs.push(line);
      },
      preflightOptions: { timeoutMs: 30_000 },
      ...change,
    });
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

  close(): void {
    this.#checkpoint?.close();
    rmSync(this.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

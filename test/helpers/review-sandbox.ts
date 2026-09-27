// A repository with a change, a checkpoint, a roles directory whose policy
// has short timeouts, and the fake runtimes, so a whole review runs through
// the controller in a test. The fakes are scripted per role and unit.
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import type { RunState } from '../../src/checkpoint/fold.ts';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { runReview, type ReviewOptions, type ReviewOutcome } from '../../src/review/controller.ts';
import { policyFileName, readPolicy } from '../../src/review/policy.ts';
import { defaultRuntimes } from '../../src/runtime/runtimes.ts';
import { repositoryRolesRoot } from '../../src/roles/assemble.ts';
import type { Script } from './fake-runtime.ts';
import { baseEnvironment, fakeClaude, fakeCodex } from './launcher.ts';
import { commitAll, repositoryWith, write } from './repository.ts';

/** The timeout a scripted worker that hangs is killed after: time for the fake to start, even on a loaded runner. */
export const hangTimeoutMs = 4000;

export class ReviewSandbox {
  readonly directory: string;
  readonly repo: string;
  readonly rolesRoot: string;
  readonly scriptFile: string;
  readonly scratchRoot: string;
  readonly home: string;
  readonly logs: string[] = [];
  #checkpoint: Checkpoint | null = null;

  constructor() {
    this.directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-review-')));
    // A repository with one commit, then a change: one file edited, one added, one removed.
    this.repo = repositoryWith(join(this.directory, 'repo'), {
      'src/a.ts': 'export function parse(text: string) {\n  return text.length;\n}\n',
      'src/gone.ts': 'export const gone = 1;\n',
      'AGENTS.md': '# Rules\n\nQuote every glob.\n',
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
    writeFileSync(join(this.rolesRoot, policyFileName), JSON.stringify({ ...policy, roles }, null, 2));
    this.scriptFile = join(this.directory, 'script.json');
    this.scratchRoot = join(this.directory, 'scratch');
    this.home = join(this.directory, 'home');
    mkdirSync(this.home);
    this.script({});
  }

  /** Write the script the fakes answer from; the attempt counters start over. */
  script(script: Script): void {
    rmSync(`${this.scriptFile}.counts`, { recursive: true, force: true });
    writeFileSync(this.scriptFile, JSON.stringify(script));
  }

  get checkpoint(): Checkpoint {
    this.#checkpoint ??= Checkpoint.open(locateCheckpoint(this.repo).root, { engine: '0.0.0-test' });
    return this.#checkpoint;
  }

  /** Run a review through the fake of the given runtime, with the flags given, reviewing the last commit unless a scope is given. */
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
      scope: { paths: [] },
      environment: { ...baseEnvironment, FAKE_SCRIPT: this.scriptFile, ...fake },
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
    const runs = this.checkpoint.listRuns();
    if (runs.length !== 1) throw new Error(`Expected one run, found ${String(runs.length)}`);
    return runs[0]!;
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

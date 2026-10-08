/**
 * A stand-in for a test file, run as its own process by
 * test/git-environment.test.ts with git variables in its environment that
 * name another repository, as `git rebase --exec` or a git hook leaves them.
 * It does what the suite's tests do with git and prints what it saw as JSON;
 * the test then checks that the repository the variables name is untouched.
 *
 * `node inherited-git-probe.ts helpers <directory>` makes repositories in
 * `<directory>` through the test helpers, as a test file does, and runs the
 * engine's own git calls on them. `node inherited-git-probe.ts engine <repo>`
 * imports no helper and only runs the engine's git calls on `<repo>`, a
 * repository the test made, so whatever keeps those calls off the named
 * repository must come from how the process was started.
 */
import { join } from 'node:path';
import { Checkpoint } from '../../src/checkpoint/checkpoint.ts';
import { locateCheckpoint } from '../../src/checkpoint/locate.ts';
import { gitText } from '../../src/scope/git.ts';

/** What the probe saw. */
export interface ProbeReport {
  /** The engine's common git directory for the repository the probe worked in. */
  readonly commonDir: string;
  /** The author of that repository's HEAD commit, as `name <email>`. */
  readonly author: string;
  /** Every ref of that repository, as the engine's git lists it. */
  readonly refs: string[];
}

/** Run the engine's git calls on `repo`: locate its checkpoint, start a run in it, and read its history. */
function engineCalls(repo: string): ProbeReport {
  const location = locateCheckpoint(repo);
  const checkpoint = Checkpoint.open(location.root, { engine: '0.0.0-test' });
  try {
    checkpoint.createRun({ worktree: location.worktree });
  } finally {
    checkpoint.close();
  }
  return {
    commonDir: location.commonDir,
    author: gitText(repo, ['log', '-1', '--format=%an <%ae>', 'HEAD']).trim(),
    refs: gitText(repo, ['for-each-ref', '--format=%(refname)']).split('\n').filter((line) => line.length > 0),
  };
}

const [mode, target] = process.argv.slice(2);
if (target === undefined) throw new Error('Usage: inherited-git-probe.ts helpers|engine <directory>');

let report: ProbeReport;
if (mode === 'helpers') {
  // Imported here, not at the top, so the engine mode loads no helper.
  const { commitAll, git, repositoryWith, write } = await import('./repository.ts');
  const repo = repositoryWith(join(target, 'repo'), { 'a.txt': 'a\n' });
  git(repo, 'branch', 'feature');
  git(repo, 'worktree', 'add', '-q', '--detach', join(target, 'linked'), 'HEAD');
  write(repo, 'b.txt', 'b\n');
  commitAll(repo, 'second');
  report = engineCalls(repo);
} else if (mode === 'engine') {
  report = engineCalls(target);
} else {
  throw new Error(`Unknown mode ${String(mode)}`);
}
process.stdout.write(`${JSON.stringify(report)}\n`);

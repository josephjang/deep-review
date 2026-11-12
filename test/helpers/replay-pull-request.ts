/**
 * A pull request for the sandbox of a replay's test: what `gh` answers for
 * pull request #42 of a review sandbox, whose change is its last commit,
 * and the scope of `review --pr 42` read through it, as the replays of the
 * decider and of the writer review it before they replay a worker.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Gh } from '../../src/github/gh.ts';
import { resolvePullRequestScope, type ScopeSource } from '../../src/review/controller.ts';
import { fakeGh, writeFakeGhScript } from './fake-gh.ts';
import { git } from './repository.ts';
import type { ReviewSandbox } from './review-sandbox.ts';

/** What `gh` answers for pull request #42 of the sandbox, whose change is its last commit. */
export function pullRequestGh(box: ReviewSandbox): Gh {
  const head = git(box.repo, 'rev-parse', 'HEAD');
  const baseHead = 'd'.repeat(40);
  const directory = join(box.directory, 'gh');
  mkdirSync(directory);
  const script = join(directory, 'script.json');
  writeFakeGhScript(script, [
    { endpoint: 'repos/{owner}/{repo}/pulls/42', pages: [{ body: { html_url: 'https://github.com/acme/widgets/pull/42', number: 42, state: 'open', merged: false, head: { sha: head }, base: { ref: 'main' }, changed_files: 3, title: 'Parse with a guard', body: 'Why the parser needs a guard.' } }] },
    { endpoint: 'repos/acme/widgets/git/ref/heads/main', pages: [{ body: { object: { sha: baseHead } } }] },
    { endpoint: `repos/acme/widgets/compare/${baseHead}...${head}`, pages: [{ body: { merge_base_commit: { sha: git(box.repo, 'rev-parse', 'HEAD~1') } } }] },
    { endpoint: 'repos/acme/widgets/pulls/42/files?per_page=100', pages: [{ body: [{ filename: 'src/a.ts', status: 'modified' }, { filename: 'src/b.ts', status: 'added' }, { filename: 'src/gone.ts', status: 'removed' }] }] },
  ]);
  return { executable: process.execPath, args: [fakeGh], cwd: directory, environment: { ...process.env, FAKE_GH_SCRIPT: script } };
}

/** The scope of `review --pr 42`, read through `gh`. */
export const pullRequestSource = (box: ReviewSandbox, gh: Gh): ScopeSource => ({
  named: true,
  pullRequest: true,
  choice: () => ({ mode: 'pull-request', request: { pullRequest: { number: 42, repository: null }, paths: [] } }),
  request: () => resolvePullRequestScope(box.repo, { pullRequest: { number: 42, repository: null }, paths: [] }, gh),
});

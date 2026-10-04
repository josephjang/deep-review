import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existingUserRulesFiles, mailmapAddress, reviewerAuthorship, userConventionFiles } from '../../src/review/conventions.ts';
import { commitAll, git as repoGit, repositoryWith, write as writeFile } from '../helpers/repository.ts';

describe('existingUserRulesFiles', () => {
  let home: string;
  const write = (path: string): void => {
    mkdirSync(join(home, ...path.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(home, ...path.split('/')), `# ${path}\n`);
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'deep-review-conventions-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('lists nothing when neither user-level rules file exists', () => {
    assert.deepEqual(existingUserRulesFiles(home), []);
  });

  it('lists each that exists, absolute, Claude Code\'s before Codex\'s', () => {
    write('.codex/AGENTS.md');
    assert.deepEqual(existingUserRulesFiles(home), [join(home, '.codex', 'AGENTS.md')]);
    write('.claude/CLAUDE.md');
    assert.deepEqual(existingUserRulesFiles(home), [join(home, '.claude', 'CLAUDE.md'), join(home, '.codex', 'AGENTS.md')]);
  });

  it('passes over a directory named like a rules file, and a rules file\'s name anywhere else under home', () => {
    mkdirSync(join(home, '.claude', 'CLAUDE.md'), { recursive: true });
    write('AGENTS.md');
    write('.codex/rules/AGENTS.md');
    assert.deepEqual(existingUserRulesFiles(home), []);
  });

  it('names the two user-level paths the role text names', () => {
    assert.deepEqual(userConventionFiles, ['.claude/CLAUDE.md', '.codex/AGENTS.md']);
  });
});

describe('reviewerAuthorship', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-authorship-'));
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  const gitIn = (repo: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  /** A commit by another author, as a maintainer of the repository makes one. */
  const commitBy = (repo: string, email: string, path: string): void => {
    writeFile(repo, path, `${path}\n`);
    gitIn(repo, 'add', '-A');
    gitIn(repo, '-c', `user.email=${email}`, '-c', 'user.name=Someone', 'commit', '-q', '-m', path);
  };

  it('counts the recent commits authored with the configured email, without regard to case', () => {
    const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': 'a\n' });
    gitIn(repo, 'config', 'user.email', 'Reviewer@Example.invalid');
    commitBy(repo, 'reviewer@example.invalid', 'b.txt');
    commitBy(repo, 'maintainer@example.invalid', 'c.txt');
    writeFile(repo, 'd.txt', 'd\n');
    commitAll(repo, 'by the configured identity');
    // The helper's first commit is test@example.invalid's, then the reviewer's, a maintainer's, and the configured identity's.
    assert.deepEqual(withoutMachineGitConfig(() => reviewerAuthorship(repo)), { identity: 'set', commits: 4, byReviewer: 2 });
  });

  /**
   * Run `body` with git reading no global or system configuration. The
   * machine's own may name an email or change how signatures are checked,
   * and the engine's git inherits the environment.
   */
  const withoutMachineGitConfig = <T>(body: () => T): T => {
    const before = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(sandbox, 'no-global'), GIT_CONFIG_NOSYSTEM: '1' });
    try {
      return body();
    } finally {
      if (before.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = before.global;
      if (before.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = before.nosystem;
    }
  };

  it('says no identity is configured, and so attributes nothing, when user.email is unset for the repository', () => {
    const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': 'a\n' });
    gitIn(repo, 'config', '--unset-all', 'user.email');
    assert.deepEqual(withoutMachineGitConfig(() => reviewerAuthorship(repo)), { identity: 'unset' });
  });

  it('counts an address the repository\'s .mailmap gives as the reviewer\'s, whichever of the two is configured', () => {
    // The reviewer commits at work and at home; the repository's own .mailmap says both addresses are one person's.
    const repo = repositoryWith(join(sandbox, 'repo'), { '.mailmap': 'Rev <Home@Example.invalid> <work@example.invalid>\n' });
    commitBy(repo, 'home@example.invalid', 'b.txt');
    commitBy(repo, 'WORK@example.invalid', 'c.txt');
    commitBy(repo, 'maintainer@example.invalid', 'd.txt');
    // The helper's first commit is test@example.invalid's, then one at home, one at work and a maintainer's.
    gitIn(repo, 'config', 'user.email', 'work@example.invalid');
    assert.deepEqual(withoutMachineGitConfig(() => reviewerAuthorship(repo)), { identity: 'set', commits: 4, byReviewer: 2 });
    gitIn(repo, 'config', 'user.email', 'home@example.invalid');
    assert.deepEqual(withoutMachineGitConfig(() => reviewerAuthorship(repo)), { identity: 'set', commits: 4, byReviewer: 2 });
  });

  it('counts only the configured address when the repository has no .mailmap', () => {
    const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': 'a\n' });
    commitBy(repo, 'home@example.invalid', 'b.txt');
    commitBy(repo, 'work@example.invalid', 'c.txt');
    gitIn(repo, 'config', 'user.email', 'work@example.invalid');
    assert.deepEqual(withoutMachineGitConfig(() => reviewerAuthorship(repo)), { identity: 'set', commits: 3, byReviewer: 1 });
  });

  it('compares a name-keyed .mailmap entry the configured address alone does not match as the configured address', () => {
    // An entry keyed on name and address maps only a commit with both, so the bare configured address stays itself.
    const repo = repositoryWith(join(sandbox, 'repo'), { '.mailmap': 'Rev <home@example.invalid> Work Name <work@example.invalid>\n' });
    commitBy(repo, 'work@example.invalid', 'b.txt');
    gitIn(repo, 'config', 'user.email', 'work@example.invalid');
    // The commit's author is named Someone, so the entry maps neither it nor the configured address.
    assert.deepEqual(withoutMachineGitConfig(() => reviewerAuthorship(repo)), { identity: 'set', commits: 2, byReviewer: 1 });
  });

  it('reads HEAD as the revision when the repository tracks a file named HEAD', () => {
    // Without `--`, git refuses a bare HEAD that names both a revision and a tracked path.
    const repo = repositoryWith(join(sandbox, 'repo'), { HEAD: 'not a revision\n' });
    assert.deepEqual(reviewerAuthorship(repo), { identity: 'set', commits: 1, byReviewer: 1 });
  });

  it('counts each commit once when log.showSignature makes git print signature checks', () => {
    const repo = repositoryWith(join(sandbox, 'repo'), { 'a.txt': 'a\n' });
    // A commit with an SSH signature header, written as a raw object so no signing key is needed. Git cannot verify it and says so on stdout.
    const signed = join(sandbox, 'signed-commit');
    writeFileSync(signed, [
      `tree ${repoGit(repo, 'rev-parse', 'HEAD^{tree}')}`,
      `parent ${repoGit(repo, 'rev-parse', 'HEAD')}`,
      'author Test <test@example.invalid> 1700000000 +0000',
      'committer Test <test@example.invalid> 1700000000 +0000',
      'gpgsig -----BEGIN SSH SIGNATURE-----',
      ' U1NIU0lH',
      ' -----END SSH SIGNATURE-----',
      '',
      'signed',
      '',
    ].join('\n'));
    gitIn(repo, 'update-ref', 'refs/heads/main', repoGit(repo, 'hash-object', '-t', 'commit', '-w', signed));
    gitIn(repo, 'config', 'log.showSignature', 'true');
    withoutMachineGitConfig(() => {
      // The setting does reach a plain `git log`: it prints more lines than the two commits.
      assert.ok(repoGit(repo, 'log', '--format=%ae', 'HEAD', '--').split(/\r?\n/).length > 2);
      assert.deepEqual(reviewerAuthorship(repo), { identity: 'set', commits: 2, byReviewer: 2 });
    });
  });
});

describe('mailmapAddress', () => {
  it('reads the address of a mapped contact and of an unmapped one, lowercased', () => {
    assert.equal(mailmapAddress('Rev <Home@Example.invalid>\n'), 'home@example.invalid');
    assert.equal(mailmapAddress('<work@example.invalid>\r\n'), 'work@example.invalid');
  });

  it('reads the last address when the name itself holds angle brackets', () => {
    assert.equal(mailmapAddress('A <b> C <home@example.invalid>\n'), 'home@example.invalid');
  });

  it('yields none for output with no address, so the configured one is compared', () => {
    assert.equal(mailmapAddress(''), null);
    assert.equal(mailmapAddress('<>\n'), null);
    assert.equal(mailmapAddress('home@example.invalid\n'), null);
  });
});

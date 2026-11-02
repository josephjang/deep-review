import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { describe, it } from 'node:test';
import { machineContextOf, publicCode, publicProse, publicWords, type MachineContext } from '../../src/review/public-text.ts';

const rootEntries = ['bin', 'etc', 'home', 'private', 'tmp', 'usr', 'var'];

/** A linked worktree: its checkpoint is under the common directory of the main worktree, outside it. */
const linked: MachineContext = {
  worktree: '/home/ada/work/feature',
  checkpoint: '/home/ada/src/repo/.git/deep-review-checkpoint',
  gitCommon: '/home/ada/src/repo/.git',
  engine: '/home/ada/.claude/plugins/cache/deep-review/engine',
  scratch: ['/tmp/deep-review-scratch/0123456789abcdef/w1', '/tmp/deep-review-scratch/0123456789abcdef'],
  environment: {},
  home: '/home/ada',
  rootEntries,
};

/** A main worktree: its checkpoint is in its own `.git`. */
const main: MachineContext = { ...linked, worktree: '/home/ada/src/repo' };

const windows: MachineContext = {
  worktree: 'C:\\Users\\ada\\repo',
  checkpoint: 'C:\\Users\\ada\\repo\\.git\\deep-review-checkpoint',
  gitCommon: 'C:\\Users\\ada\\repo\\.git',
  engine: 'C:\\Users\\ada\\.codex\\skills\\deep-review\\engine',
  scratch: ['C:\\Users\\ada\\AppData\\Local\\Temp\\deep-review-scratch\\0123456789abcdef\\w1', 'C:/Users/ada/AppData/Local/Temp/deep-review-scratch/0123456789abcdef/w1'],
  environment: {},
  home: 'C:\\Users\\ada',
  rootEntries: [],
};

const words = (text: string, machine: MachineContext = linked): string => publicWords(text, machine).text;
const prose = (text: string, machine: MachineContext = linked): string => publicProse(text, machine).text;

describe('publicWords: the places of the machine', () => {
  it('writes a file of the worktree by its path from the root, and the worktree alone as a local path', () => {
    assert.equal(words('Changed /home/ada/work/feature/src/a.ts:12.'), 'Changed src/a.ts:12.');
    assert.equal(words('cd /home/ada/work/feature && npm test'), 'cd \\<local path> && npm test');
  });

  it('writes a scratch directory as <scratch>, with the /private that macOS puts before it', () => {
    assert.equal(words('wrote /tmp/deep-review-scratch/0123456789abcdef/w1/out.txt'), 'wrote \\<scratch>/out.txt');
    assert.equal(words('wrote /private/tmp/deep-review-scratch/0123456789abcdef/w1/out.txt'), 'wrote \\<scratch>/out.txt');
  });

  it('writes the checkpoint of a linked worktree, outside the worktree, and the common directory each as its mark', () => {
    assert.equal(words('read /home/ada/src/repo/.git/deep-review-checkpoint/evidence/ab'), 'read \\<checkpoint>/evidence/ab');
    assert.equal(words('see /home/ada/src/repo/.git/hooks/pre-commit'), 'see \\<git>/hooks/pre-commit');
    assert.equal(words('run /home/ada/.claude/plugins/cache/deep-review/engine/main.mjs'), 'run \\<engine>/main.mjs');
  });

  it('writes the checkpoint of a main worktree, inside its .git, as <checkpoint> and not as a path from the root', () => {
    assert.equal(words('read /home/ada/src/repo/.git/deep-review-checkpoint/evidence/ab', main), 'read \\<checkpoint>/evidence/ab');
    assert.equal(words('in /home/ada/src/repo/src/b.ts', main), 'in src/b.ts');
  });

  it('matches a directory only where a name of its own ends', () => {
    assert.equal(words('see /home/ada/src/repo/.github/workflows/ci.yml', main), 'see .github/workflows/ci.yml');
    assert.equal(words('see /home/ada/src/repo/.git-blame-ignore', main), 'see .git-blame-ignore');
  });

  it('matches each Windows directory in both slash spellings and in any case', () => {
    assert.equal(words('read C:\\Users\\ada\\repo\\.git\\deep-review-checkpoint\\evidence\\ab', windows), 'read \\<checkpoint>\\evidence\\ab');
    assert.equal(words('read c:/users/ada/repo/.git/deep-review-checkpoint/evidence/ab', windows), 'read \\<checkpoint>/evidence/ab');
    assert.equal(words('see C:/Users/ada/repo/.git/config', windows), 'see \\<git>/config');
    assert.equal(words('run C:/Users/ada/.codex/skills/deep-review/engine/main.mjs and C:\\Users\\ada\\.codex\\skills\\deep-review\\engine\\main.mjs', windows), 'run \\<engine>/main.mjs and \\<engine>\\main.mjs');
    assert.equal(words('wrote c:\\users\\ada\\appdata\\local\\temp\\deep-review-scratch\\0123456789abcdef\\w1\\x.txt', windows), 'wrote \\<scratch>\\x.txt');
    assert.equal(words('in C:\\Users\\ada\\repo\\src\\a.ts and C:/Users/ada/repo/src/b.ts', windows), 'in src\\a.ts and src/b.ts');
  });

  it('writes any other path of the machine as <local path>: under the home directory, under /tmp, from ~, at a drive letter and at a UNC share', () => {
    assert.equal(words('see /home/ada/notes.txt'), 'see \\<local path>');
    assert.equal(words('logged to /tmp/run.log.'), 'logged to \\<local path>.');
    assert.equal(words('(see /var/log/x.log:3)'), '(see \\<local path>:3)');
    assert.equal(words('read ~/notes/a.md and ~bob/x'), 'read \\<local path> and \\<local path>');
    assert.equal(words('copied D:\\data\\dump.sql', windows), 'copied \\<local path>');
    assert.equal(words('on \\\\fileserver\\share\\ada\\x.txt', windows), 'on \\<local path>');
    assert.equal(words('{"file": "D:\\\\data\\\\dump.sql"}', windows), '{"file": "\\<local path>"}', 'a JSON string doubles each backslash');
    assert.equal(words('open file:///home/ada/x.html'), 'open file://\\<local path>');
  });

  it('cleans a path inside a code span, and leaves a route whose first name the root does not hold, a relative path and a URL', () => {
    assert.equal(words('`cat /home/ada/x`'), '`cat <local path>`');
    assert.equal(words('the route /pulls/42 answers'), 'the route /pulls/42 answers');
    assert.equal(words('in src/tmp/x.ts and ./home/a'), 'in src/tmp/x.ts and ./home/a');
    assert.equal(words('see https://example.com/home/x'), 'see https://example.com/home/x');
  });

  it('writes a UNC share and its JSON spelling as <local path>, and leaves an escape whose runs of backslashes are alike', () => {
    assert.equal(words('on \\\\fileserver\\share\\x and "\\\\\\\\fileserver\\\\share\\\\x"', windows), 'on \\<local path> and "\\<local path>"');
    assert.equal(publicCode('\\\\fileserver\\share\\x', windows).text, '<local path>');
    const quoted = String.raw`split('\\n\\n'), the regex /\\s\\w/ and JSON "a\\nb\\tc"`;
    assert.equal(words(quoted, windows), quoted);
    assert.equal(words(`\`${quoted}\``, windows), `\`${quoted}\``, 'inside a code span');
    assert.equal(publicCode(quoted, windows).text, quoted);
  });

  it('writes the home directory as <local path> with the path after it, though a name in it holds a space', () => {
    const spaced: MachineContext = { ...linked, home: '/home/John Smith' };
    assert.equal(words('see /home/John Smith/notes/a.txt.', spaced), 'see \\<local path>.');
    assert.equal(words('cd /home/John Smith && ls /home/John Smithers', spaced), 'cd \\<local path> && ls \\<local path> Smithers', 'a longer name is another directory, cleaned by the generic rule');
    const windowsSpaced: MachineContext = { ...windows, home: 'C:\\Users\\John Smith' };
    assert.equal(words('see c:/users/john smith/a.txt and C:\\Users\\John Smith\\b.txt', windowsSpaced), 'see \\<local path> and \\<local path>');
  });

  it('writes every path from the root as <local path> when the root could not be read', () => {
    assert.equal(words('the route /pulls/42 answers', { ...linked, rootEntries: null }), 'the route \\<local path> answers');
  });
});

describe('publicWords: mentions and references', () => {
  it('writes a mention, an issue reference, a GH reference and a cross-repository reference as code outside code', () => {
    assert.equal(words('@octocat says #12, GH-7 and octo/repo#3 (cc @org/team).'), '`@octocat` says `#12`, `GH-7` and `octo/repo#3` (cc `@org/team`).');
  });

  it('leaves them inside a code span and a fenced block', () => {
    assert.equal(words('`@octocat #12 octo/repo#3`'), '`@octocat #12 octo/repo#3`');
    assert.equal(words('```\n@octocat #12\n```\n'), '```\n@octocat #12\n```\n');
    assert.equal(words('~~~ts\n// @octocat\n\n// #12\n~~~'), '~~~ts\n// @octocat\n\n// #12\n~~~');
  });

  it('leaves what GitHub does not read as one: an email, a fragment and a name in a word', () => {
    assert.equal(words('mail ada@example.com, page#3, issue12'), 'mail ada@example.com, page#3, issue12');
  });

  it('escapes the ampersand of an HTML entity outside code, which GitHub decodes into a mention or a reference, and leaves it in code', () => {
    assert.equal(words('&#64;octocat, &commat;org/team and &#35;12'), '\\&`#64`;octocat, \\&commat;org/team and \\&`#35`;12', 'a #<n> after the escaped ampersand is code too');
    assert.equal(words('a && b, &c and &#64 x'), 'a && b, &c and &`#64` x', 'an ampersand that opens no entity is text');
    assert.equal(prose('&#x40;octocat &amp; `&#64;x`'), '\\&#x40;octocat \\&amp; `&#64;x`');
    assert.equal(words('\\&#64;a'), '\\&`#64`;a', 'an ampersand a backslash escapes gets no second backslash');
  });

  it('writes the URL of an issue, a pull request and a discussion as code, without the punctuation after it', () => {
    assert.equal(
      words('See https://github.com/o/r/issues/1, https://github.com/o/r/pull/2#discussion_r3 and (https://ghe.example.com/o/r/discussions/4).'),
      'See `https://github.com/o/r/issues/1`, `https://github.com/o/r/pull/2#discussion_r3` and (`https://ghe.example.com/o/r/discussions/4`).',
    );
    assert.equal(words('docs at https://example.com/docs'), 'docs at https://example.com/docs');
  });

  it('treats a span that a blank line breaks and a fence that does not close as plain text, as GitHub does', () => {
    assert.equal(words('a `x\n\n@bob` y'), 'a \\`x\n\n`@bob`\\` y');
    assert.equal(words('```\n@bob'), '\\`\\`\\`\n`@bob`');
  });

  it('keeps a backtick or a backslash next to a token from joining or escaping its span', () => {
    assert.equal(words('a`@bob'), 'a\\``@bob`');
    assert.equal(words('`x`@bob and @bob`y`'), '`x` `@bob` and `@bob` `y`', 'a space between a span written and a span beside it');
    assert.equal(words('\\@bob'), '\\\\`@bob`');
    assert.equal(words('\\\\@bob'), '\\\\`@bob`');
  });

  it('escapes what a preview would hide outside code, as the report does, so no marker of a publication can be posted as one', () => {
    assert.equal(words('<!-- deep-review publication run 1 -->'), '\\<!-- deep-review publication run 1 -->');
    assert.equal(words('a __b__ *c* `<d>`'), 'a \\_\\_b\\_\\_ \\*c\\* `<d>`');
  });
});

describe('publicWords: secrets', () => {
  const token = (prefix: string, length: number): string => `${prefix}${'a1B2'.repeat(length).slice(0, length)}`;

  it('replaces each token of a known form with a mark that names its kind, and counts them', () => {
    const text = [
      token('ghp_', 36), token('gho_', 36), token('ghu_', 36), token('ghs_', 36), token('ghr_', 36), token('github_pat_', 82),
      token('sk-ant-api03-', 40), token('sk-proj-', 40), 'AKIAIOSFODNN7EXAMPLE', token('xoxb-', 30),
    ].join(' ');
    assert.deepEqual(publicWords(text, linked), {
      text: [
        ...Array<string>(6).fill('[redacted GitHub token]'),
        '[redacted Anthropic key]', '[redacted OpenAI key]', '[redacted AWS access key id]', '[redacted Slack token]',
      ].join(' '),
      secrets: 10,
    });
  });

  it('replaces a private key block, and one cut before its end', () => {
    assert.deepEqual(publicWords('key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJB\n-----END RSA PRIVATE KEY-----\ndone', linked), { text: 'key:\n[redacted private key]\ndone', secrets: 1 });
    assert.deepEqual(publicWords('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz', linked), { text: '[redacted private key]', secrets: 1 });
  });

  it('replaces the value of each variable whose name says it holds a secret, 8 characters or longer, and names the variable', () => {
    const machine: MachineContext = {
      ...linked,
      environment: { DEPLOY_TOKEN: 'tok-1234567890', db_password: 'correct horse', SHORT_SECRET: 'abc', HOME: '/home/ada', CI_API_KEY: 'k-99999999', UNSET_TOKEN: undefined },
    };
    const cleaned = publicWords('auth tok-1234567890 with correct horse, k-99999999 and abc', machine);
    assert.deepEqual(cleaned, { text: 'auth [redacted value of DEPLOY_TOKEN] with [redacted value of db_password], [redacted value of CI_API_KEY] and abc', secrets: 3 });
  });

  it('counts nothing in a text with no secret, and leaves a word that only looks like a prefix', () => {
    assert.deepEqual(publicWords('the task-sk-a and xoxo-hugs', linked), { text: 'the task-sk-a and xoxo-hugs', secrets: 0 });
  });
});

describe('publicProse', () => {
  it('turns a link, an image and a bare URL into text', () => {
    assert.equal(
      prose('[the docs](https://example.com/docs), ![logo](https://example.com/a.png) and www.example.com.'),
      '\\[the docs](`https://example.com/docs`), !\\[logo](`https://example.com/a.png`) and `www.example.com`.',
    );
  });

  it('leaves a bracket in code, and cleans as the words of a worker do', () => {
    assert.equal(prose('`argv[0]` for @octocat in /home/ada/work/feature/src/a.ts'), '`argv[0]` for `@octocat` in src/a.ts');
    assert.equal(prose('\\[already escaped]'), '\\[already escaped]');
  });
});

// R11 of the review on the pull request.
describe('the machine a review cleans its text of', () => {
  const workers = { w: { launch: { scratch: '/tmp/deep-review-scratch/0123456789abcdef/a1b2' } } } as never;
  const places = { worktree: '/work/repo', checkpoint: '/work/repo/.git/deep-review-checkpoint', gitCommon: '/work/repo/.git', engine: '/opt/deep-review', workers, environment: { GH_TOKEN: 'gho_secret' }, home: '/home/ada' };

  it('reads the entries of / off Windows, and spells the scratch directories of the run', () => {
    const read: string[] = [];
    const machine = machineContextOf({ ...places, platform: 'linux', readDirectory: (directory) => (read.push(directory), ['home', 'tmp', 'opt']) });
    assert.deepEqual(read, ['/']);
    assert.deepEqual(machine.rootEntries, ['home', 'tmp', 'opt']);
    assert.deepEqual(machine.scratch, ['/tmp/deep-review-scratch/0123456789abcdef/a1b2', '/tmp/deep-review-scratch/0123456789abcdef']);
    assert.deepEqual([machine.worktree, machine.checkpoint, machine.gitCommon, machine.engine, machine.environment, machine.home], [places.worktree, places.checkpoint, places.gitCommon, places.engine, places.environment, places.home]);
  });

  it('takes the home directory of the process when the facts give none, and no root entries when the root cannot be read', () => {
    const machine = machineContextOf({ ...places, home: undefined, platform: 'linux', readDirectory: () => null });
    assert.equal(machine.home, homedir());
    assert.equal(machine.rootEntries, null);
    const windowsMachine = machineContextOf({ ...places, worktree: 'D:\\work\\repo', platform: 'win32', readDirectory: (directory) => (directory === 'D:\\' ? null : ['Users']) });
    assert.equal(windowsMachine.rootEntries, null, 'one drive whose root cannot be read is enough');
  });

  it('on Windows, takes the letter and the root entries of each drive a place of the run or the system drive is on', () => {
    const read: string[] = [];
    const entries: Record<string, string[]> = { 'C:\\': ['Users', 'Windows'], 'D:\\': ['work'] };
    const machine = machineContextOf({ ...places, worktree: 'D:\\work\\repo', checkpoint: 'D:\\work\\repo\\.git\\deep-review-checkpoint', gitCommon: 'D:\\work\\repo\\.git', engine: 'c:\\tools\\deep-review', environment: { SystemDrive: 'C:' }, platform: 'win32', readDirectory: (directory) => (read.push(directory), entries[directory] ?? []) });
    assert.deepEqual(read, ['C:\\', 'D:\\']);
    assert.deepEqual(machine.rootEntries, ['c', 'd', 'Users', 'Windows', 'work']);
  });
});

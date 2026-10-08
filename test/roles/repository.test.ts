import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fixerOutputSchema, surveyorCheckSchema, surveyorOutputSchema, verifierOutputSchema } from '../../src/review/schemas.ts';
import { decisionKinds, fixStatuses, leaveReasons, validationMethods, verdicts } from '../../src/review/vocabulary.ts';
import { assembleRoles, fragmentsDirectoryName, manifestFileName, repositoryRolesRoot } from '../../src/roles/assemble.ts';

/** Every role the engine knows, in manifest order: the surveyor, the ten finder angles and the phase roles around them. */
const expectedRoles = [
  'surveyor',
  'triage',
  'finder-SCAN', 'finder-REMOVALS', 'finder-RIPPLE', 'finder-FOOTGUNS', 'finder-WRAPPERS', 'finder-EFFICIENCY',
  'finder-DESIGN', 'finder-DUPLICATION', 'finder-ALTITUDE', 'finder-CONVENTIONS',
  'deduplication', 'verifier', 'sweep', 'merge-rank',
  'decider',
  'fixer', 'documentation', 'test-assessment', 'auditor', 'answer',
];

/** The roles whose prompt opens with the lead reviewer's brief. */
const leadRoles = ['triage', 'finder-SCAN', 'deduplication', 'verifier', 'sweep', 'merge-rank', 'test-assessment'];

/** The roles the read-only review runs: the surveyor, the triage (which runs `SCAN`), the nine other finders, the four phase roles after them, and the decider. */
const reviewRoles = ['surveyor', 'triage', ...expectedRoles.filter((key) => key.startsWith('finder-') && key !== 'finder-SCAN'), 'deduplication', 'verifier', 'sweep', 'merge-rank', 'decider'];

describe('the repository\'s roles/', () => {
  const roles = assembleRoles(repositoryRolesRoot());

  it('assembles exactly the expected roles, in order', () => {
    assert.deepEqual(roles.map((role) => role.key), expectedRoles);
  });

  it('gives every role a prompt that starts with text and ends with one newline', () => {
    for (const role of roles) {
      assert.ok(role.prompt.length > 0, role.key);
      assert.ok(role.prompt.endsWith('\n') && !role.prompt.endsWith('\n\n'), role.key);
      assert.ok(!role.prompt.startsWith('\n'), role.key);
    }
  });

  it('opens the lead roles with the lead brief and gives every finder the output contract', () => {
    for (const role of roles) {
      const names = role.fragments.map((fragment) => fragment.name);
      if (leadRoles.includes(role.key)) assert.equal(names[0], 'lead-brief.md', role.key);
      if (role.key.startsWith('finder-')) assert.ok(names.includes('finder-output.md'), role.key);
    }
  });

  /**
   * Every place a fragment says that other fragments' text comes below it:
   * the fragment, the words that say so, and the fragments meant, in the
   * order the words give them. Whether "below" is true depends on the
   * manifest's order, so each role that names the fragment is held to it.
   */
  const textBelow: readonly [fragment: string, words: RegExp, below: readonly string[]][] = [
    ['lead-brief.md', /the output contract below/, ['finder-output.md']],
    ['lead-verify.md', /the rubrics below/, ['rubrics.md']],
    ['analyst-brief.md', /angles are defined below[\s\S]*output contract below\s+the angle definitions/, ['angles-analyst.md', 'finder-output.md']],
    ['scout-brief.md', /angles are defined below[\s\S]*output contract below\s+the angle definitions/, ['angles-scout.md', 'finder-output.md']],
    ['conventions-brief.md', /angle is defined below[\s\S]*output contract below\s+the angle definition/, ['angles-conventions.md', 'finder-output.md']],
    ['auditor-brief.md', /three verdict definitions below/, ['step3-verdicts.md']],
    ['phase1-finders.md', /finder angles are defined below/, ['angles-scan.md', 'angles-analyst.md', 'angles-scout.md', 'angles-conventions.md']],
  ];

  /** Each role key whose manifest entry names `fragment`. */
  const keysNaming = (fragment: string): string[] => roles.filter((role) => role.fragments.some((named) => named.name === fragment)).map((role) => role.key);

  /** The roles that run the fixer's prompt: the fix pass, documentation reconciliation and a steering answer. */
  const fixerRoles = ['fixer', 'documentation', 'answer'];

  /**
   * Every place a fragment says that a role's prompt already carries some
   * text, so its reader need not paste it, or that the text it relies on
   * appears in the reader's own prompt: the fragment, the words that say
   * so, the roles meant and the fragments that hold that text. Only the
   * manifest makes such a sentence true.
   */
  const carried: readonly [fragment: string, words: RegExp, roles: readonly string[], fragments: readonly string[]][] = [
    ['phase1-finders.md', /output contract are in the finder's role\s+prompt/, expectedRoles.filter((key) => key.startsWith('finder-')), ['finder-lead.md', 'finder-output.md']],
    ['phase1-finders.md', /it appears here because you consume/, keysNaming('phase1-finders.md'), ['finder-output.md']],
    ['phase2-verify.md', /They are in the\s+verifier's role prompt/, ['verifier'], ['rubrics.md']],
    ['phase2-verify.md', /They appear\s+here because you need/, keysNaming('phase2-verify.md'), ['rubrics.md']],
    ['phase3-sweep.md', /output contract \(in the sweep's\s+role prompt/, ['sweep'], ['finder-output.md']],
    ['postreview-fix-test.md', /its test\s+requirements live in its role prompt/, fixerRoles, ['fixer-apply.md', 'fixer-tests.md']],
    ['postreview-fix-test.md', /dispatch one fixer in documentation reconciliation mode/, ['documentation'], ['fixer-documentation.md']],
  ];

  it('gives each role the text a fragment says its prompt carries', () => {
    for (const [fragment, words, keys, fragments] of carried) {
      assert.match(readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, fragment), 'utf8'), words, fragment);
      assert.ok(keys.length > 0, `${fragment}: no role is meant by ${String(words)}`);
      for (const key of keys) {
        const role = roles.find((candidate) => candidate.key === key);
        assert.ok(role, `${fragment}: no role ${key}`);
        const names = role.fragments.map((named) => named.name);
        for (const name of fragments) assert.ok(names.includes(name), `${fragment} says ${key} carries ${name}, but its manifest entry is ${names.join(', ')}`);
      }
    }
  });

  it('gives each finder the definition of its own angle', () => {
    for (const role of roles.filter((candidate) => candidate.key.startsWith('finder-'))) {
      const angle = role.key.slice('finder-'.length);
      assert.match(role.prompt, new RegExp(`^### Angle ${angle} — `, 'm'), role.key);
    }
  });

  it('places the text a fragment says is below it after that fragment, in every role', () => {
    for (const [fragment, words, below] of textBelow) {
      assert.match(readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, fragment), 'utf8'), words, fragment);
      const naming = roles.filter((role) => role.fragments.some((named) => named.name === fragment));
      assert.ok(naming.length > 0, `no role names ${fragment}`);
      for (const role of naming) {
        const names = role.fragments.map((named) => named.name);
        const positions = [fragment, ...below].map((name) => names.indexOf(name));
        assert.ok(positions.every((position, index) => position > (index === 0 ? -1 : positions[index - 1]!)), `${role.key}: ${[fragment, ...below].join(' then ')}, got ${names.join(', ')}`);
      }
    }
  });

  it('ends the documentation role with its reconciliation rule, after the fixer\'s return format', () => {
    const documentation = roles.find((role) => role.key === 'documentation')!;
    const reconciliation = documentation.prompt.lastIndexOf('**When assigned documentation reconciliation:**');
    const returnFormat = documentation.prompt.lastIndexOf('## Return format');
    assert.ok(returnFormat >= 0 && reconciliation > returnFormat, `reconciliation at ${String(reconciliation)}, return format at ${String(returnFormat)}`);
  });

  it('ends the answer role with the fixer\'s return format, and tells it to dispatch no one', () => {
    // A steering answer is carried out by one fixer, which edits and returns; the Step 3 actions that start fixers are not its task.
    const answer = roles.find((role) => role.key === 'answer')!;
    const report = readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, 'fixer-report.md'), 'utf8');
    const returnFormat = report.lastIndexOf('## Return format');
    assert.ok(returnFormat >= 0, 'fixer-report.md has no return format');
    assert.ok(answer.prompt.endsWith(report.slice(returnFormat)), `answer ends with: ${answer.prompt.slice(-200)}`);
    assert.doesNotMatch(answer.prompt, /\bdispatch/i);
  });

  it('gives every fixer role the fix pass\'s ownership rule: its own files while its batch runs, any file no cluster owns, never another cluster\'s (R4, R18 of the fix pass)', () => {
    for (const key of fixerRoles) {
      const prompt = roles.find((role) => role.key === key)!.prompt;
      assert.match(prompt, /You own your files exclusively while your batch runs/, key);
      assert.match(prompt, /You may also edit any file of the repository that no\s+cluster owns, existing or new, when a fix or its tests need it, and you\s+report every such file/, key);
      assert.match(prompt, /Never touch a file another cluster owns: if a\s+fix genuinely requires one, report the finding blocked and name the file/, key);
      assert.match(prompt, /the files other\s+clusters own, and the project's checks/, key);
      // A cluster's findings go to fix workers in batches, one after another, and a later batch is told what the earlier ones did.
      assert.match(prompt, /gives each cluster's findings, in batches, to fix workers that\s+run one after another, so a cluster has one fix worker at a time/, key);
      assert.match(prompt, /what\s+earlier batches of your cluster did/, key);
      assert.doesNotMatch(prompt, /gives each cluster to one fix worker|exclusively for this pass/, key);
      // A finding blocked on another cluster's file is not lost: it gets a second round (R21 of the fix pass).
      assert.match(prompt, /Once every fixer of the first round has finished, the engine gives such\s+a finding a second round with that file among its own\./, key);
      // The proof of concept's rule, owned files only, is gone wherever it was said.
      assert.doesNotMatch(prompt, /must not edit anything outside them|required edits outside ownership|requires another file/, key);
    }
  });

  it('describes the fixer\'s answer as the fields of its output schema, and no longer as prose lines (R5 of the fix pass)', () => {
    const perFinding = Object.keys(fixerOutputSchema.shape.findings.element.shape).filter((field) => field !== 'index');
    const perAnswer = Object.keys(fixerOutputSchema.shape).filter((field) => field !== 'findings');
    for (const key of fixerRoles) {
      const prompt = roles.find((role) => role.key === key)!.prompt;
      for (const field of [...perFinding, ...perAnswer, ...fixStatuses, ...validationMethods, 'subject', 'body']) assert.ok(prompt.includes(`\`${field}\``), `${key} names \`${field}\``);
      assert.doesNotMatch(prompt, /<ID> (APPLIED|DEFERRED|BLOCKED|CORRECTION|VALIDATION)|^(DRIFT|FILES|TESTS|SUITE) {2,}|APPLIED \(already applied\)/m, key);
    }
  });

  it('tells every fixer role to apply in the task\'s order, snapshot after each finding, and keep its logs in its scratch directory (R6, R15 of the fix pass)', () => {
    for (const key of fixerRoles) {
      const prompt = roles.find((role) => role.key === key)!.prompt;
      assert.match(prompt, /Fix each assigned finding in the order your task numbers them/, key);
      assert.match(prompt, /When you have finished a finding, whatever its status, and before you\s+start the next, run that command with the finding's index/, key);
      assert.match(prompt, /Redirect to a log in your scratch directory, never in the\s+repository/, key);
      assert.doesNotMatch(prompt, /> test\.log/, `${key} names no log beside the run`);
    }
  });

  it('asks every fixer role for the message of an already-applied finding whose edits an earlier attempt left (R20 of the fix pass)', () => {
    for (const key of fixerRoles) {
      const prompt = roles.find((role) => role.key === key)!.prompt;
      assert.match(prompt, /Give one for an\s+already-applied finding too when your task says an earlier attempt\s+left its edits, since their commit carries it; null otherwise\./, key);
    }
  });

  it('tells no worker that returns to the engine to dispatch other workers', () => {
    // The auditor and the fixer roles each return one report; starting workers is the engine's job.
    const returning = roles.filter((role) => ['auditor-brief.md', 'fixer-role.md'].includes(role.fragments[0]!.name));
    assert.deepEqual(returning.map((role) => role.key), ['fixer', 'documentation', 'auditor', 'answer']);
    assert.deepEqual(returning.filter((role) => /\bdispatch/i.test(role.prompt)).map((role) => role.key), []);
  });

  it('tells no lead role to mutate code, which only a fixer may do within its ownership', () => {
    // The fixer's validation procedure edits code to probe a test; a lead role reads and reports.
    const leads = roles.filter((role) => role.fragments[0]!.name === 'lead-brief.md');
    assert.deepEqual(leads.map((role) => role.key), leadRoles);
    assert.deepEqual(leads.filter((role) => /Keep\s+the\s+mutation\s+within\s+your\s+ownership/i.test(role.prompt)).map((role) => role.key), []);
  });

  it('gives the decider its brief, the scope rule, the verifier\'s rubrics it reads the verdicts by, and its own rubric, in that order (R2 of the decision step)', () => {
    const decider = roles.find((role) => role.key === 'decider')!;
    assert.deepEqual(decider.fragments.map((fragment) => fragment.name), ['decider-brief.md', 'worker-scope.md', 'lead-verify.md', 'rubrics.md', 'decider-rubric.md']);
    assert.match(decider.prompt, /return exactly one\s+decision per finding in the requested shape, with no preamble and no\s+commentary/);
    assert.match(decider.prompt, /You edit nothing: probe in\s+your scratch directory, never in the repository/);
    assert.match(decider.prompt, /you do not grade it again/);
  });

  it('lets a fixer defer for a fact the decision did not see, and for a design call or a public interface only when its task gives no decision, as a repair\'s does not (R12 of the decision step)', () => {
    const fixer = roles.find((role) => role.key === 'fixer')!.prompt.replace(/\s+/g, ' ');
    assert.ok(fixer.includes('- The decision you were given did not see a fact you found; name it.'));
    assert.ok(fixer.includes('- Your task gives you no decision, as a repair\'s does not, and the semantics are genuinely ambiguous and need a human design call, or the change crosses a public API boundary whose consumers you cannot audit from this repo.'));
    assert.equal(fixer.split('genuinely ambiguous and need a human design call').length, 2, 'the design call is a criterion only for a task with no decision');
    assert.equal(fixer.split('crosses a public API boundary').length, 2, 'the public interface is a criterion only for a task with no decision');
    assert.ok(fixer.includes('No tests cover the area and the change would alter observable behavior.'), 'the other criteria stay');
  });

  it('names in the decider\'s rubric every decision and exactly the leave reasons the engine records, so the prompt and the schema cannot drift apart (R3 of the decision step)', () => {
    const rubric = readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, 'decider-rubric.md'), 'utf8');
    for (const kind of decisionKinds) assert.match(rubric, new RegExp(`^\\| \`${kind}\` \\|`, 'm'), kind);
    assert.deepEqual([...rubric.matchAll(/^- `([a-z-]+)`: /gm)].map((match) => match[1]), [...leaveReasons]);
    assert.match(rubric, /The reasons a finding is left, and no others:/);
    // An ask never stops the run, and its default is what a fixer applies (R4 of the decision step).
    assert.match(rubric, /An `ask` never stops the run\. A fix worker applies the default you name\s+now/);
    assert.match(rubric, /\*\*The default is the option easiest to take back\*\*/);
  });

  /**
   * The fragments that narrate how the engine runs a review: its phases,
   * the workers it starts and, in the fix pass, its checkpoint files. A
   * worker reads them to know what its answer feeds; worker-scope.md tells
   * it they are not its task.
   */
  const engineNarration = ['phase1-finders.md', 'phase2-verify.md', 'phase3-sweep.md', 'phase4-list.md', 'postreview-fix-test.md'];

  it('lists every fragment that narrates a phase, or speaks of dispatching or checkpoints, as engine narration', () => {
    const fragments = [...new Set(roles.flatMap((role) => role.fragments.map((fragment) => fragment.name)))];
    const narrating = fragments.filter((name) => name !== 'worker-scope.md' && /\b(dispatch|checkpoint)|^## (Phase|Post-review)\b/im.test(readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, name), 'utf8')));
    assert.deepEqual(narrating.sort(), [...engineNarration].sort());
  });

  it('tells every role that reads the engine\'s narration, before it, that the narration is not its task', () => {
    const narrated = roles.filter((role) => role.fragments.some((fragment) => engineNarration.includes(fragment.name)));
    assert.deepEqual(narrated.map((role) => role.key), ['triage', 'deduplication', 'verifier', 'sweep', 'merge-rank', 'test-assessment']);
    for (const role of narrated) {
      const names = role.fragments.map((fragment) => fragment.name);
      const guard = names.indexOf('worker-scope.md');
      assert.ok(guard >= 0 && names.every((name, index) => !engineNarration.includes(name) || index > guard), `${role.key}: ${names.join(', ')}`);
    }
  });

  it('points at no checkpoint discipline, which no fragment defines', () => {
    // It lived in the prompt-only skill's resume.md, which the proposal does not move.
    assert.deepEqual(roles.filter((role) => /checkpoint\s+discipline/i.test(role.prompt)).map((role) => role.key), []);
  });

  /**
   * Text the read-only review's workers must not read (PD14 of the
   * read-only review): the angle-decision worker and its run or skip
   * decision, which no longer exist; the checkpoint files the prompt-only
   * driver wrote, which the engine's ledger replaces; the steps of the fix
   * pass, which a later element runs; and the `Driver lead` label, which
   * only an overridden skip produced.
   */
  const notForReviewWorkers: readonly [RegExp, string][] = [
    [/angle-decision/i, 'the angle-decision worker'],
    [/\brun\s*\/\s*skip\b|\bskip\s+reasons?\b|\bskipped\s+in\s+Phase\b|\boverride\s+to\s+run\b/i, 'a decision to skip an angle'],
    [/\b(triage|candidates|verdicts|sweep|ranked|fixes|audit)\.md\b/, 'a checkpoint file'],
    [/\bStep\s+[123]\b/, 'a step of the fix pass'],
    [/Driver lead/, 'the Driver lead label'],
  ];

  it('tells the roles the read-only review runs nothing about the angle decision, checkpoint files or the fix pass', () => {
    for (const key of reviewRoles) {
      const role = roles.find((candidate) => candidate.key === key)!;
      for (const [pattern, what] of notForReviewWorkers) assert.doesNotMatch(role.prompt, pattern, `${key} names ${what}`);
    }
  });

  it('points CONVENTIONS at the survey\'s convention sources wherever it is defined, judged or swept, and at no fixed list of rules files (R7, R13 of the repository survey)', () => {
    const fragment = (name: string): string => readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, name), 'utf8');
    const definition = fragment('angles-conventions.md');
    assert.match(definition, /The scope block lists the convention sources the repository survey named/);
    assert.match(definition, /A file the scope block does\s+not list is not a convention source, whatever its name/);
    assert.match(definition, /If the scope block\s+lists no source, or none governs the changed files, return nothing for\s+this angle/);
    const rubric = fragment('rubrics.md').slice(fragment('rubrics.md').indexOf('### Rubric for the CONVENTIONS angle'));
    assert.match(rubric, /the cited file is a convention source the scope block\s+lists/);
    assert.match(fragment('phase3-sweep.md'), /a clear violation of a rule a listed convention source\s+states/);
    // The fixed list is gone from every role the review runs but the surveyor, which is told where a contributor looks.
    const surveyed = ['surveyor', 'finder-CONVENTIONS', 'verifier', 'sweep', 'triage'];
    for (const key of surveyed.slice(1)) assert.match(roles.find((role) => role.key === key)!.prompt, /convention sources?/, key);
    for (const key of reviewRoles.filter((name) => name !== 'surveyor')) {
      assert.doesNotMatch(roles.find((role) => role.key === key)!.prompt, /CLAUDE\.local\.md|ancestor of a\s+changed file|verify the list yourself/, key);
    }
  });

  it('tells the surveyor to list the rule files inside a directory of rules, never the directory, which the engine refuses (R8 of the repository survey)', () => {
    // checkSurveyAnswer refuses a source that is not a regular file, and the retry is not told why, so naming the directory fails both attempts.
    const surveyor = roles.find((role) => role.key === 'surveyor')!;
    assert.match(surveyor.prompt, /the files in a\s+`\.cursor\/rules` directory/);
    assert.match(surveyor.prompt, /list each such file, never a\s+directory/);
    assert.doesNotMatch(surveyor.prompt, /a `\.cursor\/rules`\s+directory and the like/);
  });

  it('sends the surveyor into every directory between the root and a changed path, since no later worker looks past its list (R7 of the repository survey)', () => {
    // A subdirectory's rules file the survey leaves out is no convention source to any finder or verifier, and the engine never checks the list for one.
    const surveyor = roles.find((role) => role.key === 'surveyor')!;
    assert.match(surveyor.prompt, /rules files written for coding assistants, at the root, in\s+every directory between the root and a changed path/);
  });

  it('has the CONVENTIONS verifier judge what a source that names no paths reaches, since the engine refuses no scope by file name (R11 of the repository survey)', () => {
    // A rules file in a subdirectory may govern the whole repository (.claude/CLAUDE.md) or one package; only its place and its words say which.
    const rubric = readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, 'rubrics.md'), 'utf8');
    const conventions = rubric.slice(rubric.indexOf('### Rubric for the CONVENTIONS angle'));
    assert.match(conventions, /cover that file; when it names none, judge from where the\s+source lives and what it says whether it reaches that file: a rules\s+file in one package's directory governs that package, not its\s+siblings\) AND the quoted line breaks the quoted rule/);
    const surveyor = roles.find((role) => role.key === 'surveyor')!;
    assert.doesNotMatch(surveyor.prompt, /in a subdirectory whose `appliesTo` is null/);
  });

  it('has CONVENTIONS follow a local file a listed source imports from outside the repository, and judges a rule in it as the source\'s', () => {
    // A rules file whose whole content is `@../.codex/AGENTS.md` states its rules only through the import; the engine lists no path outside the repository but the offered user-level files.
    const fragment = (name: string): string => readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, name), 'utf8');
    const definition = fragment('angles-conventions.md');
    assert.match(definition, /following any local file it\s+imports or links to, in the repository or outside it/);
    assert.doesNotMatch(definition, /imports or\s+links to inside the repository/);
    assert.match(definition, /unless a listed\s+source imports or links to it: its rules are then that source's/);
    const rubric = fragment('rubrics.md').slice(fragment('rubrics.md').indexOf('### Rubric for the CONVENTIONS angle'));
    assert.match(rubric, /or a file such a source imports or links to/);
    assert.match(rubric, /neither a listed convention source nor\s+a file one imports or links to/);
    // The surveyor lists only files of the repository, and its reason for leaving a page out is the network, not that no worker can read a local file.
    const surveyor = roles.find((role) => role.key === 'surveyor')!;
    assert.doesNotMatch(surveyor.prompt, /since no\s+worker can read it/);
    assert.match(surveyor.prompt, /A web page\s+that a file links to is not a source, since a worker has no network to\s+read it/);
    assert.match(surveyor.prompt, /Nor is a local file outside the\s+repository that a source imports, unless your task offers it/);
    assert.match(surveyor.prompt, /the finder that checks\s+the source follows its imports/);
  });

  it('tells every fixer role to keep its edits within the convention sources the scope block lists (R7 of the repository survey)', () => {
    for (const key of fixerRoles) {
      const prompt = roles.find((role) => role.key === key)!.prompt;
      assert.match(prompt, /\*\*Keep your edits within the repository's conventions\.\*\* The scope block\s+lists the convention sources the repository survey named/, key);
      assert.match(prompt, /A rules file the scope block does not list is\s+not one this repository asks you to keep/, key);
    }
  });

  it('describes the surveyor\'s answer as the fields of its output schema, and tells it to run no check (R2, R4, PD9 of the repository survey)', () => {
    const surveyor = roles.find((role) => role.key === 'surveyor')!;
    const conventionFields = Object.keys(surveyorOutputSchema.shape.conventions.element.shape);
    const fields = [...Object.keys(surveyorOutputSchema.shape), ...conventionFields, ...Object.keys(surveyorCheckSchema.shape), 'applied', 'quote', 'build', 'typecheck', 'lint', 'test', 'stated', 'hint', 'repository', 'user'];
    for (const field of fields) assert.ok(surveyor.prompt.includes(`\`${field}\``), `surveyor names \`${field}\``);
    assert.match(surveyor.prompt, /run no check, no\s+test suite, no build and no installer/);
    assert.match(surveyor.prompt, /Do not run the checks: the engine runs them itself/);
    assert.match(surveyor.prompt, /an empty\s+`conventions` list is then the correct answer/);
    assert.match(surveyor.prompt, /Prefer the form that verifies over the form that rewrites/);
    // The reviewer's identity is the task's fact, never the surveyor's lookup, and a tool run through what provides it is not missing (the first survey gate, 2026-10-04).
    assert.match(surveyor.prompt, /do not look the reviewer's identity up yourself, and never take a\s+commit's author for it/);
    assert.match(surveyor.prompt, /`uv run --group dev tox` needs `uv`, not `tox`/);
    assert.doesNotMatch(surveyor.prompt, /git config user\.email/);
    // The reviewer's own rules are offered or settled by the policy; a file not offered is never listed.
    assert.match(surveyor.prompt, /one it does not offer is settled by the\s+review policy, and you never list it/);
  });

  it('tells the triage and every finder how the engine runs every angle and assigns every id', () => {
    const triage = roles.find((role) => role.key === 'triage')!;
    assert.match(triage.prompt, /Every angle runs on every review/);
    assert.match(triage.prompt, /A worker never assigns an ID/);
    assert.match(triage.prompt, /`SCAN lead`|`Lead: none`/);
    for (const key of reviewRoles.filter((name) => name.startsWith('finder-'))) {
      assert.match(roles.find((role) => role.key === key)!.prompt, /Your prompt may carry a `SCAN lead` for your angle/, key);
    }
  });

  it('tells the verifier that an answer missing a candidate is discarded whole, as the engine does', () => {
    // checkVerdicts refuses the whole answer, so a prompt that says only the missed candidates fall back would be false.
    const verifier = roles.find((role) => role.key === 'verifier')!;
    assert.match(verifier.prompt, /an answer\s+that misses one is discarded whole/);
    assert.match(verifier.prompt, /every candidate in the group is kept as PLAUSIBLE/);
    assert.doesNotMatch(verifier.prompt, /the affected candidates|recorded as they arrive/);
  });

  it('tells the verifier that a candidate on an unchanged file is located outside the change, as the engine records it', () => {
    // normalizeLocations matches such a path to the file and checks its line; only a missing file or line leaves a candidate unlocated.
    const verifier = roles.find((role) => role.key === 'verifier')!;
    assert.match(verifier.prompt, /matched to that file, in the repository's own spelling,\s+never to a changed path it merely ends with/);
    assert.match(verifier.prompt, /the candidate is marked `outside the change`/);
    assert.match(verifier.prompt, /whose file names no file of the\s+repository, or whose line lies past that\s+file's end, is kept and marked `unlocated`/);
    assert.doesNotMatch(verifier.prompt, /matches no\s+changed path/);
  });

  it('gives the rules every rubric shares first, then each rubric as checks, grades and what separates them (R1, R2, R4 of the verifier rubric)', () => {
    const rubric = readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, 'rubrics.md'), 'utf8');
    // The first section keeps the name the auditor's verdicts call the gate by, whatever stands between its two halves.
    const headings = [...rubric.matchAll(/^### (.+)$/gm)].map((match) => match[1]!);
    const expected = [/^All rubrics .+ verify before you judge$/, /^Rubric for the correctness & cost angles$/, /^Rubric for the design & cleanup angles$/, /^Rubric for the CONVENTIONS angle$/];
    assert.equal(headings.length, expected.length, headings.join(' | '));
    expected.forEach((pattern, index) => assert.match(headings[index]!, pattern));

    const between = (from: string, to: string): string => rubric.slice(rubric.indexOf(from), rubric.indexOf(to));
    // What every table relies on: the claim as written and how it may be narrowed, the check against the candidate, answers from the code.
    const shared = between('### All rubrics', '### Rubric for the correctness & cost angles').replace(/\s+/g, ' ');
    for (const rule of [
      '**Grade the claim as written.**',
      'open the evidence line with `Narrowed to:` and the statement',
      'It never replaces the problem',
      '**Try to break it before you grade it.**',
      'Every table has an `Against` check',
      '**Answer from the code.**',
      'say which check and grade PLAUSIBLE',
    ]) assert.ok(shared.includes(rule), `the shared rules do not say "${rule}"`);

    const graded: readonly [name: string, text: string][] = [
      ['correctness & cost', between('### Rubric for the correctness & cost angles', '### Rubric for the design & cleanup angles')],
      ['design & cleanup', between('### Rubric for the design & cleanup angles', '### Rubric for the CONVENTIONS angle')],
    ];
    for (const [name, text] of graded) {
      assert.match(text, /^\| Check \| Question \| How to answer \|$/m, `${name}: no table of checks`);
      assert.match(text, /^\| Against \|/m, `${name}: no check against the candidate`);
      assert.match(text, /^\| Grade \|.+\|$/m, `${name}: no table of grades`);
      for (const verdict of verdicts) assert.match(text, new RegExp(`^\\| ${verdict} \\|`, 'm'), `${name}: no row for ${verdict}`);
      assert.match(text, /^What separates the grades:$/m, `${name}: no statement of what separates the grades`);
      assert.match(text, /^Each side of each line:$/m, `${name}: no examples on each side`);
    }
  });

  it('states the evidence line\'s limit as the verifier\'s answer schema has it (R5 of the verifier rubric)', () => {
    // An answer whose evidence is longer fails its schema and costs the group one of its two attempts, so the rubric's number must be the schema's.
    const rubric = readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, 'rubrics.md'), 'utf8').replace(/\s+/g, ' ');
    const stated = /It holds at most (\d+) characters/.exec(rubric);
    assert.ok(stated, 'the rubric states no limit for the evidence line');
    const limit = Number(stated[1]);
    const answer = (length: number): unknown => ({ verdicts: [{ index: 0, verdict: 'CONFIRMED', evidence: 'x'.repeat(length) }] });
    assert.equal(verifierOutputSchema.safeParse(answer(limit)).success, true, `the schema refuses ${String(limit)} characters`);
    assert.equal(verifierOutputSchema.safeParse(answer(limit + 1)).success, false, `the schema accepts ${String(limit + 1)} characters`);
    // The form the line takes: the answers in the table's order, closed by the one that separates the grade from its neighbour.
    assert.ok(rubric.includes('ends with the one answer that separates the grade from the neighbouring one: `Not CONFIRMED: ...`, `Not REFUTED: ...`'));
    assert.ok(rubric.includes('add `Needs the author:` and the choice. That note never changes the grade.'));
  });

  it('answers in the correctness rubric the four questions the author decided (R6 of the verifier rubric)', () => {
    const rubric = readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, 'rubrics.md'), 'utf8');
    const correctness = rubric.slice(rubric.indexOf('### Rubric for the correctness & cost angles'), rubric.indexOf('### Rubric for the design & cleanup angles')).replace(/\s+/g, ' ');
    // An intended behavior that a candidate calls wrong stays, for the author (D7).
    assert.ok(correctness.includes('**Deliberate is not refuted.**'));
    assert.ok(correctness.includes('the candidate stays: it may be saying the intent is wrong, and that is the author\'s to decide'));
    // A published library's public interface has callers outside the repository; code only the repository calls does not (D8).
    assert.ok(correctness.includes('In a library published for others to use, a public interface has callers outside the repository'));
    assert.ok(correctness.includes('In code only this repository calls, a state none of its callers produces is REFUTED'));
    // Refuting takes an established fact, never an argument (D9).
    assert.ok(correctness.includes('**Refuting takes a fact you established**'));
    assert.ok(correctness.includes('An argument that the effect ought to be harmless or the cost ought to be small is not that fact: grade PLAUSIBLE'));
    // A comment that is false about the code is a wrong result, though nothing fails when the code runs (D14).
    assert.ok(correctness.includes('**A false comment is a wrong result.**'));
    assert.ok(correctness.includes('the user is the reader and the wrong result is the false statement'));
    assert.ok(correctness.includes('It is REFUTED when the statement is true of those lines, or is only less exact than it could be and says nothing false.'));
  });

  it('states no posture toward a grade in any prompt, and sends the verifier to each rubric for what its grades do (R7 of the verifier rubric)', () => {
    // A posture ("PLAUSIBLE by default") and a table that disagree on a candidate leave the choice to the reader; each boundary is a named check instead.
    for (const role of roles) {
      const prompt = role.prompt.replace(/\s+/g, ' ');
      for (const posture of ['PLAUSIBLE by default', 'Do not default to PLAUSIBLE', 'never quietly dropped']) assert.ok(!prompt.includes(posture), `${role.key} says "${posture}"`);
      // Neither grade decides whether a fix is applied without asking: the decision step does (R11 of the decision step).
      assert.ok(!prompt.includes('the split between the other two decides whether the fix is applied without asking'), role.key);
    }
    const leadVerify = readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, 'lead-verify.md'), 'utf8').replace(/\s+/g, ' ');
    assert.ok(leadVerify.includes('The other two go to the decision step, which decides what is done about the finding; each rubric says in its first lines what its PLAUSIBLE tells that step.'));
  });

  it('cites to the rubric\'s "verify before you judge" gate no feasibility rule the gate does not state', () => {
    // The auditor's prompt does not carry the rubric, so its verdicts state the feasibility rule themselves; a sentence crediting it to the gate would be false.
    const rubric = readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, 'rubrics.md'), 'utf8');
    const gate = rubric.slice(rubric.indexOf('### All rubrics'), rubric.indexOf('### Rubric for the correctness & cost angles'));
    assert.doesNotMatch(gate, /feasib/i);
    const auditor = roles.find((role) => role.key === 'auditor')!;
    assert.ok(!auditor.fragments.some((fragment) => fragment.name === 'rubrics.md'));
    const prompt = auditor.prompt.replace(/\s+/g, ' ');
    const citing = prompt.split(/(?<=\.) /).filter((sentence) => sentence.includes('"verify before you judge"'));
    assert.ok(citing.length > 0, 'the auditor no longer names the gate');
    for (const sentence of citing) assert.doesNotMatch(sentence, /feasib/i, sentence);
    assert.ok(prompt.includes('Route a refactor here only once you\'ve confirmed it is feasible, by sketching its concrete target (an unworkable target is REFUTE)'));
  });

  it('names no mechanism of one runtime in any prompt', () => {
    const offences = roles.flatMap((role) => runtimeWordingIn(role.prompt).map((offence) => `${role.key} ${offence}`));
    assert.deepEqual(offences, []);
  });
});

/**
 * Wording that names one runtime's mechanism, which no worker on another
 * runtime has (R6 of the role prompts proposal): Claude Code's subagents
 * and the `Agent` tool that spawns them, its `AskUserQuestion` tool, its
 * `Grep` tool, the "single message block" that runs tool calls in
 * parallel (and "the same block" that pointed back at it), and the names
 * of the prompt-only skill's subagents. "scope block" is not one. It
 * also finds "the driver", the prompt-only skill's name for the session
 * that runs a review, which here is the engine; a backticked `Driver lead`
 * is a label a finder reads like `SCAN lead`, not a name for the engine.
 *
 * Each pattern is matched against a whole prompt, and a space inside a
 * phrase is `\s+`, so a phrase that a line wrap splits in two is still
 * found; a subagent name may break after its dash. Every pattern ignores
 * case except the Grep tool's, because a lowercase `grep` is the shell
 * command every runtime's shell has. `AGENTS.md`, an instruction file, is
 * not an agent.
 */
const runtimeWording: readonly [RegExp, string][] = [
  [/\bsubagents?\b/gi, 'subagent'],
  [/`Agent`/gi, 'the Agent tool'],
  [/subagent_type/gi, 'subagent_type'],
  [/AskUserQuestion/gi, 'AskUserQuestion'],
  [/orchestrator/gi, 'the orchestrator'],
  [/\bagents?\b(?!\.md\b)/gi, 'agent, meaning a worker'],
  [/\bGrep\b/g, 'the Grep tool'],
  [/\btier\s+table\b/gi, 'the tier table'],
  [/\b(message|same)\s+block\b/gi, 'a message block'],
  [/\bdeep-review-\s*(lead|fixer|auditor|analyst|scout|conventions|driver)\b/gi, 'a subagent name'],
  [/\bdeep-review\s+skill\b/gi, 'the deep-review skill as the worker\'s employer'],
  [/(?<!`)\bdriver\b/gi, 'the driver, meaning the engine'],
];

/** Each runtime-specific phrase in `text`, as "line N names WHAT: LINE", N being the line the phrase starts on. */
function runtimeWordingIn(text: string): string[] {
  const lines = text.split('\n');
  const offences: string[] = [];
  for (const [pattern, what] of runtimeWording) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      offences.push(`line ${String(line)} names ${what}: ${lines[line - 1]!.trim()}`);
    }
  }
  return offences;
}

describe('the runtime-wording guard', () => {
  /** The WHAT of each offence the guard reports in `text`. */
  const named = (text: string): string[] => runtimeWordingIn(text).map((offence) => offence.replace(/^line \d+ names (.*?): .*$/s, '$1'));

  it('finds a phrase that a line wrap splits in two', () => {
    assert.deepEqual(named('run it from the tier\ntable above'), ['the tier table']);
    assert.deepEqual(named('all in a single message\n  block'), ['a message block']);
    assert.deepEqual(named('write it in the same\nblock as the dispatch'), ['a message block']);
    assert.deepEqual(named('a subagent of the deep-review\nskill'), ['subagent', 'the deep-review skill as the worker\'s employer']);
    assert.deepEqual(named('`subagent_type: "deep-review-\nlead"`'), ['subagent_type', 'a subagent name']);
  });

  it('finds a phrase whatever its case', () => {
    assert.deepEqual(named('Tier table first.'), ['the tier table']);
    assert.deepEqual(named('Message Block rules.'), ['a message block']);
    assert.deepEqual(named('The Deep-Review Skill says so.'), ['the deep-review skill as the worker\'s employer']);
    assert.deepEqual(named('Spawn a DEEP-REVIEW-FIXER.'), ['a subagent name']);
    assert.deepEqual(named('Two Agents edit it.'), ['agent, meaning a worker']);
  });

  it('passes the instruction file AGENTS.md, a scope block and the grep command', () => {
    assert.deepEqual(named('Read AGENTS.md and agents.md first.'), []);
    assert.deepEqual(named('The scope block is shared.'), []);
    assert.deepEqual(named('Run grep -n on the file.'), []);
    assert.deepEqual(named('Grep for the symbol.'), ['the Grep tool']);
  });

  it('finds the driver in prose but passes the `Driver lead` label', () => {
    assert.deepEqual(named('uses the driver\'s verified reason'), ['the driver, meaning the engine']);
    assert.deepEqual(named('is not a Driver run'), ['the driver, meaning the engine']);
    assert.deepEqual(named('a `SCAN lead` or `Driver lead` for your angle'), []);
  });

  it('reports the line a phrase starts on, and that line\'s text', () => {
    assert.deepEqual(runtimeWordingIn('first\nsecond\n  the orchestrator reads it\n'), ['line 3 names the orchestrator: the orchestrator reads it']);
    assert.deepEqual(runtimeWordingIn('first\nthe tier\ntable'), ['line 2 names the tier table: the tier']);
  });
});

describe('scripts/roles.ts', () => {
  const script = resolve(import.meta.dirname, '../../scripts/roles.ts');
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'deep-review-roles-script-'));
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('prints one line per role and writes each assembled prompt under --output', () => {
    const output = join(sandbox, 'out');
    const result = spawnSync(process.execPath, [script, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.deepEqual(lines.slice(0, -1).map((line) => line.split('\t')[0]), expectedRoles);
    assert.match(lines.at(-1)!, /^Wrote 22 prompts to /);
    assert.deepEqual(readdirSync(output).sort(), expectedRoles.map((key) => `${key}.md`).sort());
    for (const role of assembleRoles(repositoryRolesRoot())) {
      assert.equal(readFileSync(join(output, `${role.key}.md`), 'utf8'), role.prompt, role.key);
    }
  });

  it('refuses an --output directory that already exists', () => {
    const result = spawnSync(process.execPath, [script, '--output', sandbox], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not exist yet/);
    assert.deepEqual(readdirSync(sandbox), []);
  });

  it('refuses an --output that already exists as a file, leaving the file as it was', () => {
    const output = join(sandbox, 'out');
    writeFileSync(output, 'kept\n');
    const result = spawnSync(process.execPath, [script, '--output', output], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not exist yet/);
    assert.equal(readFileSync(output, 'utf8'), 'kept\n');
  });

  it('refuses a file system root as --output', () => {
    const result = spawnSync(process.execPath, [script, '--output', parse(sandbox).root], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not exist yet/);
  });

  it('creates the missing parents of --output', () => {
    const other = writeSmallRoles();
    const output = join(sandbox, 'a', 'b', 'out');
    const result = spawnSync(process.execPath, [script, '--root', other, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(output), ['only.md']);
  });

  /** A one-role roles directory under the sandbox, for the cases that must not touch the repository's roles/. */
  function writeSmallRoles(): string {
    const other = join(sandbox, 'roles');
    mkdirSync(join(other, fragmentsDirectoryName), { recursive: true });
    writeFileSync(join(other, manifestFileName), JSON.stringify({ schemaVersion: 1, roles: { only: ['a.md'] } }));
    writeFileSync(join(other, fragmentsDirectoryName, 'a.md'), 'alpha\n');
    return other;
  }

  it('assembles another roles directory with --root', () => {
    const other = writeSmallRoles();
    const result = spawnSync(process.execPath, [script, '--root', other], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^only\t1 fragments\t6 bytes\t[a-f0-9]{64}\n$/);
  });

  it('refuses an --output inside the roles directory and leaves that directory as it was', () => {
    const other = writeSmallRoles();
    const inside = [
      join(other, 'assembled'),
      join(other, fragmentsDirectoryName, 'prompts'),
      // Missing parents inside the roles directory must not be created either.
      join(other, fragmentsDirectoryName, 'nested', 'prompts'),
    ];
    // Windows paths compare without regard to case, so a differently cased spelling is the same directory.
    if (process.platform === 'win32') inside.push(join(other.toUpperCase(), 'assembled'));
    for (const output of inside) {
      const result = spawnSync(process.execPath, [script, '--root', other, '--output', output], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, output);
      assert.match(result.stderr, /must not be inside the roles directory/, output);
      assert.deepEqual(readdirSync(other).sort(), [fragmentsDirectoryName, manifestFileName].sort(), output);
      assert.deepEqual(readdirSync(join(other, fragmentsDirectoryName)), ['a.md'], output);
    }
    assert.deepEqual(assembleRoles(other).map((role) => role.key), ['only']);
  });

  it('accepts an --output beside the roles directory whose name merely starts like it', () => {
    const other = writeSmallRoles();
    const output = `${other}-assembled`;
    const result = spawnSync(process.execPath, [script, '--root', other, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(output, 'only.md'), 'utf8'), 'alpha\n');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CandidateState } from '../../src/checkpoint/review-fold.ts';
import { codeSpan, deciderTask, deduplicationTask, describeLocation, finderTask, fixerTask, mergeRankTask, repairTask, snapshotIndexPlaceholder, surveyTask, sweepTask, triageTask, unelevatedSandboxRule, verifierTask, type FixerTaskInput, type SurveyTaskInput } from '../../src/review/tasks.ts';
import { finderAngles } from '../../src/review/vocabulary.ts';

const candidate = (id: string, angle: CandidateState['angle'], change: Partial<CandidateState> = {}): CandidateState => ({
  id,
  angle,
  file: 'src/a.ts',
  line: 4,
  located: true,
  inScope: true,
  rawFile: 'src/a.ts',
  rawLine: 4,
  summary: `${id} summary`,
  detail: `${id} detail`,
  phase: 'finders',
  workerId: '00000000-0000-4000-8000-000000000001',
  duplicateOf: null,
  verdict: null,
  unverified: false,
  ...change,
});
const unlocated = candidate('SWEEP-1', 'DESIGN', { file: null, line: null, located: false, inScope: false, rawFile: 'C:\\x\\b.ts', rawLine: 9, phase: 'sweep' });
const outside = candidate('RIPPLE-3', 'RIPPLE', { file: 'src/caller.ts', line: 12, inScope: false, rawFile: 'C:\\repo\\src\\caller.ts', rawLine: 12 });

describe('describeLocation', () => {
  it('gives the repository location, marked when outside the change, or the finder\'s own with the unlocated mark', () => {
    assert.equal(describeLocation(candidate('SCAN-1', 'SCAN')), 'src/a.ts:4');
    assert.equal(describeLocation(outside), 'src/caller.ts:12 (outside the change: an unchanged file of the repository)', 'the canonical path, not the finder\'s spelling');
    assert.equal(describeLocation(unlocated), 'C:\\x\\b.ts:9 (unlocated: no file of the repository has this path and line)');
  });
});

describe('codeSpan', () => {
  it('quotes plain text in single backticks', () => {
    assert.equal(codeSpan('npm run lint'), '`npm run lint`');
  });

  it('uses a delimiter one backtick longer than the longest run inside, so the text cannot close the span', () => {
    assert.equal(codeSpan('echo `date` now'), '``echo `date` now``');
    assert.equal(codeSpan('a ``b`` c'), '```a ``b`` c```');
  });

  it('pads with a space a text that starts or ends with a backtick, which would otherwise join the delimiter', () => {
    assert.equal(codeSpan('`x'), '`` `x ``');
    assert.equal(codeSpan('echo `date`'), '`` echo `date` ``');
  });

  it('pads a text that both starts and ends with a space, which a renderer would otherwise strip', () => {
    assert.equal(codeSpan(' x '), '`  x  `');
    assert.equal(codeSpan(' x'), '` x`', 'a space at one end only is kept as it is');
  });
});

describe('the survey task', () => {
  const input: SurveyTaskInput = {
    platform: 'linux',
    fix: true,
    settled: [],
    unsettled: ['lint', 'test'],
    hints: [
      { kind: 'lint', command: 'npm run lint', rule: 'package', reading: 'the package.json script `lint` through npm, by package-lock.json' },
      { kind: 'test', command: null, rule: 'none', reading: 'no rule names it' },
    ],
    offered: [],
    policySettlesUserRules: true,
    authorship: { identity: 'unset' },
    elevatedSandbox: false,
  };

  it('looks a tool up as the check\'s shell resolves it: where.exe on Windows, command -v elsewhere', () => {
    assert.match(surveyTask({ ...input, platform: 'win32' }), /as `cmd\.exe \/d \/s \/c "<command>"`[^\n]*, with `where\.exe <tool>`, and judge the lookup by whether it succeeded/);
    assert.match(surveyTask(input), /as `\/bin\/sh -c "<command>"`[^\n]*, with `command -v <tool>`, and judge/);
  });

  it('looks a tool up with Get-Command in place of where.exe under the elevated sandbox, and changes nothing else (R12 of the Codex sandbox)', () => {
    const plain = surveyTask({ ...input, platform: 'win32' });
    const elevated = surveyTask({ ...input, platform: 'win32', elevatedSandbox: true });
    const lookup = '`powershell.exe -NoProfile -Command "Get-Command -CommandType Application <tool>"` and, when that fails, the same with `.\\<tool>`, since `cmd.exe` also runs a script in the repository root such as `gradlew.bat`, where `Get-Command` does not look (not `where.exe`, which finds nothing as this sandbox\'s user under a directory whose ancestors it cannot list)';
    assert.equal(elevated, plain.replace('`where.exe <tool>`', lookup), 'the lookup is the one difference');
    assert.notEqual(elevated, plain);
    assert.equal(surveyTask({ ...input, elevatedSandbox: true }), surveyTask(input), 'off Windows there is no elevated sandbox to look around');
  });

  it('has the elevated surveyor look in the repository root too, where cmd.exe finds a script and Get-Command does not', () => {
    // Probed on Windows 11 with zzprobe.bat in the current directory: `Get-Command -CommandType Application zzprobe`
    // exits 1, the same with `.\zzprobe` exits 0 naming zzprobe.bat, and `cmd.exe /d /s /c zzprobe` runs it.
    const elevated = surveyTask({ ...input, platform: 'win32', elevatedSandbox: true });
    assert.match(elevated, /Application <tool>"` and, when that fails, the same with `\.\\<tool>`, since `cmd\.exe` also runs a script in the repository root/);
    assert.doesNotMatch(surveyTask({ ...input, platform: 'win32' }), /repository root such as/, 'where.exe looks in the current directory itself');
  });

  it('quotes each --check command in a code span the command cannot close, and names a dropped kind', () => {
    const task = surveyTask({ ...input, settled: [{ kind: 'build', command: 'echo `git rev-parse HEAD` && make' }, { kind: 'typecheck', command: null }] });
    assert.match(task, /^- build: ``echo `git rev-parse HEAD` && make`` \(--check\)$/m);
    assert.match(task, /^- typecheck: dropped by --no-check$/m);
  });

  it('quotes each hint\'s command in a code span, and keeps its reading as prose', () => {
    const task = surveyTask(input);
    assert.match(task, /^- lint: `npm run lint` \(the package\.json script `lint` through npm, by package-lock\.json\)$/m);
    assert.match(task, /^- test: none \(no rule names it\)$/m);
  });
});

describe('the task texts', () => {
  it('tell the triage to run SCAN and return one lead per other angle, never a skip', () => {
    const task = triageTask();
    assert.match(task, /Run the `SCAN` angle/);
    assert.match(task, new RegExp(finderAngles.join(', ')));
    assert.match(task, /or null when the diff supports none/);
    assert.match(task, /never a skip/);
    assert.match(task, /the engine assigns one to each candidate/);
  });

  it('give a finder its angle and its lead, or Lead: none', () => {
    assert.match(finderTask('RIPPLE', { angle: 'RIPPLE', lead: 'the callers of parse()' }), /^Angle: RIPPLE\nSCAN lead: the callers of parse\(\)\n/);
    assert.match(finderTask('DESIGN', { angle: 'DESIGN', lead: null }), /^Angle: DESIGN\nLead: none\n/);
    assert.match(finderTask('DESIGN', null), /^Angle: DESIGN\nLead: none\n/);
    assert.match(finderTask('DESIGN', null), /Run the DESIGN angle/);
  });

  it('numbers the deduplication pool from [0] and explains groups, keep and standing alone', () => {
    const task = deduplicationTask([candidate('SCAN-1', 'SCAN'), candidate('RIPPLE-1', 'RIPPLE', { line: 5, rawLine: 5 })]);
    assert.match(task, /2 candidates, numbered \[0\] to \[1\]/);
    assert.match(task, /\[0\] SCAN-1 \(SCAN\) at src\/a\.ts:4\n {4}summary: SCAN-1 summary\n {4}detail: SCAN-1 detail\n\[1\] RIPPLE-1 \(RIPPLE\) at src\/a\.ts:5/);
    assert.match(task, /A candidate in no group stands alone/);
    assert.match(task, /Return `groups` empty when nothing repeats/);
  });

  it('numbers a verifier\'s group and tells it one verdict per index, unlocated included', () => {
    const task = verifierTask('g2', [unlocated]);
    assert.match(task, /^Group g2: 1 candidate, numbered \[0\] to \[0\]/);
    assert.match(task, /\[0\] SWEEP-1 \(DESIGN\) at C:\\x\\b\.ts:9 \(unlocated/);
    assert.match(task, /exactly one verdict per index/);
    assert.match(task, /An answer that misses an index is discarded whole and the group is run again\./);
    assert.match(task, /a candidate marked unlocated still gets a verdict/);
    assert.match(verifierTask('g1', [outside]), /\[0\] RIPPLE-3 \(RIPPLE\) at src\/caller\.ts:12 \(outside the change: an unchanged file of the repository\)\n/);
    assert.match(verifierTask('g1', [candidate('A-1', 'SCAN'), candidate('A-2', 'SCAN')]), /2 candidates, numbered \[0\] to \[1\]/);
  });

  it('gives the sweep the verified and refuted lists and the angles not run', () => {
    const task = sweepTask({
      verified: [{ candidate: candidate('RIPPLE-1', 'RIPPLE'), verdict: 'CONFIRMED', unverified: false }, { candidate: unlocated, verdict: 'PLAUSIBLE', unverified: true }],
      refuted: [{ candidate: candidate('SCAN-2', 'SCAN'), evidence: 'line 4 is a comment' }],
      anglesNotRun: { FOOTGUNS: 'two attempts failed' },
    });
    assert.match(task, /These angles did not run, so their territory is yours to cover: FOOTGUNS \(two attempts failed\)\./);
    assert.match(task, /- RIPPLE-1 \(RIPPLE\) at src\/a\.ts:4: RIPPLE-1 summary \[CONFIRMED\]/);
    assert.match(task, /\[PLAUSIBLE, unverified\]/);
    assert.match(task, /- SCAN-2 \(SCAN\) at src\/a\.ts:4: SCAN-2 summary; refuted because: line 4 is a comment/);
    assert.match(task, /each naming in `angle` the angle/);
    const empty = sweepTask({ verified: [], refuted: [], anglesNotRun: {} });
    assert.match(empty, /Every angle ran\./);
    assert.match(empty, /\(none\)\n\nRefuted candidates[^\n]*\n\(none\)/);
  });

  it('numbers the merge-rank working list with verdicts and evidence and asks for every index once', () => {
    const task = mergeRankTask([
      { candidate: candidate('RIPPLE-1', 'RIPPLE'), verdict: 'CONFIRMED', unverified: false, evidence: 'line 4' },
      { candidate: unlocated, verdict: 'PLAUSIBLE', unverified: true, evidence: null },
    ]);
    assert.match(task, /2 findings, numbered \[0\] to \[1\]/);
    assert.match(task, /\[0\] RIPPLE-1 \(RIPPLE\)[\s\S]*verdict: CONFIRMED\n {4}evidence: line 4/);
    assert.match(task, /verdict: PLAUSIBLE \(unverified\)\n {4}evidence: none; the group's verifier failed twice/);
    assert.match(task, /Every index appears exactly once, as a primary or as a member/);
    assert.match(task, /a `CONVENTIONS` violation takes the severity of the rule it breaks/);
    assert.match(task, /The engine orders the findings itself: by severity, then CONFIRMED before PLAUSIBLE, then the correctness angles and `CONVENTIONS` before `DESIGN`, `DUPLICATION` and `ALTITUDE`, then by primary id\. The order you return them in is not kept\.$/m);
    assert.doesNotMatch(task, /Order most severe first/, 'the worker is not asked for an order the engine discards');
    assert.match(mergeRankTask([{ candidate: candidate('A-1', 'SCAN'), verdict: 'PLAUSIBLE', unverified: false, evidence: 'e' }]), /1 finding, numbered/);
  });

  it('numbers the decider\'s findings in rank order, each with every candidate\'s own verdict and evidence, and asks for one decision per index (R2, R3 of the decision step)', () => {
    const member = (id: string, angle: string, verdict: 'CONFIRMED' | 'PLAUSIBLE', evidence: string | null, unverified = false) => ({ id, angle, location: `src/a.ts:${id.length}`, summary: `${id} summary`, detail: `${id} detail`, verdict, unverified, evidence });
    const task = deciderTask([
      { id: 'RIPPLE-1', severity: 'major', verdict: 'CONFIRMED', summary: 'parse dereferences null, also at line 7', reason: 'one root cause', candidates: [member('RIPPLE-1', 'RIPPLE', 'CONFIRMED', 'line 4'), member('ALTITUDE-2', 'ALTITUDE', 'PLAUSIBLE', 'Needs the author: where to guard')] },
      { id: 'SWEEP-1', severity: 'minor', verdict: 'PLAUSIBLE', summary: 'a helper', reason: 'one improvement', candidates: [member('SWEEP-1', 'DESIGN', 'PLAUSIBLE', null, true)] },
    ]);
    assert.match(task, /^The review's 2 findings, numbered \[0\] to \[1\], each with every candidate merged into it, its verdict and its verifier's evidence\. Decide each one as your role prompt defines it: `fix`, `leave` or `ask`\.$/m);
    assert.match(task, /^\[0\] RIPPLE-1 \[major\] CONFIRMED: parse dereferences null, also at line 7\n {4}merge and rank: one root cause\n {4}- RIPPLE-1 \(RIPPLE\) primary at src\/a\.ts:8: CONFIRMED\n {8}summary: RIPPLE-1 summary\n {8}detail: RIPPLE-1 detail\n {8}evidence: line 4\n {4}- ALTITUDE-2 \(ALTITUDE\) at src\/a\.ts:10: PLAUSIBLE\n {8}summary: ALTITUDE-2 summary\n {8}detail: ALTITUDE-2 detail\n {8}evidence: Needs the author: where to guard$/m);
    assert.match(task, /^\[1\] SWEEP-1 \[minor\] PLAUSIBLE: a helper\n {4}merge and rank: one improvement\n {4}- SWEEP-1 \(DESIGN\) primary at src\/a\.ts:7: PLAUSIBLE \(unverified\)\n[\s\S]* {8}evidence: none; the group's verifier failed twice$/m);
    assert.match(task, /`leave` gives its `reason`, and for `superseded` the index of the finding decided `fix` whose fix removes this one in `supersededBy`, null otherwise\./);
    assert.match(task, /the index of the option you `recommended` and of the one `applied`, the default a fix worker applies now; and where you `searched` for an answer\./);
    assert.match(task, /`departure` is the `rule` a `fix` departs from, its `source` and the `reason`, and null for every other decision and for a fix that departs from nothing\. Every index appears exactly once\. In any text you write, name another finding by its id, as `RIPPLE-2`, never by its index or its number here: the text is read where those mean nothing\.$/);
    assert.match(deciderTask([{ id: 'A-1', severity: 'minor', verdict: 'PLAUSIBLE', summary: 's', reason: 'r', candidates: [member('A-1', 'SCAN', 'PLAUSIBLE', 'e')] }]), /^The review's 1 finding, numbered \[0\] to \[0\]/);
  });
});

describe('the fixer\'s task', () => {
  const snapshot = `node "/engine/main.mjs" snapshot --finding ${snapshotIndexPlaceholder} --into "/scratch/w1/snapshots"`;
  const input: FixerTaskInput = {
    cluster: 'c1',
    batch: 'c1-2',
    secondRound: false,
    findings: [
      {
        id: 'RIPPLE-1', severity: 'major', verdict: 'CONFIRMED', unverified: false, summary: 'parse dereferences null', reason: 'one root cause',
        primary: { id: 'RIPPLE-1', angle: 'RIPPLE', location: 'src/a.ts:4', summary: 'line 4 dereferences null', detail: 'other() passes null', verdict: 'CONFIRMED', unverified: false, evidence: 'line 4 uses text!' },
        members: [{ id: 'SWEEP-2', angle: 'ALTITUDE', location: 'src/a.ts:7', summary: 'guard once', detail: 'one guard serves both sites', verdict: 'PLAUSIBLE', unverified: false, evidence: 'Needs the author: guard in parse or in each caller' }],
        decision: { id: 'RIPPLE-1', decision: 'fix', grounds: 'the changelog says parse accepts null', fix: { approach: 'guard in parse', rejected: [{ option: 'guard in each caller', reason: 'two copies of one rule' }] }, leave: null, ask: null, departure: { rule: 'parse trusts its callers', source: 'src/a.ts:2', reason: 'other() is a caller it never trusted' } },
        supersedes: [{ id: 'SCAN-3', location: 'src/a.ts:9', summary: 'the guard is missing' }],
        firstRound: null,
      },
      {
        id: 'SWEEP-1', severity: 'minor', verdict: 'PLAUSIBLE', unverified: true, summary: 's', reason: 'r',
        primary: { id: 'SWEEP-1', angle: 'SCAN', location: 'lib/b.ts:9 (unlocated: no file of the repository has this path and line)', summary: 'own s', detail: 'd', verdict: 'PLAUSIBLE', unverified: true, evidence: null },
        members: [],
        decision: {
          id: 'SWEEP-1', decision: 'ask', grounds: 'nothing states it', fix: null, leave: null, departure: null,
          ask: { question: 'Should b log?', options: [{ option: 'log once', cost: 'c', rule: 'r', edits: true }, { option: 'stay quiet', cost: 'c', rule: 'r', edits: false }, { option: 'log always', cost: 'c', rule: 'r', edits: true }], recommended: 1, applied: 0, searched: ['docs'] },
        },
        supersedes: [],
        firstRound: null,
      },
    ],
    earlier: [],
    owned: ['src/a.ts'],
    othersOwned: [{ cluster: 'c2', files: ['src/b.ts'] }, { cluster: 'c3', files: [] }],
    checks: [
      { kind: 'build', command: null, origin: 'none', reason: 'nothing names it', source: null },
      { kind: 'typecheck', command: 'npm run typecheck', origin: 'package', reason: null, source: null },
      { kind: 'lint', command: null, origin: 'flag', reason: 'dropped by --no-check', source: null },
      { kind: 'test', command: 'npm run test', origin: 'package', reason: null, source: null },
    ],
    snapshotCommand: snapshot,
    mayHoldWork: false,
    unfinished: [],
    baselineFailures: [],
    unelevatedSandbox: false,
  };

  it('numbers the batch\'s findings with everything the fixer judges by', () => {
    const task = fixerTask(input);
    assert.match(task, /^Cluster c1, batch c1-2: 2 findings, numbered \[0\] to \[1\], in the order to apply them\.$/m);
    assert.match(task, /^\[0\] RIPPLE-1 \[major\] CONFIRMED \(RIPPLE\) at src\/a\.ts:4\n {4}summary: parse dereferences null\n {4}reason: one root cause\n {4}primary: RIPPLE-1 \(RIPPLE\) at src\/a\.ts:4: CONFIRMED\n {8}summary: line 4 dereferences null\n {8}detail: other\(\) passes null\n {8}evidence: line 4 uses text!\n/m);
    assert.match(task, /^\[1\] SWEEP-1 \[minor\] PLAUSIBLE \(unverified\) \(SCAN\) at lib\/b\.ts:9 \(unlocated[^\n]*\n {4}summary: s\n {4}reason: r\n {4}primary: SWEEP-1 \(SCAN\) at lib\/b\.ts:9 \(unlocated[^\n]*: PLAUSIBLE \(unverified\)\n {8}summary: own s\n {8}detail: d\n {8}evidence: none; the group's verifier failed twice\n/m);
  });

  it('prints a PLAUSIBLE primary\'s evidence under its own verdict, never under the finding\'s CONFIRMED one (R7 of the decision step)', () => {
    const ripple = input.findings[0]!;
    const plausible = { ...ripple.primary, verdict: 'PLAUSIBLE' as const, evidence: 'Not CONFIRMED: only one caller passes null' };
    const confirming = { ...ripple.members[0]!, verdict: 'CONFIRMED' as const, evidence: 'line 7 passes null too' };
    const task = fixerTask({ ...input, findings: [{ ...ripple, primary: plausible, members: [confirming] }] });
    assert.match(task, /^\[0\] RIPPLE-1 \[major\] CONFIRMED \(RIPPLE\) at src\/a\.ts:4\n {4}summary: parse dereferences null\n {4}reason: one root cause\n {4}primary: RIPPLE-1 \(RIPPLE\) at src\/a\.ts:4: PLAUSIBLE\n {8}summary: line 4 dereferences null\n {8}detail: other\(\) passes null\n {8}evidence: Not CONFIRMED: only one caller passes null\n {4}merged: SWEEP-2 \(ALTITUDE\) at src\/a\.ts:7: CONFIRMED\n[\s\S]*? {8}evidence: line 7 passes null too\n/m);
    assert.doesNotMatch(task, /^ {4}evidence:/m, 'no evidence line sits under the finding\'s merged verdict');
  });

  it('gives each merged candidate its own verdict and evidence, not only where it is (R7 of the decision step)', () => {
    assert.match(fixerTask(input), /^ {8}evidence: line 4 uses text!\n {4}merged: SWEEP-2 \(ALTITUDE\) at src\/a\.ts:7: PLAUSIBLE\n {8}summary: guard once\n {8}detail: one guard serves both sites\n {8}evidence: Needs the author: guard in parse or in each caller\n/m);
  });

  it('tells the fixer what was decided for each finding: the approach, what was rejected, a rule departed from, and an ask\'s default and question (R7 of the decision step)', () => {
    const task = fixerTask(input);
    assert.match(task, /^ {4}decided: fix\. the changelog says parse accepts null\n {8}approach: guard in parse\n {8}rejected: guard in each caller \(two copies of one rule\)\n {8}departs from: parse trusts its callers \(src\/a\.ts:2\): other\(\) is a caller it never trusted$/m);
    assert.match(task, /^ {4}decided: ask the author, applying a default now\. nothing states it\n {8}apply: log once\n {8}the question the author answers later: Should b log\? The other options: stay quiet; log always$/m);
    assert.match(task, /Each finding carries what was decided for it before any fixer ran, with the grounds: apply it the way the decision says, and for an ask, apply the default it names; the author answers the question later\. Never defer a finding over a choice its decision made: defer only by the criteria of your role prompt, and when the reason is a fact the decision did not see, name that fact in `note`\. When applying the decision changes a behavior a test pins, change that test with the fix and say which test and why in `note` and in the message's `body`\./);
    // The role prompt's other defer criteria still hold, so the task does not narrow every defer to an unseen fact (R12 of the decision step).
    assert.doesNotMatch(task, /Defer a finding only for a fact the decision did not see/);
  });

  it('names a finding left as superseded under the finding whose fix removes it, so the fixer checks it is gone', () => {
    assert.match(fixerTask(input), /^ {8}departs from: [^\n]*\n {4}removes also: SCAN-3 at src\/a\.ts:9: the guard is missing \(left because this fix removes it, and given to no fixer: check it is gone\)$/m);
    assert.doesNotMatch(fixerTask({ ...input, findings: input.findings.map((finding) => ({ ...finding, supersedes: [] })) }), /removes also/);
  });

  it('says nothing of decisions to a fixer of a run configured before the decision step, whose findings have none', () => {
    const task = fixerTask({ ...input, findings: input.findings.map((finding) => ({ ...finding, decision: null })) });
    assert.doesNotMatch(task, /decided:|Each finding carries what was decided/);
  });

  it('states the ownership rule with both file lists', () => {
    const task = fixerTask(input);
    assert.match(task, /Files you own while this batch runs, which no other worker edits:\n- src\/a\.ts\n/);
    assert.match(task, /Files other clusters own, which you must not edit; a fix that needs one is `blocked`, naming it in `requiredFiles`:\n- src\/b\.ts \(c2\)\n\n/);
    assert.match(task, /You may edit any other file of the repository, existing or new, when a fix or its tests need it; report every file you edit or create under the finding it served\./);
    assert.match(fixerTask({ ...input, owned: [], othersOwned: [] }), /no other worker edits:\n\(none\)\n[\s\S]*`requiredFiles`:\n\(none\)\n/);
  });

  it('names what the cluster\'s earlier batches did, as work already in the tree, and says nothing of them for a first batch', () => {
    assert.doesNotMatch(fixerTask(input), /Findings of this cluster that earlier batches worked/);
    const task = fixerTask({ ...input, earlier: [{ batch: 'c1-1', id: 'SCAN-1', outcome: 'applied', note: 'guarded the null' }, { batch: 'c1-1', id: 'SCAN-2', outcome: 'not attempted', note: null }] });
    assert.match(task, /^Findings of this cluster that earlier batches worked, one after another before yours; their edits are already in the tree, so build on them and neither redo nor undo them:\n- c1-1 SCAN-1 applied: guarded the null\n- c1-1 SCAN-2 not attempted\n\n/m);
    assert.doesNotMatch(task, /may already hold part of this work/, 'earlier batches are no warning of a half-done batch');
  });

  it('tells a second-round batch what each finding was first blocked on, that the files are now its own, and what the first round did in them (R21)', () => {
    const task = fixerTask({
      ...input,
      cluster: 'c4',
      batch: 'c4-1',
      secondRound: true,
      findings: [{ ...input.findings[0]!, firstRound: { note: 'the fix flips an assertion in t.ts, which c2 owns', requiredFiles: ['t.ts'] } }],
      earlier: [{ batch: 'c2-1', id: 'T-1', outcome: 'applied', note: 'tightened the builder test' }],
      owned: ['src/a.ts', 't.ts'],
    });
    assert.match(task, /^Cluster c4, batch c4-1, in the second round: 1 finding, numbered \[0\] to \[0\]/m);
    assert.match(task, /^ {4}first round: blocked, needing t\.ts: the fix flips an assertion in t\.ts, which c2 owns$/m);
    assert.match(task, /^Each of these was blocked in the first round on files another cluster owned\. Every first-round fixer has finished, and those files are now yours: apply the fix the finding needs there, its tests included\.$/m);
    assert.match(task, /^Findings the first round worked in your files, and this cluster's earlier batches; their edits are already in the tree, so build on them and neither redo nor undo them:\n- c2-1 T-1 applied: tightened the builder test$/m);
    assert.doesNotMatch(fixerTask(input), /first round|second round/, 'a first-round batch says nothing of rounds');
  });

  it('names the checks that failed before any fixer edited the tree, with their outputs\' paths, as failures that are not the fixer\'s (R24)', () => {
    assert.doesNotMatch(fixerTask(input), /These failed before any fixer edited the tree/);
    const task = fixerTask({ ...input, baselineFailures: [{ kind: 'test', stdout: '/evidence/out', stderr: '/evidence/err' }] });
    assert.match(task, /^These failed before any fixer edited the tree; their output then is at the paths given\. A failure that output does not show is yours, even when an earlier batch's tree already had it:\n- test: \/evidence\/out, \/evidence\/err$/m);
  });

  it('names each check\'s command or why it has none, or that none is available', () => {
    const task = fixerTask(input);
    assert.match(task, /^- build: not available \(nothing names it\)\n- typecheck: npm run typecheck\n- lint: not available \(dropped by --no-check\)\n- test: npm run test$/m);
    const none = fixerTask({ ...input, checks: input.checks.map((check) => ({ ...check, command: null, origin: 'none' as const, reason: 'nothing' })) });
    assert.match(none, /No check is available/);
    assert.doesNotMatch(none, /- build:/);
  });

  it('tells a fixer in the unelevated sandbox what cannot run there and how to validate instead, and says nothing of it otherwise, so other runs\' tasks are unchanged (R6 of the Codex sandbox)', () => {
    const plain = fixerTask(input);
    const held = fixerTask({ ...input, unelevatedSandbox: true });
    assert.doesNotMatch(plain, /unelevated|EPERM/);
    assert.equal(held, plain.replace('\n\nAfter finishing each finding', `\n\n${unelevatedSandboxRule}\n\nAfter finishing each finding`), 'the rule is the one difference, a paragraph after the checks');
    assert.match(unelevatedSandboxRule, /a Node process cannot start a child whose output it captures: the build, the tests and package scripts .* fail there with `EPERM`/);
    // `node --test <file>` runs the file as a child through captured stdio by default (NODE_TEST_CONTEXT=child-v8 on Node 26.10),
    // the very spawn that fails there, so the rule names the option that keeps it in one process.
    assert.match(unelevatedSandboxRule, /such as a direct `node` probe or one test file run in a single process, with the option that keeps the test runner from starting a child for it, as `node --test --test-isolation=none <file>` does; when nothing that runs can show it, record the validation as `limited` with that reason./);
    assert.match(unelevatedSandboxRule, /The engine runs the checks itself after you return.$/);
  });

  it('quotes the snapshot command on a line of its own, and asks for it after each finding', () => {
    const task = fixerTask(input);
    assert.ok(task.includes(`\n\n    ${snapshot}\n\n`), task);
    assert.match(task, /After finishing each finding, and before starting the next, run this from the repository root with that finding's index in place of <index>:/);
  });

  it('describes the answer\'s fields and the rule that every changed owned file is reported, and warns of earlier work only when there may be some', () => {
    const task = fixerTask(input);
    for (const field of ['`status`', '`already-applied`', '`file`', '`line`', '`note`', '`files`', '`message`', '`subject`', '`body`', '`corrections`', '`validation`', '`requiredFiles`', '`drift`', '`tests`', '`suite`']) assert.ok(task.includes(field), field);
    assert.match(task, /at most 72 characters with no trailing period/);
    assert.match(task, /an answer that leaves one out is discarded/);
    assert.match(task, /Write logs and every other temporary file under your scratch directory, never in the repository\.$/);
    assert.doesNotMatch(task, /may already hold part of this work/);
    assert.match(fixerTask({ ...input, mayHoldWork: true }), /The tree may already hold part of this work: an earlier worker on it did not finish\. Verify each finding against the code before applying it/);
    assert.doesNotMatch(fixerTask({ ...input, mayHoldWork: true }), /An earlier attempt left edits/, 'no finding has an attempt\'s recorded edits');
    assert.match(fixerTask({ ...input, mayHoldWork: true, unfinished: ['RIPPLE-1', 'SWEEP-1'] }), /never apply a change on top of itself\. An earlier attempt left edits for RIPPLE-1, SWEEP-1, recorded as that attempt's work; for each of these you report `already-applied`, give the `message` its commit will carry, as for an applied finding\.$/m);
    assert.match(fixerTask(input), /null for a deferred or blocked one, and null for an already-applied one unless this task asks for its message;/);
  });
});

describe('the repair task', () => {
  const failing = {
    kind: 'test' as const,
    command: 'npm run test',
    outcome: 'failed' as const,
    exitCode: 1,
    stdout: { tail: Buffer.from('```\n1 failing\n'), path: '/evidence/out' },
    stderr: { tail: Buffer.alloc(0), path: '/evidence/err' },
    baseline: null,
  };

  it('numbers the failing checks with their exit, fenced output and logs, and lists the files and what each fixer did', () => {
    const task = repairTask({
      checks: [failing, { ...failing, kind: 'lint', command: 'npm run lint', outcome: 'timeout', exitCode: null }],
      owned: ['src/a.ts', 'test/a.test.ts'],
      answers: [{ batch: 'c1-1', id: 'RIPPLE-1', status: 'applied', note: 'guarded the null' }],
      allChecks: [{ kind: 'test', command: 'npm run test', origin: 'package', reason: null, source: null }],
      snapshotCommand: `node "/e/main.mjs" snapshot --finding ${snapshotIndexPlaceholder} --into "/s"`,
      mayHoldWork: true,
      unfinished: ['test'],
      unelevatedSandbox: false,
    });
    assert.match(task, /^Repair: 2 checks, numbered \[0\] to \[1\], fail after the fixers' edits\./);
    assert.match(task, /^\[0\] test: [\s\S]*?\n {4}It passed before any fixer edited the tree\.$/m);
    assert.match(task, /^\[0\] test: npm run test\n {4}exited with code 1\n {4}stdout, its last 14 bytes \(the whole is at \/evidence\/out\):\n````text\n```\n1 failing\n````\n {4}stderr: empty \(frozen at \/evidence\/err\)$/m);
    assert.match(task, /^\[1\] lint: npm run lint\n {4}ran past its timeout and was killed$/m);
    assert.match(task, /Files you own: every file the fixers changed\.\n- src\/a\.ts\n- test\/a\.test\.ts/);
    assert.match(task, /^- c1-1 RIPPLE-1 applied: guarded the null$/m);
    assert.match(task, /with that check's index in place of <index>/);
    assert.match(task, /Verify each check against the code/);
    assert.match(task, /The `message` of an applied check describes what the repair changed\./);
    assert.match(task, /An earlier attempt left edits for test, recorded as that attempt's work; for each of these you report `already-applied`, give the `message` its commit will carry, as for an applied check\./);
  });

  it('gives a check that failed before the fixes too its output then, and tells the worker to fix only the failures it does not show (R24)', () => {
    const before = { stdout: { tail: Buffer.from('2 failing\n'), path: '/evidence/before-out' }, stderr: { tail: Buffer.alloc(0), path: '/evidence/before-err' } };
    const task = repairTask({
      checks: [{ ...failing, baseline: before }],
      owned: ['src/a.ts'],
      answers: [],
      allChecks: [{ kind: 'test', command: 'npm run test', origin: 'package', reason: null, source: null }],
      snapshotCommand: `node "/e/main.mjs" snapshot --finding ${snapshotIndexPlaceholder} --into "/s"`,
      mayHoldWork: false,
      unfinished: [],
      unelevatedSandbox: false,
    });
    assert.match(task, /^ {4}It failed before any fixer edited the tree too: fix only the failures its output then does not show, and answer `deferred` naming them when every failure was there before\. Its output then:\n {4}stdout, its last 10 bytes \(the whole is at \/evidence\/before-out\):\n```text\n2 failing\n```\n {4}stderr: empty \(frozen at \/evidence\/before-err\)$/m);
    assert.doesNotMatch(task, /It passed before any fixer/);
  });

  it('tells a repair worker in the unelevated sandbox the same as a fixer, and says nothing of it otherwise (R6 of the Codex sandbox)', () => {
    const repair = { checks: [failing], owned: ['src/a.ts'], answers: [], allChecks: [{ kind: 'test' as const, command: 'npm run test', origin: 'package' as const, reason: null, source: null }], snapshotCommand: 'snap', mayHoldWork: false, unfinished: [] };
    const plain = repairTask({ ...repair, unelevatedSandbox: false });
    assert.doesNotMatch(plain, /unelevated|EPERM/);
    assert.equal(repairTask({ ...repair, unelevatedSandbox: true }), plain.replace('\n\nAfter finishing each check', `\n\n${unelevatedSandboxRule}\n\nAfter finishing each check`));
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { routeOfDecision, type RoutedDecision } from '../../src/checkpoint/fix-state.ts';
import type { CandidateState } from '../../src/checkpoint/review-fold.ts';
import { batchesOf, planFixes, planSecondRound, type FixPlan, type PlannedCluster } from '../../src/review/fixes.ts';
import type { ReportFinding } from '../../src/review/state.ts';
import { angles, type Angle, type Verdict } from '../../src/review/vocabulary.ts';
import { fragmentsDirectoryName, repositoryRolesRoot } from '../../src/roles/assemble.ts';

/** A candidate located at `file`, or unlocated when `file` is null with `raw` as the finder spelled it. */
function candidate(id: string, angle: Angle, file: string | null, raw = file ?? 'nowhere.ts'): CandidateState {
  return {
    id, angle, file, line: file === null ? null : 3, located: file !== null, inScope: file !== null && !file.startsWith('lib/'),
    rawFile: raw, rawLine: 3, summary: `${id} summary`, detail: `${id} detail`,
    phase: 'finders', workerId: '00000000-0000-4000-8000-000000000001', duplicateOf: null, verdict: null, unverified: false,
  };
}

/** A ranked finding with its primary, members and merged verdict. */
function finding(primary: CandidateState, verdict: Verdict = 'CONFIRMED', members: CandidateState[] = [], unverified = false): ReportFinding {
  return {
    finding: { id: primary.id, members: members.map((member) => member.id), severity: 'major', summary: `${primary.id} summary`, reason: 'reason' },
    primary,
    members,
    resolution: { verdict, unverified, evidence: unverified ? null : 'evidence' },
  };
}

/** An ask whose default, option 0, edits the code or keeps it as it is. */
const ask = (id: string, edits: boolean): Extract<RoutedDecision, { decision: 'ask' }> => ({
  id,
  decision: 'ask',
  ask: {
    question: 'which?',
    options: [{ option: 'the default', cost: 'c', rule: 'r', edits }, { option: 'the other', cost: 'c', rule: 'r', edits: true }],
    recommended: 1,
    applied: 0,
    searched: ['docs'],
  },
});

/** A decision of `kind` for each finding, `fix` unless `kinds` names another; an ask's default edits. */
function decide(findings: readonly ReportFinding[], kinds: Readonly<Record<string, 'fix' | 'leave' | 'ask'>> = {}): RoutedDecision[] {
  return findings.map((entry) => {
    const kind = kinds[entry.finding.id] ?? 'fix';
    return kind === 'ask' ? ask(entry.finding.id, true) : { id: entry.finding.id, decision: kind, ask: null };
  });
}

describe('routeOfDecision (R6 of the decision step)', () => {
  it('sends a fix to a fixer and holds a leave', () => {
    assert.equal(routeOfDecision({ id: 'X-1', decision: 'fix', ask: null }), 'fixer');
    assert.equal(routeOfDecision({ id: 'X-1', decision: 'leave', ask: null }), 'held');
  });

  it('sends an ask to a fixer when the default it applies edits the code, and holds it when the default keeps the code as it is', () => {
    assert.equal(routeOfDecision(ask('X-1', true)), 'fixer');
    assert.equal(routeOfDecision(ask('X-1', false)), 'held');
    const second = ask('X-1', false);
    assert.equal(routeOfDecision({ ...second, ask: { ...second.ask, applied: 1 } }), 'fixer', 'the applied option decides, not the first');
  });

  it('refuses an ask that applies an option it does not offer', () => {
    const outside = ask('X-1', true);
    assert.throws(() => routeOfDecision({ ...outside, ask: { ...outside.ask, applied: 2 } }), /The ask decided for X-1 applies no option it offers/);
  });
});

describe('what the rubrics say a grade does next (R3 of the verifier rubric, R11 of the decision step)', () => {
  const text = readFileSync(join(repositoryRolesRoot(), fragmentsDirectoryName, 'rubrics.md'), 'utf8');

  /**
   * Each rubric the verifier grades by: its heading, and the words that
   * say where a `CONFIRMED` and a `PLAUSIBLE` candidate go. A finding is
   * routed by the decision made for it (`routeOfDecision`), not by its
   * verdict, so the words are held to the rubric's text alone.
   */
  const rubrics = [
    { heading: '### Rubric for the correctness & cost angles', says: 'CONFIRMED and PLAUSIBLE both go to the decision step, PLAUSIBLE telling it which condition is unsettled.' },
    { heading: '### Rubric for the design & cleanup angles', says: 'CONFIRMED and PLAUSIBLE both go to the decision step, PLAUSIBLE telling it the scope or the choice that keeps the candidate from CONFIRMED.' },
    { heading: '### Rubric for the CONVENTIONS angle', says: 'CONFIRMED and PLAUSIBLE both go to the decision step.' },
  ] as const;

  /** A rubric's first paragraph on one line: the text under its heading, up to the first blank line. */
  const opening = (heading: string): string => {
    const start = text.indexOf(`${heading}\n\n`);
    assert.notEqual(start, -1, `no rubric is headed "${heading}"`);
    const body = text.slice(start + heading.length + 2);
    return body.slice(0, body.indexOf('\n\n')).replace(/\s+/g, ' ');
  };

  /** The angles a paragraph names, each in backticks. */
  const namedIn = (paragraph: string): Angle[] => angles.filter((angle) => paragraph.includes(`\`${angle}\``));

  it('names every angle in the first lines of exactly one rubric', () => {
    const named = rubrics.flatMap(({ heading }) => namedIn(opening(heading)));
    assert.deepEqual([...named].sort(), [...angles].sort());
  });

  it('names the decision step as where CONFIRMED and PLAUSIBLE go, says REFUTED removes, and names an angle', () => {
    for (const { heading, says } of rubrics) {
      const paragraph = opening(heading);
      assert.ok(paragraph.includes(says), `${heading}: its first lines do not say "${says}"`);
      assert.match(paragraph, /REFUTED removes (the candidate|it)\./, heading);
      assert.ok(namedIn(paragraph).length > 0, `${heading} names no angle`);
      assert.doesNotMatch(paragraph, /to a fixer|to the author/, `${heading} still names where a grade went before the decision step`);
    }
  });
});

/** The plan in batches of four, the policy's default, every finding decided `fix` unless `kinds` names another decision. */
const planOf = (findings: readonly ReportFinding[], kinds: Readonly<Record<string, 'fix' | 'leave' | 'ask'>> = {}): FixPlan => planFixes(findings, decide(findings, kinds), 4);

describe('planFixes', () => {
  it('plans nothing for no finding', () => {
    assert.deepEqual(planOf([]), { routes: [], clusters: [], batches: [] });
  });

  it('routes every ranked finding once, in rank order, and clusters only the fixer-routed ones, one per file', () => {
    const plan = planOf([
      finding(candidate('SCAN-1', 'SCAN', 'src/a.ts')),
      finding(candidate('DESIGN-1', 'DESIGN', 'src/a.ts'), 'PLAUSIBLE'),
      finding(candidate('RIPPLE-1', 'RIPPLE', 'src/b.ts')),
      finding(candidate('RIPPLE-2', 'RIPPLE', 'src/a.ts'), 'PLAUSIBLE'),
    ], { 'DESIGN-1': 'leave' });
    assert.deepEqual(plan.routes, [{ id: 'SCAN-1', route: 'fixer' }, { id: 'DESIGN-1', route: 'held' }, { id: 'RIPPLE-1', route: 'fixer' }, { id: 'RIPPLE-2', route: 'fixer' }]);
    assert.deepEqual(plan.clusters, [
      { id: 'c1', findingIds: ['SCAN-1', 'RIPPLE-2'], files: ['src/a.ts'] },
      { id: 'c2', findingIds: ['RIPPLE-1'], files: ['src/b.ts'] },
    ]);
  });

  it('keeps a merged finding whole: its two files join one cluster, pulling in every finding of both', () => {
    const plan = planOf([
      finding(candidate('SCAN-1', 'SCAN', 'src/a.ts')),
      finding(candidate('RIPPLE-1', 'RIPPLE', 'src/b.ts')),
      finding(candidate('FOOTGUNS-1', 'FOOTGUNS', 'src/c.ts')),
      // Ranked last, it merges the first two clusters; the result keeps the first one's place.
      finding(candidate('REMOVALS-1', 'REMOVALS', 'src/b.ts'), 'CONFIRMED', [candidate('SWEEP-1', 'SCAN', 'src/a.ts')]),
    ]);
    assert.deepEqual(plan.clusters, [
      { id: 'c1', findingIds: ['SCAN-1', 'RIPPLE-1', 'REMOVALS-1'], files: ['src/a.ts', 'src/b.ts'] },
      { id: 'c2', findingIds: ['FOOTGUNS-1'], files: ['src/c.ts'] },
    ]);
  });

  it('merges transitively, so no file is ever owned by two clusters', () => {
    const plan = planOf([
      finding(candidate('A-1', 'SCAN', 'a.ts'), 'CONFIRMED', [candidate('A-2', 'SCAN', 'b.ts')]),
      finding(candidate('B-1', 'SCAN', 'c.ts'), 'CONFIRMED', [candidate('B-2', 'SCAN', 'd.ts')]),
      finding(candidate('C-1', 'SCAN', 'b.ts'), 'CONFIRMED', [candidate('C-2', 'SCAN', 'c.ts')]),
    ]);
    assert.deepEqual(plan.clusters, [{ id: 'c1', findingIds: ['A-1', 'B-1', 'C-1'], files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }]);
    const owned = plan.clusters.flatMap((cluster) => cluster.files);
    assert.equal(new Set(owned).size, owned.length);
  });

  it('owns a located file outside the change as it owns a changed one', () => {
    assert.deepEqual(planOf([finding(candidate('RIPPLE-1', 'RIPPLE', 'lib/caller.ts'))]).clusters, [{ id: 'c1', findingIds: ['RIPPLE-1'], files: ['lib/caller.ts'] }]);
  });

  it('clusters an unlocated finding alone by its spelling, owning nothing, apart from a located file of the same name', () => {
    const plan = planOf([
      finding(candidate('SCAN-1', 'SCAN', 'src/a.ts')),
      finding(candidate('SWEEP-1', 'SCAN', null, 'src/a.ts')),
    ]);
    assert.deepEqual(plan.clusters, [
      { id: 'c1', findingIds: ['SCAN-1'], files: ['src/a.ts'] },
      { id: 'c2', findingIds: ['SWEEP-1'], files: [] },
    ]);
  });

  it('folds two spellings of one unlocated path, in case, slashes or an absolute prefix, into one cluster', () => {
    const plan = planOf([
      finding(candidate('SCAN-1', 'SCAN', null, 'Src\\Gone.ts')),
      finding(candidate('RIPPLE-1', 'RIPPLE', null, './src/gone.ts')),
      finding(candidate('REMOVALS-1', 'REMOVALS', null, 'C:\\repo\\src\\gone.ts')),
      finding(candidate('FOOTGUNS-1', 'FOOTGUNS', null, 'other/place.ts')),
    ]);
    assert.deepEqual(plan.clusters, [
      { id: 'c1', findingIds: ['SCAN-1', 'RIPPLE-1', 'REMOVALS-1'], files: [] },
      { id: 'c2', findingIds: ['FOOTGUNS-1'], files: [] },
    ]);
  });

  it('lets an unlocated member join its finding\'s cluster without owning anything', () => {
    const plan = planOf([finding(candidate('SCAN-1', 'SCAN', 'src/a.ts'), 'CONFIRMED', [candidate('SWEEP-1', 'SCAN', null, 'elsewhere.ts')])]);
    assert.deepEqual(plan.clusters, [{ id: 'c1', findingIds: ['SCAN-1'], files: ['src/a.ts'] }]);
  });

  it('never lets a held finding\'s file join a cluster, nor its members', () => {
    const plan = planOf([
      finding(candidate('DESIGN-1', 'DESIGN', 'src/a.ts'), 'PLAUSIBLE', [candidate('ALTITUDE-1', 'ALTITUDE', 'src/b.ts')]),
      finding(candidate('SCAN-1', 'SCAN', 'src/a.ts')),
      finding(candidate('RIPPLE-1', 'RIPPLE', 'src/b.ts')),
    ], { 'DESIGN-1': 'leave' });
    assert.deepEqual(plan.clusters, [
      { id: 'c1', findingIds: ['SCAN-1'], files: ['src/a.ts'] },
      { id: 'c2', findingIds: ['RIPPLE-1'], files: ['src/b.ts'] },
    ]);
  });

  it('routes by the decision alone: a PLAUSIBLE design finding decided fix goes to a fixer, a CONFIRMED defect decided leave is held, the unverified mark changes nothing', () => {
    const findings = [
      finding(candidate('DESIGN-1', 'DESIGN', 'src/a.ts'), 'PLAUSIBLE', [], true),
      finding(candidate('SCAN-1', 'SCAN', 'src/b.ts'), 'CONFIRMED'),
    ];
    const plan = planOf(findings, { 'SCAN-1': 'leave' });
    assert.deepEqual(plan.routes, [{ id: 'DESIGN-1', route: 'fixer' }, { id: 'SCAN-1', route: 'held' }]);
    assert.deepEqual(plan.clusters, [{ id: 'c1', findingIds: ['DESIGN-1'], files: ['src/a.ts'] }]);
  });

  it('clusters an ask whose default edits as a fix, and holds one whose default keeps the code', () => {
    const findings = [finding(candidate('DESIGN-1', 'DESIGN', 'src/a.ts'), 'PLAUSIBLE'), finding(candidate('ALTITUDE-1', 'ALTITUDE', 'src/b.ts'), 'PLAUSIBLE')];
    const plan = planFixes(findings, [ask('DESIGN-1', true), ask('ALTITUDE-1', false)], 4);
    assert.deepEqual(plan.routes, [{ id: 'DESIGN-1', route: 'fixer' }, { id: 'ALTITUDE-1', route: 'held' }]);
    assert.deepEqual(plan.batches, [{ key: 'c1-1', cluster: 'c1', findingIds: ['DESIGN-1'] }]);
  });

  it('refuses a finding with no decision, and plans nothing from decisions alone', () => {
    const findings = [finding(candidate('SCAN-1', 'SCAN', 'src/a.ts')), finding(candidate('RIPPLE-1', 'RIPPLE', 'src/b.ts'))];
    assert.throws(() => planFixes(findings, decide(findings.slice(0, 1)), 4), /Finding RIPPLE-1 has no decision to route it by/);
    assert.deepEqual(planFixes([], decide(findings), 4), { routes: [], clusters: [], batches: [] }, 'a decision for no ranked finding routes nothing');
  });
});

describe('batches', () => {
  const ids = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1)}`);

  it('cuts a cluster of nine into batches of four, four and one, in rank order, numbered within the cluster', () => {
    const cluster: PlannedCluster = { id: 'c1', findingIds: ids('SCAN', 9), files: ['a.ts'] };
    assert.deepEqual(batchesOf([cluster], cluster.findingIds, 4), [
      { key: 'c1-1', cluster: 'c1', findingIds: ['SCAN-1', 'SCAN-2', 'SCAN-3', 'SCAN-4'] },
      { key: 'c1-2', cluster: 'c1', findingIds: ['SCAN-5', 'SCAN-6', 'SCAN-7', 'SCAN-8'] },
      { key: 'c1-3', cluster: 'c1', findingIds: ['SCAN-9'] },
    ]);
  });

  it('gives a cluster of exactly the size one batch, and a batch size of one a batch per finding', () => {
    const cluster: PlannedCluster = { id: 'c1', findingIds: ids('SCAN', 4), files: [] };
    assert.deepEqual(batchesOf([cluster], cluster.findingIds, 4).map((batch) => batch.key), ['c1-1']);
    assert.deepEqual(batchesOf([cluster], cluster.findingIds, 1).map((batch) => [batch.key, batch.findingIds]), [['c1-1', ['SCAN-1']], ['c1-2', ['SCAN-2']], ['c1-3', ['SCAN-3']], ['c1-4', ['SCAN-4']]]);
  });

  it('orders every batch of the run by the rank of its first finding, so the best-ranked go first whatever their cluster', () => {
    // Ranked: A-1 A-2 B-1 A-3 A-4 B-2; A's cluster holds four, B's two, in batches of two.
    const ranked = ['A-1', 'A-2', 'B-1', 'A-3', 'A-4', 'B-2'];
    const clusters: PlannedCluster[] = [{ id: 'c1', findingIds: ['A-1', 'A-2', 'A-3', 'A-4'], files: ['a.ts'] }, { id: 'c2', findingIds: ['B-1', 'B-2'], files: ['b.ts'] }];
    assert.deepEqual(batchesOf(clusters, ranked, 2).map((batch) => batch.key), ['c1-1', 'c2-1', 'c1-2']);
    assert.deepEqual(batchesOf(clusters, ranked, 1).map((batch) => batch.key), ['c1-1', 'c1-2', 'c2-1', 'c1-3', 'c1-4', 'c2-2']);
  });

  it('refuses a batch size below one, and a finding the ranking does not hold', () => {
    const cluster: PlannedCluster = { id: 'c1', findingIds: ['A-1'], files: [] };
    for (const size of [0, -1, 1.5]) assert.throws(() => batchesOf([cluster], ['A-1'], size), /at least one finding/, String(size));
    assert.throws(() => batchesOf([cluster], [], 4), /A-1 is not in the ranking/);
  });

  it('plans the batches with the clusters, every fixer-routed finding in exactly one, none for a held finding', () => {
    const findings = [
      finding(candidate('SCAN-1', 'SCAN', 'src/a.ts')),
      finding(candidate('DESIGN-1', 'DESIGN', 'src/a.ts'), 'PLAUSIBLE'),
      finding(candidate('RIPPLE-1', 'RIPPLE', 'src/b.ts')),
      finding(candidate('RIPPLE-2', 'RIPPLE', 'src/a.ts')),
      finding(candidate('FOOTGUNS-1', 'FOOTGUNS', 'src/a.ts')),
    ];
    const plan = planFixes(findings, decide(findings, { 'DESIGN-1': 'leave' }), 2);
    assert.deepEqual(plan.batches, [
      { key: 'c1-1', cluster: 'c1', findingIds: ['SCAN-1', 'RIPPLE-2'] },
      { key: 'c2-1', cluster: 'c2', findingIds: ['RIPPLE-1'] },
      { key: 'c1-2', cluster: 'c1', findingIds: ['FOOTGUNS-1'] },
    ]);
    const batched = plan.batches.flatMap((batch) => batch.findingIds).sort();
    assert.deepEqual(batched, plan.routes.filter((route) => route.route === 'fixer').map((route) => route.id).sort());
  });
});

describe('planSecondRound', () => {
  // The first round: c1 owns a.ts (A-1, A-2), c2 owns t.ts (T-1), c3 owns b.ts (B-1); ranked A-1, T-1, A-2, B-1.
  const plan = {
    routes: [{ id: 'A-1', route: 'fixer' }, { id: 'T-1', route: 'fixer' }, { id: 'A-2', route: 'fixer' }, { id: 'B-1', route: 'fixer' }, { id: 'D-1', route: 'held' }] as const,
    clusters: [
      { id: 'c1', findingIds: ['A-1', 'A-2'], files: ['a.ts'] },
      { id: 'c2', findingIds: ['T-1'], files: ['t.ts'] },
      { id: 'c3', findingIds: ['B-1'], files: ['b.ts'] },
    ],
  };
  type Answer = { readonly status: 'applied' | 'already-applied' | 'deferred' | 'blocked'; readonly requiredFiles: readonly string[] };
  const answers = (given: Record<string, Answer>) => (id: string): Answer | null => given[id] ?? null;
  const blocked = (...requiredFiles: string[]): Answer => ({ status: 'blocked', requiredFiles });

  it('takes a finding blocked on another first-round cluster\'s file, owning its own files and the ones it needed, numbered on from the first round', () => {
    const second = planSecondRound(plan, answers({ 'A-1': blocked('t.ts'), 'T-1': { status: 'applied', requiredFiles: [] } }), 4);
    assert.deepEqual(second, {
      blocked: [{ id: 'A-1', requiredFiles: ['t.ts'] }],
      clusters: [{ id: 'c4', findingIds: ['A-1'], files: ['a.ts', 't.ts'] }],
      batches: [{ key: 'c4-1', cluster: 'c4', findingIds: ['A-1'] }],
    });
  });

  it('clusters blocked findings that share a file, in rank order, and batches them at the size given', () => {
    const second = planSecondRound(plan, answers({ 'A-1': blocked('t.ts'), 'A-2': blocked('b.ts'), 'B-1': blocked('t.ts') }), 1);
    assert.deepEqual(second.clusters, [{ id: 'c4', findingIds: ['A-1', 'A-2', 'B-1'], files: ['a.ts', 'b.ts', 't.ts'] }]);
    assert.deepEqual(second.batches.map((batch) => [batch.key, batch.findingIds]), [['c4-1', ['A-1']], ['c4-2', ['A-2']], ['c4-3', ['B-1']]]);
    const apart = planSecondRound(plan, answers({ 'A-1': blocked('t.ts'), 'B-1': blocked('t.ts') }), 4);
    assert.deepEqual(apart.clusters.map((cluster) => cluster.findingIds), [['A-1', 'B-1']], 'one needed file joins them');
  });

  it('leaves out a finding blocked on a file no cluster owned or on its own cluster\'s, a deferred or applied one, and one with no answer', () => {
    const second = planSecondRound(plan, answers({ 'A-1': blocked('elsewhere.ts'), 'A-2': blocked('a.ts'), 'T-1': { status: 'deferred', requiredFiles: [] }, 'B-1': blocked('t.ts', 'nowhere.ts') }), 4);
    assert.deepEqual(second, { blocked: [], clusters: [], batches: [] });
    assert.deepEqual(planSecondRound(plan, answers({}), 4), { blocked: [], clusters: [], batches: [] });
    assert.deepEqual(planSecondRound(plan, answers({ 'A-1': blocked() }), 4).blocked, [], 'blocked on no file names nothing to own');
  });

  it('never takes a held finding, which no fixer saw', () => {
    assert.deepEqual(planSecondRound(plan, answers({ 'D-1': blocked('a.ts') }), 4).blocked, []);
  });
});

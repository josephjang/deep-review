import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { koreanParticle, namedFindings, namedInDiagram, type NamedId } from '../../src/review/finding-names.ts';
import { pullRequestWords } from '../../src/review/pull-request-words.ts';

const english = pullRequestWords('en').naming;
const korean = pullRequestWords('ko').naming;
/** RIPPLE-2 is finding 3, SCAN-4 merged into it, SWEEP-1 is finding 1, finding 10 and 12 for the readings of a whole ten, DESIGN-1 and EFFICIENCY-1 refuted. */
const names = new Map<string, NamedId>([
  ['RIPPLE-2', { kind: 'finding', number: 3 }],
  ['SCAN-4', { kind: 'finding', number: 3 }],
  ['SWEEP-1', { kind: 'finding', number: 1 }],
  ['ALTITUDE-6', { kind: 'finding', number: 10 }],
  ['FOOTGUNS-3', { kind: 'finding', number: 12 }],
  ['DESIGN-1', { kind: 'refuted' }],
  ['EFFICIENCY-1', { kind: 'refuted' }],
]);

const en = (text: string): string => namedFindings(text, names, english);
const ko = (text: string): string => namedFindings(text, names, korean);
const diagram = (text: string): string | null => namedInDiagram(text, names, english);

// R1 to R3 of the finding names in the review.
describe('the name of a finding in place of its id', () => {
  it('names a finding and a merged candidate by the finding\'s number, and a refuted candidate as such', () => {
    assert.equal(en('If RIPPLE-2 lands, SCAN-4 goes too, unlike DESIGN-1.'), 'If finding 3 lands, finding 3 goes too, unlike a refuted candidate.');
    assert.equal(en('This waits on RIPPLE-2\'s question.'), 'This waits on finding 3\'s question.');
  });

  it('capitalizes a name that starts the text, a sentence, a paragraph or a list item, in English', () => {
    assert.equal(en('RIPPLE-2 and SWEEP-1 share a cause. SWEEP-1 is older.'), 'Finding 3 and finding 1 share a cause. Finding 1 is older.');
    assert.equal(en('Two:\n- DESIGN-1 was refuted.\n2. RIPPLE-2 stands.\n* SWEEP-1 too.\n3) SWEEP-1 last.'), 'Two:\n- A refuted candidate was refuted.\n2. Finding 3 stands.\n* Finding 1 too.\n3) Finding 1 last.');
    assert.equal(en('- RIPPLE-2 crashes.'), '- Finding 3 crashes.', 'a list item that starts the text');
    assert.equal(en('1. **SWEEP-1** first.'), '1. **Finding 1** first.', 'a numbered list item that starts the text');
    assert.equal(en('Two causes:\n\nRIPPLE-2 crashes.'), 'Two causes:\n\nFinding 3 crashes.', 'a paragraph');
  });

  it('keeps a name in lower case after a line break inside a sentence, which Markdown joins into one line', () => {
    assert.equal(en('This waits on\nRIPPLE-2 first, and on\n  SWEEP-1 too.'), 'This waits on\nfinding 3 first, and on\n  finding 1 too.');
  });

  it('leaves an id the run does not hold, a word shaped like one, and an id in a path or a URL', () => {
    const text = 'UTF-8 and SHA-256 differ from NOPE-9; see notes/RIPPLE-2.md and https://x.test/RIPPLE-2 and RIPPLE-2.md.';
    assert.equal(en(text), text);
    const paths = 'See src/RIPPLE-2/a.ts, docs/RIPPLE-2, RIPPLE-2/notes, src\\RIPPLE-2, ./RIPPLE-2, a.RIPPLE-2, #RIPPLE-2, RIPPLE-2-1 and https://x.test/RIPPLE-2/SWEEP-1.';
    assert.equal(en(paths), paths);
  });

  it('names an id that a hyphen joins to a word or a slash to another id, and one after an ellipsis (FOOTGUNS-2 of the review of the change)', () => {
    assert.equal(en('Both RIPPLE-2/SWEEP-1 conflict, unlike RIPPLE-2/NOPE-9.'), 'Both finding 3/finding 1 conflict, unlike finding 3/NOPE-9.');
    assert.equal(en('RIPPLE-2/SCAN-4. Then...RIPPLE-2 waits for non-SWEEP-1 work.'), 'Finding 3/finding 3. Then...finding 3 waits for non-finding 1 work.');
    assert.equal(en('A RIPPLE-2-based fix, the SWEEP-1-style guard and RIPPLE-2-style/SWEEP-1 checks.'), 'A finding 3-based fix, the finding 1-style guard and finding 3-style/finding 1 checks.');
  });

  it('gives the article before an id in a hyphened word to that word: an `a` stays, an `an` becomes `a`, and a refuted candidate takes none of its own', () => {
    assert.equal(en('an ALTITUDE-6-style fix'), 'A finding 10-style fix');
    assert.equal(en('DESIGN-1-based fixes fail, unlike a DESIGN-1-like one or an DESIGN-1-ish one.'), 'Refuted candidate-based fixes fail, unlike a refuted candidate-like one or a refuted candidate-ish one.');
  });

  it('names a code span whose whole text is one id, and keeps every other code span as code', () => {
    assert.equal(en('`RIPPLE-2` needs `guard(RIPPLE-2)` first; `` SWEEP-1 `` too.'), 'Finding 3 needs `guard(RIPPLE-2)` first; finding 1 too.');
    assert.equal(en('`NOPE-9` stays.'), '`NOPE-9` stays.');
  });

  it('says a finding once when a word around its id already says what it names', () => {
    assert.equal(en('As finding RIPPLE-2 shows, findings SWEEP-1 and RIPPLE-2 differ; see Finding `SWEEP-1`.'), 'As finding 3 shows, findings 1 and 3 differ; see Finding 1.');
    assert.equal(en('The DESIGN-1 candidate was refuted, unlike a DESIGN-1; DESIGN-1 candidates rarely are.'), 'The refuted candidate was refuted, unlike a refuted candidate; refuted candidates rarely are.');
    assert.equal(ko('지적 사항 RIPPLE-2와 DESIGN-1 후보를 봅니다.'), '지적 사항 3과 반박된 후보를 봅니다.');
  });

  it('says each number of a list after findings alone, in English and in Korean', () => {
    assert.equal(en('Findings SWEEP-1, RIPPLE-2, and SCAN-4 differ; findings SWEEP-1 or `RIPPLE-2` too, but finding SWEEP-1 and RIPPLE-2 do not.'), 'Findings 1, 3, and 3 differ; findings 1 or 3 too, but finding 1 and finding 3 do not.');
    assert.equal(en('The findings SWEEP-1 and the RIPPLE-2 fix differ.'), 'The findings 1 and the finding 3 fix differ.', 'a list that a word other than a number breaks');
    assert.equal(ko('지적 사항 SWEEP-1과 RIPPLE-2를, 지적 사항 SWEEP-1, `RIPPLE-2`, ALTITUDE-6을 봅니다.'), '지적 사항 1과 3을, 지적 사항 1, 3, 10을 봅니다.');
  });

  it('takes in a noun after the id that says finding, and agrees a Korean particle after it with the name', () => {
    assert.equal(en('The RIPPLE-2 finding is real, and the SWEEP-1 finding\'s fix waits.'), 'The finding 3 is real, and the finding 1\'s fix waits.');
    assert.equal(en('Finding RIPPLE-2 finding stands, and RIPPLE-2 findingsless stays.'), 'Finding 3 stands, and finding 3 findingsless stays.');
    assert.equal(ko('RIPPLE-2 지적 사항은 맞고, SWEEP-1 지적을 먼저, `ALTITUDE-6` 지적사항이 남습니다.'), '지적 사항 3은 맞고, 지적 사항 1을 먼저, 지적 사항 10이 남습니다.');
    assert.equal(ko('RIPPLE-2 지적 사항을 보고 SWEEP-1 지적에서 봅니다.'), '지적 사항 3을 보고 지적 사항 1에서 봅니다.');
    assert.equal(ko('RIPPLE-2 지적했듯이 SWEEP-1 지적 사항들과 다릅니다.'), '지적 사항 3 지적했듯이 지적 사항 1 지적 사항들과 다릅니다.', 'a longer word that starts as the noun stays');
  });

  it('names a refuted candidate once with a determiner, a refuted or a candidate written before its id', () => {
    assert.equal(en('The refuted DESIGN-1 and RIPPLE-2 differ; this DESIGN-1 was wrong, as every DESIGN-1 is.'), 'The refuted candidate and finding 3 differ; this refuted candidate was wrong, as every refuted candidate is.');
    assert.equal(en('The candidate DESIGN-1 was refuted. Candidate DESIGN-1 was. The refuted candidate DESIGN-1 was.'), 'The refuted candidate was refuted. A refuted candidate was. The refuted candidate was.');
    assert.equal(en('The verifiers refuted DESIGN-1, and the refuted DESIGN-1 candidate stays refuted.'), 'The verifiers refuted a candidate, and the refuted candidate stays refuted.');
    assert.equal(ko('후보 DESIGN-1은 반박되었고, 반박된 DESIGN-1을 다시, 반박된 후보 DESIGN-1과 DESIGN-1후보를 봅니다.'), '반박된 후보는 반박되었고, 반박된 후보를 다시, 반박된 후보와 반박된 후보를 봅니다.');
  });

  it('gives a refuted candidate before a noun its article when nothing determines it, and takes in a finding written before its id', () => {
    assert.equal(en('DESIGN-1 candidate was refuted. As DESIGN-1 candidate showed, DESIGN-1 candidates rarely are.'), 'A refuted candidate was refuted. As a refuted candidate showed, refuted candidates rarely are.');
    assert.equal(en('Finding DESIGN-1 was refuted, as the finding DESIGN-1 showed and finding DESIGN-1 did.'), 'A refuted candidate was refuted, as the refuted candidate showed and a refuted candidate did.');
    assert.equal(ko('지적 사항 DESIGN-1은 반박되었고, 지적사항 DESIGN-1을 다시 봅니다.'), '반박된 후보는 반박되었고, 반박된 후보를 다시 봅니다.');
  });

  it('takes in the article a writer chose for the sound of an id: a finding takes none, and a refuted candidate writes its own', () => {
    assert.equal(en('An ALTITUDE-6 shows it; this is an `ALTITUDE-6`, not a RIPPLE-2.'), 'Finding 10 shows it; this is finding 10, not finding 3.');
    assert.equal(en('An EFFICIENCY-1 was wrong, as an EFFICIENCY-1 candidate and an candidate EFFICIENCY-1 were.'), 'A refuted candidate was wrong, as a refuted candidate and a refuted candidate were.');
    assert.equal(en('A finding ALTITUDE-6 and an refuted EFFICIENCY-1 stay; its plan RIPPLE-2 too.'), 'A finding 10 and an refuted candidate stay; its plan finding 3 too.', 'an article before a noun that already says it, or a word that only ends in an');
  });

  it('leaves a text with no names as it is', () => {
    assert.equal(namedFindings('RIPPLE-2 stays.', new Map(), english), 'RIPPLE-2 stays.');
  });
});

// R5 and PD7 of the finding names in the review.
describe('the Korean particle after a name', () => {
  it('agrees with how the number is read: a final consonant, a vowel, or ㄹ before 으로', () => {
    assert.equal(ko('SWEEP-1을 먼저 고칩니다.'), '지적 사항 1을 먼저 고칩니다.');
    assert.equal(ko('RIPPLE-2을 먼저, RIPPLE-2은 나중에.'), '지적 사항 3을 먼저, 지적 사항 3은 나중에.');
    assert.equal(ko('SWEEP-1으로 합칩니다.'), '지적 사항 1로 합칩니다.');
    assert.equal(ko('RIPPLE-2로 합칩니다.'), '지적 사항 3으로 합칩니다.');
    assert.equal(ko('ALTITUDE-6가 남고 FOOTGUNS-3과 SCAN-4를 봅니다.'), '지적 사항 10이 남고 지적 사항 12와 3을 봅니다.');
    assert.equal(ko('DESIGN-1을 다시 보지 않습니다.'), '반박된 후보를 다시 보지 않습니다.');
  });

  it('agrees a particle right after the closing backtick of a span it names (M1 of the review of the proposal)', () => {
    assert.equal(ko('`RIPPLE-2`을 먼저, `SWEEP-1`으로 합치고 `ALTITUDE-6`가 남습니다.'), '지적 사항 3을 먼저, 지적 사항 1로 합치고 지적 사항 10이 남습니다.');
  });

  it('leaves a particle that more Hangul follows, as the copula of 이고 or a word such as 이후', () => {
    assert.equal(ko('SWEEP-1이고, RIPPLE-2이후에 봅니다.'), '지적 사항 1이고, 지적 사항 3이후에 봅니다.');
  });

  it('chooses the form of a particle after a Hangul syllable by its final consonant', () => {
    assert.deepEqual([koreanParticle('반박된 후보', '을'), koreanParticle('지적 사항', '는'), koreanParticle('규칙', '으로'), koreanParticle('파일', '으로'), koreanParticle('후보', '만')], ['를', '은', '으로', '로', '만']);
  });
});

// R4 of the finding names in the review.
describe('the name of a finding in a diagram', () => {
  it('names an id in a quoted label, the text of an edge and the title of a subgraph', () => {
    assert.equal(
      diagram('flowchart LR\n  subgraph S [SWEEP-1 area]\n  A["RIPPLE-2, SCAN-4"] -->|SWEEP-1 waits| B["`DESIGN-1`"]\n  B -- RIPPLE-2 then --> C["done"]\n  end'),
      'flowchart LR\n  subgraph S [Finding 1 area]\n  A["Finding 3, finding 3"] -->|Finding 1 waits| B["A refuted candidate"]\n  B -- Finding 3 then --> C["done"]\n  end',
    );
  });

  it('names an id after a colon, in a block label, an alias, the title and a note of a sequence or state diagram', () => {
    assert.equal(
      diagram('sequenceDiagram\n  title RIPPLE-2 in order\n  participant P as SWEEP-1 fix\n  alt RIPPLE-2 applies\n  P->>Q: RIPPLE-2 calls parse\n  end'),
      'sequenceDiagram\n  title Finding 3 in order\n  participant P as Finding 1 fix\n  alt Finding 3 applies\n  P->>Q: Finding 3 calls parse\n  end',
    );
    assert.equal(diagram('stateDiagram-v2\n  A --> B: SWEEP-1\n  note right of B\n    waits on RIPPLE-2\n  end note'), 'stateDiagram-v2\n  A --> B: Finding 1\n  note right of B\n    waits on finding 3\n  end note');
  });

  it('leaves out a diagram that keeps an id of the run as an identifier, shown or not (R4, RK4)', () => {
    assert.equal(diagram('flowchart LR\n  RIPPLE-2 --> A["x"]'), null);
    assert.equal(diagram('flowchart LR\n  RIPPLE-2["parse crashes"] --> A["x"]'), null);
    assert.equal(diagram('sequenceDiagram\n  RIPPLE-2->>B: calls'), null);
    assert.equal(diagram('flowchart LR\n  A["UTF-8"] --> B["NOPE-9"]'), 'flowchart LR\n  A["UTF-8"] --> B["NOPE-9"]', 'an id the run does not hold');
  });

  it('names in a label an id that a hyphen joins to a word or a slash to another id, as prose does, and keeps the diagram', () => {
    assert.equal(diagram('flowchart LR\n  A["RIPPLE-2-style fix"] --> B["RIPPLE-2/SWEEP-1"]'), 'flowchart LR\n  A["Finding 3-style fix"] --> B["Finding 3/finding 1"]');
    assert.equal(diagram('flowchart LR\n  A["see src/RIPPLE-2/a.ts"] --> B["x"]'), 'flowchart LR\n  A["see src/RIPPLE-2/a.ts"] --> B["x"]', 'an id in a path is no identifier');
  });
});

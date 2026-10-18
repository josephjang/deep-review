import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeLimit } from '../../src/runtime/claude-limits.ts';

describe('claudeLimit (R14 of resumable runs)', () => {
  it('reads the session limit of run e21b026d with its reset', () => {
    const text = 'You\'ve hit your session limit · resets 12:10pm (Asia/Seoul)';
    assert.deepEqual(claudeLimit(text), { text, reset: '12:10pm (Asia/Seoul)' });
  });

  it('reads the other words Claude Code uses for its limits, and the reset each names', () => {
    assert.deepEqual(claudeLimit('You’ve hit your usage limit · resets 3am (America/New_York)'), { text: 'You’ve hit your usage limit · resets 3am (America/New_York)', reset: '3am (America/New_York)' });
    assert.deepEqual(claudeLimit('Claude usage limit reached. Your limit will reset at 3pm (Europe/Paris).'), { text: 'Claude usage limit reached. Your limit will reset at 3pm (Europe/Paris).', reset: '3pm (Europe/Paris)' });
    assert.deepEqual(claudeLimit('Claude AI usage limit reached|1760850000'), { text: 'Claude AI usage limit reached|1760850000', reset: '2025-10-19T05:00:00.000Z' });
    assert.deepEqual(claudeLimit('5-hour limit reached ∙ resets 1pm'), { text: '5-hour limit reached ∙ resets 1pm', reset: '1pm' });
    assert.deepEqual(claudeLimit('You\'ve hit your weekly limit'), { text: 'You\'ve hit your weekly limit', reset: null });
  });

  it('is null for every other error, one that names a limit of another kind among them', () => {
    for (const text of ['boom', 'Prompt is too long', 'API Error: 529 overloaded', 'the context limit was reached', '']) assert.equal(claudeLimit(text), null, text);
  });
});

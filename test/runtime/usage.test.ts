import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyUsageSummary } from '../../src/runtime/adapter.ts';
import { claudeAdapter, summarizeClaudeUsage } from '../../src/runtime/claude.ts';
import { codexAdapter, summarizeCodexUsage } from '../../src/runtime/codex.ts';
import { finiteNumber, sumOrNull } from '../../src/runtime/json.ts';

/**
 * The usage the runtime adapter's second smoke run recorded (its design's
 * Open Questions), as `decodeClaude` stores it: a continuation whose
 * `total_cost_usd` covers the whole session while `usage` covers this
 * process alone, with most of its input read from the prompt cache.
 */
const claudeContinuation = {
  usage: { input_tokens: 17, cache_creation_input_tokens: 1682, cache_read_input_tokens: 18498, output_tokens: 261 },
  modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 34, outputTokens: 692, costUSD: 0.012 } },
  total_cost_usd: 0.012,
};

/** The usage of the same run's Codex worker, as `decodeCodex` stores it: the last `turn.completed`'s, cached tokens counted in `input_tokens`. */
const codexTurn = { input_tokens: 29646, cached_input_tokens: 14464, output_tokens: 1403 };

describe('summarizeClaudeUsage', () => {
  it('reads the cost and counts every input token, cached ones included', () => {
    assert.deepEqual(summarizeClaudeUsage(claudeContinuation), { costUsd: 0.012, inputTokens: 17 + 1682 + 18498, cachedInputTokens: 18498, outputTokens: 261 });
    assert.equal(claudeAdapter.summarizeUsage, summarizeClaudeUsage);
    assert.equal(claudeAdapter.capabilities.costInUsd, true);
  });

  it('reads a usage parsed back from the text a finish records exactly as the live one', () => {
    const finishText = JSON.stringify(claudeContinuation);
    assert.deepEqual(summarizeClaudeUsage(JSON.parse(finishText)), summarizeClaudeUsage(claudeContinuation));
  });

  it('gives null for a token count when any of its three parts is missing, rather than undercounting', () => {
    const summary = summarizeClaudeUsage({ usage: { input_tokens: 17, output_tokens: 261 }, modelUsage: null, total_cost_usd: 0.012 });
    assert.deepEqual(summary, { costUsd: 0.012, inputTokens: null, cachedInputTokens: null, outputTokens: 261 });
  });

  it('gives null for a field that is not a finite number and keeps the others', () => {
    const summary = summarizeClaudeUsage({ usage: { input_tokens: '17', cache_creation_input_tokens: 1, cache_read_input_tokens: 2, output_tokens: Infinity }, modelUsage: null, total_cost_usd: NaN });
    assert.deepEqual(summary, { costUsd: null, inputTokens: null, cachedInputTokens: 2, outputTokens: null });
    assert.deepEqual(summarizeClaudeUsage({ usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, modelUsage: null, total_cost_usd: 0 }), { costUsd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  });

  it('says nothing about a usage that is null, absent, a string or an array, without throwing', () => {
    for (const usage of [null, undefined, 'usage', 7, [1, 2], { usage: null, modelUsage: null, total_cost_usd: null }]) {
      assert.deepEqual(summarizeClaudeUsage(usage), emptyUsageSummary, JSON.stringify(usage));
    }
  });
});

describe('summarizeCodexUsage', () => {
  it('reads tokens and reports no cost', () => {
    assert.deepEqual(summarizeCodexUsage(codexTurn), { costUsd: null, inputTokens: 29646, cachedInputTokens: 14464, outputTokens: 1403 });
    assert.equal(codexAdapter.summarizeUsage, summarizeCodexUsage);
    assert.equal(codexAdapter.capabilities.costInUsd, false);
  });

  it('reads a usage parsed back from the text a finish records exactly as the live one', () => {
    assert.deepEqual(summarizeCodexUsage(JSON.parse(JSON.stringify(codexTurn))), summarizeCodexUsage(codexTurn));
  });

  it('gives null for a missing or non-numeric field and keeps the others', () => {
    assert.deepEqual(summarizeCodexUsage({ input_tokens: 5, output_tokens: 'two' }), { costUsd: null, inputTokens: 5, cachedInputTokens: null, outputTokens: null });
  });

  it('says nothing about a usage that is null, absent, a string or an array, without throwing', () => {
    for (const usage of [null, undefined, 'usage', 7, [1, 2], {}]) {
      assert.deepEqual(summarizeCodexUsage(usage), emptyUsageSummary, JSON.stringify(usage));
    }
  });
});

describe('finiteNumber and sumOrNull', () => {
  it('keeps finite numbers, zero included, and drops everything else', () => {
    assert.equal(finiteNumber(0), 0);
    assert.equal(finiteNumber(-1.5), -1.5);
    for (const value of [NaN, Infinity, -Infinity, '1', null, undefined, true, {}]) assert.equal(finiteNumber(value), null, String(value));
  });

  it('sums numbers and gives null as soon as one part is null', () => {
    assert.equal(sumOrNull(), 0);
    assert.equal(sumOrNull(1, 2, 3), 6);
    assert.equal(sumOrNull(1, null, 3), null);
    assert.equal(sumOrNull(null), null);
  });
});

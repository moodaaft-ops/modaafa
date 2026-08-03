import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILDER_MINIMUM_ROUND_BUDGET_MS,
  hasBuilderRoundBudget,
} from '../lib/ai/builder-agent';

test('the campaign builder starts a round when the full time budget remains', () => {
  const now = 1_000_000;
  assert.equal(
    hasBuilderRoundBudget({
      deadlineAt: now + BUILDER_MINIMUM_ROUND_BUDGET_MS,
      now: () => now,
    }),
    true
  );
});

test('the campaign builder stops before a round that would overrun the request deadline', () => {
  const now = 1_000_000;
  assert.equal(
    hasBuilderRoundBudget({
      deadlineAt: now + BUILDER_MINIMUM_ROUND_BUDGET_MS - 1,
      now: () => now,
    }),
    false
  );
});

test('the campaign builder remains backwards compatible without a deadline', () => {
  assert.equal(hasBuilderRoundBudget(), true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAmbiguousGoogleAdsMutationError,
  prepareActionForExecution,
} from '../lib/ai/execution-preflight';
import type { OptimizerAction } from '../lib/ai/optimizer-agent';

function budgetAction(params: Record<string, unknown>): OptimizerAction {
  return {
    type: 'adjust_budget',
    target_id: 'customers/1/campaignBudgets/2',
    params: { budget_resource: 'customers/1/campaignBudgets/2', ...params },
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'cost', delta_pct: 10, delta_sar_per_month: 0 },
  };
}

test('a delta-only budget recommendation is converted from the live Google Ads budget', async () => {
  const queries: string[] = [];
  const customer = {
    async query(gaql: string) {
      queries.push(gaql);
      if (gaql.includes('FROM campaign_budget')) {
        return [{ campaignBudget: { amountMicros: '100000000' } }];
      }
      return [{ metrics: { costMicros: '25000000', clicks: 12, conversions: 2 } }];
    },
  };

  const prepared = await prepareActionForExecution(budgetAction({ delta_pct: 10 }), customer);

  assert.equal(prepared.action.params.current_amount_micros, 100_000_000);
  assert.equal(prepared.action.params.new_amount_micros, 110_000_000);
  assert.equal(prepared.action.params.delta_pct, 10);
  assert.equal(prepared.rollbackPayload.amount_micros, 100_000_000);
  assert.deepEqual(prepared.measurement?.before, {
    cost: 25,
    clicks: 12,
    conversions: 2,
    conversion_value: 0,
  });
  assert.equal(queries.length, 2);
});

test('budget preflight fails closed when neither a valid absolute amount nor delta exists', async () => {
  const customer = {
    async query() {
      return [{ campaignBudget: { amountMicros: 100_000_000 } }];
    },
  };

  await assert.rejects(
    prepareActionForExecution(budgetAction({ delta_pct: 0 }), customer),
    /neither an absolute amount nor a delta/
  );
});

test('transport failures after a mutation are treated as an unknown Google Ads outcome', () => {
  const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const nestedFetch = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' }),
  });

  assert.equal(isAmbiguousGoogleAdsMutationError(reset), true);
  assert.equal(isAmbiguousGoogleAdsMutationError(nestedFetch), true);
  assert.equal(isAmbiguousGoogleAdsMutationError({ name: 'AbortError' }), true);
});

test('an explicit Google rejection is not mistaken for an ambiguous network outcome', () => {
  assert.equal(
    isAmbiguousGoogleAdsMutationError({
      name: 'GoogleAdsRestError',
      code: 'POLICY_FINDING',
      message: 'The ad violates policy',
    }),
    false,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGuardrails, type OptimizerAction } from '../lib/ai/optimizer-agent';

function budgetAction(overrides: Record<string, unknown> = {}): OptimizerAction {
  return {
    type: 'adjust_budget',
    target_id: 'customers/123/campaignBudgets/456',
    params: {
      current_amount_micros: 10_000_000,
      new_amount_micros: 12_000_000,
      delta_pct: 20,
      ...overrides,
    },
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'conversions', delta_pct: 5, delta_sar_per_month: 100 },
  };
}

function mockSupabase(results: Record<string, { data: any; error: any }>) {
  return {
    from(table: string) {
      const result = results[table] ?? { data: null, error: null };
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        maybeSingle: async () => result,
        then: (resolve: (value: any) => unknown) => Promise.resolve(result).then(resolve),
      };
      return builder;
    },
  };
}

test('budget guardrail fails closed when action history cannot be read', async () => {
  const supabase = mockSupabase({
    ai_actions: { data: null, error: { message: 'database unavailable' } },
  });
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', supabase), null);
});

test('budget guardrail blocks unsafe single and cumulative increases', async () => {
  const supabase = mockSupabase({
    ai_actions: { data: [{ payload: { action: { params: { delta_pct: 30 } } } }], error: null },
    google_ads_accounts: { data: { business_id: null, currency_code: 'USD' }, error: null },
  });
  assert.equal(await checkGuardrails(budgetAction({ delta_pct: 26 }), 'account-1', supabase), null);
  assert.equal(await checkGuardrails(budgetAction({ delta_pct: 21 }), 'account-1', supabase), null);
});

test('budget guardrail allows a bounded change when required metadata is available', async () => {
  const action = budgetAction();
  const supabase = mockSupabase({
    ai_actions: { data: [], error: null },
    google_ads_accounts: { data: { business_id: null, currency_code: 'USD' }, error: null },
  });
  assert.equal(await checkGuardrails(action, 'account-1', supabase), action);
});

test('SAR business budget cap blocks daily budget above the monthly limit', async () => {
  const supabase = mockSupabase({
    ai_actions: { data: [], error: null },
    google_ads_accounts: { data: { business_id: 'business-1', currency_code: 'SAR' }, error: null },
    businesses: { data: { monthly_budget: 300 }, error: null },
  });
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', supabase), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGuardrails, type OptimizerAction, type OptimizerSnapshot } from '../lib/ai/optimizer-agent';
import {
  BID_MIN_CONVERSIONS_30D,
  BUDGET_STEP_MAX_PCT,
  BUDGET_STEP_MIN_PCT,
  evaluateBidGate,
  evaluateBudgetBounds,
  evaluateBudgetGate,
  evaluateTrackingGate,
  lockedByRecentChange,
  SCALE_MIN_LOST_BUDGET_IS,
} from '../lib/ai/optimizer-gates';
import { computeBreakEven } from '../lib/economics/break-even';
import { buildSnapshotEconomics } from '../lib/ai/optimizer-snapshot';

const NOW = new Date('2026-10-14T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const CAMPAIGN = 'customers/123/campaigns/789';
const BUDGET = 'customers/123/campaignBudgets/456';
const AD_GROUP = 'customers/123/adGroups/55';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A store whose margin is 20-40%: break-even ROAS 5. */
const store = () =>
  buildSnapshotEconomics(
    computeBreakEven({ facts: { type: { choice: 'ecommerce' }, margin: { choice: '20_40', min_per_100: 20, max_per_100: 40 } } }),
    null
  );

/** A lead business with every answer: break-even CPA 400 SAR. */
const leads = () =>
  buildSnapshotEconomics(
    computeBreakEven({
      facts: {
        type: { choice: 'services' },
        deal_value: { choice: '10k_50k', min_sar: 10000, max_sar: 50000 },
        close_rate: { choice: '2_3', min_of_10: 2, max_of_10: 3 },
        margin: { choice: '20_40', min_per_100: 20, max_per_100: 40 },
      },
    }),
    null
  );

const unknownEconomics = () => buildSnapshotEconomics(computeBreakEven({ facts: { type: { choice: 'ecommerce' } } }), null);

function campaign(overrides: { diag?: Record<string, unknown>; last_30d?: Record<string, unknown> | null; budget?: string; resource?: string } = {}) {
  const row: Record<string, any> = {
    campaign: { id: '789', name: 'بحث', resourceName: overrides.resource ?? CAMPAIGN },
    campaignBudget: { id: '456', amountMicros: '10000000', resourceName: overrides.budget ?? BUDGET },
    metrics: { costMicros: '70000000', clicks: 400, conversions: 20, conversionsValue: 700 },
    diag: {
      type: 'SEARCH',
      bidding: 'MAXIMIZE_CONVERSION_VALUE',
      primary_status: 'ELIGIBLE',
      status_reasons: [],
      impressions_7d: 5000,
      search_is: 0.35,
      lost_budget_is: 0.25,
      lost_rank_is: 0.1,
      ...overrides.diag,
    },
  };
  // 30 days: 300 SAR spent, 80 conversions, 2,400 SAR value: ROAS 8, CPA 3.75.
  if (overrides.last_30d !== null) {
    row.last_30d = { cost_micros: 300_000_000, conversions: 80, conversions_value: 2400, ...overrides.last_30d };
  }
  return row;
}

function snapshot(overrides: Partial<OptimizerSnapshot> = {}): OptimizerSnapshot {
  return {
    account_id: 'account-1',
    customer_id: '123',
    campaigns: [campaign()],
    underperforming_keywords: [],
    high_performing_keywords: [],
    wasted_search_terms: [],
    budget_utilization: [],
    poor_ads: [],
    keyword_count: 10,
    currency_code: 'SAR',
    conversion_tracking: { status: 'healthy', enabled_actions: 2 },
    economics: store(),
    ad_group_bid_targets: [
      {
        adGroup: { resourceName: AD_GROUP, campaign: CAMPAIGN, targetRoas: 6 },
        metrics: { conversions: 40 },
      },
    ],
    target_roas: 5,
    target_cpa: null,
    ...overrides,
  };
}

function budgetAction(params: Record<string, unknown> = {}): OptimizerAction {
  return {
    type: 'adjust_budget',
    target_id: BUDGET,
    params: { budget_resource: BUDGET, current_amount_micros: 10_000_000, new_amount_micros: 11_500_000, delta_pct: 15, ...params },
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'conversions', delta_pct: 5, delta_sar_per_month: 100 },
  };
}

function bidAction(params: Record<string, unknown> = {}): OptimizerAction {
  return {
    type: 'adjust_bid',
    target_id: AD_GROUP,
    params: { ad_group_resource: AD_GROUP, current_target_roas: 6, target_roas: 6.6, ...params },
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'roas', delta_pct: 5, delta_sar_per_month: 100 },
  };
}

type Tables = Record<string, { data: any; error: any }>;

function db(tables: Tables = {}) {
  const calls: Array<{ table: string; filters: Array<[string, unknown[]]> }> = [];
  return {
    calls,
    from(table: string) {
      const result = tables[table] ?? { data: [], error: null };
      const call = { table, filters: [] as Array<[string, unknown[]]> };
      calls.push(call);
      const builder: any = {};
      for (const method of ['select', 'eq', 'in', 'gte', 'order', 'limit']) {
        builder[method] = (...args: unknown[]) => {
          call.filters.push([method, args]);
          return builder;
        };
      }
      builder.maybeSingle = async () => result;
      builder.then = (resolve: (value: any) => unknown) => Promise.resolve(result).then(resolve);
      return builder;
    },
  };
}

const withContext = (snap = snapshot()) => ({ snapshot: snap, now: NOW });

// ---------------------------------------------------------------------------
// Bounds: 5 to 20 percent, every caller
// ---------------------------------------------------------------------------

test('budget bounds: a step is 5 to 20 percent either way', () => {
  assert.equal(BUDGET_STEP_MAX_PCT, 20);
  assert.equal(BUDGET_STEP_MIN_PCT, 5);
  const check = (delta: number) => evaluateBudgetBounds({ delta_pct: delta }).ok;
  assert.equal(check(20), true);
  assert.equal(check(-20), true);
  assert.equal(check(5), true);
  assert.equal(check(-5), true);
  assert.equal(check(21), false);
  assert.equal(check(25), false);
  assert.equal(check(-25), false);
  assert.equal(check(-30), false);
  assert.equal(check(4.9), false);
  assert.equal(check(0), false);
  assert.equal(evaluateBudgetBounds({}).ok, false);
  assert.equal(evaluateBudgetBounds({ delta_pct: 'abc' }).ok, false);
});

test('budget bounds: the percent and the amounts must agree, and the amounts are what is measured', () => {
  // The amount executes, the percent is what used to be checked: a mismatch is refused.
  assert.equal(evaluateBudgetBounds({ delta_pct: 10, current_amount_micros: 10_000_000, new_amount_micros: 20_000_000 }).ok, false);
  assert.equal(evaluateBudgetBounds({ delta_pct: 15, current_amount_micros: 10_000_000, new_amount_micros: 11_500_000 }).ok, true);
  // Amounts that move more than 20% fail even when delta_pct claims otherwise.
  assert.equal(evaluateBudgetBounds({ delta_pct: 20, current_amount_micros: 10_000_000, new_amount_micros: 13_000_000 }).ok, false);
  // Whole-cent rounding of a +20% on a small budget is not a breach.
  assert.equal(evaluateBudgetBounds({ delta_pct: 20, current_amount_micros: 1_237_500, new_amount_micros: 1_490_000 }).ok, true);
});

test('checkGuardrails applies the 5 to 20 bounds with no snapshot at all (execution time, Jarvis, autopilot)', async () => {
  const empty = db({ ai_actions: { data: [], error: null }, google_ads_accounts: { data: { business_id: null, currency_code: 'USD' }, error: null } });
  const ok = budgetAction({ delta_pct: 20, new_amount_micros: 12_000_000 });
  assert.equal(await checkGuardrails(ok, 'account-1', empty), ok);
  for (const bad of [{ delta_pct: 25, new_amount_micros: 12_500_000 }, { delta_pct: -30, new_amount_micros: 7_000_000 }, { delta_pct: 3, new_amount_micros: 10_300_000 }]) {
    assert.equal(await checkGuardrails(budgetAction(bad), 'account-1', empty), null, JSON.stringify(bad));
  }
});

test('the 24-hour compounding cap still blocks a second rise on the same budget', async () => {
  // Legacy row without a budget_resource: treated as the same budget by the compounding cap.
  const legacy = db({
    ai_actions: { data: [{ payload: { action: { params: { delta_pct: 30 } } }, created_at: daysAgo(0.5) }], error: null },
    google_ads_accounts: { data: { business_id: null }, error: null },
  });
  // 1.30 x 1.20 = 1.56: over 50% in a day.
  assert.equal(await checkGuardrails(budgetAction({ delta_pct: 20, new_amount_micros: 12_000_000 }), 'account-1', legacy), null);

  // The same row a few days old is outside the 24-hour window.
  const old = db({
    ai_actions: { data: [{ payload: { action: { params: { delta_pct: 30 } } }, created_at: daysAgo(3) }], error: null },
    google_ads_accounts: { data: { business_id: null }, error: null },
  });
  const action = budgetAction({ delta_pct: 20, new_amount_micros: 12_000_000 });
  assert.equal(await checkGuardrails(action, 'account-1', old), action);
});

// ---------------------------------------------------------------------------
// Tracking gate
// ---------------------------------------------------------------------------

test('only a healthy tracking verdict unlocks budget, bid, keyword pause and ad pause', () => {
  const gated: Array<OptimizerAction['type']> = ['adjust_budget', 'adjust_bid', 'pause_keyword', 'pause_ad'];
  for (const status of ['missing', 'suspect', 'broken_recently', 'wrong_primary', 'unknown'] as const) {
    const snap = snapshot({ conversion_tracking: { status, enabled_actions: 1 } });
    for (const type of gated) {
      assert.deepEqual(evaluateTrackingGate({ ...budgetAction(), type }, { snapshot: snap }), { ok: false, code: 'tracking_not_healthy' }, `${type}:${status}`);
    }
    // Negatives and promotions are not blocked by it.
    assert.equal(evaluateTrackingGate({ ...budgetAction(), type: 'add_negative_keyword' }, { snapshot: snap }).ok, true);
  }
  for (const type of gated) {
    assert.equal(evaluateTrackingGate({ ...budgetAction(), type }, { snapshot: snapshot() }).ok, true, type);
  }
  // No tracking block at all is not healthy either.
  assert.equal(evaluateTrackingGate(budgetAction(), { snapshot: snapshot({ conversion_tracking: null }) }).ok, false);
});

test('queue time: a pause_keyword is rejected in code when tracking is not healthy', async () => {
  const action: OptimizerAction = {
    type: 'pause_keyword',
    target_id: 'customers/123/adGroupCriteria/55~9',
    params: {},
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'cost', delta_pct: -2, delta_sar_per_month: 10 },
  };
  // The snapshot row the proposal points at: 30 days, 40 clicks, 20 SAR, no conversions (the account's own CPA is 3.75).
  const keywordRow = {
    ad_group_criterion: { resource_name: 'customers/123/adGroupCriteria/55~9', keyword: { text: 'كلمة' } },
    metrics: { clicks: 40, impressions: 900, cost_micros: 20_000_000, conversions: 0 },
  };
  const broken = withContext(
    snapshot({ underperforming_keywords: [keywordRow], conversion_tracking: { status: 'broken_recently', enabled_actions: 2 } })
  );
  assert.equal(await checkGuardrails(action, 'account-1', db(), broken), null);
  assert.equal(await checkGuardrails(action, 'account-1', db(), withContext(snapshot({ underperforming_keywords: [keywordRow] }))), action);
  // Without a snapshot (execution time) the gate is not applied: the optimizer's own queue is where it holds.
  assert.equal(await checkGuardrails(action, 'account-1', db()), action);
});

// ---------------------------------------------------------------------------
// Budget increase gate
// ---------------------------------------------------------------------------

const accountOk = { google_ads_accounts: { data: { business_id: null, currency_code: 'SAR' }, error: null } };

test('a budget increase passes only when every condition holds', async () => {
  const action = budgetAction();
  assert.equal(await checkGuardrails(action, 'account-1', db({ ai_actions: { data: [], error: null }, recommendations: { data: [], error: null }, ...accountOk }), withContext()), action);
});

test('a budget increase is refused when the economics are unknown', async () => {
  const snap = snapshot({ economics: unknownEconomics(), target_roas: null });
  assert.deepEqual(evaluateBudgetGate(budgetAction(), { snapshot: snap }, null), { ok: false, code: 'economics_unknown' });
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', db(accountOk), withContext(snap)), null);
  // Also without any economics block at all.
  assert.equal(evaluateBudgetGate(budgetAction(), { snapshot: snapshot({ economics: null }) }, null).ok, false);
});

test('economics unknown means no budget change at all, a cut included', async () => {
  const snap = snapshot({ economics: unknownEconomics() });
  const cut = budgetAction({ delta_pct: -15, new_amount_micros: 8_500_000 });
  assert.deepEqual(evaluateBudgetGate(cut, { snapshot: snap }, null), { ok: false, code: 'economics_unknown' });
});

test('a budget increase is refused when tracking is not healthy', async () => {
  const snap = snapshot({ conversion_tracking: { status: 'suspect', enabled_actions: 1 } });
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', db(accountOk), withContext(snap)), null);
});

test('a budget increase needs 1.2 x break-even ROAS on 15+ conversions in 30 days', () => {
  const gate = (last_30d: Record<string, unknown>) =>
    evaluateBudgetGate(budgetAction(), { snapshot: snapshot({ campaigns: [campaign({ last_30d })] }) }, null);
  // Break-even ROAS is 5, so 6.0 is the line.
  assert.equal(gate({ cost_micros: 300_000_000, conversions_value: 1800, conversions: 80 }).ok, true); // exactly 6.0
  assert.equal(gate({ cost_micros: 300_000_000, conversions_value: 1790, conversions: 80 }).ok, false); // 5.97
  assert.equal(gate({ cost_micros: 300_000_000, conversions_value: 4000, conversions: 14 }).ok, false); // great ROAS, too few conversions
  assert.equal(gate({ cost_micros: 300_000_000, conversions_value: 4000, conversions: 15 }).ok, true);
  // Conversions without tracked value cannot show a ROAS.
  assert.equal(gate({ cost_micros: 300_000_000, conversions_value: 0, conversions: 80 }).ok, false);
});

test('a lead business raises a budget only at 0.8 x break-even CPA or better', () => {
  const snap = (cost: number) =>
    snapshot({ economics: leads(), campaigns: [campaign({ last_30d: { cost_micros: cost * 1_000_000, conversions: 20, conversions_value: 0 } })] });
  // Break-even CPA is 400, so 320 per conversion is the line: 20 conversions at 6,400 SAR.
  assert.equal(evaluateBudgetGate(budgetAction(), { snapshot: snap(6400) }, null).ok, true);
  assert.equal(evaluateBudgetGate(budgetAction(), { snapshot: snap(6500) }, null).ok, false);
});

test('a budget increase needs lost-to-budget impression share of 20%+ (titan 6.4) and search impression share under 50%', () => {
  const gate = (diag: Record<string, unknown>) =>
    evaluateBudgetGate(budgetAction(), { snapshot: snapshot({ campaigns: [campaign({ diag })] }) }, null);
  assert.equal(SCALE_MIN_LOST_BUDGET_IS, 0.2);
  assert.equal(gate({ lost_budget_is: 0.2, search_is: 0.49 }).ok, true);
  assert.equal(gate({ lost_budget_is: 0.31, search_is: 0.49 }).ok, true);
  // The old 10% floor is no longer enough.
  assert.deepEqual(gate({ lost_budget_is: 0.1, search_is: 0.3 }), { ok: false, code: 'budget_not_constrained' });
  assert.deepEqual(gate({ lost_budget_is: 0.19, search_is: 0.3 }), { ok: false, code: 'budget_not_constrained' });
  assert.deepEqual(gate({ lost_budget_is: 0.3, search_is: 0.5 }), { ok: false, code: 'budget_not_constrained' });
  assert.equal(gate({ lost_budget_is: 0.3, search_is: 0.8 }).ok, false);
});

test('without impression share, only Google\'s own budget-constrained status can justify an increase', () => {
  const pmax = (status_reasons: string[]) =>
    snapshot({
      campaigns: [campaign({ diag: { type: 'PERFORMANCE_MAX', search_is: null, lost_budget_is: null, lost_rank_is: null, status_reasons } })],
    });
  assert.equal(evaluateBudgetGate(budgetAction(), { snapshot: pmax(['BUDGET_CONSTRAINED']) }, null).ok, true);
  assert.equal(evaluateBudgetGate(budgetAction(), { snapshot: pmax([]) }, null).ok, false);
  // The same economics condition still applies.
  const weak = snapshot({
    campaigns: [
      campaign({
        diag: { search_is: null, lost_budget_is: null, status_reasons: ['BUDGET_CONSTRAINED'] },
        last_30d: { cost_micros: 300_000_000, conversions_value: 900, conversions: 80 },
      }),
    ],
  });
  assert.equal(evaluateBudgetGate(budgetAction(), { snapshot: weak }, null).ok, false);
});

test('a campaign row with no diagnostics (the plain query fallback) can never justify an increase', () => {
  const row = campaign();
  delete row.diag;
  assert.equal(evaluateBudgetGate(budgetAction(), { snapshot: snapshot({ campaigns: [row] }) }, null).ok, false);
});

test('a budget increase is refused when the 30-day totals could not be read, or the budget is not in the snapshot', () => {
  assert.deepEqual(
    evaluateBudgetGate(budgetAction(), { snapshot: snapshot({ campaigns: [campaign({ last_30d: null })] }) }, null),
    { ok: false, code: 'campaign_30d_unavailable' }
  );
  assert.deepEqual(
    evaluateBudgetGate(budgetAction({ budget_resource: 'customers/123/campaignBudgets/999' }), { snapshot: snapshot() }, null),
    { ok: false, code: 'budget_not_in_snapshot' }
  );
});

test('a budget shared by several campaigns is judged on their combined 30 days', () => {
  const a = campaign({ resource: 'customers/123/campaigns/1', last_30d: { cost_micros: 100_000_000, conversions: 10, conversions_value: 900 } });
  const b = campaign({ resource: 'customers/123/campaigns/2', last_30d: { cost_micros: 100_000_000, conversions: 10, conversions_value: 900 } });
  // Alone, 10 conversions each is under 15. Together it is 20 and ROAS 9.
  assert.equal(evaluateBudgetGate(budgetAction(), { snapshot: snapshot({ campaigns: [a] }) }, null).ok, false);
  assert.equal(evaluateBudgetGate(budgetAction(), { snapshot: snapshot({ campaigns: [a, b] }) }, null).ok, true);
});

// ---------------------------------------------------------------------------
// Budget decrease gate
// ---------------------------------------------------------------------------

test('a budget cut is judged at the CUT end of the owner\'s range, not the SCALE end', () => {
  const cut = budgetAction({ delta_pct: -15, new_amount_micros: 8_500_000 });
  const lead = (cost: number, conversions: number) =>
    snapshot({ economics: leads(), campaigns: [campaign({ last_30d: { cost_micros: cost * 1_000_000, conversions, conversions_value: 0 } })] });
  // Lead business 10k-50k x margin 20-40% x close 2-3 of 10: scale CPA 400, CUT CPA 6000, spend floor 2 x 6000.
  assert.equal(evaluateBudgetGate(cut, { snapshot: lead(24_000, 4) }, null).ok, true); // CPA 6000, spend 24000
  assert.equal(evaluateBudgetGate(cut, { snapshot: lead(23_600, 4) }, null).ok, false); // CPA 5900: still inside the range
  assert.equal(evaluateBudgetGate(cut, { snapshot: lead(12_000, 0) }, null).ok, true); // nothing converted on 2+ CUT CPAs of spend
  assert.equal(evaluateBudgetGate(cut, { snapshot: lead(11_000, 0) }, null).ok, false); // not enough spend yet
  // The old rule would have cut this one (CPA 600 = 1.5 x the pessimistic 400): it is inside the owner's range now.
  assert.equal(evaluateBudgetGate(cut, { snapshot: lead(1_200, 2) }, null).ok, false);
  assert.equal(evaluateBudgetGate(cut, { snapshot: lead(900, 0) }, null).ok, false);

  // A clinic: profit 50-200 SAR x close 2-3 of 10: scale CPA 10, CUT CPA 60, floor 120.
  const clinic = buildSnapshotEconomics(
    computeBreakEven({
      facts: {
        type: { choice: 'clinic' },
        profit_per_deal: { choice: '50_200', min_sar: 50, max_sar: 200 },
        close_rate: { choice: '2_3', min_of_10: 2, max_of_10: 3 },
      },
    }),
    null
  );
  const clinicSnap = (cost: number, conversions: number) =>
    snapshot({ economics: clinic, campaigns: [campaign({ last_30d: { cost_micros: cost * 1_000_000, conversions, conversions_value: 0 } })] });
  assert.equal(evaluateBudgetGate(cut, { snapshot: clinicSnap(240, 4) }, null).ok, true); // CPA 60
  assert.equal(evaluateBudgetGate(cut, { snapshot: clinicSnap(236, 4) }, null).ok, false); // CPA 59
  assert.equal(evaluateBudgetGate(cut, { snapshot: clinicSnap(30, 1) }, null).ok, false); // CPA 30 is above the pessimistic 10 but well inside the range

  // A store with margin 20-40%: scale ROAS 5, CUT ROAS 2.5 (a real margin of 20-40% makes ROAS 3.2 normal, not a loss).
  const storeSnap = (cost: number, value: number, conversions: number) =>
    snapshot({ campaigns: [campaign({ last_30d: { cost_micros: cost * 1_000_000, conversions, conversions_value: value } })] });
  assert.equal(evaluateBudgetGate(cut, { snapshot: storeSnap(300, 960, 20) }, 15).ok, false); // ROAS 3.2: NO cut
  assert.equal(evaluateBudgetGate(cut, { snapshot: storeSnap(300, 750, 20) }, 15).ok, true); // ROAS 2.5: the optimistic break-even
  assert.equal(evaluateBudgetGate(cut, { snapshot: storeSnap(300, 600, 20) }, 15).ok, true); // ROAS 2.0
  assert.equal(evaluateBudgetGate(cut, { snapshot: storeSnap(300, 800, 20) }, 15).ok, false); // ROAS 2.67 is between the ends
  assert.equal(evaluateBudgetGate(cut, { snapshot: storeSnap(20, 0, 0) }, 15).ok, false); // under 2 x 15 of spend
  // Conversions with no tracked value say nothing about ROAS: never cut on a missing number.
  assert.equal(evaluateBudgetGate(cut, { snapshot: storeSnap(300, 0, 20) }, 15).ok, false);
  // A store with no account CPA to set the spend floor cannot be cut.
  assert.equal(evaluateBudgetGate(cut, { snapshot: storeSnap(300, 600, 20) }, null).ok, false);
  // A margin above 40% has a CUT ROAS of 1.25 and a scale ROAS of 2.5: ROAS 2.0 is not a loss.
  const rich = buildSnapshotEconomics(
    computeBreakEven({ facts: { type: { choice: 'ecommerce' }, margin: { choice: 'gt40', min_per_100: 40 } } }),
    null
  );
  assert.equal(evaluateBudgetGate(cut, { snapshot: { ...storeSnap(300, 600, 20), economics: rich } }, 15).ok, false);
  assert.equal(evaluateBudgetGate(cut, { snapshot: { ...storeSnap(300, 360, 20), economics: rich } }, 15).ok, true); // ROAS 1.2
});

test('between the SCALE and the CUT threshold nothing moves: no raise and no cut', () => {
  const raise = budgetAction();
  const cut = budgetAction({ delta_pct: -15, new_amount_micros: 8_500_000 });
  // Margin 20-40%: ROAS 3.2 is above the CUT end (2.5) and below the SCALE end (5).
  const mid = snapshot({ campaigns: [campaign({ last_30d: { cost_micros: 300_000_000, conversions: 80, conversions_value: 960 } })] });
  assert.equal(evaluateBudgetGate(raise, { snapshot: mid }, 15).ok, false);
  assert.equal(evaluateBudgetGate(cut, { snapshot: mid }, 15).ok, false);
});

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

test('lockedByRecentChange matches kind, target and window', () => {
  const rows = [{ operation: 'adjust_budget', resource: BUDGET, at: daysAgo(6) }];
  const now = NOW.getTime();
  assert.equal(lockedByRecentChange(rows, 'adjust_budget', BUDGET, 7, now), true);
  assert.equal(lockedByRecentChange(rows, 'adjust_budget', BUDGET, 5, now), false);
  assert.equal(lockedByRecentChange(rows, 'adjust_budget', 'customers/123/campaignBudgets/9', 7, now), false);
  assert.equal(lockedByRecentChange(rows, 'adjust_bid', BUDGET, 7, now), false);
  assert.equal(lockedByRecentChange(rows, 'adjust_budget', '', 7, now), false);
});

test('one budget change per budget per 7 days: an executed change locks the next one', async () => {
  const tables = (created_at: string): Tables => ({
    ai_actions: { data: [{ payload: { action: { params: { budget_resource: BUDGET, delta_pct: 10 } } }, created_at }], error: null },
    recommendations: { data: [], error: null },
    ...accountOk,
  });
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', db(tables(daysAgo(5))), withContext()), null);
  const later = budgetAction();
  assert.equal(await checkGuardrails(later, 'account-1', db(tables(daysAgo(8))), withContext()), later);
});

test('one budget change per budget per 7 days: a pending or approved recommendation locks it too', async () => {
  const pending = (created_at: string, resource = BUDGET): Tables => ({
    ai_actions: { data: [], error: null },
    recommendations: { data: [{ status: 'pending', created_at, action_payload: { operation: 'adjust_budget', params: { budget_resource: resource } } }], error: null },
    ...accountOk,
  });
  const database = db(pending(daysAgo(2)));
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', database, withContext()), null);
  const recQuery = database.calls.find((call) => call.table === 'recommendations');
  assert.deepEqual(recQuery?.filters.find(([method]) => method === 'in')?.[1], ['status', ['pending', 'approved', 'executing']]);

  // A pending change to a different budget does not lock this one.
  const other = budgetAction();
  assert.equal(await checkGuardrails(other, 'account-1', db(pending(daysAgo(2), 'customers/123/campaignBudgets/999')), withContext()), other);
  // Neither does a different operation.
  const bid: Tables = {
    ai_actions: { data: [], error: null },
    recommendations: { data: [{ status: 'pending', created_at: daysAgo(1), action_payload: { operation: 'adjust_bid', params: { budget_resource: BUDGET } } }], error: null },
    ...accountOk,
  };
  assert.equal(await checkGuardrails(other, 'account-1', db(bid), withContext()), other);
});

test('a stale pending optimizer recommendation (over 14 days) locks neither a budget nor a bid, a current one still does', async () => {
  const pendingRow = (operation: string, params: Record<string, unknown>, ageDays: number): Tables => ({
    ai_actions: { data: [], error: null },
    // The fake returns the row whatever the window the query asked for, as a database with a bad clock would.
    recommendations: { data: [{ status: 'pending', created_at: daysAgo(ageDays), action_payload: { operation, params, source: 'optimizer_cron' } }], error: null },
    ...accountOk,
  });
  const budget = budgetAction();
  assert.equal(await checkGuardrails(budget, 'account-1', db(pendingRow('adjust_budget', { budget_resource: BUDGET }, 20)), withContext()), budget);
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', db(pendingRow('adjust_budget', { budget_resource: BUDGET }, 6)), withContext()), null);
  const bid = bidAction();
  assert.equal(await checkGuardrails(bid, 'account-1', db(pendingRow('adjust_bid', { ad_group_resource: AD_GROUP }, 20)), withContext()), bid);
  assert.equal(await checkGuardrails(bidAction(), 'account-1', db(pendingRow('adjust_bid', { ad_group_resource: AD_GROUP }, 13)), withContext()), null);
});

test('a refused proposal is reported with its reason code and action type', async () => {
  const reasons: Array<{ code: string; action_type: string }> = [];
  const context = (snap: OptimizerSnapshot) => ({ snapshot: snap, now: NOW, onReject: (r: { code: string; action_type: string }) => reasons.push(r) });
  const open: Tables = { ai_actions: { data: [], error: null }, recommendations: { data: [], error: null }, ...accountOk };

  // Tracking, economics, bounds, impression share: each its own code.
  assert.equal(
    await checkGuardrails(budgetAction(), 'account-1', db(open), context(snapshot({ conversion_tracking: { status: 'wrong_primary', enabled_actions: 2 } }))),
    null
  );
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', db(open), context(snapshot({ economics: unknownEconomics() }))), null);
  assert.equal(await checkGuardrails(budgetAction({ delta_pct: 30, new_amount_micros: 13_000_000 }), 'account-1', db(open), context(snapshot())), null);
  assert.equal(
    await checkGuardrails(budgetAction(), 'account-1', db(open), context(snapshot({ campaigns: [campaign({ diag: { lost_budget_is: 0.1, search_is: 0.3 } })] }))),
    null
  );
  // A lock, a keyword with a BROAD match type, a bid with no 30-day volume.
  const locked: Tables = {
    ai_actions: { data: [{ payload: { action: { params: { budget_resource: BUDGET } } }, created_at: daysAgo(2) }], error: null },
    recommendations: { data: [], error: null },
    ...accountOk,
  };
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', db(locked), context(snapshot())), null);
  const broad: OptimizerAction = {
    type: 'add_keyword',
    target_id: AD_GROUP,
    params: { ad_group_resource: AD_GROUP, keyword_text: 'عيادة', match_type: 'BROAD' },
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'conversions', delta_pct: 0, delta_sar_per_month: 0 },
  };
  assert.equal(await checkGuardrails(broad, 'account-1', db(open), context(snapshot())), null);

  assert.deepEqual(
    reasons.map((r) => r.code),
    [
      'tracking_not_healthy',
      'economics_unknown',
      'budget_step_too_large',
      'budget_not_constrained',
      'budget_locked_recent_change',
      'keyword_match_type_not_allowed',
    ]
  );
  assert.deepEqual(reasons.map((r) => r.action_type), ['adjust_budget', 'adjust_budget', 'adjust_budget', 'adjust_budget', 'adjust_budget', 'add_keyword']);

  // An accepted proposal reports nothing, and a caller with no callback is unaffected.
  const before = reasons.length;
  const fine = budgetAction();
  assert.equal(await checkGuardrails(fine, 'account-1', db(open), context(snapshot())), fine);
  assert.equal(reasons.length, before);
  assert.equal(await checkGuardrails(budgetAction({ delta_pct: 30, new_amount_micros: 13_000_000 }), 'account-1', db(open), withContext()), null);
});

test('the locks fail closed when the history cannot be read', async () => {
  const noActions: Tables = { ai_actions: { data: null, error: { message: 'down' } }, recommendations: { data: [], error: null }, ...accountOk };
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', db(noActions), withContext()), null);
  const noRecs: Tables = { ai_actions: { data: [], error: null }, recommendations: { data: null, error: { message: 'down' } }, ...accountOk };
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', db(noRecs), withContext()), null);
});

test('the locks apply to the optimizer\'s own queue only: execution of an approved recommendation is not locked by itself', async () => {
  // The same pending row that blocks the queue must not block the execution of that very recommendation.
  const tables: Tables = {
    ai_actions: { data: [], error: null },
    recommendations: { data: [{ status: 'approved', created_at: daysAgo(1), action_payload: { operation: 'adjust_budget', params: { budget_resource: BUDGET } } }], error: null },
    ...accountOk,
  };
  const action = budgetAction();
  assert.equal(await checkGuardrails(action, 'account-1', db(tables)), action);
});

// ---------------------------------------------------------------------------
// Bids
// ---------------------------------------------------------------------------

test('a bid change needs 30+ conversions on the campaign in 30 days', () => {
  assert.equal(BID_MIN_CONVERSIONS_30D, 30);
  const gate = (conversions: number) =>
    evaluateBidGate(bidAction(), { snapshot: snapshot({ campaigns: [campaign({ last_30d: { conversions } })] }) });
  assert.equal(gate(30).ok, true);
  assert.deepEqual(gate(29), { ok: false, code: 'bid_needs_more_conversions' });
});

test('a target ROAS is never set below break-even ROAS, a target CPA never above break-even CPA', () => {
  // Break-even ROAS 5.
  assert.equal(evaluateBidGate(bidAction({ current_target_roas: 6, target_roas: 5 }), { snapshot: snapshot() }).ok, true);
  assert.deepEqual(evaluateBidGate(bidAction({ current_target_roas: 5.2, target_roas: 4.9 }), { snapshot: snapshot() }), {
    ok: false,
    code: 'target_roas_below_break_even',
  });

  // Break-even CPA 400 SAR = 400,000,000 micros.
  const cpaSnap = snapshot({
    economics: leads(),
    ad_group_bid_targets: [{ adGroup: { resourceName: AD_GROUP, campaign: CAMPAIGN, targetCpaMicros: 380_000_000 }, metrics: { conversions: 40 } }],
  });
  const cpa = (next: number) => bidAction({ target_roas: undefined, current_target_cpa_micros: 380_000_000, target_cpa_micros: next });
  assert.equal(evaluateBidGate(cpa(400_000_000), { snapshot: cpaSnap }).ok, true);
  assert.deepEqual(evaluateBidGate(cpa(400_000_001), { snapshot: cpaSnap }), { ok: false, code: 'target_cpa_above_break_even' });
  // A store has no CPA break-even to hold a target CPA to.
  assert.deepEqual(
    evaluateBidGate(cpa(300_000_000), { snapshot: snapshot({ ad_group_bid_targets: cpaSnap.ad_group_bid_targets }) }),
    { ok: false, code: 'no_cpa_break_even' }
  );
});

test('a bid change is refused with unknown economics, unhealthy tracking, or an ad group the model was not shown', () => {
  assert.equal(evaluateBidGate(bidAction(), { snapshot: snapshot({ economics: unknownEconomics() }) }).ok, false);
  assert.equal(evaluateBidGate(bidAction(), { snapshot: snapshot({ conversion_tracking: { status: 'wrong_primary', enabled_actions: 2 } }) }).ok, false);
  assert.deepEqual(evaluateBidGate(bidAction({ ad_group_resource: 'customers/123/adGroups/1' }), { snapshot: snapshot() }), {
    ok: false,
    code: 'ad_group_not_in_snapshot',
  });
});

test('one target change per ad group per 14 days', async () => {
  const tables = (created_at: string): Tables => ({
    ai_actions: { data: [{ payload: { action: { params: { ad_group_resource: AD_GROUP } } }, created_at }], error: null },
    recommendations: { data: [], error: null },
  });
  assert.equal(await checkGuardrails(bidAction(), 'account-1', db(tables(daysAgo(13))), withContext()), null);
  const action = bidAction();
  assert.equal(await checkGuardrails(action, 'account-1', db(tables(daysAgo(15))), withContext()), action);

  const pending: Tables = {
    ai_actions: { data: [], error: null },
    recommendations: { data: [{ status: 'pending', created_at: daysAgo(3), action_payload: { operation: 'adjust_bid', params: { ad_group_resource: AD_GROUP } } }], error: null },
  };
  assert.equal(await checkGuardrails(bidAction(), 'account-1', db(pending), withContext()), null);
});

test('the existing plus-or-minus 20 percent bid bound still holds', async () => {
  const empty = db();
  assert.equal(await checkGuardrails(bidAction({ target_roas: 8 }), 'account-1', empty, withContext()), null);
});

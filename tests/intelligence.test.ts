import assert from 'node:assert/strict';
import test from 'node:test';

import { checkGuardrails, type OptimizerAction } from '../lib/ai/optimizer-agent';
import { computeWeeklyComparison, type CampaignWeekRow } from '../lib/ai/report-agent';
import { computeObservedImpact, sumMetricRows } from '../lib/ai/impact';
import { runRuleBasedAudit } from '../lib/audit/rule-engine';

const noopSupabase: any = { from: () => ({ select: () => ({}) }) };

// ---------------------------------------------------------------------------
// add_keyword (expansion) guardrails
// ---------------------------------------------------------------------------

function keywordAction(params: Record<string, unknown>): OptimizerAction {
  return {
    type: 'add_keyword',
    target_id: 'customers/1/adGroups/2',
    params,
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'conversions', delta_pct: 5, delta_sar_per_month: 100 },
  };
}

test('a sane EXACT keyword promotion passes guardrails', async () => {
  const action = keywordAction({
    ad_group_resource: 'customers/1/adGroups/2',
    keyword_text: 'عطر رجالي فاخر',
    match_type: 'EXACT',
  });
  assert.notEqual(await checkGuardrails(action, 'account-1', noopSupabase), null);
});

test('BROAD promotion is always blocked — a promoted term must never widen delivery', async () => {
  const action = keywordAction({
    ad_group_resource: 'customers/1/adGroups/2',
    keyword_text: 'عطر',
    match_type: 'BROAD',
  });
  assert.equal(await checkGuardrails(action, 'account-1', noopSupabase), null);
});

test('over-long or over-worded keyword text is blocked', async () => {
  const tooLong = keywordAction({
    keyword_text: 'x'.repeat(81),
    match_type: 'EXACT',
  });
  assert.equal(await checkGuardrails(tooLong, 'account-1', noopSupabase), null);

  const tooManyWords = keywordAction({
    keyword_text: 'a b c d e f g h i j k',
    match_type: 'PHRASE',
  });
  assert.equal(await checkGuardrails(tooManyWords, 'account-1', noopSupabase), null);
});

// ---------------------------------------------------------------------------
// Weekly comparison math (the numbers the narrative is built from)
// ---------------------------------------------------------------------------

const week = (rows: Array<Partial<CampaignWeekRow> & { name: string }>): CampaignWeekRow[] =>
  rows.map((row) => ({
    cost: 0,
    clicks: 0,
    conversions: 0,
    conversion_value: 0,
    ...row,
  }));

test('weekly comparison totals and deltas are exact', () => {
  const comparison = computeWeeklyComparison(
    week([
      { name: 'A', cost: 700, clicks: 350, conversions: 14, conversion_value: 2800 },
      { name: 'B', cost: 300, clicks: 150, conversions: 2, conversion_value: 400 },
    ]),
    week([
      { name: 'A', cost: 500, clicks: 300, conversions: 10, conversion_value: 2000 },
      { name: 'B', cost: 300, clicks: 160, conversions: 4, conversion_value: 800 },
    ])
  );

  assert.equal(comparison.totals.this_week.cost, 1000);
  assert.equal(comparison.totals.prior_week.cost, 800);
  assert.equal(comparison.totals.delta.cost, 200);
  assert.equal(comparison.totals.delta.conversions, 2);
  assert.equal(comparison.totals.delta.cpa_this, 62.5); // 1000 / 16
  assert.equal(comparison.totals.delta.cpa_prior, 57.14); // 800 / 14 rounded
});

test('movers are attributed to the campaigns that actually drove the change', () => {
  const comparison = computeWeeklyComparison(
    week([
      { name: 'الحملة الكبيرة', cost: 900, conversions: 9 },
      { name: 'الثابتة', cost: 100, conversions: 1 },
    ]),
    week([
      { name: 'الحملة الكبيرة', cost: 400, conversions: 4 },
      { name: 'الثابتة', cost: 100, conversions: 1 },
    ])
  );

  assert.equal(comparison.movers.spend[0].name, 'الحملة الكبيرة');
  assert.equal(comparison.movers.spend[0].delta, 500);
  // The unchanged campaign must NOT appear as a mover.
  assert.ok(!comparison.movers.spend.some((mover) => mover.name === 'الثابتة'));
});

test('a campaign that disappeared this week still counts as a negative mover', () => {
  const comparison = computeWeeklyComparison(
    week([{ name: 'باقية', cost: 100 }]),
    week([
      { name: 'باقية', cost: 100 },
      { name: 'موقوفة', cost: 250, conversions: 3 },
    ])
  );
  const gone = comparison.movers.spend.find((mover) => mover.name === 'موقوفة');
  assert.ok(gone);
  assert.equal(gone!.delta, -250);
});

// ---------------------------------------------------------------------------
// Observed impact (the learning loop)
// ---------------------------------------------------------------------------

test('metric rows sum across camelCase and snake_case shapes', () => {
  const totals = sumMetricRows([
    { metrics: { costMicros: 5_000_000, clicks: 10, conversions: 1, conversionsValue: 200 } },
    { metrics: { cost_micros: 2_500_000, clicks: 5, conversions: 0.5, conversions_value: 100 } },
  ]);
  assert.equal(totals.cost, 7.5);
  assert.equal(totals.clicks, 15);
  assert.equal(totals.conversions, 1.5);
  assert.equal(totals.conversion_value, 300);
});

test('observed impact deltas compare after against before', () => {
  const impact = computeObservedImpact(
    { cost: 100, clicks: 50, conversions: 5, conversion_value: 1000 },
    { cost: 80, clicks: 60, conversions: 8, conversion_value: 1600 }
  );
  assert.equal(impact.delta.cost, -20);
  assert.equal(impact.delta.clicks, 10);
  assert.equal(impact.delta.conversions, 3);
  assert.equal(impact.delta.conversion_value, 600);
  assert.equal(impact.window_days, 7);
});

test('a missing before snapshot is treated as zeros, not a crash', () => {
  const impact = computeObservedImpact(null, { cost: 40, clicks: 20, conversions: 2, conversion_value: 300 });
  assert.equal(impact.delta.cost, 40);
  assert.equal(impact.delta.conversions, 2);
});

// ---------------------------------------------------------------------------
// Conversion tracking findings in the audit
// ---------------------------------------------------------------------------

const cachedCampaign = (metrics30: Record<string, number>) => ({
  id: 'row-1',
  google_campaign_id: 1,
  name: 'حملة البحث',
  type: 'SEARCH',
  status: 'ENABLED',
  daily_budget: 100,
  metrics_30d: metrics30,
  metrics_7d: metrics30,
  metrics_today: {},
});

test('zero enabled conversion actions produces the critical tracking-missing finding', () => {
  const result = runRuleBasedAudit({
    account: { customer_id: '1', customer_name: 'اختبار', currency_code: 'SAR' },
    campaigns: [cachedCampaign({ cost: 500, clicks: 200, impressions: 4000, conversions: 0 })],
    conversionTracking: { enabled_actions: 0 },
  });
  const finding = result.findings.find((item) => item.action_payload.operation === 'setup_conversion_tracking');
  assert.ok(finding, 'tracking-missing finding should exist');
  assert.equal(finding!.severity, 'critical');
  // The vaguer "no conversions" finding must NOT duplicate it.
  assert.ok(!result.findings.some((item) => item.action_payload.operation === 'audit_conversion_tracking'));
});

test('enabled actions + real clicks + zero conversions reads as broken tracking', () => {
  const result = runRuleBasedAudit({
    account: { customer_id: '1', customer_name: 'اختبار', currency_code: 'SAR' },
    campaigns: [cachedCampaign({ cost: 500, clicks: 200, impressions: 4000, conversions: 0 })],
    conversionTracking: { enabled_actions: 3 },
  });
  const finding = result.findings.find((item) => item.title_ar.includes('معطل'));
  assert.ok(finding, 'tracking-suspect finding should exist');
  assert.equal(finding!.severity, 'critical');
});

test('healthy tracking with conversions produces no tracking finding', () => {
  const result = runRuleBasedAudit({
    account: { customer_id: '1', customer_name: 'اختبار', currency_code: 'SAR' },
    campaigns: [cachedCampaign({ cost: 500, clicks: 200, impressions: 4000, conversions: 12 })],
    conversionTracking: { enabled_actions: 3 },
  });
  assert.ok(
    !result.findings.some(
      (item) =>
        item.action_payload.operation === 'setup_conversion_tracking' ||
        item.title_ar.includes('معطل')
    )
  );
});

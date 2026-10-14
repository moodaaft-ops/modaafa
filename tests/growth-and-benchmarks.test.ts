import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MIN_CLUSTER_CONVERSIONS_FOR_NEW_CAMPAIGN,
  buildOpportunityRecommendation,
  conversionValueIsTracked,
  detectCampaignOpportunity,
  mapConvertingTermRows,
  opportunityMode,
  type ConvertingTermRow,
} from '../lib/ai/opportunity';
import {
  buildSectorBenchmarks,
  median,
  normalizeSector,
  sumCampaignMetrics30d,
  type AccountAggregate,
} from '../lib/benchmarks/compute';
import { runRuleBasedAudit } from '../lib/audit/rule-engine';

// ---------------------------------------------------------------------------
// Campaign opportunity detection
// ---------------------------------------------------------------------------

const term = (overrides: Partial<ConvertingTermRow> & { term: string }): ConvertingTermRow => ({
  clicks: 20,
  conversions: 3,
  cost: 90,
  conversion_value: 600,
  ...overrides,
});

test('a real cluster of winners produces an opportunity with an honest brief', () => {
  const opportunity = detectCampaignOpportunity(
    [
      term({ term: 'عطر رجالي فاخر', conversions: 6, cost: 180 }),
      term({ term: 'عطر عود اصلي', conversions: 4, cost: 120 }),
      term({ term: 'أفضل عطر هدية', conversions: 3, cost: 100 }),
    ],
    'SAR'
  );
  assert.ok(opportunity);
  assert.equal(opportunity!.totals.conversions, 13);
  assert.equal(opportunity!.totals.cost, 400);
  // The brief must carry the actual terms, not a paraphrase.
  assert.match(opportunity!.brief_ar, /عطر رجالي فاخر/);
  // Titan 3.5: the brief now says "13 تحويل" (no tanween) and asks for Exact keywords, not a new campaign.
  assert.match(opportunity!.brief_ar, /13 تحويل/);
});

// Titan 3.5, 20.3: consolidate. A campaign under ~30 conversions a month swings and relearns, so
// winning terms are promoted to EXACT keywords where they already convert; a separate campaign is
// suggested only when the cluster itself reached 30 conversions in 30 days.
test('under 30 conversions the suggestion is Exact keywords inside the existing ad group, never a new campaign', () => {
  const opportunity = detectCampaignOpportunity(
    [
      term({ term: 'عطر رجالي فاخر', conversions: 6, cost: 180 }),
      term({ term: 'عطر عود اصلي', conversions: 4, cost: 120 }),
      term({ term: 'أفضل عطر هدية', conversions: 3, cost: 100 }),
    ],
    'SAR'
  );
  assert.ok(opportunity);
  assert.equal(opportunity!.mode, 'exact_keywords');
  assert.equal(opportunityMode(opportunity!.totals.conversions), 'exact_keywords');
  assert.match(opportunity!.title_ar, /مطابقة تامة/);
  assert.match(opportunity!.description_ar, /Exact/);
  assert.match(opportunity!.description_ar, /نفس المجموعة الإعلانية/);
  assert.match(opportunity!.description_ar, /30 تحويل في الشهر/);
  assert.match(opportunity!.brief_ar, /بدون حملة جديدة/);
  assert.match(opportunity!.brief_ar, /Exact/);
  for (const text of [opportunity!.title_ar, opportunity!.description_ar, opportunity!.brief_ar]) {
    assert.doesNotMatch(text, /حملة مخصصة|عادةً بتكلفة تحويل أقل|تستحق حملة/, 'the old new-campaign pitch is gone');
    assert.doesNotMatch(text, /[—–]/, 'no long dashes in user-facing Arabic');
  }
});

test('a new campaign is suggested only from 30 conversions in 30 days, and only behind an economic reason', () => {
  const justBelow = detectCampaignOpportunity(
    [term({ term: 'أ', conversions: 10 }), term({ term: 'ب', conversions: 10 }), term({ term: 'ج', conversions: 9 })],
    'SAR'
  );
  assert.equal(justBelow!.totals.conversions, 29);
  assert.equal(justBelow!.mode, 'exact_keywords');

  const atThirty = detectCampaignOpportunity(
    [term({ term: 'أ', conversions: 10 }), term({ term: 'ب', conversions: 10 }), term({ term: 'ج', conversions: 10 })],
    'SAR'
  );
  assert.equal(atThirty!.totals.conversions, 30);
  assert.equal(atThirty!.mode, 'new_campaign');
  assert.equal(MIN_CLUSTER_CONVERSIONS_FOR_NEW_CAMPAIGN, 30);
  assert.match(atThirty!.description_ar, /اقتصاد مختلف/);
  assert.match(atThirty!.brief_ar, /سبب اقتصادي للفصل/);
  assert.match(atThirty!.brief_ar, /بدون أي توقع/);
  for (const text of [atThirty!.title_ar, atThirty!.description_ar, atThirty!.brief_ar]) {
    assert.doesNotMatch(text, /[—–]/, 'no long dashes in user-facing Arabic');
  }
});

// ---------------------------------------------------------------------------
// The opportunity's recommendation row: mode-based, measured, no invented value
// ---------------------------------------------------------------------------

const cluster = (conversions: number, conversion_value: number) => [
  term({ term: 'أ', conversions: conversions / 3, cost: 100, conversion_value: conversion_value / 3 }),
  term({ term: 'ب', conversions: conversions / 3, cost: 100, conversion_value: conversion_value / 3 }),
  term({ term: 'ج', conversions: conversions / 3, cost: 100, conversion_value: conversion_value / 3 }),
];

test('a conversion value equal to the conversion count is Google\'s default, not revenue', () => {
  assert.equal(conversionValueIsTracked({ conversions: 12, conversion_value: 12 }), false);
  assert.equal(conversionValueIsTracked({ conversions: 12, conversion_value: 12.004 }), false);
  assert.equal(conversionValueIsTracked({ conversions: 12, conversion_value: 0 }), false);
  assert.equal(conversionValueIsTracked({ conversions: 12, conversion_value: Number.NaN }), false);
  assert.equal(conversionValueIsTracked({ conversions: 12, conversion_value: 1800 }), true);
});

test('under 30 conversions the row is a «growth» Exact-keywords tip with the MEASURED cost and conversions, no percentage', () => {
  const opportunity = detectCampaignOpportunity(cluster(15, 2250), 'SAR')!;
  assert.equal(opportunity.mode, 'exact_keywords');
  const row = buildOpportunityRecommendation(opportunity, 'SAR');
  assert.equal(row.severity, 'growth');
  assert.equal(row.category, 'keywords');
  assert.equal(row.action_payload.operation, 'build_campaign_opportunity');
  assert.equal(row.action_payload.mode, 'exact_keywords');
  assert.deepEqual(row.expected_impact, {
    metric: 'conversions',
    basis: 'measured_30d',
    conversions: 15,
    cost: 300,
    cpa: 20,
    currency: 'SAR',
    conversion_value: 2250,
  });
  // The old fixed 15% and the revenue derived from it are gone.
  assert.equal('delta_pct' in row.expected_impact, false);
  assert.equal('delta_sar_per_month' in row.expected_impact, false);
  assert.match(row.title, /مطابقة تامة/);
});

test('from 30 conversions the row is a «medium» structure decision, still behind the economic-reason brief', () => {
  const opportunity = detectCampaignOpportunity(cluster(30, 4500), 'SAR')!;
  const row = buildOpportunityRecommendation(opportunity, 'SAR');
  assert.equal(opportunity.mode, 'new_campaign');
  assert.equal(row.severity, 'medium');
  assert.equal(row.category, 'structure');
  assert.equal(row.action_payload.mode, 'new_campaign');
  assert.match(row.action_payload.brief_ar, /سبب اقتصادي للفصل/);
  assert.equal(row.expected_impact.conversions, 30);
});

test('an account that never set a conversion value gets no value in the impact or the payload', () => {
  // Value equals the count: 15 conversions, 15 "value".
  const opportunity = detectCampaignOpportunity(cluster(15, 15), 'SAR')!;
  const row = buildOpportunityRecommendation(opportunity, 'SAR');
  assert.equal(row.action_payload.value_tracked, false);
  assert.equal('conversion_value' in row.expected_impact, false);
  assert.equal(row.action_payload.totals.conversion_value, null);
  assert.ok(row.action_payload.terms.every((entry) => entry.conversion_value === null));
  assert.deepEqual(row.expected_impact, { metric: 'conversions', basis: 'measured_30d', conversions: 15, cost: 300, cpa: 20, currency: 'SAR' });

  const tracked = buildOpportunityRecommendation(detectCampaignOpportunity(cluster(15, 2250), 'SAR')!, 'SAR');
  assert.equal(tracked.action_payload.value_tracked, true);
  assert.equal(tracked.action_payload.totals.conversion_value, 2250);
});

test('the row text has no long dash and the title fits the column', () => {
  for (const conversions of [15, 30]) {
    const row = buildOpportunityRecommendation(detectCampaignOpportunity(cluster(conversions, conversions), 'SAR')!, 'SAR');
    assert.ok(row.title.length <= 120);
    for (const text of [row.title, row.description, row.action_payload.brief_ar]) assert.doesNotMatch(text, /[—–]/);
  }
});

test('the cron builds the opportunity row from the mode and no longer invents a 15% impact', () => {
  const route = readFileSync(new URL('../app/api/cron/optimize/route.ts', import.meta.url), 'utf8');
  const start = route.indexOf('async function maybeQueueCampaignOpportunity');
  const fn = route.slice(start, route.indexOf('// Weekly intelligence report', start));
  assert.match(fn, /buildOpportunityRecommendation\(opportunity, currencyCode\)/);
  assert.doesNotMatch(fn, /delta_pct: 15/);
  assert.doesNotMatch(fn, /\* 0\.15/);
  assert.doesNotMatch(fn, /totals\.conversions >= 15/);
  // A pending opportunity older than the cooldown holds the fingerprint: it is renewed, not lost.
  assert.match(fn, /renewStalePendingRecommendation\(supabase, held\.id, row\)/);
});

test('too few terms or too few conversions produce NO opportunity', () => {
  assert.equal(
    detectCampaignOpportunity([
      term({ term: 'أ', conversions: 3 }),
      term({ term: 'ب', conversions: 3 }),
    ]),
    null,
    'two terms are not a campaign'
  );
  assert.equal(
    detectCampaignOpportunity([
      term({ term: 'أ', conversions: 1 }),
      term({ term: 'ب', conversions: 1 }),
      term({ term: 'ج', conversions: 1 }),
    ]),
    null,
    'terms below the per-term conversion floor are excluded, so the cluster dies'
  );
});

test('GAQL rows map across camelCase and snake_case shapes', () => {
  const rows = mapConvertingTermRows([
    { searchTermView: { searchTerm: 'تجربة' }, metrics: { clicks: 10, conversions: 2, costMicros: 5_000_000 } },
    { search_term_view: { search_term: 'ثانية' }, metrics: { clicks: 4, conversions: 3, cost_micros: 2_000_000 } },
    { metrics: { clicks: 9 } }, // no term → dropped
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].term, 'تجربة');
  assert.equal(rows[0].cost, 5);
  assert.equal(rows[1].conversions, 3);
});

test('duplicate GAQL rows for the same search term collapse into one real term', () => {
  const rows = mapConvertingTermRows([
    { searchTermView: { searchTerm: '  عطر   رجالي ' }, metrics: { clicks: 4, conversions: 2, costMicros: 3_000_000 } },
    { searchTermView: { searchTerm: 'عطر رجالي' }, metrics: { clicks: 6, conversions: 3, costMicros: 5_000_000 } },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].term, 'عطر رجالي');
  assert.equal(rows[0].clicks, 10);
  assert.equal(rows[0].conversions, 5);
  assert.equal(rows[0].cost, 8);
});

// ---------------------------------------------------------------------------
// Sector benchmarks
// ---------------------------------------------------------------------------

test('median is robust to odd/even/empty inputs', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('sector normalization trims and rejects empties', () => {
  assert.equal(normalizeSector('  تجارة إلكترونية  '), 'تجارة إلكترونية');
  assert.equal(normalizeSector('   '), null);
  assert.equal(normalizeSector(null), null);
});

const aggregate = (overrides: Partial<AccountAggregate>): AccountAggregate => ({
  business_id: 'b1',
  sector: 'تجارة إلكترونية',
  currency_code: 'SAR',
  cost: 1000,
  clicks: 500,
  impressions: 10_000,
  conversions: 20,
  conversion_value: 4000,
  ...overrides,
});

test('a sector below 3 distinct businesses publishes NO benchmark (k-anonymity)', () => {
  const rows = buildSectorBenchmarks([
    aggregate({ business_id: 'b1' }),
    aggregate({ business_id: 'b2' }),
    // Same business twice (agency with two accounts) must not count as a third.
    aggregate({ business_id: 'b2' }),
  ]);
  assert.equal(rows.length, 0);
});

test('three businesses produce a benchmark with median (not mean) CPA', () => {
  const rows = buildSectorBenchmarks([
    aggregate({ business_id: 'b1', cost: 500, conversions: 10 }), // CPA 50
    aggregate({ business_id: 'b2', cost: 900, conversions: 10 }), // CPA 90
    aggregate({ business_id: 'b3', cost: 10_000, conversions: 10 }), // CPA 1000 (whale)
  ]);
  assert.equal(rows.length, 1);
  // Median 90 — a mean would have been ~380, dragged by the whale.
  assert.equal(rows[0].median_cpa, 90);
  assert.equal(rows[0].businesses_count, 3);
});

test('one business with many accounts contributes one benchmark observation', () => {
  const dominantAgencyAccounts = Array.from({ length: 5 }, (_, index) =>
    aggregate({
      business_id: 'b1',
      cost: 1000,
      conversions: 1,
      impressions: 10_000 + index,
    })
  );
  const rows = buildSectorBenchmarks([
    ...dominantAgencyAccounts,
    aggregate({ business_id: 'b2', cost: 500, conversions: 10 }), // CPA 50
    aggregate({ business_id: 'b3', cost: 900, conversions: 10 }), // CPA 90
  ]);

  assert.equal(rows.length, 1);
  // b1 is CPA 1000 after its accounts are combined. Per-account weighting
  // would return 1000; one observation per business correctly returns 90.
  assert.equal(rows[0].median_cpa, 90);
  assert.equal(rows[0].businesses_count, 3);
  assert.equal(rows[0].accounts_count, 7);
});

test('different currencies never mix into one benchmark', () => {
  const rows = buildSectorBenchmarks([
    aggregate({ business_id: 'b1', currency_code: 'SAR' }),
    aggregate({ business_id: 'b2', currency_code: 'SAR' }),
    aggregate({ business_id: 'b3', currency_code: 'USD' }),
  ]);
  // Neither group reaches 3 businesses on its own.
  assert.equal(rows.length, 0);
});

test('sector names with spaces survive the grouping round-trip', () => {
  const rows = buildSectorBenchmarks([
    aggregate({ business_id: 'b1', sector: 'عيادات و مراكز طبية' }),
    aggregate({ business_id: 'b2', sector: 'عيادات و مراكز طبية' }),
    aggregate({ business_id: 'b3', sector: 'عيادات و مراكز طبية' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sector, 'عيادات و مراكز طبية');
  assert.equal(rows[0].currency_code, 'SAR');
});

test('campaign cache metrics sum into an account aggregate', () => {
  const totals = sumCampaignMetrics30d([
    { metrics_30d: { cost: 100, clicks: 50, impressions: 1000, conversions: 4, conversion_value: 800 } },
    { metrics_30d: { cost: 60, clicks: 30, impressions: 500, conversions: 2, conversion_value: 300 } },
    { metrics_30d: null },
  ]);
  assert.equal(totals.cost, 160);
  assert.equal(totals.conversions, 6);
  assert.equal(totals.impressions, 1500);
});

// ---------------------------------------------------------------------------
// Benchmark finding in the audit
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

test('a CPA far above the sector median produces the benchmark finding', () => {
  const result = runRuleBasedAudit({
    account: { customer_id: '1', customer_name: 'اختبار', currency_code: 'SAR' },
    // CPA = 1000 / 5 = 200 vs sector median 80 → 2.5× → critical.
    campaigns: [cachedCampaign({ cost: 1000, clicks: 300, impressions: 8000, conversions: 5 })],
    conversionTracking: { enabled_actions: 2 },
    benchmark: { businesses_count: 5, median_cpa: 80, median_ctr: 0.05, median_roas: 3 },
  });
  const finding = result.findings.find(
    (item) => item.action_payload.operation === 'review_vs_sector_benchmark'
  );
  assert.ok(finding, 'benchmark finding should exist');
  assert.equal(finding!.severity, 'critical');
  assert.match(finding!.description_ar, /5 أنشطة/);
});

test('a CPA close to the sector median produces NO benchmark finding', () => {
  const result = runRuleBasedAudit({
    account: { customer_id: '1', customer_name: 'اختبار', currency_code: 'SAR' },
    // CPA = 100 vs median 80 → 1.25× < 1.5× threshold.
    campaigns: [cachedCampaign({ cost: 500, clicks: 300, impressions: 8000, conversions: 5 })],
    conversionTracking: { enabled_actions: 2 },
    benchmark: { businesses_count: 5, median_cpa: 80, median_ctr: 0.05, median_roas: 3 },
  });
  assert.ok(
    !result.findings.some((item) => item.action_payload.operation === 'review_vs_sector_benchmark')
  );
});

test('no benchmark data means no benchmark finding — never a fabricated comparison', () => {
  const result = runRuleBasedAudit({
    account: { customer_id: '1', customer_name: 'اختبار', currency_code: 'SAR' },
    campaigns: [cachedCampaign({ cost: 1000, clicks: 300, impressions: 8000, conversions: 5 })],
    conversionTracking: { enabled_actions: 2 },
    benchmark: null,
  });
  assert.ok(
    !result.findings.some((item) => item.action_payload.operation === 'review_vs_sector_benchmark')
  );
});

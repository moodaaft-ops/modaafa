import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectCampaignOpportunity,
  mapConvertingTermRows,
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
  assert.match(opportunity!.brief_ar, /13 تحويلاً/);
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

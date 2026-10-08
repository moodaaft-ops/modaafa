import assert from 'node:assert/strict';
import test from 'node:test';
import {
  biggestExpectedImpact,
  computeKpi,
  kpiKeysForGoal,
  previousRange,
  recommendationCountLabel,
  spendChange,
  sumCampaignTotals,
} from '../app/(dashboard)/dashboard/dashboard-metrics';
import { resolveDateRange } from '../lib/analytics/date-range';

test('spend total includes paused campaigns that spent in the period', () => {
  const totals = sumCampaignTotals([
    { range_metrics: { cost: 100, clicks: 10, impressions: 1000, conversions: 2, conversion_value: 400 } },
    // A campaign paused today that spent earlier in the range.
    { range_metrics: { cost: 50, clicks: 5, impressions: 500, conversions: 1, conversion_value: 100 } },
    { range_metrics: null },
  ]);
  assert.equal(totals.cost, 150);
  assert.equal(totals.clicks, 15);
  assert.equal(totals.conversions, 3);
  assert.equal(totals.conversionValue, 500);
});

test('spend total reads legacy cost_sar keys', () => {
  assert.equal(sumCampaignTotals([{ range_metrics: { cost_sar: 80 } }]).cost, 80);
});

test('previous range has the same length and ends the day before', () => {
  const range = resolveDateRange({ range: '7d' }, '7d', new Date('2026-10-07T10:00:00Z'));
  assert.equal(range.from, '2026-10-01');
  const prev = previousRange(range);
  assert.equal(prev.to, '2026-09-30');
  assert.equal(prev.from, '2026-09-24');
  assert.equal(prev.days, 7);
  assert.equal(prev.metricKey, null);
});

test('spend change covers every honest state', () => {
  assert.deepEqual(spendChange(100, null), { kind: 'unavailable' });
  assert.deepEqual(spendChange(0, 0), { kind: 'none' });
  assert.deepEqual(spendChange(10, 0), { kind: 'new' });
  assert.deepEqual(spendChange(150, 100), { kind: 'delta', direction: 'up', percent: 50, previous: 100 });
  assert.deepEqual(spendChange(75, 100), { kind: 'delta', direction: 'down', percent: 25, previous: 100 });
  assert.deepEqual(spendChange(100, 100), { kind: 'delta', direction: 'flat', percent: 0, previous: 100 });
});

test('lead goal shows cost per lead instead of ROAS', () => {
  const leads = kpiKeysForGoal('leads');
  assert.deepEqual(leads, ['leads', 'cpl', 'conversion_rate']);
  assert.ok(!leads.includes('roas' as never));
  assert.deepEqual(kpiKeysForGoal('conversions'), ['conversions', 'roas', 'cpa']);
  assert.deepEqual(kpiKeysForGoal('traffic'), ['clicks', 'cpc', 'ctr']);
  assert.deepEqual(kpiKeysForGoal('awareness'), ['impressions', 'cpm', 'ctr']);
});

test('missing or unknown goal falls back to the sales set', () => {
  assert.deepEqual(kpiKeysForGoal(null), ['conversions', 'roas', 'cpa']);
  assert.deepEqual(kpiKeysForGoal('something'), ['conversions', 'roas', 'cpa']);
});

test('KPI values divide correctly and never invent a number', () => {
  const t = { cost: 300, clicks: 100, impressions: 10000, conversions: 6, conversionValue: 900 };
  assert.deepEqual(computeKpi('cpl', t), { kind: 'money', value: 50 });
  assert.deepEqual(computeKpi('roas', t), { kind: 'ratio', value: 3 });
  assert.deepEqual(computeKpi('conversion_rate', t), { kind: 'percent', value: 6 });
  assert.deepEqual(computeKpi('cpm', t), { kind: 'money', value: 30 });

  const none = { cost: 300, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0 };
  assert.equal(computeKpi('cpl', none).kind, 'empty');
  assert.equal(computeKpi('roas', none).kind, 'empty');
  assert.equal(computeKpi('cpc', none).kind, 'empty');
  assert.equal(computeKpi('ctr', none).kind, 'empty');
  assert.deepEqual(computeKpi('leads', none), { kind: 'count', value: 0 });
});

test('biggest expected impact ignores missing values and uses absolute size', () => {
  assert.equal(biggestExpectedImpact([]), null);
  assert.equal(biggestExpectedImpact([{ expected_impact: null }, { expected_impact: {} }]), null);
  assert.equal(
    biggestExpectedImpact([
      { expected_impact: { delta_sar_per_month: 120 } },
      { expected_impact: { delta_sar_per_month: -400 } },
      { expected_impact: { delta_sar_per_month: 'x' } },
    ]),
    400
  );
});

test('recommendation count uses correct Arabic plurals', () => {
  assert.equal(recommendationCountLabel(1), 'توصية واحدة');
  assert.equal(recommendationCountLabel(2), 'توصيتان');
  assert.equal(recommendationCountLabel(3), '3 توصيات');
  assert.equal(recommendationCountLabel(10), '10 توصيات');
  assert.equal(recommendationCountLabel(11), '11 توصية');
});

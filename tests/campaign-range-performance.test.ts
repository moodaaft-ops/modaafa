import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCampaignRangeMetrics } from '../lib/analytics/campaign-performance';
import { buildCampaignRangeQuery } from '../lib/google-ads/range-performance';

test('the Google Ads range query uses explicit safe dates', () => {
  const query = buildCampaignRangeQuery('2026-08-01', '2026-08-22');
  assert.match(query, /segments\.date BETWEEN '2026-08-01' AND '2026-08-22'/);
  assert.match(query, /campaign\.status != 'REMOVED'/);
  assert.throws(
    () => buildCampaignRangeQuery("2026-08-01' OR TRUE", '2026-08-22'),
    /Invalid Google Ads date range/
  );
});

test('live range metrics merge with cached campaign metadata without dropping zero rows', () => {
  const merged = mergeCampaignRangeMetrics(
    [
      { id: 'cached-1', google_campaign_id: 101, name: 'قديمة', status: 'PAUSED' },
      { id: 'cached-2', google_campaign_id: 202, name: 'بدون حركة', status: 'ENABLED' },
    ],
    [
      {
        google_campaign_id: 101,
        name: 'الحملة المحدثة',
        type: 'SEARCH',
        status: 'ENABLED',
        daily_budget: 120,
        bidding_strategy: 'MAXIMIZE_CONVERSIONS',
        metrics: {
          cost: 500,
          clicks: 100,
          impressions: 5_000,
          conversions: 10,
          conversion_value: 1_500,
          ctr: 0.02,
          cpc: 5,
          cpa: 50,
          roas: 3,
          currency_code: 'SAR',
        },
      },
      {
        google_campaign_id: 303,
        name: 'حملة جديدة من Google',
        type: 'PMAX',
        status: 'ENABLED',
        daily_budget: 200,
        bidding_strategy: 'MAXIMIZE_CONVERSION_VALUE',
        metrics: {
          cost: 50,
          clicks: 5,
          impressions: 1_000,
          conversions: 1,
          conversion_value: 100,
          ctr: 0.005,
          cpc: 10,
          cpa: 50,
          roas: 2,
          currency_code: 'SAR',
        },
      },
    ],
    'SAR'
  );

  assert.equal(merged.length, 3);
  assert.equal(merged[0].name, 'الحملة المحدثة');
  assert.equal(merged[0].range_metrics.cost, 500);
  assert.equal(merged[1].range_metrics.cost, 0);
  assert.equal(merged[2].google_campaign_id, 303);
});

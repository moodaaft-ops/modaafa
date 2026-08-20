import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAuditNarrative } from '../lib/audit/ai-analyst';
import { auditFindingTargetKey } from '../lib/audit/fingerprint';
import { collectAuditLiveSnapshot, type AuditLiveSnapshot } from '../lib/audit/live-snapshot';
import { runRuleBasedAudit } from '../lib/audit/rule-engine';
import { AUDIT_ENGINE_VERSION, auditEngineVersion, isCurrentAuditEngine } from '../lib/audit/version';

const account = {
  customer_id: '3571670180',
  customer_name: 'أضاحي السعودية الجديد',
  currency_code: 'USD',
};

function cachedCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cached-1',
    google_campaign_id: 101,
    name: 'حملة البحث الرئيسية',
    type: 'SEARCH',
    status: 'ENABLED',
    daily_budget: 100,
    metrics_30d: {
      cost: 2406.32,
      clicks: 640,
      impressions: 16_000,
      conversions: 39,
      conversion_value: 0,
      ctr: 0.04,
      cpa: 61.7,
    },
    metrics_7d: {
      cost: 944.89,
      clicks: 180,
      impressions: 5_000,
      conversions: 5,
      conversion_value: 0,
      ctr: 0.036,
      cpa: 188.98,
    },
    metrics_today: {},
    ...overrides,
  };
}

function snapshot(overrides: Partial<AuditLiveSnapshot> = {}): AuditLiveSnapshot {
  return {
    campaigns: [
      {
        id: '101',
        name: 'حملة البحث الرئيسية',
        resource_name: 'customers/3571670180/campaigns/101',
        budget_resource_name: 'customers/3571670180/campaignBudgets/1',
        status: 'ENABLED',
        type: 'SEARCH',
        daily_budget: 100,
        cost: 2406.32,
        clicks: 640,
        impressions: 16_000,
        conversions: 39,
        conversion_value: 0,
        ctr: 0.04,
      },
    ],
    search_share: [
      {
        campaign_id: '101',
        campaign_name: 'حملة البحث الرئيسية',
        impression_share: 0.42,
        lost_budget_share: 0.24,
        lost_rank_share: 0.39,
      },
    ],
    search_terms: [
      {
        term: 'أضاحي مجانية',
        status: 'NONE',
        campaign_name: 'حملة البحث الرئيسية',
        campaign_resource_name: 'customers/3571670180/campaigns/101',
        ad_group_resource_name: 'customers/3571670180/adGroups/201',
        cost: 148.5,
        clicks: 17,
        impressions: 390,
        conversions: 0,
        conversion_value: 0,
      },
      {
        term: 'شراء أضحية اونلاين',
        status: 'NONE',
        campaign_name: 'حملة البحث الرئيسية',
        campaign_resource_name: 'customers/3571670180/campaigns/101',
        ad_group_resource_name: 'customers/3571670180/adGroups/201',
        cost: 80,
        clicks: 31,
        impressions: 510,
        conversions: 4,
        conversion_value: 0,
      },
    ],
    keywords: [
      {
        text: 'اضاحي السعودية',
        match_type: 'BROAD',
        resource_name: 'customers/3571670180/adGroupCriteria/201~301',
        campaign_name: 'حملة البحث الرئيسية',
        campaign_resource_name: 'customers/3571670180/campaigns/101',
        ad_group_name: 'المجموعة الرئيسية',
        ad_group_resource_name: 'customers/3571670180/adGroups/201',
        cost: 510,
        clicks: 110,
        impressions: 3_000,
        conversions: 5,
        quality_score: 3,
        expected_ctr: 'BELOW_AVERAGE',
        ad_relevance: 'AVERAGE',
        landing_page_experience: 'BELOW_AVERAGE',
      },
    ],
    ads: [
      {
        resource_name: 'customers/3571670180/adGroupAds/201~401',
        campaign_name: 'حملة البحث الرئيسية',
        ad_group_name: 'المجموعة الرئيسية',
        ad_strength: 'POOR',
        approval_status: 'APPROVED',
        cost: 900,
        impressions: 8_000,
        clicks: 280,
        conversions: 12,
        ctr: 0.035,
      },
    ],
    conversion_tracking: { enabled_actions: 2 },
    coverage: {
      campaigns: true,
      search_share: true,
      search_terms: true,
      keywords: true,
      ads: true,
      conversion_tracking: true,
      coverage_pct: 100,
      confidence: 'high',
      failed_checks: [],
    },
    ...overrides,
  };
}

test('a live evidence audit produces specific findings instead of a generic healthy score', () => {
  const result = runRuleBasedAudit({
    account,
    campaigns: [cachedCampaign()],
    conversionTracking: { enabled_actions: 2 },
    liveSnapshot: snapshot(),
  });

  const operations = new Set(result.findings.map((finding) => finding.action_payload.operation));
  assert.ok(operations.has('review_wasted_search_term'));
  assert.ok(operations.has('review_low_quality_keyword'));
  assert.ok(operations.has('review_ad_policy_or_strength'));
  assert.ok(operations.has('review_conversion_values'));
  assert.ok(operations.has('review_recent_efficiency_regression'));
  assert.ok(result.health_score < 88, `expected evidence to lower score, got ${result.health_score}`);
  assert.equal(result.category_scores.data_confidence, 100);

  const wasted = result.findings.find((finding) => finding.action_payload.operation === 'review_wasted_search_term');
  assert.equal(wasted?.action_payload.source, 'google_ads_live');
  assert.equal(wasted?.action_payload.confidence, 'high');
  assert.ok((wasted?.action_payload.evidence_ar?.length ?? 0) >= 2);
});

test('incomplete live evidence caps health and records exactly what could not be checked', () => {
  const partial = snapshot({
    keywords: [],
    ads: [],
    conversion_tracking: null,
    coverage: {
      campaigns: true,
      search_share: false,
      search_terms: false,
      keywords: false,
      ads: false,
      conversion_tracking: false,
      coverage_pct: 17,
      confidence: 'limited',
      failed_checks: ['عبارات البحث الفعلية', 'جودة الكلمات المفتاحية', 'قوة الإعلانات وحالة الموافقة'],
    },
  });
  const result = runRuleBasedAudit({ account, campaigns: [cachedCampaign()], liveSnapshot: partial });
  const finding = result.findings.find((item) => item.action_payload.operation === 'retry_incomplete_audit');

  assert.ok(finding);
  assert.ok(result.health_score <= 72);
  assert.equal(result.category_scores.data_confidence, 17);
  assert.match(finding!.description_ar, /17%/);
});

test('live spend is used when the cache is stale instead of reporting zero waste', () => {
  const result = runRuleBasedAudit({
    account,
    campaigns: [cachedCampaign({ metrics_30d: {}, metrics_7d: {} })],
    liveSnapshot: snapshot(),
  });
  assert.ok(result.estimated_monthly_waste_sar > 0);
});

test('the current audit engine stamp rejects legacy unversioned results', () => {
  assert.equal(isCurrentAuditEngine(null), false);
  assert.equal(isCurrentAuditEngine({}), false);
  assert.equal(isCurrentAuditEngine({ audit_engine_version: '2' }), false);
  assert.equal(isCurrentAuditEngine({ audit_engine_version: AUDIT_ENGINE_VERSION - 1 }), false);
  assert.equal(isCurrentAuditEngine({ audit_engine_version: AUDIT_ENGINE_VERSION }), true);
  assert.equal(isCurrentAuditEngine({ audit_engine_version: AUDIT_ENGINE_VERSION + 1 }), true);
  assert.equal(auditEngineVersion({ audit_engine_version: AUDIT_ENGINE_VERSION }), AUDIT_ENGINE_VERSION);
});

test('real-account-shaped evidence cannot produce a zero-waste healthy audit', () => {
  const realAccountSnapshot = snapshot({
    campaigns: [
      {
        id: '101',
        name: '2 ADA Search',
        resource_name: 'customers/3571670180/campaigns/101',
        budget_resource_name: 'customers/3571670180/campaignBudgets/1',
        status: 'ENABLED',
        type: 'SEARCH',
        daily_budget: 170,
        cost: 2216.412536,
        clicks: 805,
        impressions: 6828,
        conversions: 39,
        conversion_value: 7318.2391,
        ctr: 0.117897,
      },
    ],
    search_share: [
      {
        campaign_id: '101',
        campaign_name: '2 ADA Search',
        impression_share: 0.173085,
        lost_budget_share: 0.564328,
        lost_rank_share: 0.262587,
      },
    ],
    search_terms: [
      {
        term: 'عقيقة',
        status: 'NONE',
        campaign_name: '2 ADA Search',
        campaign_resource_name: 'customers/3571670180/campaigns/101',
        ad_group_resource_name: 'customers/3571670180/adGroups/201',
        cost: 81.90941,
        clicks: 28,
        impressions: 210,
        conversions: 0,
        conversion_value: 0,
      },
      {
        term: 'اضاحي',
        status: 'NONE',
        campaign_name: '2 ADA Search',
        campaign_resource_name: 'customers/3571670180/campaigns/101',
        ad_group_resource_name: 'customers/3571670180/adGroups/202',
        cost: 48.07549,
        clicks: 32,
        impressions: 240,
        conversions: 0,
        conversion_value: 0,
      },
      {
        term: 'أضحية',
        status: 'NONE',
        campaign_name: '2 ADA Search',
        campaign_resource_name: 'customers/3571670180/campaigns/101',
        ad_group_resource_name: 'customers/3571670180/adGroups/203',
        cost: 41.38,
        clicks: 3,
        impressions: 32,
        conversions: 0,
        conversion_value: 0,
      },
    ],
    keywords: [
      {
        text: 'عقيقة مولود ذكر',
        match_type: 'BROAD',
        resource_name: 'customers/3571670180/adGroupCriteria/201~301',
        campaign_name: '2 ADA Search',
        campaign_resource_name: 'customers/3571670180/campaigns/101',
        ad_group_name: 'عقيقة',
        ad_group_resource_name: 'customers/3571670180/adGroups/201',
        cost: 480.542428,
        clicks: 169,
        impressions: 1270,
        conversions: 6,
        quality_score: 3,
        expected_ctr: 'BELOW_AVERAGE',
        ad_relevance: 'AVERAGE',
        landing_page_experience: 'BELOW_AVERAGE',
      },
    ],
    ads: [],
    conversion_tracking: { enabled_actions: 13 },
  });

  const result = runRuleBasedAudit({
    account,
    campaigns: [cachedCampaign({ name: '2 ADA Search', daily_budget: 170 })],
    conversionTracking: { enabled_actions: 13 },
    liveSnapshot: realAccountSnapshot,
  });
  const operations = new Set(result.findings.map((finding) => finding.action_payload.operation));

  assert.ok(result.estimated_monthly_waste_sar >= 170, `expected visible waste, got ${result.estimated_monthly_waste_sar}`);
  assert.ok(result.health_score < 80, `expected evidence-led risk score, got ${result.health_score}`);
  assert.ok(operations.has('review_wasted_search_term'));
  assert.ok(operations.has('review_low_quality_keyword'));
  assert.ok(operations.has('review_budget_limited_winner'));
});

test('live collector normalizes micros and isolates a failed diagnostic layer', async () => {
  const customer = {
    async query(query: string) {
      if (query.includes('FROM campaign') && query.includes('campaign_budget.amount_micros')) {
        return [{
          campaign: { id: '101', name: 'بحث', resourceName: 'customers/1/campaigns/101', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
          campaignBudget: { resourceName: 'customers/1/campaignBudgets/1', amountMicros: '75000000' },
          metrics: { costMicros: '12340000', clicks: '20', impressions: '500', conversions: '2', conversionsValue: '400', ctr: '0.04' },
        }];
      }
      if (query.includes('FROM keyword_view')) throw new Error('unsupported field');
      if (query.includes('FROM conversion_action')) return [{ conversionAction: { status: 'ENABLED' } }];
      return [];
    },
  };

  const result = await collectAuditLiveSnapshot(customer);
  assert.equal(result.campaigns[0].cost, 12.34);
  assert.equal(result.campaigns[0].daily_budget, 75);
  assert.equal(result.campaigns[0].conversion_value, 400);
  assert.equal(result.coverage.keywords, false);
  assert.equal(result.coverage.coverage_pct, 83);
  assert.equal(result.coverage.confidence, 'medium');
  assert.ok(result.coverage.failed_checks.includes('جودة الكلمات المفتاحية'));
});

test('AI audit narrative parser accepts bounded JSON and rejects malformed output', () => {
  const parsed = parseAuditNarrative(JSON.stringify({
    headline_ar: 'الميزانية لا تذهب إلى أفضل فرص الطلب',
    executive_summary_ar: 'هناك دليل مباشر من عبارات البحث وجودة الكلمات.',
    priorities_ar: ['راجع العبارة المهدرة', 'أصلح الكلمة منخفضة الجودة'],
    risks_ar: ['قيمة التحويل صفر'],
    growth_ar: ['وسّع العبارة التي حققت تحويلات'],
  }));
  assert.equal(parsed?.generated_by, 'model');
  assert.equal(parsed?.priorities_ar.length, 2);
  assert.equal(parseAuditNarrative('not-json'), null);
  assert.equal(parseAuditNarrative('{"headline_ar": 2}'), null);
});

test('search-term finding identity ignores changing metrics but keeps its real target', () => {
  const first = auditFindingTargetKey({
    search_term: '  عقيقة   بالرياض ',
    campaign_resource_name: 'customers/1/campaigns/2',
    ad_group_resource_name: 'customers/1/adGroups/3',
    cost_30d: 100,
    clicks_30d: 10,
  });
  const later = auditFindingTargetKey({
    search_term: 'عقيقة بالرياض',
    campaign_resource_name: 'customers/1/campaigns/2',
    ad_group_resource_name: 'customers/1/adGroups/3',
    cost_30d: 175,
    clicks_30d: 17,
  });

  assert.equal(first, later);
  assert.notEqual(first, auditFindingTargetKey({
    search_term: 'عقيقة بالرياض',
    campaign_resource_name: 'customers/1/campaigns/2',
    ad_group_resource_name: 'customers/1/adGroups/4',
  }));
});

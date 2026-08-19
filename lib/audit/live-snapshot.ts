import { moneyMetric } from '@/lib/google-ads/metrics';

type QueryCustomer = {
  query: (query: string) => Promise<any[]>;
};

export type AuditConfidence = 'high' | 'medium' | 'limited';

export type AuditLiveSnapshot = {
  campaigns: Array<{
    id: string;
    name: string;
    resource_name: string;
    budget_resource_name: string | null;
    status: string;
    type: string;
    daily_budget: number;
    cost: number;
    clicks: number;
    impressions: number;
    conversions: number;
    conversion_value: number;
    ctr: number;
  }>;
  search_share: Array<{
    campaign_id: string;
    campaign_name: string;
    impression_share: number | null;
    lost_budget_share: number | null;
    lost_rank_share: number | null;
  }>;
  search_terms: Array<{
    term: string;
    status: string;
    campaign_name: string;
    campaign_resource_name: string;
    ad_group_resource_name: string;
    cost: number;
    clicks: number;
    impressions: number;
    conversions: number;
    conversion_value: number;
  }>;
  keywords: Array<{
    text: string;
    match_type: string;
    resource_name: string;
    campaign_name: string;
    campaign_resource_name: string;
    ad_group_name: string;
    ad_group_resource_name: string;
    cost: number;
    clicks: number;
    impressions: number;
    conversions: number;
    quality_score: number | null;
    expected_ctr: string | null;
    ad_relevance: string | null;
    landing_page_experience: string | null;
  }>;
  ads: Array<{
    resource_name: string;
    campaign_name: string;
    ad_group_name: string;
    ad_strength: string | null;
    approval_status: string | null;
    cost: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
  }>;
  conversion_tracking: { enabled_actions: number } | null;
  coverage: {
    campaigns: boolean;
    search_share: boolean;
    search_terms: boolean;
    keywords: boolean;
    ads: boolean;
    conversion_tracking: boolean;
    coverage_pct: number;
    confidence: AuditConfidence;
    failed_checks: string[];
  };
};

type CheckName = Exclude<keyof AuditLiveSnapshot['coverage'], 'coverage_pct' | 'confidence' | 'failed_checks'>;

const CHECK_LABELS: Record<CheckName, string> = {
  campaigns: 'أداء الحملات الحي',
  search_share: 'حصة الظهور وفقد الميزانية والترتيب',
  search_terms: 'عبارات البحث الفعلية',
  keywords: 'جودة الكلمات المفتاحية',
  ads: 'قوة الإعلانات وحالة الموافقة',
  conversion_tracking: 'إجراءات التحويل',
};

/**
 * Read-only, bounded diagnostics for an audit. Every layer is independent so
 * an unsupported GAQL field cannot turn the entire audit into a false success.
 */
export async function collectAuditLiveSnapshot(customer: QueryCustomer): Promise<AuditLiveSnapshot> {
  const [campaigns, searchShare, searchTerms, keywords, ads, conversions] = await Promise.all([
    runCheck(customer, 'campaigns', `
      SELECT
        campaign.id, campaign.name, campaign.resource_name,
        campaign.status, campaign.advertising_channel_type,
        campaign_budget.resource_name, campaign_budget.amount_micros,
        metrics.cost_micros, metrics.clicks, metrics.impressions,
        metrics.conversions, metrics.conversions_value, metrics.ctr
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS
      ORDER BY metrics.cost_micros DESC
      LIMIT 250
    `),
    runCheck(customer, 'search_share', `
      SELECT
        campaign.id, campaign.name,
        metrics.search_impression_share,
        metrics.search_budget_lost_impression_share,
        metrics.search_rank_lost_impression_share
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS
        AND campaign.advertising_channel_type = 'SEARCH'
        AND campaign.status = 'ENABLED'
      ORDER BY metrics.search_impression_share ASC
      LIMIT 200
    `),
    runCheck(customer, 'search_terms', `
      SELECT
        search_term_view.search_term, search_term_view.status,
        campaign.name, campaign.resource_name,
        ad_group.resource_name,
        metrics.cost_micros, metrics.clicks, metrics.impressions,
        metrics.conversions, metrics.conversions_value
      FROM search_term_view
      WHERE segments.date DURING LAST_30_DAYS
        AND metrics.impressions > 0
      ORDER BY metrics.cost_micros DESC
      LIMIT 500
    `),
    runCheck(customer, 'keywords', `
      SELECT
        ad_group_criterion.resource_name,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        ad_group_criterion.quality_info.quality_score,
        ad_group_criterion.quality_info.creative_quality_score,
        ad_group_criterion.quality_info.post_click_quality_score,
        ad_group_criterion.quality_info.search_predicted_ctr,
        campaign.name, campaign.resource_name,
        ad_group.name, ad_group.resource_name,
        metrics.cost_micros, metrics.clicks, metrics.impressions,
        metrics.conversions
      FROM keyword_view
      WHERE segments.date DURING LAST_30_DAYS
        AND ad_group_criterion.status = 'ENABLED'
        AND metrics.impressions > 0
      ORDER BY metrics.cost_micros DESC
      LIMIT 500
    `),
    runCheck(customer, 'ads', `
      SELECT
        ad_group_ad.resource_name,
        ad_group_ad.ad_strength,
        ad_group_ad.policy_summary.approval_status,
        campaign.name, ad_group.name,
        metrics.cost_micros, metrics.impressions, metrics.clicks,
        metrics.conversions, metrics.ctr
      FROM ad_group_ad
      WHERE segments.date DURING LAST_30_DAYS
        AND ad_group_ad.status = 'ENABLED'
      ORDER BY metrics.impressions DESC
      LIMIT 300
    `),
    runCheck(customer, 'conversion_tracking', `
      SELECT conversion_action.resource_name, conversion_action.status
      FROM conversion_action
      WHERE conversion_action.status = 'ENABLED'
      LIMIT 100
    `),
  ]);

  const checks = { campaigns, search_share: searchShare, search_terms: searchTerms, keywords, ads, conversion_tracking: conversions };
  const passed = Object.values(checks).filter((check) => check.ok).length;
  const coveragePct = Math.round((passed / Object.keys(checks).length) * 100);
  const failedChecks = Object.entries(checks)
    .filter(([, check]) => !check.ok)
    .map(([name]) => CHECK_LABELS[name as CheckName]);

  return {
    campaigns: campaigns.ok ? campaigns.rows.map(normalizeCampaign) : [],
    search_share: searchShare.ok ? searchShare.rows.map(normalizeSearchShare) : [],
    search_terms: searchTerms.ok ? searchTerms.rows.map(normalizeSearchTerm) : [],
    keywords: keywords.ok ? keywords.rows.map(normalizeKeyword) : [],
    ads: ads.ok ? ads.rows.map(normalizeAd) : [],
    conversion_tracking: conversions.ok ? { enabled_actions: conversions.rows.length } : null,
    coverage: {
      campaigns: campaigns.ok,
      search_share: searchShare.ok,
      search_terms: searchTerms.ok,
      keywords: keywords.ok,
      ads: ads.ok,
      conversion_tracking: conversions.ok,
      coverage_pct: coveragePct,
      confidence: coveragePct >= 84 ? 'high' : coveragePct >= 50 ? 'medium' : 'limited',
      failed_checks: failedChecks,
    },
  };
}

async function runCheck(customer: QueryCustomer, name: CheckName, query: string) {
  try {
    return { ok: true as const, rows: await customer.query(query) };
  } catch (error) {
    console.warn(`Google Ads audit check failed: ${name}`, error);
    return { ok: false as const, rows: [] as any[] };
  }
}

function normalizeCampaign(row: any): AuditLiveSnapshot['campaigns'][number] {
  const campaign = objectAt(row, 'campaign');
  const budget = objectAt(row, 'campaignBudget', 'campaign_budget');
  const metrics = objectAt(row, 'metrics');
  return {
    id: textAt(campaign, 'id'),
    name: textAt(campaign, 'name'),
    resource_name: textAt(campaign, 'resourceName', 'resource_name'),
    budget_resource_name: nullableTextAt(budget, 'resourceName', 'resource_name'),
    status: textAt(campaign, 'status'),
    type: textAt(campaign, 'advertisingChannelType', 'advertising_channel_type'),
    daily_budget: microsAt(budget, 'amountMicros', 'amount_micros'),
    cost: googleCost(metrics),
    clicks: numberAt(metrics, 'clicks'),
    impressions: numberAt(metrics, 'impressions'),
    conversions: numberAt(metrics, 'conversions'),
    conversion_value: numberAt(metrics, 'conversionsValue', 'conversions_value'),
    ctr: numberAt(metrics, 'ctr'),
  };
}

function normalizeSearchShare(row: any): AuditLiveSnapshot['search_share'][number] {
  const campaign = objectAt(row, 'campaign');
  const metrics = objectAt(row, 'metrics');
  return {
    campaign_id: textAt(campaign, 'id'),
    campaign_name: textAt(campaign, 'name'),
    impression_share: nullableNumberAt(metrics, 'searchImpressionShare', 'search_impression_share'),
    lost_budget_share: nullableNumberAt(metrics, 'searchBudgetLostImpressionShare', 'search_budget_lost_impression_share'),
    lost_rank_share: nullableNumberAt(metrics, 'searchRankLostImpressionShare', 'search_rank_lost_impression_share'),
  };
}

function normalizeSearchTerm(row: any): AuditLiveSnapshot['search_terms'][number] {
  const view = objectAt(row, 'searchTermView', 'search_term_view');
  const campaign = objectAt(row, 'campaign');
  const adGroup = objectAt(row, 'adGroup', 'ad_group');
  const metrics = objectAt(row, 'metrics');
  return {
    term: textAt(view, 'searchTerm', 'search_term'),
    status: textAt(view, 'status'),
    campaign_name: textAt(campaign, 'name'),
    campaign_resource_name: textAt(campaign, 'resourceName', 'resource_name'),
    ad_group_resource_name: textAt(adGroup, 'resourceName', 'resource_name') || textAt(view, 'adGroup', 'ad_group'),
    cost: googleCost(metrics),
    clicks: numberAt(metrics, 'clicks'),
    impressions: numberAt(metrics, 'impressions'),
    conversions: numberAt(metrics, 'conversions'),
    conversion_value: numberAt(metrics, 'conversionsValue', 'conversions_value'),
  };
}

function normalizeKeyword(row: any): AuditLiveSnapshot['keywords'][number] {
  const criterion = objectAt(row, 'adGroupCriterion', 'ad_group_criterion');
  const keyword = objectAt(criterion, 'keyword');
  const quality = objectAt(criterion, 'qualityInfo', 'quality_info');
  const campaign = objectAt(row, 'campaign');
  const adGroup = objectAt(row, 'adGroup', 'ad_group');
  const metrics = objectAt(row, 'metrics');
  return {
    text: textAt(keyword, 'text'),
    match_type: textAt(keyword, 'matchType', 'match_type'),
    resource_name: textAt(criterion, 'resourceName', 'resource_name'),
    campaign_name: textAt(campaign, 'name'),
    campaign_resource_name: textAt(campaign, 'resourceName', 'resource_name'),
    ad_group_name: textAt(adGroup, 'name'),
    ad_group_resource_name: textAt(adGroup, 'resourceName', 'resource_name'),
    cost: googleCost(metrics),
    clicks: numberAt(metrics, 'clicks'),
    impressions: numberAt(metrics, 'impressions'),
    conversions: numberAt(metrics, 'conversions'),
    quality_score: nullableNumberAt(quality, 'qualityScore', 'quality_score'),
    expected_ctr: nullableTextAt(quality, 'searchPredictedCtr', 'search_predicted_ctr'),
    ad_relevance: nullableTextAt(quality, 'creativeQualityScore', 'creative_quality_score'),
    landing_page_experience: nullableTextAt(quality, 'postClickQualityScore', 'post_click_quality_score'),
  };
}

function normalizeAd(row: any): AuditLiveSnapshot['ads'][number] {
  const ad = objectAt(row, 'adGroupAd', 'ad_group_ad');
  const policy = objectAt(ad, 'policySummary', 'policy_summary');
  const campaign = objectAt(row, 'campaign');
  const adGroup = objectAt(row, 'adGroup', 'ad_group');
  const metrics = objectAt(row, 'metrics');
  return {
    resource_name: textAt(ad, 'resourceName', 'resource_name'),
    campaign_name: textAt(campaign, 'name'),
    ad_group_name: textAt(adGroup, 'name'),
    ad_strength: nullableTextAt(ad, 'adStrength', 'ad_strength'),
    approval_status: nullableTextAt(policy, 'approvalStatus', 'approval_status'),
    cost: googleCost(metrics),
    impressions: numberAt(metrics, 'impressions'),
    clicks: numberAt(metrics, 'clicks'),
    conversions: numberAt(metrics, 'conversions'),
    ctr: numberAt(metrics, 'ctr'),
  };
}

function objectAt(value: any, ...keys: string[]) {
  for (const key of keys) {
    if (value?.[key] && typeof value[key] === 'object') return value[key];
  }
  return {};
}

function rawAt(value: any, ...keys: string[]) {
  for (const key of keys) {
    if (value?.[key] !== undefined && value?.[key] !== null) return value[key];
  }
  return undefined;
}

function textAt(value: any, ...keys: string[]) {
  return String(rawAt(value, ...keys) ?? '');
}

function nullableTextAt(value: any, ...keys: string[]) {
  const result = rawAt(value, ...keys);
  return result === undefined || result === null || result === '' ? null : String(result);
}

function numberAt(value: any, ...keys: string[]) {
  const result = Number(rawAt(value, ...keys) ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function nullableNumberAt(value: any, ...keys: string[]) {
  const raw = rawAt(value, ...keys);
  if (raw === undefined || raw === null || raw === '') return null;
  const result = Number(raw);
  return Number.isFinite(result) ? result : null;
}

function microsAt(value: any, ...keys: string[]) {
  return numberAt(value, ...keys) / 1_000_000;
}

function googleCost(metrics: Record<string, unknown>) {
  const micros = rawAt(metrics, 'costMicros', 'cost_micros');
  if (micros !== undefined) return Number(micros) / 1_000_000;
  return moneyMetric(metrics, 'cost');
}

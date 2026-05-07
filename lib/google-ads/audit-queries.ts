import type { Customer } from 'google-ads-api';

/**
 * GAQL queries used by the Audit Agent to gather a complete snapshot
 * of an account before passing it to Claude for analysis.
 */

export interface AccountSnapshot {
  accountInfo: any;
  campaigns: any[];
  adGroups: any[];
  keywords: any[];
  underperformingKeywords: any[];
  searchTermsWithoutConversions: any[];
  ads: any[];
  lowQualityAds: any[];
  negativeKeywords: any[];
  campaignBudgets: any[];
  geoPerformance: any[];
  hourlyPerformance: any[];
}

const LAST_30_DAYS = 'DURING LAST_30_DAYS';

export async function gatherAccountSnapshot(customer: Customer): Promise<AccountSnapshot> {
  const [
    accountInfoRows,
    campaigns,
    adGroups,
    keywords,
    underperformingKeywords,
    searchTermsWithoutConversions,
    ads,
    lowQualityAds,
    negativeKeywords,
    campaignBudgets,
    geoPerformance,
    hourlyPerformance,
  ] = await Promise.all([
    customer.query(`
      SELECT
        customer.id,
        customer.descriptive_name,
        customer.currency_code,
        customer.time_zone,
        customer.auto_tagging_enabled,
        customer.tracking_url_template
      FROM customer
      LIMIT 1
    `),

    customer.query(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        campaign.bidding_strategy_type,
        campaign_budget.amount_micros,
        metrics.cost_micros,
        metrics.clicks,
        metrics.impressions,
        metrics.conversions,
        metrics.conversions_value,
        metrics.ctr,
        metrics.average_cpc
      FROM campaign
      WHERE segments.date ${LAST_30_DAYS}
        AND campaign.status != 'REMOVED'
    `),

    customer.query(`
      SELECT
        ad_group.id,
        ad_group.name,
        ad_group.status,
        ad_group.campaign,
        metrics.cost_micros,
        metrics.clicks,
        metrics.conversions,
        metrics.ctr
      FROM ad_group
      WHERE segments.date ${LAST_30_DAYS}
        AND ad_group.status != 'REMOVED'
    `),

    customer.query(`
      SELECT
        ad_group_criterion.criterion_id,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        ad_group_criterion.quality_info.quality_score,
        ad_group_criterion.status,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.ctr
      FROM keyword_view
      WHERE segments.date ${LAST_30_DAYS}
        AND ad_group_criterion.status != 'REMOVED'
    `),

    // Underperforming keywords - high cost, low CTR, no conversions
    customer.query(`
      SELECT
        ad_group_criterion.criterion_id,
        ad_group_criterion.keyword.text,
        metrics.cost_micros,
        metrics.clicks,
        metrics.conversions,
        metrics.ctr
      FROM keyword_view
      WHERE segments.date ${LAST_30_DAYS}
        AND metrics.clicks > 20
        AND metrics.conversions = 0
        AND metrics.ctr < 0.01
      ORDER BY metrics.cost_micros DESC
      LIMIT 50
    `),

    // Search terms triggering ads but never converting
    customer.query(`
      SELECT
        search_term_view.search_term,
        search_term_view.status,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions
      FROM search_term_view
      WHERE segments.date ${LAST_30_DAYS}
        AND metrics.clicks > 5
        AND metrics.conversions = 0
      ORDER BY metrics.cost_micros DESC
      LIMIT 100
    `),

    customer.query(`
      SELECT
        ad_group_ad.ad.id,
        ad_group_ad.ad.type,
        ad_group_ad.status,
        ad_group_ad.ad_strength,
        metrics.clicks,
        metrics.impressions,
        metrics.conversions,
        metrics.ctr
      FROM ad_group_ad
      WHERE segments.date ${LAST_30_DAYS}
        AND ad_group_ad.status != 'REMOVED'
    `),

    // Ads with low ad strength
    customer.query(`
      SELECT
        ad_group_ad.ad.id,
        ad_group_ad.ad_strength,
        ad_group_ad.ad.responsive_search_ad.headlines,
        ad_group_ad.ad.responsive_search_ad.descriptions
      FROM ad_group_ad
      WHERE ad_group_ad.ad_strength IN ('POOR', 'AVERAGE')
        AND ad_group_ad.status = 'ENABLED'
      LIMIT 50
    `),

    customer.query(`
      SELECT
        campaign_criterion.campaign,
        campaign_criterion.keyword.text,
        campaign_criterion.keyword.match_type,
        campaign_criterion.negative
      FROM campaign_criterion
      WHERE campaign_criterion.type = 'KEYWORD'
        AND campaign_criterion.negative = TRUE
    `),

    customer.query(`
      SELECT
        campaign_budget.id,
        campaign_budget.name,
        campaign_budget.amount_micros,
        campaign_budget.delivery_method,
        campaign_budget.has_recommended_budget
      FROM campaign_budget
    `),

    // Geographic performance
    customer.query(`
      SELECT
        geographic_view.country_criterion_id,
        segments.geo_target_region,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions
      FROM geographic_view
      WHERE segments.date ${LAST_30_DAYS}
      ORDER BY metrics.cost_micros DESC
      LIMIT 20
    `),

    // Hour-of-day performance
    customer.query(`
      SELECT
        segments.hour,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions
      FROM customer
      WHERE segments.date ${LAST_30_DAYS}
    `),
  ]);

  return {
    accountInfo: accountInfoRows[0]?.customer ?? {},
    campaigns,
    adGroups,
    keywords,
    underperformingKeywords,
    searchTermsWithoutConversions,
    ads,
    lowQualityAds,
    negativeKeywords,
    campaignBudgets,
    geoPerformance,
    hourlyPerformance,
  };
}

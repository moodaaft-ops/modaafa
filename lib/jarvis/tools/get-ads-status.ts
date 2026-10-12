import type { EvidenceRow, JarvisReadTool } from './types';
import {
  cleanText,
  currencyUnits,
  enumLabel,
  money,
  num,
  num0,
  okResult,
  parseArgs,
  pct1,
  pick,
  refCounter,
  round,
  runQuery,
  safeCurrency,
  str,
  tryQuery,
} from './shared';

const PERFORMANCE_LIMIT = 100;
const WEAK_MIN_IMPRESSIONS = 100;
const WEAK_TOP = 15;
const POLICY_TOP = 30;
const TOPICS_PER_AD = 5;

export const getAdsStatusTool: JarvisReadTool = {
  name: 'get_ads_status',
  description:
    'Returns the weakest running ads (poor or average ad strength with real impressions) and the ads that are disapproved or limited, with their policy topics. Use it when impressions drop suddenly or before suggesting new ad copy.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(input, ctx) {
    parseArgs(input, []);

    const [performanceRows, policyRows] = await Promise.all([
      runQuery(
        ctx,
        `
        SELECT campaign.name, ad_group.name, ad_group_ad.resource_name, ad_group_ad.ad.id,
          ad_group_ad.status, ad_group_ad.ad_strength,
          metrics.impressions, metrics.clicks, metrics.ctr, metrics.conversions, metrics.cost_micros
        FROM ad_group_ad
        WHERE segments.date DURING LAST_30_DAYS AND ad_group_ad.status != 'REMOVED'
        ORDER BY metrics.impressions DESC
        LIMIT ${PERFORMANCE_LIMIT}
      `
      ),
      // No date filter: a disapproved ad has no numbers, so a date filter would hide it.
      tryQuery(
        ctx,
        'ads_policy',
        `
        SELECT campaign.name, ad_group.name, ad_group_ad.resource_name, ad_group_ad.ad.id,
          ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status,
          ad_group_ad.policy_summary.policy_topic_entries
        FROM ad_group_ad
        WHERE ad_group_ad.status = 'ENABLED'
          AND ad_group_ad.policy_summary.approval_status != 'APPROVED'
      `
      ),
    ]);

    const ads = performanceRows.map((row) => ({
      resource: str(row, 'ad_group_ad.resource_name'),
      adId: str(row, 'ad_group_ad.ad.id'),
      campaign: cleanText(str(row, 'campaign.name')),
      adGroup: cleanText(str(row, 'ad_group.name')),
      status: enumLabel(str(row, 'ad_group_ad.status'), 'UNKNOWN'),
      strength: enumLabel(str(row, 'ad_group_ad.ad_strength'), 'UNKNOWN'),
      impressions: num0(row, 'metrics.impressions'),
      clicks: num0(row, 'metrics.clicks'),
      ctr: num(row, 'metrics.ctr'),
      conversions: num0(row, 'metrics.conversions'),
      cost: currencyUnits(row, 'metrics.cost_micros'),
    }));

    const strengthCounts: Record<string, number> = {};
    for (const ad of ads.filter((entry) => entry.status === 'ENABLED')) {
      strengthCounts[ad.strength] = (strengthCounts[ad.strength] ?? 0) + 1;
    }

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];

    const weakest = ads
      .filter(
        (ad) =>
          ad.status === 'ENABLED' &&
          (ad.strength === 'POOR' || ad.strength === 'AVERAGE') &&
          ad.impressions >= WEAK_MIN_IMPRESSIONS
      )
      .sort((a, b) => Number(b.strength === 'POOR') - Number(a.strength === 'POOR') || b.cost - a.cost)
      .slice(0, WEAK_TOP)
      .map((ad) => {
        const ref = nextRef('ad');
        evidence.push({
          ref,
          kind: 'ad',
          data: {
            role: 'weak',
            status: ad.status,
            ad_group_ad_resource_name: ad.resource,
            ad_id: ad.adId,
            campaign_name: ad.campaign,
            ad_group_name: ad.adGroup,
            ad_strength: ad.strength,
            impressions: ad.impressions,
            clicks: ad.clicks,
            cost: money(ad.cost),
            conversions: round(ad.conversions, 2),
          },
        });
        return {
          ref,
          campaign: ad.campaign,
          ad_group: ad.adGroup,
          ad_strength: ad.strength,
          impressions: ad.impressions,
          clicks: ad.clicks,
          ctr: pct1(ad.ctr),
          cost: money(ad.cost),
          conversions: round(ad.conversions, 2),
        };
      });

    const flagged = (policyRows ?? []).slice(0, POLICY_TOP).map((row) => {
      const entries = pick(row, 'ad_group_ad.policy_summary.policy_topic_entries');
      const topics = (Array.isArray(entries) ? entries : []).slice(0, TOPICS_PER_AD).map((entry) => ({
        topic: cleanText(str(entry, 'topic')),
        type: enumLabel(str(entry, 'type'), 'UNKNOWN'),
      }));
      const ref = nextRef('ad');
      const campaign = cleanText(str(row, 'campaign.name'));
      const adGroup = cleanText(str(row, 'ad_group.name'));
      const approval = enumLabel(str(row, 'ad_group_ad.policy_summary.approval_status'), 'UNKNOWN');
      const review = enumLabel(str(row, 'ad_group_ad.policy_summary.review_status'), 'UNKNOWN');
      evidence.push({
        ref,
        kind: 'ad',
        data: {
          role: 'policy',
          // The policy query only reads ENABLED ads.
          status: 'ENABLED',
          ad_group_ad_resource_name: str(row, 'ad_group_ad.resource_name'),
          ad_id: str(row, 'ad_group_ad.ad.id'),
          campaign_name: campaign,
          ad_group_name: adGroup,
          approval_status: approval,
          review_status: review,
          policy_topics: topics,
        },
      });
      return { ref, campaign, ad_group: adGroup, approval_status: approval, review_status: review, policy_topics: topics };
    });

    return okResult(
      {
        period: 'LAST_30_DAYS',
        currency: safeCurrency(ctx),
        ads_scanned: ads.length,
        truncated: performanceRows.length >= PERFORMANCE_LIMIT,
        enabled_ad_strength: strengthCounts,
        weakest_ads: weakest,
        policy_check_available: policyRows !== null,
        policy_issues_total: policyRows ? policyRows.length : null,
        disapproved_or_limited: flagged,
      },
      evidence
    );
  },
};

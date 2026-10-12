import type { EvidenceRow, JarvisReadTool } from './types';
import {
  cleanText,
  currencyUnits,
  enumLabel,
  money,
  moneyOrNull,
  num,
  num0,
  okResult,
  optDigits,
  parseArgs,
  pct1,
  ratio,
  refCounter,
  round,
  runQuery,
  safeCurrency,
  str,
} from './shared';

const ROW_LIMIT = 200;
const TOP_BY_COST = 30;
const NO_CONVERSION_MIN_CLICKS = 3;
const LOW_QUALITY_MAX = 4;

export const getKeywordsTool: JarvisReadTool = {
  name: 'get_keywords',
  description:
    'Returns the highest spending keywords of the last 30 days with match type, quality score, clicks and conversions, flagging keywords that spent without converting and keywords with a low quality score. Use it to find keywords worth pausing or fixing.',
  input_schema: {
    type: 'object',
    properties: {
      campaign_id: {
        type: 'string',
        pattern: '^[0-9]{1,20}$',
        description: 'Optional campaign id (digits) taken from get_campaigns.',
      },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const args = parseArgs(input, ['campaign_id']);
    const campaignId = optDigits(args, 'campaign_id');
    const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : '';

    const rawRows = await runQuery(
      ctx,
      `
      SELECT campaign.id, campaign.name, campaign.resource_name,
        ad_group.name, ad_group.resource_name,
        ad_group_criterion.resource_name, ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type, ad_group_criterion.status,
        ad_group_criterion.quality_info.quality_score,
        metrics.impressions, metrics.clicks, metrics.ctr,
        metrics.cost_micros, metrics.conversions
      FROM keyword_view
      WHERE segments.date DURING LAST_30_DAYS AND ad_group_criterion.status != 'REMOVED'
        ${campaignFilter}
      ORDER BY metrics.cost_micros DESC
      LIMIT ${ROW_LIMIT}
    `
    );

    const keywords = rawRows
      .map((row) => {
        const quality = num(row, 'ad_group_criterion.quality_info.quality_score');
        const cost = currencyUnits(row, 'metrics.cost_micros');
        const clicks = num0(row, 'metrics.clicks');
        const conversions = num0(row, 'metrics.conversions');
        return {
          text: cleanText(str(row, 'ad_group_criterion.keyword.text')),
          matchType: enumLabel(str(row, 'ad_group_criterion.keyword.match_type'), 'UNKNOWN'),
          status: enumLabel(str(row, 'ad_group_criterion.status'), 'UNKNOWN'),
          criterionResource: str(row, 'ad_group_criterion.resource_name'),
          adGroupName: cleanText(str(row, 'ad_group.name')),
          adGroupResource: str(row, 'ad_group.resource_name'),
          campaignName: cleanText(str(row, 'campaign.name')),
          campaignResource: str(row, 'campaign.resource_name'),
          impressions: num0(row, 'metrics.impressions'),
          clicks,
          ctr: num(row, 'metrics.ctr'),
          cost,
          conversions,
          qualityScore: quality !== null && quality > 0 ? quality : null,
          spendNoConversions: cost > 0 && conversions <= 0 && clicks >= NO_CONVERSION_MIN_CLICKS,
          lowQuality: quality !== null && quality > 0 && quality <= LOW_QUALITY_MAX,
        };
      })
      .filter((keyword) => keyword.text.length > 0);

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];

    const top = [...keywords]
      .sort((a, b) => b.cost - a.cost)
      .slice(0, TOP_BY_COST)
      .map((keyword) => {
        const ref = nextRef('kw');
        evidence.push({
          ref,
          kind: 'keyword',
          data: {
            text: keyword.text,
            match_type: keyword.matchType,
            status: keyword.status,
            criterion_resource_name: keyword.criterionResource,
            ad_group_resource_name: keyword.adGroupResource,
            ad_group_name: keyword.adGroupName,
            campaign_resource_name: keyword.campaignResource,
            campaign_name: keyword.campaignName,
            clicks: keyword.clicks,
            cost: money(keyword.cost),
            conversions: round(keyword.conversions, 2),
            quality_score: keyword.qualityScore,
          },
        });
        const flags: string[] = [];
        if (keyword.spendNoConversions) flags.push('spend_no_conversions');
        if (keyword.lowQuality) flags.push('low_quality');
        const compact: Record<string, unknown> = {
          ref,
          text: keyword.text,
          match_type: keyword.matchType,
          status: keyword.status,
          campaign: keyword.campaignName,
          ad_group: keyword.adGroupName,
          impressions: keyword.impressions,
          clicks: keyword.clicks,
          ctr: pct1(keyword.ctr),
          cost: money(keyword.cost),
          conversions: round(keyword.conversions, 2),
          cpa: moneyOrNull(ratio(keyword.cost, keyword.conversions)),
          quality_score: keyword.qualityScore,
        };
        if (flags.length > 0) compact.flags = flags;
        return compact;
      });

    const noConversion = keywords.filter((keyword) => keyword.spendNoConversions);
    return okResult(
      {
        period: 'LAST_30_DAYS',
        currency: safeCurrency(ctx),
        campaign_filtered: Boolean(campaignId),
        keywords_scanned: keywords.length,
        truncated: rawRows.length >= ROW_LIMIT,
        scanned_flags: {
          spend_no_conversions: {
            keywords: noConversion.length,
            cost: money(noConversion.reduce((sum, keyword) => sum + keyword.cost, 0)),
          },
          low_quality: { keywords: keywords.filter((keyword) => keyword.lowQuality).length },
        },
        keywords: top,
      },
      evidence
    );
  },
};

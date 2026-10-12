import type { EvidenceRow, JarvisReadTool } from './types';
import {
  cleanText,
  money,
  num0,
  okResult,
  parseArgs,
  refCounter,
  reqDigits,
  round,
  runQuery,
  safeCurrency,
  str,
} from './shared';

const TOP = 25;

export const getPmaxCategoriesTool: JarvisReadTool = {
  name: 'get_pmax_categories',
  description:
    'Returns the search term categories Google reports for one Performance Max campaign over the last 30 days, with impressions, clicks and conversions. Use it to see what kind of searches a Performance Max campaign is really capturing; it needs the campaign id from get_campaigns.',
  input_schema: {
    type: 'object',
    properties: {
      campaign_id: {
        type: 'string',
        pattern: '^[0-9]{1,20}$',
        description: 'Performance Max campaign id (digits) taken from get_campaigns.',
      },
    },
    required: ['campaign_id'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const args = parseArgs(input, ['campaign_id']);
    const campaignId = reqDigits(args, 'campaign_id');

    const rows = await runQuery(
      ctx,
      `
      SELECT campaign_search_term_insight.category_label,
        metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM campaign_search_term_insight
      WHERE segments.date DURING LAST_30_DAYS
        AND campaign_search_term_insight.campaign_id = '${campaignId}'
    `
    );

    const categories = rows
      .map((row) => ({
        label: cleanText(str(row, 'campaign_search_term_insight.category_label')),
        impressions: num0(row, 'metrics.impressions'),
        clicks: num0(row, 'metrics.clicks'),
        conversions: num0(row, 'metrics.conversions'),
        value: num0(row, 'metrics.conversions_value'),
      }))
      .sort((a, b) => b.conversions - a.conversions || b.clicks - a.clicks || b.impressions - a.impressions);

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];
    const top = categories.slice(0, TOP).map((category) => {
      const ref = nextRef('pmx');
      const compact = {
        category: category.label || '(uncategorized)',
        impressions: category.impressions,
        clicks: category.clicks,
        conversions: round(category.conversions, 2),
        conv_value: money(category.value),
      };
      evidence.push({ ref, kind: 'pmax_category', data: { campaign_id: campaignId, ...compact } });
      return { ref, ...compact };
    });

    return okResult(
      {
        period: 'LAST_30_DAYS',
        currency: safeCurrency(ctx),
        categories_total: categories.length,
        categories: top,
        ...(categories.length === 0
          ? { note: 'No categories returned. The campaign may not be Performance Max or may have too little data.' }
          : {}),
      },
      evidence
    );
  },
};

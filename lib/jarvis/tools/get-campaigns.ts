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
  optBool,
  optEnum,
  parseArgs,
  pct1,
  ratio,
  refCounter,
  round,
  runQuery,
  safeCurrency,
  str,
} from './shared';

export const CAMPAIGN_PERIODS = ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS'] as const;

/** Lost impression share to budget above this marks a campaign as budget limited. */
const BUDGET_LIMITED_THRESHOLD = 0.2;
const CAMPAIGN_LIMIT = 100;

export const getCampaignsTool: JarvisReadTool = {
  name: 'get_campaigns',
  description:
    'Lists the campaigns of the connected account with status, type, bidding, daily budget, spend, clicks, conversions, CPA, ROAS and search impression share (plus the share lost to budget and to rank). Use it first to get the account picture, to find budget limited campaigns, or to get the campaign id other tools ask for.',
  input_schema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: [...CAMPAIGN_PERIODS],
        description: 'Reporting window. Default LAST_7_DAYS.',
      },
      include_paused: {
        type: 'boolean',
        description: 'Also return paused campaigns. Default false (enabled campaigns only).',
      },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const args = parseArgs(input, ['period', 'include_paused']);
    const period = optEnum(args, 'period', CAMPAIGN_PERIODS, 'LAST_7_DAYS');
    const includePaused = optBool(args, 'include_paused', false);
    const statusFilter = includePaused ? "campaign.status != 'REMOVED'" : "campaign.status = 'ENABLED'";

    const rows = await runQuery(
      ctx,
      `
      SELECT campaign.id, campaign.name, campaign.status, campaign.resource_name,
        campaign.advertising_channel_type, campaign.bidding_strategy_type,
        campaign_budget.amount_micros, campaign_budget.resource_name,
        metrics.cost_micros, metrics.impressions, metrics.clicks,
        metrics.conversions, metrics.conversions_value,
        metrics.search_impression_share, metrics.search_budget_lost_impression_share,
        metrics.search_rank_lost_impression_share
      FROM campaign
      WHERE segments.date DURING ${period} AND ${statusFilter}
      ORDER BY metrics.cost_micros DESC
      LIMIT ${CAMPAIGN_LIMIT}
    `
    );

    const parsed = rows
      .map((row) => {
        const budgetMicros = num(row, 'campaign_budget.amount_micros');
        return {
          id: str(row, 'campaign.id'),
          name: cleanText(str(row, 'campaign.name')),
          resourceName: str(row, 'campaign.resource_name'),
          status: enumLabel(str(row, 'campaign.status')),
          type: enumLabel(str(row, 'campaign.advertising_channel_type')),
          bidding: enumLabel(str(row, 'campaign.bidding_strategy_type')),
          budgetResourceName: str(row, 'campaign_budget.resource_name') || null,
          budgetMicros,
          spend: currencyUnits(row, 'metrics.cost_micros'),
          clicks: num0(row, 'metrics.clicks'),
          impressions: num0(row, 'metrics.impressions'),
          conversions: num0(row, 'metrics.conversions'),
          value: num0(row, 'metrics.conversions_value'),
          share: num(row, 'metrics.search_impression_share'),
          lostBudget: num(row, 'metrics.search_budget_lost_impression_share'),
          lostRank: num(row, 'metrics.search_rank_lost_impression_share'),
        };
      })
      .sort((a, b) => b.spend - a.spend);

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];
    const totals = { spend: 0, clicks: 0, impressions: 0, conversions: 0, value: 0 };

    const campaigns = parsed.map((c) => {
      const ref = nextRef('cmp');
      totals.spend += c.spend;
      totals.clicks += c.clicks;
      totals.impressions += c.impressions;
      totals.conversions += c.conversions;
      totals.value += c.value;

      evidence.push({
        ref,
        kind: 'campaign',
        data: {
          id: c.id,
          name: c.name,
          resource_name: c.resourceName,
          status: c.status,
          type: c.type,
          bidding: c.bidding,
          budget_resource_name: c.budgetResourceName,
          budget_micros: c.budgetMicros,
        },
      });

      const compact: Record<string, unknown> = {
        ref,
        // The campaign id is how the model passes a campaign to other tools. It is not a resource name.
        id: c.id,
        name: c.name,
        status: c.status,
        type: c.type,
        bidding: c.bidding,
        budget_per_day: c.budgetMicros === null ? null : money(c.budgetMicros / 1_000_000),
        spend: money(c.spend),
        clicks: c.clicks,
        impressions: c.impressions,
        conversions: round(c.conversions, 2),
        conv_value: money(c.value),
        cpa: moneyOrNull(ratio(c.spend, c.conversions)),
        roas: moneyOrNull(ratio(c.value, c.spend)),
        impression_share: pct1(c.share),
        lost_to_budget: pct1(c.lostBudget),
        lost_to_rank: pct1(c.lostRank),
      };
      if (c.lostBudget !== null && c.lostBudget > BUDGET_LIMITED_THRESHOLD) compact.budget_limited = true;
      return compact;
    });

    return okResult(
      {
        period,
        currency: safeCurrency(ctx),
        include_paused: includePaused,
        count: campaigns.length,
        truncated: rows.length >= CAMPAIGN_LIMIT,
        totals: {
          spend: money(totals.spend),
          clicks: totals.clicks,
          impressions: totals.impressions,
          conversions: round(totals.conversions, 2),
          conv_value: money(totals.value),
          cpa: moneyOrNull(ratio(totals.spend, totals.conversions)),
          roas: moneyOrNull(ratio(totals.value, totals.spend)),
        },
        campaigns,
      },
      evidence
    );
  },
};

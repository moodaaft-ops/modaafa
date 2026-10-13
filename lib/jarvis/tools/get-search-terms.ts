import type { EvidenceRow, JarvisReadTool } from './types';
import {
  cleanText,
  currencyUnits,
  enumLabel,
  money,
  moneyOrNull,
  num0,
  okResult,
  optDigits,
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
import { buildNegativeWordCandidates, termIdentity } from './negative-words';

export const SEARCH_TERM_PERIODS = ['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS'] as const;
export const SEARCH_TERM_VIEWS = ['waste', 'winners', 'all'] as const;

const ROW_LIMIT = 1000;
const WASTE_MIN_CLICKS = 3;
const WASTE_TOP = 25;
const WINNER_MIN_CONVERSIONS = 2;
const WINNER_TOP = 15;
/** Statuses where the term is already a keyword or already blocked. */
const ALREADY_HANDLED = new Set(['ADDED', 'ADDED_EXCLUDED', 'EXCLUDED']);
const ALREADY_EXCLUDED = new Set(['EXCLUDED', 'ADDED_EXCLUDED']);

type TermRow = {
  term: string;
  termRaw: string;
  status: string;
  matchType: string;
  campaignId: string;
  campaignName: string;
  campaignResource: string;
  adGroupName: string;
  adGroupResource: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  value: number;
};

function periodDays(period: string) {
  const match = /LAST_(\d+)_DAYS/.exec(period);
  return match ? Number(match[1]) : 30;
}

export const getSearchTermsTool: JarvisReadTool = {
  name: 'get_search_terms',
  description:
    'Reads the search terms that triggered the ads and returns wasted terms (clicks but no conversions), winning terms not yet added as keywords, and negative word candidates (words repeated across wasted terms and never seen in a converting term). Use it to find wasted spend and to decide which negative keywords to prepare.',
  input_schema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: [...SEARCH_TERM_PERIODS],
        description: 'Reporting window. Default LAST_30_DAYS.',
      },
      campaign_id: {
        type: 'string',
        pattern: '^[0-9]{1,20}$',
        description: 'Optional campaign id (digits) taken from get_campaigns.',
      },
      view: {
        type: 'string',
        enum: [...SEARCH_TERM_VIEWS],
        description: 'waste, winners or all. Default all.',
      },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const args = parseArgs(input, ['period', 'campaign_id', 'view']);
    const period = optEnum(args, 'period', SEARCH_TERM_PERIODS, 'LAST_30_DAYS');
    const campaignId = optDigits(args, 'campaign_id');
    const view = optEnum(args, 'view', SEARCH_TERM_VIEWS, 'all');
    const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : '';

    const rawRows = await runQuery(
      ctx,
      `
      SELECT search_term_view.search_term, search_term_view.status,
        segments.search_term_match_type,
        campaign.id, campaign.name, campaign.resource_name,
        ad_group.name, ad_group.resource_name,
        metrics.impressions, metrics.clicks, metrics.cost_micros,
        metrics.conversions, metrics.conversions_value
      FROM search_term_view
      WHERE segments.date DURING ${period} AND metrics.cost_micros > 0
        ${campaignFilter}
      ORDER BY metrics.cost_micros DESC
      LIMIT ${ROW_LIMIT}
    `
    );

    const rows: TermRow[] = rawRows
      .map((row) => ({
        term: cleanText(str(row, 'search_term_view.search_term')),
        // Untouched text for the server only (negative payloads); never sent to the model.
        termRaw: str(row, 'search_term_view.search_term').trim(),
        status: enumLabel(str(row, 'search_term_view.status'), 'NONE'),
        matchType: enumLabel(str(row, 'segments.search_term_match_type'), 'UNKNOWN'),
        campaignId: str(row, 'campaign.id'),
        campaignName: cleanText(str(row, 'campaign.name')),
        campaignResource: str(row, 'campaign.resource_name'),
        adGroupName: cleanText(str(row, 'ad_group.name')),
        adGroupResource: str(row, 'ad_group.resource_name'),
        impressions: num0(row, 'metrics.impressions'),
        clicks: num0(row, 'metrics.clicks'),
        cost: currencyUnits(row, 'metrics.cost_micros'),
        conversions: num0(row, 'metrics.conversions'),
        value: num0(row, 'metrics.conversions_value'),
      }))
      .filter((row) => row.term.length > 0);

    const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
    // A term that converted anywhere in the result is never waste, even in an ad group where it did not.
    const convertingRows = rows.filter((row) => row.conversions > 0);
    const convertingIdentities = new Set(convertingRows.map((row) => termIdentity(row.term)));

    const wasteAll = rows.filter(
      (row) =>
        row.conversions <= 0 &&
        row.clicks >= WASTE_MIN_CLICKS &&
        !ALREADY_EXCLUDED.has(row.status) &&
        !convertingIdentities.has(termIdentity(row.term))
    );
    const wasteTop = [...wasteAll].sort((a, b) => b.cost - a.cost).slice(0, WASTE_TOP);
    const winnersTop = rows
      .filter((row) => row.conversions >= WINNER_MIN_CONVERSIONS && !ALREADY_HANDLED.has(row.status))
      .sort((a, b) => b.conversions - a.conversions || a.cost - b.cost)
      .slice(0, WINNER_TOP);

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];

    const termRef = (row: TermRow, role: 'waste' | 'winner') => {
      const ref = nextRef('st');
      evidence.push({
        ref,
        kind: 'search_term',
        data: {
          role,
          term: row.term,
          term_raw: row.termRaw,
          period_days: periodDays(period),
          status: row.status,
          match_type: row.matchType,
          campaign_id: row.campaignId,
          campaign_name: row.campaignName,
          campaign_resource_name: row.campaignResource,
          ad_group_name: row.adGroupName,
          ad_group_resource_name: row.adGroupResource,
          impressions: row.impressions,
          clicks: row.clicks,
          cost: money(row.cost),
          conversions: round(row.conversions, 2),
          conv_value: money(row.value),
        },
      });
      return ref;
    };

    const compactTerm = (row: TermRow, ref: string, withValue: boolean) => {
      const compact: Record<string, unknown> = {
        ref,
        term: row.term,
        campaign: row.campaignName,
        ad_group: row.adGroupName,
        match_type: row.matchType,
        status: row.status,
        impressions: row.impressions,
        clicks: row.clicks,
        cost: money(row.cost),
        conversions: round(row.conversions, 2),
      };
      if (withValue) {
        compact.conv_value = money(row.value);
        compact.cpa = moneyOrNull(ratio(row.cost, row.conversions));
      }
      return compact;
    };

    const summary: Record<string, unknown> = {
      period,
      currency: safeCurrency(ctx),
      view,
      campaign_filtered: Boolean(campaignId),
      rows_scanned: rows.length,
      truncated: rawRows.length >= ROW_LIMIT,
      spend_scanned: money(totalCost),
    };

    if (view === 'waste' || view === 'all') {
      const wasteCost = wasteAll.reduce((sum, row) => sum + row.cost, 0);
      summary.waste = {
        terms_total: wasteAll.length,
        cost_total: money(wasteCost),
        clicks_total: wasteAll.reduce((sum, row) => sum + row.clicks, 0),
        share_of_spend_pct: pct1(ratio(wasteCost, totalCost)),
        top: wasteTop.map((row) => compactTerm(row, termRef(row, 'waste'), false)),
      };

      const candidates = buildNegativeWordCandidates({
        wasted: wasteAll.map((row) => ({
          term: row.term,
          cost: row.cost,
          clicks: row.clicks,
          campaignResource: row.campaignResource,
          campaignId: row.campaignId,
          campaignName: row.campaignName,
        })),
        convertingTerms: convertingRows.map((row) => row.term),
        protectedTexts: [ctx.business?.name, ctx.business?.sector, ...(ctx.business?.keywords ?? [])],
      });

      summary.negative_word_candidates = candidates.map((candidate) => {
        const ref = nextRef('nw');
        evidence.push({
          ref,
          kind: 'negative_word',
          data: {
            period_days: periodDays(period),
            word: candidate.word,
            key: candidate.key,
            cost: money(candidate.cost),
            clicks: candidate.clicks,
            term_count: candidate.termCount,
            campaigns: candidate.campaigns.map((campaign) => ({
              campaign_resource_name: campaign.resource,
              campaign_id: campaign.id,
              campaign_name: campaign.name,
              cost: money(campaign.cost),
            })),
            sample_terms: candidate.sampleTerms,
          },
        });
        return {
          ref,
          word: candidate.word,
          wasted_cost: money(candidate.cost),
          clicks: candidate.clicks,
          terms: candidate.termCount,
          campaigns: candidate.campaigns.length,
          sample_terms: candidate.sampleTerms,
        };
      });
    }

    if (view === 'winners' || view === 'all') {
      summary.winners = winnersTop.map((row) => compactTerm(row, termRef(row, 'winner'), true));
    }

    return okResult(summary, evidence);
  },
};

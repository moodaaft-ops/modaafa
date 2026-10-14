import { allowableCpaCut, allowableCpaScale } from '../economics/break-even';
import type { OptimizerAction, OptimizerSnapshot } from './optimizer-agent';
import { negativeWouldBlock, normalizeKeywordText } from './execution-preflight';
import {
  TRACKING_HEALTHY,
  accountCpa30dFromSnapshot,
  numOrNull,
  pick,
  strOrEmpty,
  type GateVerdict,
} from './optimizer-gates';

/**
 * Code checks for the proposals the system prompt only described.
 *
 * The prompt tells the model "pause a keyword only at 2 x the allowable CPA and
 * 20 clicks", "negate only wasted terms", "pause an ad only against its
 * siblings". A prompt is a request, not a guarantee: the model may misread a
 * row, copy a number from the wrong one or simply ignore the rule. This file
 * re-derives every one of those conditions from the SNAPSHOT ROW the proposal
 * names (matched by resource name or by the normalized term, never by a number
 * the model wrote), so a proposal the evidence does not support never reaches
 * the owner's table.
 *
 * Queue time only (it needs the snapshot). Pure: no database, no clock.
 *
 * Units. Snapshot rows carry `cost_micros` (millionths of the account
 * currency); the allowable CPAs are whole currency units. Every comparison here
 * converts the row to whole units first.
 *
 * Thresholds: titan keywords-search-terms.md 7.1 (a term with one target CPA of
 * spend and no conversion is under review, two target CPAs is a negative) and
 * the prompt's pause rules. Waste is judged against the CUT end of the client's
 * range (the optimistic one), a promotion against the SCALE end.
 */

// ---------------------------------------------------------------------------
// Constants (the system prompt states the same numbers; a test keeps them equal)
// ---------------------------------------------------------------------------

/** pause_keyword: at least this many clicks in 30 days, no conversion, and cost this many allowable CPAs. */
export const PAUSE_KEYWORD_MIN_CLICKS = 20;
export const PAUSE_KEYWORD_COST_IN_CPAS = 2;

/** pause_ad: enough impressions to judge, a CTR below this share of the ad group's, and siblings to keep serving. */
export const PAUSE_AD_MIN_IMPRESSIONS = 1000;
export const PAUSE_AD_MAX_CTR_SHARE = 0.5;
export const PAUSE_AD_MIN_OTHER_ENABLED_ADS = 2;
export const PAUSE_AD_CPA_IN_GROUP_CPAS = 2;

/**
 * add_negative_keyword: a wasted term costs this many allowable CPAs, or is clearly irrelevant on this many clicks.
 * With the client's own break-even the limit is a real one and 1 x is enough. With no economics the limit is the
 * account's own 30-day CPA, a much weaker yardstick (it says what happened, not what is acceptable): there the
 * knowledge base's rule applies, 1 x is a term to review and 2 x is a term to negate.
 */
export const NEGATIVE_COST_IN_CPAS = 1;
export const NEGATIVE_COST_IN_CPAS_FALLBACK = 2;
export const NEGATIVE_IRRELEVANT_MIN_CLICKS = 5;

export type ProposalContext = {
  snapshot: Pick<
    OptimizerSnapshot,
    | 'campaigns'
    | 'conversion_tracking'
    | 'economics'
    | 'underperforming_keywords'
    | 'high_performing_keywords'
    | 'wasted_search_terms'
    | 'converting_search_terms'
    | 'poor_ads'
  >;
};

const ok: GateVerdict = { ok: true };
const no = (code: string): GateVerdict => ({ ok: false, code });

// ---------------------------------------------------------------------------
// Reading the rows
// ---------------------------------------------------------------------------

type RowMetrics = { clicks: number; impressions: number; costMicros: number; conversions: number; ctr: number | null };

function metricsOf(row: unknown): RowMetrics {
  const num = (path: string) => numOrNull(pick(row, path));
  return {
    clicks: num('metrics.clicks') ?? 0,
    impressions: num('metrics.impressions') ?? 0,
    costMicros: num('metrics.cost_micros') ?? 0,
    conversions: num('metrics.conversions') ?? 0,
    ctr: num('metrics.ctr'),
  };
}

const toUnits = (micros: number) => micros / 1_000_000;

function rows(list: unknown): unknown[] {
  return Array.isArray(list) ? list : [];
}

function termOf(row: unknown): string {
  return normalizeKeywordText(strOrEmpty(pick(row, 'search_term_view.search_term')));
}

/** `search_term_view.status`: ADDED, EXCLUDED and ADDED_EXCLUDED all mean the term is already handled. */
function termIsAlreadyHandled(row: unknown): boolean {
  const status = pick(row, 'search_term_view.status');
  if (typeof status === 'number') return status === 2 || status === 3 || status === 4;
  return ['ADDED', 'EXCLUDED', 'ADDED_EXCLUDED'].includes(strOrEmpty(status).toUpperCase());
}

/** Keyword texts of the enabled keywords the snapshot lists (a sample, not the whole account), normalized. */
function knownKeywordTexts(snapshot: ProposalContext['snapshot']): string[] {
  const out = new Set<string>();
  for (const list of [snapshot.high_performing_keywords, snapshot.underperforming_keywords]) {
    for (const row of rows(list)) {
      const text = normalizeKeywordText(strOrEmpty(pick(row, 'ad_group_criterion.keyword.text')));
      if (text) out.add(text);
    }
  }
  return [...out];
}

function cutLimit(snapshot: ProposalContext['snapshot']) {
  return allowableCpaCut(snapshot.economics ?? null, accountCpa30dFromSnapshot(snapshot));
}

// ---------------------------------------------------------------------------
// pause_keyword
// ---------------------------------------------------------------------------

/**
 * The keyword must be a row of `underperforming_keywords` (30 days, enabled),
 * with 0 conversions, at least 20 clicks and a cost of at least 2 allowable
 * CPAs (the CUT end; the account's own 30-day CPA when the client's economics
 * are unknown, and with neither there is no yardstick and no pause).
 */
export function evaluatePauseKeyword(action: OptimizerAction, context: ProposalContext): GateVerdict {
  const target = String(action.target_id ?? '').trim();
  const row = rows(context.snapshot.underperforming_keywords).find(
    (candidate) => strOrEmpty(pick(candidate, 'ad_group_criterion.resource_name')) === target
  );
  if (!target || !row) return no('pause_keyword_not_in_snapshot');

  const metrics = metricsOf(row);
  if (metrics.conversions > 0) return no('pause_keyword_has_conversions');
  if (metrics.clicks < PAUSE_KEYWORD_MIN_CLICKS) return no('pause_keyword_few_clicks');

  const limit = cutLimit(context.snapshot);
  if (!limit) return no('pause_keyword_no_cost_reference');
  if (toUnits(metrics.costMicros) < PAUSE_KEYWORD_COST_IN_CPAS * limit.value) return no('pause_keyword_cost_below_floor');
  return ok;
}

// ---------------------------------------------------------------------------
// pause_ad
// ---------------------------------------------------------------------------

/**
 * The ad must be a row of `poor_ads`, with 1000+ impressions in 30 days and a
 * CTR below half of its ad group's. The ad group must keep at least two OTHER
 * enabled ads (`enabled_ads` counts the ad itself, so 3 or more), and the ad
 * either has no conversions or costs at least twice what the group pays for one.
 * Every unknown (the group's CTR, the ad count) means "do not pause".
 */
export function evaluatePauseAd(action: OptimizerAction, context: ProposalContext): GateVerdict {
  const target = String(action.target_id ?? '').trim();
  const row = rows(context.snapshot.poor_ads).find(
    (candidate) => strOrEmpty(pick(candidate, 'ad_group_ad.resource_name')) === target
  );
  if (!target || !row) return no('pause_ad_not_in_snapshot');

  const metrics = metricsOf(row);
  if (metrics.impressions < PAUSE_AD_MIN_IMPRESSIONS) return no('pause_ad_few_impressions');

  const group = (row as any)?.ad_group ?? {};
  const groupCtr = numOrNull(group.ctr_30d);
  const groupCpa = numOrNull(group.cpa_30d);
  const enabledAds = numOrNull(group.enabled_ads);
  if (groupCtr === null || !(groupCtr > 0)) return no('pause_ad_group_unknown');

  // metrics.ctr is a fraction; fall back to clicks / impressions when the column is absent.
  const adCtr = metrics.ctr !== null ? metrics.ctr : metrics.impressions > 0 ? metrics.clicks / metrics.impressions : null;
  if (adCtr === null || !(adCtr < PAUSE_AD_MAX_CTR_SHARE * groupCtr)) return no('pause_ad_ctr_not_low');

  if (enabledAds === null || enabledAds < PAUSE_AD_MIN_OTHER_ENABLED_ADS + 1) return no('pause_ad_not_enough_siblings');

  if (metrics.conversions > 0) {
    if (groupCpa === null) return no('pause_ad_converts');
    const adCpa = toUnits(metrics.costMicros) / metrics.conversions;
    if (adCpa < PAUSE_AD_CPA_IN_GROUP_CPAS * groupCpa) return no('pause_ad_converts');
  }
  return ok;
}

// ---------------------------------------------------------------------------
// add_keyword
// ---------------------------------------------------------------------------

/**
 * The term must be a row of `converting_search_terms` captured by the ad group
 * the proposal names, not already handled as a keyword or a negative, and not
 * among the enabled keywords the snapshot lists. When the client's CPA is known
 * (the SCALE end) the term's own CPA must be at or below it. The preflight
 * checks the account's full keyword list again at execution.
 */
export function evaluateAddKeyword(action: OptimizerAction, context: ProposalContext): GateVerdict {
  const params = action.params as Record<string, unknown>;
  const text = normalizeKeywordText(strOrEmpty(params.keyword_text));
  const adGroup = strOrEmpty(params.ad_group_resource);
  const row = rows(context.snapshot.converting_search_terms).find(
    (candidate) => termOf(candidate) === text && strOrEmpty(pick(candidate, 'search_term_view.ad_group')) === adGroup
  );
  if (!text || !adGroup || !row) return no('add_keyword_term_not_converting');

  if (termIsAlreadyHandled(row) || knownKeywordTexts(context.snapshot).includes(text)) {
    return no('add_keyword_already_exists');
  }

  const metrics = metricsOf(row);
  if (!(metrics.conversions > 0)) return no('add_keyword_term_not_converting');

  const limit = allowableCpaScale(context.snapshot.economics ?? null);
  if (limit && toUnits(metrics.costMicros) / metrics.conversions > limit.value) return no('add_keyword_cpa_above_limit');
  return ok;
}

// ---------------------------------------------------------------------------
// add_negative_keyword
// ---------------------------------------------------------------------------

/**
 * The term must be a row of `wasted_search_terms` of the campaign the proposal
 * names, with 0 conversions, and either cost at least one allowable CPA (the
 * CUT end; two when there are no economics and the limit is the account's own
 * 30-day CPA; only while tracking is healthy, because zero conversions mean
 * nothing when tracking is broken) or be clearly
 * irrelevant on at least 5 clicks. The negative must not block a converting
 * search term, and must not equal or sit inside an enabled keyword the snapshot
 * lists (Arabic-normalized, so a spelling variant does not slip through).
 */
export function evaluateAddNegativeKeyword(action: OptimizerAction, context: ProposalContext): GateVerdict {
  const params = action.params as Record<string, unknown>;
  const text = normalizeKeywordText(strOrEmpty(params.keyword_text));
  const campaign = strOrEmpty(params.campaign_resource);
  const matchType = strOrEmpty(params.match_type).toUpperCase();
  const row = rows(context.snapshot.wasted_search_terms).find(
    (candidate) => termOf(candidate) === text && strOrEmpty(pick(candidate, 'campaign.resource_name')) === campaign
  );
  if (!text || !campaign || !row) return no('negative_term_not_wasted');

  const metrics = metricsOf(row);
  if (metrics.conversions > 0) return no('negative_term_not_wasted');

  const trackingHealthy = context.snapshot.conversion_tracking?.status === TRACKING_HEALTHY;
  const limit = cutLimit(context.snapshot);
  const costInCpas = limit?.source === 'account_30d_cpa_fallback' ? NEGATIVE_COST_IN_CPAS_FALLBACK : NEGATIVE_COST_IN_CPAS;
  const costJustifies = trackingHealthy && limit !== null && toUnits(metrics.costMicros) >= costInCpas * limit.value;
  const irrelevantJustifies =
    action.evidence?.relevance === 'clearly_irrelevant' && metrics.clicks >= NEGATIVE_IRRELEVANT_MIN_CLICKS;
  if (!costJustifies && !irrelevantJustifies) return no('negative_below_waste_floor');

  for (const converting of rows(context.snapshot.converting_search_terms)) {
    if (negativeWouldBlock(text, matchType, termOf(converting))) return no('negative_blocks_converting_term');
  }
  for (const keyword of knownKeywordTexts(context.snapshot)) {
    if (negativeWouldBlock(text, matchType, keyword)) return no('negative_matches_enabled_keyword');
  }
  return ok;
}

// ---------------------------------------------------------------------------
// One entry point
// ---------------------------------------------------------------------------

/** The evidence check for any action type this file covers; every other type passes. */
export function evaluateProposalEvidence(action: OptimizerAction, context: ProposalContext): GateVerdict {
  switch (action.type) {
    case 'pause_keyword':
      return evaluatePauseKeyword(action, context);
    case 'pause_ad':
      return evaluatePauseAd(action, context);
    case 'add_keyword':
      return evaluateAddKeyword(action, context);
    case 'add_negative_keyword':
      return evaluateAddNegativeKeyword(action, context);
    default:
      return ok;
  }
}

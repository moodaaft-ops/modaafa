/**
 * Auction insights reader and the monthly «منافس جديد أو يكبر» finding
 * (google-ads-titan operations-diagnostics 10, monthly).
 *
 * Is it available through the API? The Google Ads API v22 field reference lists
 * `segments.auction_insight_domain` and the metrics
 * `metrics.auction_insight_search_impression_share`, `_overlap_rate`,
 * `_outranking_share`, `_position_above_rate`, `_top_impression_percentage`
 * and `_absolute_top_impression_percentage` on the keyword_view resource
 * (developers.google.com/google-ads/api/fields/v22/keyword_view, read 19 Oct
 * 2026). That is the form this reader runs. It is NOT verified against a live
 * account: Google can refuse the query for an account or an API version, can
 * return a share as 0.0999 for "less than 10%", and can return no rows for
 * accounts with little traffic. So the reader reports `source: 'unavailable'`
 * honestly, and the monthly session falls back to the impression share trend
 * (own share, lost to budget, lost to rank), which every Search campaign has.
 *
 * Pure parts (aggregation, detection, trend) are separated from the reads so
 * they can be tested without Google.
 */

import { num, num0, str } from '../jarvis/tools/shared';

export type Customer = { query(gaql: string): Promise<any[]> };

export type DomainStat = {
  domain: string;
  impression_share: number | null;
  overlap_rate: number | null;
  outranking_share: number | null;
  position_above_rate: number | null;
  top_impression_pct: number | null;
};

export type Window = { from: string; to: string };

/** Weighted by our own impressions on the row, because a keyword with more traffic says more. */
export function aggregateDomainRows(rows: any[]): DomainStat[] {
  type Acc = { weight: number; sums: Record<Exclude<keyof DomainStat, 'domain'>, { value: number; weight: number }> };
  const byDomain = new Map<string, Acc>();
  const fields: Array<[Exclude<keyof DomainStat, 'domain'>, string]> = [
    ['impression_share', 'metrics.auction_insight_search_impression_share'],
    ['overlap_rate', 'metrics.auction_insight_search_overlap_rate'],
    ['outranking_share', 'metrics.auction_insight_search_outranking_share'],
    ['position_above_rate', 'metrics.auction_insight_search_position_above_rate'],
    ['top_impression_pct', 'metrics.auction_insight_search_top_impression_percentage'],
  ];
  for (const row of rows ?? []) {
    const domain = cleanDomain(str(row, 'segments.auction_insight_domain'));
    if (!domain) continue;
    const weight = Math.max(1, num0(row, 'metrics.impressions'));
    let acc = byDomain.get(domain);
    if (!acc) {
      acc = {
        weight: 0,
        sums: Object.fromEntries(fields.map(([key]) => [key, { value: 0, weight: 0 }])) as Acc['sums'],
      };
      byDomain.set(domain, acc);
    }
    acc.weight += weight;
    for (const [key, path] of fields) {
      const value = num(row, path);
      if (value === null) continue;
      acc.sums[key].value += value * weight;
      acc.sums[key].weight += weight;
    }
  }
  return [...byDomain.entries()].map(([domain, acc]) => {
    const avg = (key: Exclude<keyof DomainStat, 'domain'>) =>
      acc.sums[key].weight > 0 ? Math.round((acc.sums[key].value / acc.sums[key].weight) * 10_000) / 10_000 : null;
    return {
      domain,
      impression_share: avg('impression_share'),
      overlap_rate: avg('overlap_rate'),
      outranking_share: avg('outranking_share'),
      position_above_rate: avg('position_above_rate'),
      top_impression_pct: avg('top_impression_pct'),
    };
  });
}

/** A competitor domain, lower case, letters digits dots and dashes only. Anything else is not shown. */
export function cleanDomain(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (!text || text.length > 80) return null;
  return /^[a-z0-9.؀-ۿ-]+$/.test(text) && text.includes('.') ? text : null;
}

export type CompetitorFinding = {
  kind: 'new' | 'growing' | 'above_us_more';
  domain: string;
  overlap_now: number | null;
  overlap_before: number | null;
  above_now: number | null;
  above_before: number | null;
  text_ar: string;
};

export const NEW_COMPETITOR_MIN_OVERLAP = 0.15;
export const NEW_COMPETITOR_PRIOR_MAX = 0.03;
export const GROWING_MIN_RELATIVE = 0.5;
export const GROWING_MIN_POINTS = 0.07;
export const ABOVE_US_MIN_RATE = 0.25;
export const ABOVE_US_MIN_RISE = 0.1;
const MAX_FINDINGS = 5;

function pct(value: number | null) {
  return value === null ? '؟' : `${Math.round(value * 100)}%`;
}

/**
 * New or growing competitors, month against month.
 *   new            overlap now >= 15% and under 3% (or absent) a month ago
 *   growing        overlap now >= 15%, up by half or more and by 7 points or more
 *   above_us_more  they show above us in 25% or more of shared auctions, up 10 points or more
 */
export function detectCompetitorShifts(current: readonly DomainStat[], prior: readonly DomainStat[]): CompetitorFinding[] {
  const before = new Map(prior.map((d) => [d.domain, d]));
  const findings: CompetitorFinding[] = [];
  for (const now of current) {
    const was = before.get(now.domain) ?? null;
    const overlapNow = now.overlap_rate;
    const overlapBefore = was?.overlap_rate ?? null;
    const aboveNow = now.position_above_rate;
    const aboveBefore = was?.position_above_rate ?? null;
    const base = { domain: now.domain, overlap_now: overlapNow, overlap_before: overlapBefore, above_now: aboveNow, above_before: aboveBefore };

    if (overlapNow !== null && overlapNow >= NEW_COMPETITOR_MIN_OVERLAP && (overlapBefore ?? 0) < NEW_COMPETITOR_PRIOR_MAX) {
      findings.push({
        ...base,
        kind: 'new',
        text_ar: `منافس جديد ${now.domain}: يظهر معك في ${pct(overlapNow)} من المزادات وكان تقريباً ما يظهر الشهر اللي قبل`,
      });
      continue;
    }
    if (
      overlapNow !== null &&
      overlapBefore !== null &&
      overlapNow >= NEW_COMPETITOR_MIN_OVERLAP &&
      overlapNow - overlapBefore >= GROWING_MIN_POINTS &&
      overlapBefore > 0 &&
      (overlapNow - overlapBefore) / overlapBefore >= GROWING_MIN_RELATIVE
    ) {
      findings.push({
        ...base,
        kind: 'growing',
        text_ar: `${now.domain} يكبر: ظهوره معك من ${pct(overlapBefore)} إلى ${pct(overlapNow)} من المزادات`,
      });
      continue;
    }
    if (
      aboveNow !== null &&
      aboveBefore !== null &&
      aboveNow >= ABOVE_US_MIN_RATE &&
      aboveNow - aboveBefore >= ABOVE_US_MIN_RISE
    ) {
      findings.push({
        ...base,
        kind: 'above_us_more',
        text_ar: `${now.domain} صار يطلع فوقك أكثر: من ${pct(aboveBefore)} إلى ${pct(aboveNow)} من المزادات المشتركة`,
      });
    }
  }
  const rank = { new: 0, growing: 1, above_us_more: 2 } as const;
  return findings
    .sort((a, b) => rank[a.kind] - rank[b.kind] || (b.overlap_now ?? 0) - (a.overlap_now ?? 0))
    .slice(0, MAX_FINDINGS);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function auctionQuery(window: Window) {
  return `
    SELECT segments.auction_insight_domain,
      metrics.impressions,
      metrics.auction_insight_search_impression_share,
      metrics.auction_insight_search_overlap_rate,
      metrics.auction_insight_search_outranking_share,
      metrics.auction_insight_search_position_above_rate,
      metrics.auction_insight_search_top_impression_percentage
    FROM keyword_view
    WHERE segments.date BETWEEN '${window.from}' AND '${window.to}'
      AND metrics.impressions > 0
    LIMIT 5000
  `;
}

export type AuctionRead =
  | { available: true; current: DomainStat[]; prior: DomainStat[] }
  | { available: false; reason: 'query_rejected' | 'no_rows' };

/** One read per window. `available: false` when Google refuses the query or answers with no competitor rows. */
export async function readAuctionInsights(customer: Customer, windows: { current: Window; prior: Window }): Promise<AuctionRead> {
  try {
    const [currentRows, priorRows] = await Promise.all([
      customer.query(auctionQuery(windows.current)),
      customer.query(auctionQuery(windows.prior)),
    ]);
    const current = aggregateDomainRows(currentRows);
    if (current.length === 0) return { available: false, reason: 'no_rows' };
    return { available: true, current, prior: aggregateDomainRows(priorRows) };
  } catch {
    return { available: false, reason: 'query_rejected' };
  }
}

// ---------------------------------------------------------------------------
// Fallback: impression share trend
// ---------------------------------------------------------------------------

export type ShareWindow = { search_is: number | null; lost_budget_is: number | null; lost_rank_is: number | null };

/** Impression-weighted shares of the Search campaigns in one window. */
export function aggregateShareRows(rows: any[]): ShareWindow {
  const acc = { is: [0, 0], budget: [0, 0], rank: [0, 0] };
  for (const row of rows ?? []) {
    const weight = Math.max(1, num0(row, 'metrics.impressions'));
    const values: Array<[keyof typeof acc, number | null]> = [
      ['is', num(row, 'metrics.search_impression_share')],
      ['budget', num(row, 'metrics.search_budget_lost_impression_share')],
      ['rank', num(row, 'metrics.search_rank_lost_impression_share')],
    ];
    for (const [key, value] of values) {
      if (value === null) continue;
      acc[key][0] += value * weight;
      acc[key][1] += weight;
    }
  }
  const avg = (pair: number[]) => (pair[1] > 0 ? Math.round((pair[0] / pair[1]) * 10_000) / 10_000 : null);
  return { search_is: avg(acc.is), lost_budget_is: avg(acc.budget), lost_rank_is: avg(acc.rank) };
}

export type ShareTrend = {
  current: ShareWindow;
  prior: ShareWindow;
  /** Percentage points, current minus prior. */
  change_points: { search_is: number | null; lost_budget_is: number | null; lost_rank_is: number | null };
  text_ar: string | null;
};

export const RANK_LOSS_RISE_POINTS = 5;
export const SHARE_DROP_POINTS = 5;

function points(now: number | null, before: number | null) {
  return now === null || before === null ? null : Math.round((now - before) * 1000) / 10;
}

/**
 * Own share trend. A rise in the share lost to RANK (not to budget) with a
 * falling share is what a stronger competitor or a weaker ad quality looks
 * like; it is a hint to read the quality score and the ads, not a proof.
 */
export function impressionShareTrend(current: ShareWindow, prior: ShareWindow): ShareTrend {
  const change = {
    search_is: points(current.search_is, prior.search_is),
    lost_budget_is: points(current.lost_budget_is, prior.lost_budget_is),
    lost_rank_is: points(current.lost_rank_is, prior.lost_rank_is),
  };
  let text: string | null = null;
  if (change.lost_rank_is !== null && change.lost_rank_is >= RANK_LOSS_RISE_POINTS && (change.search_is ?? 0) <= 0) {
    text = `حصة الظهور اللي نخسرها بسبب الترتيب زادت ${Math.abs(change.lost_rank_is)} نقطة عن الشهر اللي قبل. هذا شكله منافس أقوى أو جودة إعلان أضعف، مو ميزانية`;
  } else if (change.search_is !== null && change.search_is <= -SHARE_DROP_POINTS) {
    text = `حصة الظهور نزلت ${Math.abs(change.search_is)} نقطة عن الشهر اللي قبل`;
  }
  return { current, prior, change_points: change, text_ar: text };
}

function shareQuery(window: Window) {
  return `
    SELECT metrics.impressions, metrics.search_impression_share,
      metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
    FROM campaign
    WHERE segments.date BETWEEN '${window.from}' AND '${window.to}'
      AND campaign.advertising_channel_type = 'SEARCH'
      AND campaign.status = 'ENABLED'
      AND metrics.impressions > 0
    LIMIT 500
  `;
}

export async function readImpressionShareTrend(
  customer: Customer,
  windows: { current: Window; prior: Window }
): Promise<ShareTrend | null> {
  try {
    const [currentRows, priorRows] = await Promise.all([
      customer.query(shareQuery(windows.current)),
      customer.query(shareQuery(windows.prior)),
    ]);
    return impressionShareTrend(aggregateShareRows(currentRows), aggregateShareRows(priorRows));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The monthly finding
// ---------------------------------------------------------------------------

export type CompetitionFinding = {
  source: 'auction_insights' | 'impression_share_trend' | 'unavailable';
  findings: CompetitorFinding[];
  share_trend: ShareTrend | null;
  /** One line for the report. Null when nothing moved. */
  summary_ar: string | null;
  /** Why the competitor table is missing, when it is. */
  fallback_reason: 'query_rejected' | 'no_rows' | null;
};

/** Reads auction insights; falls back to the share trend; never throws. */
export async function monthlyCompetitionFinding(
  customer: Customer,
  windows: { current: Window; prior: Window }
): Promise<CompetitionFinding> {
  const auction = await readAuctionInsights(customer, windows);
  if (auction.available) {
    const findings = detectCompetitorShifts(auction.current, auction.prior);
    return {
      source: 'auction_insights',
      findings,
      share_trend: null,
      summary_ar: findings.length ? findings[0].text_ar : null,
      fallback_reason: null,
    };
  }
  const trend = await readImpressionShareTrend(customer, windows);
  return {
    source: trend ? 'impression_share_trend' : 'unavailable',
    findings: [],
    share_trend: trend,
    summary_ar: trend?.text_ar ?? null,
    fallback_reason: auction.reason,
  };
}

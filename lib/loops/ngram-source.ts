import { currencyUnits, num0, str } from '../jarvis/tools/shared';
import { analyzeNgrams, type AllowableCpaInput, type GramEntry, type NgramAnalysis, type TermStat } from './ngram';

/**
 * Google Ads side of the n-gram analysis: one search_term_view read, mapped to
 * plain rows. The same read the Jarvis search-terms tool runs, so Google accepts it.
 * Kept apart from ngram.ts so the pure math has no dependency on the tool helpers.
 */

export const NGRAM_ROW_LIMIT = 1000;

type Customer = { query(gaql: string): Promise<any[]> };

export const NGRAM_PERIODS = ['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS'] as const;
export type NgramPeriod = (typeof NGRAM_PERIODS)[number];

export function periodDays(period: string) {
  const match = /LAST_(\d+)_DAYS/.exec(period);
  return match ? Number(match[1]) : 30;
}

/** Rows of the account's search terms, or null when Google refuses the read. */
export async function fetchSearchTermStats(
  customer: Customer,
  period: NgramPeriod = 'LAST_30_DAYS'
): Promise<{ terms: TermStat[]; truncated: boolean } | null> {
  let rows: any[];
  try {
    rows = await customer.query(`
      SELECT search_term_view.search_term,
        metrics.impressions, metrics.clicks, metrics.cost_micros,
        metrics.conversions, metrics.conversions_value
      FROM search_term_view
      WHERE segments.date DURING ${period} AND metrics.cost_micros > 0
      ORDER BY metrics.cost_micros DESC
      LIMIT ${NGRAM_ROW_LIMIT}
    `);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const terms = rows
    .map((row) => ({
      term: str(row, 'search_term_view.search_term').trim(),
      impressions: num0(row, 'metrics.impressions'),
      clicks: num0(row, 'metrics.clicks'),
      cost: currencyUnits(row, 'metrics.cost_micros'),
      conversions: num0(row, 'metrics.conversions'),
      value: num0(row, 'metrics.conversions_value'),
    }))
    .filter((row) => row.term.length > 0);
  return { terms, truncated: rows.length >= NGRAM_ROW_LIMIT };
}

/** Reads the terms and runs the analysis. Null when the read failed (the caller leaves the block out). */
export async function readNgramAnalysis(args: {
  customer: Customer;
  allowableCpa: AllowableCpaInput;
  protectedTexts?: Array<string | null | undefined>;
  period?: NgramPeriod;
}): Promise<(NgramAnalysis & { truncated: boolean }) | null> {
  const period = args.period ?? 'LAST_30_DAYS';
  const fetched = await fetchSearchTermStats(args.customer, period);
  if (!fetched) return null;
  const analysis = analyzeNgrams({
    terms: fetched.terms,
    allowableCpa: args.allowableCpa,
    protectedTexts: args.protectedTexts,
    windowDays: periodDays(period),
  });
  return { ...analysis, truncated: fetched.truncated };
}

type CompactGram = Pick<GramEntry, 'gram' | 'n' | 'cost' | 'clicks' | 'conversions' | 'terms' | 'share_of_spend_pct' | 'sample_terms'> &
  Partial<Pick<GramEntry, 'cpa' | 'roas'>>;

export type NgramPromptBlock = {
  window_days: number;
  terms_scanned: number;
  allowable_cpa: AllowableCpaInput;
  waste_threshold: number | null;
  wasteful: CompactGram[];
  wasteful_terms_cost: number;
  winners: CompactGram[];
  truncated: boolean;
};

/**
 * The compact block the optimizer sees. Nothing here is an instruction: gram
 * texts and sample terms come from strangers and go through the prompt
 * sanitiser with the rest of the snapshot.
 */
export function ngramPromptBlock(analysis: NgramAnalysis & { truncated?: boolean }): NgramPromptBlock | null {
  if (analysis.note === 'no_terms') return null;
  const waste = (g: GramEntry): CompactGram => ({
    gram: g.gram,
    n: g.n,
    cost: g.cost,
    clicks: g.clicks,
    conversions: g.conversions,
    terms: g.terms,
    share_of_spend_pct: g.share_of_spend_pct,
    sample_terms: g.sample_terms,
  });
  const win = (g: GramEntry): CompactGram => ({ ...waste(g), cpa: g.cpa, roas: g.roas });
  return {
    window_days: analysis.window_days,
    terms_scanned: analysis.terms_scanned,
    allowable_cpa: analysis.allowable_cpa,
    waste_threshold: analysis.waste_threshold,
    wasteful: analysis.wasteful.slice(0, 10).map(waste),
    wasteful_terms_cost: analysis.wasteful_terms_cost,
    winners: analysis.winners.slice(0, 6).map(win),
    truncated: analysis.truncated === true,
  };
}

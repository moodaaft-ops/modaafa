import type { JarvisReadTool } from './types';
import { cleanText, money, moneyOrNull, okResult, optEnum, parseArgs, safeCurrency } from './shared';
import { allowableCpaCut } from '@/lib/economics/break-even';
import { isNgramEnabled } from '@/lib/loops/flags';
import { analyzeNgrams, type GramEntry } from '@/lib/loops/ngram';
import { fetchSearchTermStats, NGRAM_PERIODS, periodDays } from '@/lib/loops/ngram-source';

/**
 * N-gram analysis of the account's search terms (NGRAM_ENABLED). Reads the same
 * search terms as get_search_terms, breaks them into 1, 2 and 3 word pieces and
 * adds up the money per piece. Read only: it carries no refs, so it cannot be
 * turned into a change by itself; a negative still goes through get_search_terms
 * (negative_word_candidates) and prepare_change.
 */
function compact(gram: GramEntry, withEfficiency: boolean) {
  const out: Record<string, unknown> = {
    gram: cleanText(gram.gram),
    words: gram.n,
    cost: money(gram.cost),
    clicks: gram.clicks,
    conversions: gram.conversions,
    terms: gram.terms,
    share_of_spend_pct: gram.share_of_spend_pct,
    sample_terms: gram.sample_terms.map((term) => cleanText(term)),
  };
  if (withEfficiency) {
    out.cpa = moneyOrNull(gram.cpa);
    out.roas = gram.roas;
  }
  return out;
}

export const getNgramAnalysisTool: JarvisReadTool = {
  name: 'get_ngram_analysis',
  description:
    'Breaks the search terms into 1, 2 and 3 word pieces and adds up cost, clicks and conversions per piece. ' +
    'Use it to find a repeating word or phrase that spends without converting (the real negative keyword) and the pieces that convert. ' +
    'wasteful pieces have zero conversions and cost at least 2 x the allowable cost per conversion.',
  input_schema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: [...NGRAM_PERIODS], description: 'Reporting window. Default LAST_30_DAYS.' },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    if (!isNgramEnabled()) {
      return { ok: false, error: 'disabled', message_ar: 'تحليل الكلمات مو مفعّل الحين' };
    }
    const args = parseArgs(input, ['period']);
    const period = optEnum(args, 'period', NGRAM_PERIODS, 'LAST_30_DAYS');
    const fetched = await fetchSearchTermStats(ctx.customer, period);
    if (!fetched) return { ok: false, error: 'read_failed', message_ar: 'ما قدرت أقرا مصطلحات البحث الحين' };

    const spend = fetched.terms.reduce((sum, row) => sum + row.cost, 0);
    const conversions = fetched.terms.reduce((sum, row) => sum + row.conversions, 0);
    const accountCpa = conversions >= 1 ? spend / conversions : null;
    const allowable = allowableCpaCut(ctx.economics ?? null, accountCpa);

    const analysis = analyzeNgrams({
      terms: fetched.terms,
      allowableCpa: allowable,
      protectedTexts: [ctx.business?.name, ctx.business?.sector, ...(ctx.business?.keywords ?? [])],
      windowDays: periodDays(period),
    });

    return okResult(
      {
        period,
        currency: safeCurrency(ctx),
        terms_scanned: analysis.terms_scanned,
        truncated: fetched.truncated,
        spend_scanned: money(analysis.spend_scanned),
        allowable_cpa: allowable,
        waste_threshold: analysis.waste_threshold,
        note: analysis.note,
        wasteful: analysis.wasteful.slice(0, 12).map((gram) => compact(gram, false)),
        wasteful_terms_cost: money(analysis.wasteful_terms_cost),
        winners: analysis.winners.slice(0, 8).map((gram) => compact(gram, true)),
      },
      []
    );
  },
};

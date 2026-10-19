import type { JarvisReadTool } from './types';
import { okResult, safeCurrency } from './shared';
import { addDays, riyadhDay } from '@/lib/loops/seasons';
import { isMonthlyReviewEnabled } from '@/lib/loops/flags';
import { monthlyCompetitionFinding } from '@/lib/loops/auction-insights';

/**
 * Competition, month against month (MONTHLY_REVIEW_ENABLED): new or growing
 * competitors from auction insights when the account's API answers, and the
 * impression share trend when it does not.
 */
export const getAuctionInsightsTool: JarvisReadTool = {
  name: 'get_auction_insights',
  description:
    'Who competes with the ads, last 30 days against the 30 before: new competitors, competitors that grow, and the impression share trend ' +
    '(share lost to budget versus to rank). Use it when the customer asks about competitors or why the ads show less.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_input, ctx) {
    if (!isMonthlyReviewEnabled()) {
      return { ok: false, error: 'disabled', message_ar: 'قراءة المنافسين مو مفعّلة الحين' };
    }
    const today = riyadhDay(ctx.now);
    const finding = await monthlyCompetitionFinding(ctx.customer, {
      current: { from: addDays(today, -30), to: addDays(today, -1) },
      prior: { from: addDays(today, -60), to: addDays(today, -31) },
    });
    return okResult(
      {
        currency: safeCurrency(ctx),
        source: finding.source,
        summary: finding.summary_ar,
        competitors: finding.findings.map((f) => ({
          kind: f.kind,
          domain: f.domain,
          overlap_now: f.overlap_now,
          overlap_before: f.overlap_before,
          above_now: f.above_now,
          above_before: f.above_before,
        })),
        impression_share_change_points: finding.share_trend?.change_points ?? null,
        fallback_reason: finding.fallback_reason,
      },
      []
    );
  },
};

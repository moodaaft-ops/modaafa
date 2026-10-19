import type { JarvisReadTool } from './types';
import { cleanText, okResult, safeCurrency } from './shared';
import { isMonthlyReviewEnabled } from '@/lib/loops/flags';
import { qualityFindings, readQualityKeywords } from '@/lib/loops/quality-score';

/**
 * Quality Score of the keywords that spend the most (MONTHLY_REVIEW_ENABLED),
 * with the three components and one concrete suggestion per weak component.
 * Read only: the suggestions are for the customer to decide, never executed.
 */
export const getQualityScoreTool: JarvisReadTool = {
  name: 'get_quality_score',
  description:
    'Quality Score (1 to 10) of the top-spending keywords with expected CTR, ad relevance and landing page experience, and a concrete suggestion ' +
    '(split the ad group, rewrite the ad, fix the landing page, improve the CTR) for each keyword under 7. Use it when the customer asks why clicks are expensive or how to improve the ads.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_input, ctx) {
    if (!isMonthlyReviewEnabled()) {
      return { ok: false, error: 'disabled', message_ar: 'قراءة جودة الكلمات مو مفعّلة الحين' };
    }
    const keywords = await readQualityKeywords(ctx.customer);
    if (!keywords) return { ok: false, error: 'read_failed', message_ar: 'ما قدرت أقرا جودة الكلمات الحين' };
    const findings = qualityFindings(keywords);
    return okResult(
      {
        currency: safeCurrency(ctx),
        keywords_read: keywords.length,
        keywords_with_score: keywords.filter((k) => k.quality_score !== null).length,
        needs_work: findings.map((f) => ({
          keyword: cleanText(f.keyword),
          ad_group: cleanText(f.ad_group),
          campaign: cleanText(f.campaign),
          quality_score: f.quality_score,
          priority: f.priority,
          components: f.components,
          cost: f.cost,
          suggestions: f.suggestions,
        })),
        note: 'Quality Score is a diagnosis from Google, not a target. Suggestions are for the customer to decide.',
      },
      []
    );
  },
};

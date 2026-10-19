import type { EvidenceRow, JarvisReadTool } from './types';
import { cleanText, okResult, parseArgs, refCounter } from './shared';
import { readShoppingHealthOrThrow } from '@/lib/shopping/reader';
import { isShoppingHealthEnabled } from '@/lib/shopping/flag';

/**
 * Merchant Center product status as Google Ads sees it (the shopping_product
 * resource): how many products are eligible, limited or not eligible, and the
 * issues that block them, grouped by cause with sample item ids. Registered
 * only when SHOPPING_HEALTH_ENABLED is on. Read only.
 */

export const getShoppingHealthTool: JarvisReadTool = {
  name: 'get_shopping_health',
  description:
    "Reads the Merchant Center feed status through Google Ads: counts of eligible, limited and not-eligible products and the issues behind them (disapprovals, demotions) grouped by cause with sample item ids. Use it before saying anything about why products do not show in Shopping or Performance Max. An account with no Merchant Center link returns zero products. Read only: it never changes the account.",
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(input, ctx) {
    parseArgs(input, []);
    if (!isShoppingHealthEnabled()) throw new Error('shopping health disabled');
    const health = await readShoppingHealthOrThrow(ctx.customer);

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];
    const issues = health.issues.map((issue) => {
      const ref = nextRef('shi');
      const compact = {
        code: cleanText(issue.code),
        severity: issue.severity,
        attribute: cleanText(issue.attribute),
        products: issue.products,
      };
      evidence.push({ ref, kind: 'shopping_issue', data: { ...compact, description: cleanText(issue.description), sample_items: issue.sample_items } });
      return { ref, ...compact };
    });

    return okResult(
      {
        total_products: health.total,
        eligible: health.eligible,
        eligible_limited: health.eligible_limited,
        not_eligible: health.not_eligible,
        unknown_status: health.unknown,
        not_eligible_share: health.not_eligible_share,
        counts_are_a_floor: health.truncated,
        issues,
      },
      evidence
    );
  },
};

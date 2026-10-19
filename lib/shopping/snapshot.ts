import type { ShoppingHealth } from './reader';

/**
 * The compact block the optimizer reads (SHOPPING_HEALTH_ENABLED). Counts and
 * issue codes only: no product titles, no item ids, nothing a merchant typed.
 * An account without products gets no block, so a non-shopping account sees
 * nothing new.
 */
export type ShoppingHealthBlock = {
  total_products: number;
  eligible: number;
  eligible_limited: number;
  not_eligible: number;
  not_eligible_share: number;
  counts_are_a_floor: boolean;
  top_issues: Array<{ code: string; severity: string; products: number }>;
  note: string;
};

export function shoppingHealthBlock(health: ShoppingHealth): ShoppingHealthBlock | null {
  if (health.total === 0) return null;
  return {
    total_products: health.total,
    eligible: health.eligible,
    eligible_limited: health.eligible_limited,
    not_eligible: health.not_eligible,
    not_eligible_share: health.not_eligible_share,
    counts_are_a_floor: health.truncated,
    top_issues: health.issues.slice(0, 5).map((i) => ({ code: i.code, severity: i.severity, products: i.products })),
    note: 'Feed status from Merchant Center. Disapproved products do not serve; fixing the feed comes before any budget or bid change on Shopping or Performance Max.',
  };
}

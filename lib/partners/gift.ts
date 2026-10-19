import { partnersEnabled, refereeGiftPromoCode } from './config';
import { openReferralFor } from './store';
import { resolvePromotionCode } from '@/lib/billing/arabic-checkout/flow';

type ResolveStripe = Parameters<typeof resolvePromotionCode>[0];

/**
 * The welcome discount for a customer who came through a partner link and has not
 * paid yet: the Stripe promotion code named in PARTNER_REFEREE_PROMO_CODE. Used
 * only when the customer typed no code of their own (Stripe takes one code per
 * subscription, and theirs wins). Returns null for anything that is not a plain
 * yes: programme off, no code configured, no open referral, or the code is no
 * longer valid. A gift that cannot be applied must never block a checkout.
 */
export async function refereeGiftPromotion(
  deps: { getDb: () => unknown; stripe: ResolveStripe },
  params: { userId: string; customerId: string },
) {
  if (!partnersEnabled()) return null;
  const code = refereeGiftPromoCode();
  if (!code) return null;
  try {
    if (!(await openReferralFor(deps.getDb(), params.userId))) return null;
    return await resolvePromotionCode(deps.stripe, code, { customerId: params.customerId });
  } catch (error) {
    console.error('[partners] referee gift skipped', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

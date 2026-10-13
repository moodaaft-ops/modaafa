import type { EnforceTrialCardUniqueness, TrialCardSubscription } from '@/lib/billing/trial-card-guard';
import type { EnforceTrialStartAccountLock } from '@/lib/billing/trial-start-account-lock';

/**
 * The two guards that run when a subscription becomes a live trial, in one place
 * so the Stripe webhook (checkout.session.completed and
 * customer.subscription.created) and /api/billing/checkout/complete cannot drift:
 *
 *   1. one trial per physical card (trial-card-guard.ts);
 *   2. the Google Ads account lock at trial start (trial-start-account-lock.ts).
 *
 * The card guard goes first. When it has already cancelled the subscription the
 * account lock is not run: nothing is left to protect, and parking accounts for a
 * trial that never started would only hurt the user.
 *
 * `error` is the redirect code of the checkout-complete path and doubles as the
 * reason in logs. A blocked trial is written as `canceled` by every caller, never
 * gets a welcome email, and still counts as the user's trial being used.
 */
export type TrialStartBlockReason = 'card_trial_used' | 'ads_account_trial_used';

export async function runTrialStartGuards({
  admin,
  userId,
  subscription,
  enforceCard,
  enforceAccountLock,
}: {
  admin: any;
  userId: string;
  subscription: TrialCardSubscription;
  enforceCard: EnforceTrialCardUniqueness;
  enforceAccountLock: EnforceTrialStartAccountLock;
}): Promise<{ blocked: boolean; error: TrialStartBlockReason | null }> {
  const card = await enforceCard({ admin, userId, subscription });
  if (card.blocked) return { blocked: true, error: 'card_trial_used' };

  const accounts = await enforceAccountLock({ admin, userId, subscription });
  if (accounts.blocked) return { blocked: true, error: 'ads_account_trial_used' };

  return { blocked: false, error: null };
}

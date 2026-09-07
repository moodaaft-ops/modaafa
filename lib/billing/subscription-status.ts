export type StoredSubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'paused';

/** Only Stripe's actual retry/grace status grants temporary past-due access. */
export function normalizeSubscriptionStatus(status?: string): StoredSubscriptionStatus {
  if (status === 'active' || status === 'trialing' || status === 'past_due') return status;
  if (status === 'canceled' || status === 'incomplete_expired') return 'canceled';
  // Keep non-terminal unpaid/incomplete subscriptions available for billing
  // recovery and cancellation, but never mistake them for paid grace time.
  return 'paused';
}

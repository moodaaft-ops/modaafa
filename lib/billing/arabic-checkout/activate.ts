import { planFromSubscription } from '@/lib/billing/stripe';
import { recordTrialGrant } from '@/lib/billing/checkout-policy';
import { applySubscriptionEvent } from '@/lib/billing/subscription-events';
import { enforceTrialCardUniquenessLive } from '@/lib/billing/trial-card-guard';
import { enforceTrialStartAccountLockLive } from '@/lib/billing/trial-start-account-lock';
import { runTrialStartGuards, type TrialStartBlockReason } from '@/lib/billing/trial-start-guards';

/**
 * Replaces `/api/billing/checkout/complete` for subscriptions made by the Arabic
 * checkout: write the local row once Stripe says the subscription is live, after
 * the same two guards the hosted path runs.
 *
 * It runs from the browser's request, and the webhook runs for the same
 * subscription at about the same time, in either order. Three things keep that
 * safe:
 *   - the row goes through `applySubscriptionEvent`, so a stale write loses to a
 *     newer one in the database itself;
 *   - the timestamp is one second BEFORE the subscription started, so any real
 *     webhook (created at or after the start) always wins, and the webhook's own
 *     write still counts as "applied", which is what sends the welcome email;
 *   - the guards and the trial ledger are idempotent, so running them twice is
 *     the same as running them once.
 */
export type ActivateDependencies = {
  planFromSubscription: typeof planFromSubscription;
  runTrialStartGuards: typeof runTrialStartGuards;
  applySubscriptionEvent: typeof applySubscriptionEvent;
  recordTrialGrant: typeof recordTrialGrant;
  enforceCard: Parameters<typeof runTrialStartGuards>[0]['enforceCard'];
  enforceAccountLock: Parameters<typeof runTrialStartGuards>[0]['enforceAccountLock'];
};

export const defaultActivateDependencies: ActivateDependencies = {
  planFromSubscription,
  runTrialStartGuards,
  applySubscriptionEvent,
  recordTrialGrant,
  enforceCard: enforceTrialCardUniquenessLive,
  enforceAccountLock: enforceTrialStartAccountLockLive,
};

export type ActivationResult =
  | { ok: true; status: 'trialing' | 'active'; trialEnd: string | null }
  | { ok: false; error: TrialStartBlockReason };

export async function activateArabicSubscription(
  input: { admin: any; userId: string; subscription: any },
  dependencies: ActivateDependencies = defaultActivateDependencies,
): Promise<ActivationResult> {
  const { admin, userId, subscription } = input;
  if (subscription.metadata?.userId !== userId) {
    throw new Error('Subscription does not belong to this user');
  }
  if (subscription.status !== 'trialing' && subscription.status !== 'active') {
    // The route only calls this for a live subscription. Anything else would be
    // written as a state it is not in.
    throw new Error(`Refusing to activate a ${subscription.status} subscription`);
  }

  const { plan, period } = dependencies.planFromSubscription(subscription);
  const guards = await dependencies.runTrialStartGuards({
    admin,
    userId,
    subscription,
    enforceCard: dependencies.enforceCard,
    enforceAccountLock: dependencies.enforceAccountLock,
  });

  const periodStart = stripeTimestamp(subscription.current_period_start);
  const floor = periodStart ? new Date(new Date(periodStart).getTime() - 1000).toISOString() : new Date(0).toISOString();
  const status = guards.blocked ? 'canceled' : subscription.status;

  await dependencies.applySubscriptionEvent(admin, {
    user_id: userId,
    plan,
    billing_period: period,
    status,
    stripe_subscription_id: subscription.id,
    stripe_customer_id: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
    trial_ends_at: stripeTimestamp(subscription.trial_end),
    current_period_start: periodStart,
    current_period_end: stripeTimestamp(subscription.current_period_end),
    last_event_at: floor,
    ...(guards.blocked
      ? { canceled_at: stripeTimestamp(subscription.canceled_at) ?? new Date().toISOString() }
      : {}),
  });

  // A blocked trial still counts as the user's trial being used, so the next
  // checkout offers no second one (same rule as checkout/complete).
  if (subscription.trial_end) {
    await dependencies.recordTrialGrant({
      supabase: admin,
      userId,
      stripeSubscriptionId: subscription.id,
      source: 'checkout_complete',
    });
  }

  if (guards.blocked && guards.error) return { ok: false, error: guards.error };
  return { ok: true, status: subscription.status, trialEnd: stripeTimestamp(subscription.trial_end) };
}

function stripeTimestamp(value?: number | null) {
  return value ? new Date(value * 1000).toISOString() : null;
}

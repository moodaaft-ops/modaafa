/**
 * One free trial per physical card.
 *
 * The email ledger and the Google Ads account lock both live on identities the
 * abuser controls. A card fingerprint (Stripe `card.fingerprint`, stable across
 * PaymentMethod objects for the same card number) is the one thing a person
 * cannot cheaply multiply, so the first trial taken with a card claims it in
 * `trial_card_ledger`; a different user starting a trial with the same card has
 * the subscription cancelled on the spot.
 *
 * Fail-open on purpose. If Stripe or the ledger cannot be read, or the card
 * carries no fingerprint, the trial is NOT blocked: cancelling a real customer
 * over a transient error is worse than letting one trial through, and the
 * Google Ads account lock (checkout-policy.ts) is the primary guard.
 *
 * Every dependency is injected so the rules are unit-testable without Stripe or
 * Supabase. The production wiring is `enforceTrialCardUniquenessLive`.
 */

import { trialCardStripe } from '@/lib/billing/stripe';

type PaymentMethodLike = {
  id?: string;
  card?: { fingerprint?: string | null } | null;
};

type CustomerLike = {
  deleted?: unknown;
  invoice_settings?: {
    default_payment_method?: string | PaymentMethodLike | null;
  } | null;
};

/** The slice of the Stripe SDK the guard needs. */
export type TrialCardStripe = {
  retrievePaymentMethod(id: string): Promise<PaymentMethodLike | null>;
  retrieveCustomer(id: string): Promise<CustomerLike | null>;
  retrieveSubscription(id: string): Promise<{ status?: string } | null>;
  /** Immediate cancellation: no proration, no final invoice. */
  cancelSubscription(id: string): Promise<unknown>;
};

/** The slice of the Stripe subscription the guard reads. */
export type TrialCardSubscription = {
  id: string;
  status?: string | null;
  trial_end?: number | null;
  customer?: string | { id: string } | null;
  default_payment_method?: string | PaymentMethodLike | null;
};

export type TrialCardGuardOutcome =
  | 'not_trialing'
  | 'no_fingerprint'
  | 'lookup_failed'
  | 'first_use'
  | 'same_user'
  | 'duplicate_card';

export type TrialCardGuardResult = {
  blocked: boolean;
  outcome: TrialCardGuardOutcome;
};

/** What callers (webhook handler, checkout/complete) depend on. */
export type EnforceTrialCardUniqueness = (params: {
  admin: any;
  userId: string;
  subscription: TrialCardSubscription;
}) => Promise<TrialCardGuardResult>;

export async function enforceTrialCardUniqueness({
  stripe,
  admin,
  userId,
  subscription,
  now = Date.now(),
}: {
  stripe: TrialCardStripe;
  admin: any;
  userId: string;
  subscription: TrialCardSubscription;
  now?: number;
}): Promise<TrialCardGuardResult> {
  if (!isLiveTrial(subscription, now)) return { blocked: false, outcome: 'not_trialing' };

  let fingerprint: string | null;
  let ownerId: string | null = null;
  let claimed = false;
  try {
    fingerprint = await resolveFingerprint(stripe, subscription);
    if (!fingerprint) {
      console.error('Trial card guard found no card fingerprint; allowing the trial', {
        subscriptionId: subscription.id,
      });
      return { blocked: false, outcome: 'no_fingerprint' };
    }

    // First writer wins. The insert ignores a duplicate and returns only the rows
    // it actually inserted, so an empty result means someone already owns this
    // card and the read-back says who. Concurrent first uses agree on one owner.
    const { data: inserted, error: insertError } = await admin
      .from('trial_card_ledger')
      .upsert(
        {
          fingerprint,
          first_user_id: userId,
          stripe_subscription_id: subscription.id,
        },
        { onConflict: 'fingerprint', ignoreDuplicates: true }
      )
      .select('fingerprint');
    if (insertError) throw insertError;

    claimed = Array.isArray(inserted) && inserted.length > 0;
    if (!claimed) {
      const { data, error: readError } = await admin
        .from('trial_card_ledger')
        .select('first_user_id')
        .eq('fingerprint', fingerprint)
        .maybeSingle();
      if (readError) throw readError;
      ownerId = data?.first_user_id ?? null;
      if (!ownerId) throw new Error('Trial card ledger row missing after insert');
    }
  } catch (error) {
    console.error('Trial card guard lookup failed; allowing the trial', {
      subscriptionId: subscription.id,
      error,
    });
    return { blocked: false, outcome: 'lookup_failed' };
  }

  if (claimed) return { blocked: false, outcome: 'first_use' };
  if (ownerId === userId) return { blocked: false, outcome: 'same_user' };

  // A different user already took a trial with this card.
  await cancelImmediately(stripe, subscription.id);
  console.warn('Trial cancelled: card already used for a trial by another user', {
    subscriptionId: subscription.id,
    userId,
  });
  return { blocked: true, outcome: 'duplicate_card' };
}

/**
 * Production wiring: the real Stripe client. Used by the Stripe webhook handler
 * (through its dependency object) and by checkout/complete.
 */
export const enforceTrialCardUniquenessLive: EnforceTrialCardUniqueness = (params) =>
  enforceTrialCardUniqueness({ ...params, stripe: trialCardStripe });

function isLiveTrial(subscription: TrialCardSubscription, now: number) {
  return (
    subscription.status === 'trialing' &&
    typeof subscription.trial_end === 'number' &&
    subscription.trial_end * 1000 > now
  );
}

async function resolveFingerprint(stripe: TrialCardStripe, subscription: TrialCardSubscription) {
  const fromSubscription = await fingerprintOf(stripe, subscription.default_payment_method);
  if (fromSubscription) return fromSubscription;

  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (!customerId) return null;
  const customer = await stripe.retrieveCustomer(customerId);
  if (!customer || customer.deleted) return null;
  return fingerprintOf(stripe, customer.invoice_settings?.default_payment_method);
}

async function fingerprintOf(
  stripe: TrialCardStripe,
  paymentMethod: string | PaymentMethodLike | null | undefined
) {
  if (!paymentMethod) return null;
  if (typeof paymentMethod === 'string') {
    const retrieved = await stripe.retrievePaymentMethod(paymentMethod);
    return cleanFingerprint(retrieved?.card?.fingerprint);
  }
  const expanded = cleanFingerprint(paymentMethod.card?.fingerprint);
  if (expanded) return expanded;
  if (paymentMethod.id) {
    const retrieved = await stripe.retrievePaymentMethod(paymentMethod.id);
    return cleanFingerprint(retrieved?.card?.fingerprint);
  }
  return null;
}

function cleanFingerprint(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Cancel the duplicate-card subscription. Two paths can reach this at once (the
 * checkout return and the webhook), so a cancel that fails because the other
 * path already won is fine: re-read the subscription and only rethrow when it is
 * still live. Throwing is deliberate: the webhook returns 500 and Stripe retries,
 * which is better than leaving a known-duplicate trial running.
 */
async function cancelImmediately(stripe: TrialCardStripe, subscriptionId: string) {
  try {
    await stripe.cancelSubscription(subscriptionId);
  } catch (error) {
    let live: { status?: string } | null = null;
    try {
      live = await stripe.retrieveSubscription(subscriptionId);
    } catch {
      // Could not confirm; fall through and surface the original failure.
    }
    if (live?.status !== 'canceled') throw error;
  }
}

/**
 * How a subscription made by the in-platform checkout is recognised.
 *
 * The hosted Checkout Session stamps `userId`, `plan` and `period` on the
 * subscription. The Arabic checkout stamps the same three, plus these two, so
 * the webhook can tell the two apart without a second lookup.
 */
export const ARABIC_CHECKOUT_SOURCE = 'arabic_checkout';

type SubscriptionLike = {
  status?: string | null;
  metadata?: Record<string, string | undefined> | null;
};

export function isArabicCheckoutSubscription(subscription: SubscriptionLike | null | undefined) {
  return subscription?.metadata?.source === ARABIC_CHECKOUT_SOURCE;
}

/**
 * A subscription this checkout created that never became a live one: the first
 * payment is still waiting on the bank (`incomplete`) or the wait ran out
 * (`incomplete_expired`).
 *
 * The webhook must not write these. `incomplete` maps to `past_due` in
 * `normalizeSubscriptionStatus`, and `past_due` counts as a live subscription,
 * so writing it would block the customer from subscribing again and could keep
 * access open for a payment that never happened. `incomplete_expired` maps to
 * `paused`, which is live too. The row is written when the status becomes
 * `trialing` or `active`, by the finalize route or by the webhook that follows.
 */
export function isUnactivatedArabicSubscription(subscription: SubscriptionLike | null | undefined) {
  return (
    isArabicCheckoutSubscription(subscription) &&
    (subscription?.status === 'incomplete' || subscription?.status === 'incomplete_expired')
  );
}

/**
 * The moment the welcome email goes out for a subscription from this checkout.
 *
 * There is no checkout.session.completed event on this path, so the welcome
 * moves to the subscription events: `created` when the subscription is already
 * live (a trial starts live), or the `updated` event that carries a pay-now
 * subscription from `incomplete` to `trialing` or `active`. Any other update is
 * a plan change or a renewal and gets no welcome.
 *
 * The same welcome can be reached twice (created and updated both landing after
 * the payment cleared), so the mail carries an idempotency key per subscription
 * and Resend drops the second one.
 */
export function isArabicWelcomeMoment(input: {
  eventType: string;
  subscription: SubscriptionLike;
  previousAttributes?: { status?: string | null } | null;
}) {
  const { eventType, subscription, previousAttributes } = input;
  if (!isArabicCheckoutSubscription(subscription)) return false;
  if (subscription.status !== 'trialing' && subscription.status !== 'active') return false;
  if (eventType === 'customer.subscription.created') return true;
  return eventType === 'customer.subscription.updated' && previousAttributes?.status === 'incomplete';
}

export function arabicWelcomeIdempotencyKey(subscriptionId: string) {
  return `modaafa-arabic-welcome:${subscriptionId}`;
}

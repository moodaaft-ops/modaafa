import { PLAN_PRICE_IDS, type PeriodKey, type PlanKey } from '@/lib/billing/stripe';
import { isConfiguredEnv } from '@/lib/platform/env';
import { ARABIC_CHECKOUT_SOURCE } from '@/lib/billing/arabic-checkout/source';

/**
 * The Stripe side of the in-platform checkout, with Stripe itself injected so the
 * rules can be tested without the network.
 *
 * The order, and why:
 *   1. createArabicSetupIntent  saves the card with no charge (and runs 3D Secure
 *      once, in the browser). It records on the SetupIntent what the customer was
 *      shown: plan, period and trial days.
 *   2. startArabicSubscription  creates the subscription from that saved card.
 *      Everything it needs is read from Stripe, never from the browser, and the
 *      trial days are asked again from the server's own decision.
 *   3. finalizeArabicSubscription  runs after the browser has finished a 3D Secure
 *      prompt for the first payment (only the pay-now path ever needs one).
 */

// The shapes come straight from Stripe's API, so they stay loose here.
type Loose = any;

export interface ArabicCheckoutStripeApi {
  createSetupIntent(params: Loose): Promise<Loose>;
  retrieveSetupIntent(id: string): Promise<Loose>;
  createSubscription(params: Loose, idempotencyKey: string): Promise<Loose>;
  /** Re-read with `latest_invoice.payment_intent` expanded. */
  retrieveSubscription(id: string): Promise<Loose>;
  listCustomerSubscriptions(customerId: string): Promise<Loose[]>;
  cancelSubscription(id: string): Promise<Loose>;
  findPromotionCode(code: string): Promise<Loose | null>;
}

/** An error whose `code` is something `arabicCheckoutError` knows how to say. */
export class ArabicCheckoutError extends Error {
  readonly code: string;
  readonly declineCode: string | null;

  constructor(code: string, declineCode?: string | null) {
    super(code);
    this.name = 'ArabicCheckoutError';
    this.code = code;
    this.declineCode = declineCode ?? null;
  }
}

const LIVE_STRIPE_STATUSES = new Set(['trialing', 'active', 'past_due', 'unpaid', 'paused']);

export function planPriceId(plan: PlanKey, period: PeriodKey) {
  const priceId = PLAN_PRICE_IDS[plan]?.[period];
  if (!isConfiguredEnv(priceId)) throw new ArabicCheckoutError('checkout_failed');
  return priceId.trim();
}

export async function createArabicSetupIntent(
  stripe: ArabicCheckoutStripeApi,
  input: { userId: string; customerId: string; plan: PlanKey; period: PeriodKey; trialDays: number },
) {
  // Fail before the customer types a card number, not after.
  planPriceId(input.plan, input.period);

  const setupIntent = await stripe.createSetupIntent({
    customer: input.customerId,
    // Card only, like the hosted checkout. Nothing else is offered or accepted.
    payment_method_types: ['card'],
    usage: 'off_session',
    metadata: {
      userId: input.userId,
      plan: input.plan,
      period: input.period,
      // What the page promised. startArabicSubscription refuses to continue when
      // the server's own answer is different by the time the customer pays.
      trial_days: String(input.trialDays),
      source: ARABIC_CHECKOUT_SOURCE,
    },
  });
  if (!setupIntent.client_secret) throw new ArabicCheckoutError('checkout_failed');
  return { setupIntentId: String(setupIntent.id), clientSecret: String(setupIntent.client_secret) };
}

export type PromotionView = {
  id: string;
  /** Short Arabic line for the page, for example «خصم 20%». */
  label: string;
  percentOff: number | null;
  amountOff: number | null;
  currency: string | null;
  duration: 'once' | 'repeating' | 'forever' | null;
  durationInMonths: number | null;
};

const PROMO_CODE_PATTERN = /^[A-Za-z0-9_-]{3,40}$/;

/**
 * Looks a discount code up on the server. The customer types it into our page,
 * but whether it works is Stripe's answer, so the code that was previewed and the
 * code that is applied go through this same function.
 */
export async function resolvePromotionCode(
  stripe: ArabicCheckoutStripeApi,
  rawCode: string,
  options: { customerId?: string | null; now?: number } = {},
): Promise<PromotionView> {
  const code = rawCode.trim();
  if (!PROMO_CODE_PATTERN.test(code)) throw new ArabicCheckoutError('promo_invalid');

  const promotion = await stripe.findPromotionCode(code);
  if (!promotion) throw new ArabicCheckoutError('promo_invalid');

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const coupon = promotion.coupon ?? {};
  if (promotion.active === false) throw new ArabicCheckoutError('promo_expired');
  if (typeof promotion.expires_at === 'number' && promotion.expires_at <= now) {
    throw new ArabicCheckoutError('promo_expired');
  }
  if (
    typeof promotion.max_redemptions === 'number' &&
    typeof promotion.times_redeemed === 'number' &&
    promotion.times_redeemed >= promotion.max_redemptions
  ) {
    throw new ArabicCheckoutError('promo_expired');
  }
  if (coupon.valid === false) throw new ArabicCheckoutError('promo_expired');
  // A code made for one customer is not another customer's.
  const restrictedTo =
    typeof promotion.customer === 'string' ? promotion.customer : promotion.customer?.id ?? null;
  if (restrictedTo && restrictedTo !== options.customerId) throw new ArabicCheckoutError('promo_invalid');

  const percentOff = typeof coupon.percent_off === 'number' ? coupon.percent_off : null;
  const amountOff = typeof coupon.amount_off === 'number' ? coupon.amount_off / 100 : null;
  const currency = typeof coupon.currency === 'string' ? coupon.currency.toLowerCase() : null;
  if (percentOff === null && amountOff === null) throw new ArabicCheckoutError('promo_not_applicable');

  const duration = (coupon.duration ?? null) as PromotionView['duration'];
  const durationInMonths = typeof coupon.duration_in_months === 'number' ? coupon.duration_in_months : null;
  const size = percentOff !== null ? `خصم ${formatNumber(percentOff)}%` : `خصم ${formatNumber(amountOff ?? 0)} ريال`;
  const span =
    duration === 'forever'
      ? ' على كل الدفعات'
      : duration === 'repeating' && durationInMonths
        ? ` لمدة ${durationInMonths} ${durationInMonths <= 10 ? 'أشهر' : 'شهراً'}`
        : ' على أول دفعة';

  return {
    id: String(promotion.id),
    label: `${size}${span}`,
    percentOff,
    amountOff,
    currency,
    duration,
    durationInMonths,
  };
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

/** The first charge after a promotion, in the price's own currency, never below zero. */
export function firstChargeAfterDiscount(
  amount: number,
  currency: string,
  promotion: Pick<PromotionView, 'percentOff' | 'amountOff' | 'currency'> | null,
) {
  if (!promotion) return amount;
  if (promotion.percentOff !== null) {
    return Math.max(0, Math.round(amount * (1 - promotion.percentOff / 100) * 100) / 100);
  }
  if (promotion.amountOff !== null && promotion.currency === currency.toLowerCase()) {
    return Math.max(0, Math.round((amount - promotion.amountOff) * 100) / 100);
  }
  return amount;
}

export type SubscriptionOutcome =
  | { kind: 'ready'; subscription: Loose }
  | { kind: 'requires_action'; subscriptionId: string; clientSecret: string };

export async function startArabicSubscription(
  stripe: ArabicCheckoutStripeApi,
  input: {
    userId: string;
    customerId: string;
    setupIntentId: string;
    /** The server's own decision, asked again now. Never the browser's. */
    trialDays: number;
    promotionCodeId?: string | null;
  },
): Promise<SubscriptionOutcome> {
  const setupIntent = await stripe.retrieveSetupIntent(input.setupIntentId);
  const setupCustomer =
    typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer?.id;
  const metadata = setupIntent.metadata ?? {};

  // The SetupIntent must be ours, for this customer, finished, and made by this
  // checkout. A client_secret from anywhere else is not a card we may charge.
  if (
    metadata.source !== ARABIC_CHECKOUT_SOURCE ||
    metadata.userId !== input.userId ||
    setupCustomer !== input.customerId
  ) {
    throw new ArabicCheckoutError('setup_not_completed');
  }
  if (setupIntent.status !== 'succeeded') throw new ArabicCheckoutError('setup_not_completed');
  const paymentMethod =
    typeof setupIntent.payment_method === 'string' ? setupIntent.payment_method : setupIntent.payment_method?.id;
  if (!paymentMethod) throw new ArabicCheckoutError('setup_not_completed');

  const plan = metadata.plan as PlanKey;
  const period = metadata.period as PeriodKey;
  const priceId = planPriceId(plan, period);

  // The price and the trial on the page were fixed when the SetupIntent was made.
  // If the server would now decide differently (a trial was taken in another
  // tab, say), stop: continuing would turn a free trial into a charge the
  // customer was not shown.
  if (Number(metadata.trial_days ?? 0) !== input.trialDays) throw new ArabicCheckoutError('terms_changed');

  // One subscription per customer. The unique index on our table catches a
  // duplicate only after Stripe has already created it, so Stripe is asked first.
  const existing = await stripe.listCustomerSubscriptions(input.customerId);
  const sameIntent = existing.find(
    (candidate) =>
      candidate.metadata?.source === ARABIC_CHECKOUT_SOURCE &&
      candidate.metadata?.setup_intent === input.setupIntentId,
  );
  for (const candidate of existing) {
    if (candidate === sameIntent) continue;
    if (LIVE_STRIPE_STATUSES.has(candidate.status)) throw new ArabicCheckoutError('already_subscribed');
  }
  if (sameIntent && (LIVE_STRIPE_STATUSES.has(sameIntent.status) || sameIntent.status === 'incomplete')) {
    // The same card submitted twice (a double click, or a retry after the answer
    // was lost): hand back what already exists instead of making another.
    return interpretSubscription(stripe, await stripe.retrieveSubscription(sameIntent.id), { afterAction: false });
  }
  // A leftover `incomplete` subscription (an abandoned 3D Secure) holds no money
  // but would sit beside the new one. It is closed first.
  for (const candidate of existing) {
    if (candidate.status === 'incomplete') {
      try {
        await stripe.cancelSubscription(candidate.id);
      } catch (error) {
        console.warn('Could not close a leftover incomplete subscription', { id: candidate.id, error });
      }
    }
  }

  const params: Loose = {
    customer: input.customerId,
    items: [{ price: priceId, quantity: 1 }],
    default_payment_method: paymentMethod,
    payment_settings: { payment_method_types: ['card'] },
    metadata: {
      userId: input.userId,
      plan,
      period,
      source: ARABIC_CHECKOUT_SOURCE,
      setup_intent: input.setupIntentId,
    },
    expand: ['latest_invoice.payment_intent'],
  };
  // Omitting `trial_period_days` does not mean "no trial" if the Price carries a
  // default one; checkStripeConfiguration() fails readiness for such a price.
  if (input.trialDays > 0) params.trial_period_days = input.trialDays;
  if (input.promotionCodeId) params.discounts = [{ promotion_code: input.promotionCodeId }];

  // Keyed on the SetupIntent: the same card cannot become two subscriptions.
  const created = await stripe.createSubscription(params, `modaafa-arabic-sub:${input.setupIntentId}`);
  // Read it again rather than trust the response: Stripe replays the first
  // response for a repeated key, and that snapshot can be out of date.
  return interpretSubscription(stripe, await stripe.retrieveSubscription(created.id), { afterAction: false });
}

/**
 * After the browser finished (or abandoned) a 3D Secure prompt for the first
 * payment. The subscription is read from Stripe and must be this user's.
 */
export async function finalizeArabicSubscription(
  stripe: ArabicCheckoutStripeApi,
  input: { userId: string; customerId: string; subscriptionId: string },
) {
  const subscription = await stripe.retrieveSubscription(input.subscriptionId);
  const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (
    subscription.metadata?.source !== ARABIC_CHECKOUT_SOURCE ||
    subscription.metadata?.userId !== input.userId ||
    customer !== input.customerId
  ) {
    throw new ArabicCheckoutError('setup_not_completed');
  }
  const outcome = await interpretSubscription(stripe, subscription, { afterAction: true });
  if (outcome.kind !== 'ready') throw new ArabicCheckoutError('payment_intent_authentication_failure');
  return outcome.subscription;
}

async function interpretSubscription(
  stripe: ArabicCheckoutStripeApi,
  subscription: Loose,
  options: { afterAction: boolean },
): Promise<SubscriptionOutcome> {
  if (subscription.status === 'trialing' || subscription.status === 'active') {
    return { kind: 'ready', subscription };
  }

  const intent = subscription.latest_invoice?.payment_intent;
  const intentObject = intent && typeof intent === 'object' ? intent : null;

  if (subscription.status === 'incomplete') {
    if (intentObject?.status === 'requires_action' && !options.afterAction && intentObject.client_secret) {
      return {
        kind: 'requires_action',
        subscriptionId: String(subscription.id),
        clientSecret: String(intentObject.client_secret),
      };
    }
    if (intentObject?.status === 'processing') {
      // The bank has not answered. Cancelling now could race a charge that is
      // about to succeed, so it is left alone and the webhook finishes it.
      throw new ArabicCheckoutError('payment_processing');
    }
    // Declined, or a 3D Secure prompt that was not completed. Nothing was
    // charged, and the half-made subscription is closed so it cannot linger.
    await cancelQuietly(stripe, String(subscription.id));
    const lastError = intentObject?.last_payment_error;
    throw new ArabicCheckoutError(
      lastError?.code ?? (options.afterAction ? 'payment_intent_authentication_failure' : 'card_declined'),
      lastError?.decline_code ?? null,
    );
  }

  if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') {
    const lastError = intentObject?.last_payment_error;
    throw new ArabicCheckoutError(lastError?.code ?? 'card_declined', lastError?.decline_code ?? null);
  }

  // past_due, unpaid, paused: not something this checkout creates on purpose.
  throw new ArabicCheckoutError('processing_error');
}

async function cancelQuietly(stripe: ArabicCheckoutStripeApi, subscriptionId: string) {
  try {
    await stripe.cancelSubscription(subscriptionId);
  } catch (error) {
    console.error('Could not cancel an unpaid subscription after a failed first payment', { subscriptionId, error });
  }
}

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
  /** Voids an open invoice (which also cancels its payment attempt). Best effort. */
  voidInvoice?(id: string): Promise<Loose>;
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

/**
 * After the bank says "paid", Stripe moves the subscription from `incomplete` to
 * `active` a moment later. The subscription is read again a few times before the
 * customer is told it is still pending. Replaceable so tests do not sleep.
 */
export const settleControl = {
  delaysMs: [600, 1200, 2400],
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** A payment attempt that may still turn into a charge. */
const PAYMENT_IN_PROGRESS_WINDOW_MS = 30 * 60 * 1000;

function paymentIntentOf(subscription: Loose): Loose | null {
  const intent = subscription?.latest_invoice?.payment_intent;
  return intent && typeof intent === 'object' ? intent : null;
}

function invoiceIsPaid(subscription: Loose) {
  const invoice = subscription?.latest_invoice;
  return !!invoice && typeof invoice === 'object' && invoice.status === 'paid';
}

/** Money has been taken (or is certain to be) for the first invoice. */
function firstPaymentWentThrough(subscription: Loose) {
  return paymentIntentOf(subscription)?.status === 'succeeded' || invoiceIsPaid(subscription);
}

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
  // and is closed so it cannot sit beside the new one. But one whose payment is
  // still moving (another tab in the middle of 3D Secure, a payment the bank has
  // not answered, or one that already went through) is left alone: closing it
  // could kill a charge that is about to succeed and then charge a second time.
  const leftovers = existing.filter((candidate) => candidate !== sameIntent && candidate.status === 'incomplete');
  for (const candidate of leftovers) {
    const intent = paymentIntentOf(candidate);
    const ageMs = Date.now() - Number(candidate.created ?? 0) * 1000;
    if (firstPaymentWentThrough(candidate)) throw new ArabicCheckoutError('payment_processing');
    if (
      (intent?.status === 'processing' || intent?.status === 'requires_action') &&
      ageMs < PAYMENT_IN_PROGRESS_WINDOW_MS
    ) {
      throw new ArabicCheckoutError('payment_in_progress');
    }
  }
  for (const candidate of leftovers) await closeUnpaidSubscription(stripe, candidate);

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
  let created: Loose;
  try {
    created = await stripe.createSubscription(params, `modaafa-arabic-sub:${input.setupIntentId}`);
  } catch (error) {
    // A card decline or a rejected request means nothing was charged. A lost
    // connection or a Stripe server error may mean the subscription exists, so the
    // customer is told the truth: the state is unknown, do not pay again.
    const type = (error as { type?: string } | null)?.type;
    if (type === 'StripeCardError' || type === 'StripeInvalidRequestError' || type === 'StripeRateLimitError') throw error;
    console.error('Arabic checkout: subscription create result unknown', { setupIntentId: input.setupIntentId, error });
    throw new ArabicCheckoutError('payment_status_unknown');
  }
  // From here a subscription exists. Any failure below must not claim nothing was charged.
  try {
    // Read it again rather than trust the response: Stripe replays the first
    // response for a repeated key, and that snapshot can be out of date.
    return await interpretSubscription(stripe, await stripe.retrieveSubscription(created.id), { afterAction: false });
  } catch (error) {
    if (error instanceof ArabicCheckoutError) throw error;
    console.error('Arabic checkout: could not read the subscription after creating it', { id: created?.id, error });
    throw new ArabicCheckoutError('payment_status_unknown');
  }
}

/**
 * After the browser finished (or abandoned) a 3D Secure prompt for the first
 * payment. The subscription is read from Stripe and must be this user's.
 */
export async function finalizeArabicSubscription(
  stripe: ArabicCheckoutStripeApi,
  /**
   * Ownership comes from the metadata this server wrote on the subscription. The
   * customer is not looked up again: a second lookup can land on a different
   * Stripe customer than the one the subscription was made on.
   */
  input: { userId: string; subscriptionId: string; customerId?: string },
) {
  const subscription = await stripe.retrieveSubscription(input.subscriptionId);
  const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (
    subscription.metadata?.source !== ARABIC_CHECKOUT_SOURCE ||
    subscription.metadata?.userId !== input.userId ||
    (input.customerId !== undefined && customer !== input.customerId)
  ) {
    throw new ArabicCheckoutError('setup_not_completed');
  }
  const outcome = await interpretSubscription(stripe, subscription, { afterAction: true });
  if (outcome.kind !== 'ready') throw new ArabicCheckoutError('payment_intent_authentication_failure');
  return outcome.subscription;
}

async function interpretSubscription(
  stripe: ArabicCheckoutStripeApi,
  initial: Loose,
  options: { afterAction: boolean },
): Promise<SubscriptionOutcome> {
  let subscription = initial;
  if (subscription.status === 'trialing' || subscription.status === 'active') {
    return { kind: 'ready', subscription };
  }

  if (subscription.status === 'incomplete') {
    const firstIntent = paymentIntentOf(subscription);
    if (firstIntent?.status === 'requires_action' && !options.afterAction && firstIntent.client_secret) {
      return {
        kind: 'requires_action',
        subscriptionId: String(subscription.id),
        clientSecret: String(firstIntent.client_secret),
      };
    }

    // The bank already said yes, but Stripe has not moved the subscription to
    // `active` yet. Read it again a few times; cancelling here would take a
    // payment that went through and leave the customer with no plan.
    if (firstPaymentWentThrough(subscription)) {
      for (const delay of settleControl.delaysMs) {
        await settleControl.wait(delay);
        subscription = await stripe.retrieveSubscription(String(initial.id));
        if (subscription.status === 'trialing' || subscription.status === 'active') {
          return { kind: 'ready', subscription };
        }
        if (!firstPaymentWentThrough(subscription)) break;
      }
      if (subscription.status === 'incomplete' && firstPaymentWentThrough(subscription)) {
        // Paid, not yet active. The update event from Stripe finishes it.
        throw new ArabicCheckoutError('payment_processing');
      }
    }

    const intent = paymentIntentOf(subscription);
    const lastError = intent?.last_payment_error;
    const definitelyNotPaid =
      intent?.status === 'requires_payment_method' ||
      intent?.status === 'canceled' ||
      // The browser ran the 3D Secure prompt and it is still waiting: abandoned.
      (intent?.status === 'requires_action' && options.afterAction);
    if (!definitelyNotPaid) {
      // Processing, or a state this code does not know. Not closed: a charge may
      // be about to succeed, and the webhook finishes it either way.
      throw new ArabicCheckoutError('payment_processing');
    }

    // Declined, or a 3D Secure prompt that was not completed. Nothing was charged,
    // and the half-made subscription is closed so it cannot linger.
    await closeUnpaidSubscription(stripe, subscription);
    throw new ArabicCheckoutError(
      lastError?.code ?? (options.afterAction ? 'payment_intent_authentication_failure' : 'card_declined'),
      lastError?.decline_code ?? null,
    );
  }

  if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') {
    const lastError = paymentIntentOf(subscription)?.last_payment_error;
    throw new ArabicCheckoutError(lastError?.code ?? 'card_declined', lastError?.decline_code ?? null);
  }

  // past_due, unpaid, paused: not something this checkout creates on purpose.
  throw new ArabicCheckoutError('processing_error');
}

/**
 * Closes a subscription whose first payment did not happen. The open invoice is
 * voided first (that also cancels its payment attempt), so a 3D Secure window
 * left open somewhere cannot still collect money for a cancelled subscription.
 * Both steps are best effort; a failure is logged, never thrown.
 */
async function closeUnpaidSubscription(stripe: ArabicCheckoutStripeApi, subscription: Loose) {
  const invoice = subscription?.latest_invoice;
  const invoiceId = typeof invoice === 'string' ? invoice : invoice?.id;
  if (invoiceId && stripe.voidInvoice && (typeof invoice === 'string' || invoice.status === 'open')) {
    try {
      await stripe.voidInvoice(String(invoiceId));
    } catch (error) {
      console.warn('Could not void the open invoice of an unpaid subscription', { invoiceId, error });
    }
  }
  try {
    await stripe.cancelSubscription(String(subscription.id));
  } catch (error) {
    console.error('Could not cancel an unpaid subscription', { subscriptionId: subscription.id, error });
  }
}

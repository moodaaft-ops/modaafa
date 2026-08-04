import Stripe from 'stripe';
import { isConfiguredEnv } from '@/lib/platform/env';
import { minorUnitsToAmount } from '@/lib/billing/invoices';

/**
 * Stripe billing utilities. Stripe is the ONLY payment provider in production.
 *
 * The Moyasar module was removed: nothing imported it, no webhook route
 * existed, `subscriptions.moyasar_subscription_id` was never read or written,
 * and its unverified HMAC scheme was a liability sitting in the repo waiting
 * for someone to wire it up. Reintroduce from current provider docs if needed.
 */

/**
 * NOTE: there is deliberately no `STRIPE_PRICE_ID` catch-all fallback.
 * A single default silently made every plan check out at the same price when
 * one of the six per-plan variables was missing, and `missing_price_slots` in
 * the health check tested the *resolved* value so it reported nothing wrong.
 * A missing slot must fail loudly instead.
 */
export const PLAN_PRICE_IDS: Record<string, Record<string, string | undefined>> = {
  starter: {
    monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY,
    yearly: process.env.STRIPE_PRICE_STARTER_YEARLY,
  },
  growth: {
    monthly: process.env.STRIPE_PRICE_GROWTH_MONTHLY,
    yearly: process.env.STRIPE_PRICE_GROWTH_YEARLY,
  },
  pro: {
    monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,
    yearly: process.env.STRIPE_PRICE_PRO_YEARLY,
  },
};

export type PlanKey = 'starter' | 'growth' | 'pro';
export type PeriodKey = 'monthly' | 'yearly';

/**
 * Reverse map price id → (plan, period).
 *
 * The local `plan` used to be read from `subscription.metadata`, a snapshot
 * written once at creation that Stripe never updates. A customer who
 * downgraded pro → starter through the Customer Portal kept `plan: 'pro'`
 * locally — paying the starter price while keeping pro quotas — and an
 * upgrade had the mirror-image problem.
 */
export function resolvePlanFromPriceId(priceId?: string | null): { plan: PlanKey; period: PeriodKey } | null {
  const normalized = priceId?.trim();
  if (!normalized) return null;

  for (const [plan, periods] of Object.entries(PLAN_PRICE_IDS)) {
    for (const [period, configured] of Object.entries(periods)) {
      if (configured?.trim() && configured.trim() === normalized) {
        return { plan: plan as PlanKey, period: period as PeriodKey };
      }
    }
  }
  return null;
}

/**
 * Look up the plan for a live subscription, preferring the price it is
 * actually billed on and falling back to creation metadata only when the
 * price is not one we recognise.
 */
export function planFromSubscription(subscription: Stripe.Subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id ?? null;
  const fromPrice = resolvePlanFromPriceId(priceId);
  if (fromPrice) return { ...fromPrice, source: 'price' as const };

  const metaPlan = subscription.metadata?.plan;
  const metaPeriod = subscription.metadata?.period;
  if (priceId) {
    console.warn(`Stripe price ${priceId} is not mapped to a Modaafa plan; falling back to metadata`);
  }

  return {
    plan: (['starter', 'growth', 'pro'].includes(String(metaPlan)) ? metaPlan : 'starter') as PlanKey,
    period: (['monthly', 'yearly'].includes(String(metaPeriod)) ? metaPeriod : 'monthly') as PeriodKey,
    source: 'metadata' as const,
  };
}

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!isConfiguredEnv(secretKey)) throw new Error('Missing STRIPE_SECRET_KEY');

  return new Stripe(secretKey.trim(), {
    apiVersion: '2025-02-24.acacia',
    typescript: true,
  });
}

export interface CheckoutParams {
  userId: string;
  email: string;
  plan: 'starter' | 'growth' | 'pro';
  period: 'monthly' | 'yearly';
  successUrl: string;
  cancelUrl: string;
  trialDays?: number;
  customerId?: string | null;
  idempotencyKey?: string;
}

export async function createCheckoutSession(params: CheckoutParams) {
  const priceId = PLAN_PRICE_IDS[params.plan]?.[params.period];
  if (!isConfiguredEnv(priceId)) {
    throw new Error(`Missing Stripe price for plan/period: ${params.plan}/${params.period}`);
  }

  const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
    metadata: {
      userId: params.userId,
      plan: params.plan,
      period: params.period,
    },
  };
  // Omitting `trial_period_days` does NOT mean "no trial": Stripe then applies
  // whatever default trial the Price carries (`recurring.trial_period_days`).
  // A user who had already used their one free trial could get a second one
  // purely from a dashboard setting. Checkout has no "zero days" value, so the
  // invariant is asserted in checkStripeConfiguration() instead — a price with
  // a built-in trial makes the readiness check fail.
  if (params.trialDays && params.trialDays > 0) {
    subscriptionData.trial_period_days = params.trialDays;
  }

  const session: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId.trim(), quantity: 1 }],
    subscription_data: subscriptionData,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: {
      userId: params.userId,
      plan: params.plan,
      period: params.period,
    },
    // Stripe's canonical user-linkage field; makes the Dashboard and every
    // reporting export able to answer "who is this?" without metadata.
    client_reference_id: params.userId,
    allow_promotion_codes: true,
  };

  // Always pass an explicit customer id when we have one. `customer_email` in
  // subscription mode makes Stripe mint a BRAND NEW Customer per completed
  // session — it never looks one up by email — so two concurrent checkouts
  // produced two customers, two live subscriptions and two charges.
  if (params.customerId) session.customer = params.customerId;
  else session.customer_email = params.email;

  return getStripe().checkout.sessions.create(
    session,
    params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined
  );
}

export async function createBillingPortalSession(customerId: string, returnUrl: string) {
  return getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

export async function cancelStripeSubscription(subscriptionId: string) {
  return getStripe().subscriptions.cancel(subscriptionId);
}

export async function retrieveStripeSubscription(subscriptionId: string) {
  return getStripe().subscriptions.retrieve(subscriptionId);
}

export async function retrieveCheckoutSession(sessionId: string) {
  return getStripe().checkout.sessions.retrieve(sessionId, {
    expand: ['subscription'],
  });
}

export function constructWebhookEvent(payload: string | Buffer, signature: string): Stripe.Event {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!isConfiguredEnv(webhookSecret)) throw new Error('Missing STRIPE_WEBHOOK_SECRET');

  return getStripe().webhooks.constructEvent(payload, signature, webhookSecret.trim());
}

const REQUIRED_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  // The single highest-value billing notification: three days before a
  // trialing user's first real charge.
  'customer.subscription.trial_will_end',
] as const;

/**
 * Resolve (or create) the one Stripe Customer for a user.
 *
 * Called before checkout so the session always carries an explicit customer
 * id. Without this, two concurrent checkouts each fell back to
 * `customer_email` and Stripe created two Customers, two subscriptions, and
 * charged the user twice.
 */
export async function ensureStripeCustomer(params: {
  userId: string;
  email: string;
  existingCustomerId?: string | null;
}) {
  const stripe = getStripe();

  if (params.existingCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(params.existingCustomerId);
      if (!('deleted' in existing) || !existing.deleted) return params.existingCustomerId;
    } catch {
      // Falls through to search/create — the stored id no longer resolves.
    }
  }

  // Look for a customer we previously created for this user before making a
  // new one, so a retry after a crash does not duplicate.
  try {
    const found = await stripe.customers.search({
      query: `metadata['modaafaUserId']:'${params.userId}'`,
      limit: 1,
    });
    const match = found.data[0];
    if (match && !match.deleted) return match.id;
  } catch (error) {
    console.warn('Stripe customer search unavailable; creating a new customer', error);
  }

  const created = await stripe.customers.create(
    {
      email: params.email,
      metadata: { modaafaUserId: params.userId },
    },
    // Same user → same key → Stripe returns the first customer instead of a
    // second one, even under a genuine double submit.
    { idempotencyKey: `modaafa-customer:${params.userId}` }
  );

  return created.id;
}

export type PlanPriceAmount = { amount: number; currency: string } | null;
export type PlanPriceAmounts = Record<PlanKey, Record<PeriodKey, PlanPriceAmount>>;

let priceAmountsCache: { at: number; data: PlanPriceAmounts } | null = null;
const PRICE_AMOUNTS_TTL_MS = 60 * 60 * 1000;

/**
 * Live display amounts for the pricing cards, read from the same six Stripe
 * prices checkout actually bills. The yearly amounts were previously
 * unpurchasable AND undisplayable because the UI hardcoded monthly numbers —
 * hardcoding yearly ones too would just create a second copy that drifts from
 * Stripe. Failure here must never break the billing page, so errors degrade to
 * `null` (the page then falls back to its static monthly copy).
 */
export async function getPlanPriceAmounts(): Promise<PlanPriceAmounts | null> {
  if (priceAmountsCache && Date.now() - priceAmountsCache.at < PRICE_AMOUNTS_TTL_MS) {
    return priceAmountsCache.data;
  }

  try {
    const stripe = getStripe();
    const slots = Object.entries(PLAN_PRICE_IDS).flatMap(([plan, periods]) =>
      Object.entries(periods).map(([period, priceId]) => ({
        plan: plan as PlanKey,
        period: period as PeriodKey,
        priceId: isConfiguredEnv(priceId) ? priceId.trim() : null,
      })),
    );

    const resolved = await Promise.all(
      slots.map(async (slot): Promise<[PlanKey, PeriodKey, PlanPriceAmount]> => {
        if (!slot.priceId) return [slot.plan, slot.period, null];
        try {
          const price = await stripe.prices.retrieve(slot.priceId);
          if (!price.active || typeof price.unit_amount !== 'number') {
            return [slot.plan, slot.period, null];
          }
          return [
            slot.plan,
            slot.period,
            { amount: minorUnitsToAmount(price.unit_amount, price.currency), currency: price.currency },
          ];
        } catch {
          return [slot.plan, slot.period, null];
        }
      }),
    );

    const data = { starter: {}, growth: {}, pro: {} } as PlanPriceAmounts;
    for (const [plan, period, amount] of resolved) data[plan][period] = amount;
    priceAmountsCache = { at: Date.now(), data };
    return data;
  } catch (error) {
    console.error('Failed to load Stripe price amounts for the billing page', error);
    return priceAmountsCache?.data ?? null;
  }
}

export async function checkStripeConfiguration() {
  if (!isConfiguredEnv(process.env.STRIPE_SECRET_KEY)) {
    return { ok: false, configured: false, status: 'secret_key_missing' };
  }

  try {
    const stripe = getStripe();
    const configuredPrices = Object.entries(PLAN_PRICE_IDS).flatMap(([plan, periods]) =>
      Object.entries(periods).map(([period, priceId]) => ({ plan, period, priceId })),
    );
    const uniquePriceIds = Array.from(
      new Set(configuredPrices.map(({ priceId }) => priceId?.trim()).filter(Boolean) as string[]),
    );
    const expectedWebhookUrl = `${(process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')}/api/webhooks/stripe`;

    const [account, prices, webhookEndpoints] = await Promise.all([
      stripe.accounts.retrieve(),
      Promise.all(
        uniquePriceIds.map(async (priceId) => {
          try {
            const price = await stripe.prices.retrieve(priceId);
            const slot = configuredPrices.find(({ priceId: id }) => id?.trim() === priceId);
            const expectedInterval = slot?.period === 'yearly' ? 'year' : 'month';
            const interval = price.recurring?.interval ?? null;
            const builtInTrialDays = price.recurring?.trial_period_days ?? null;
            return {
              id: price.id,
              // Interval is asserted so that swapping the monthly and yearly
              // env values — undetectable before — fails the readiness check
              // instead of billing a yearly amount on a "/ شهر" button.
              ok:
                price.active &&
                price.type === 'recurring' &&
                interval === expectedInterval &&
                !builtInTrialDays,
              active: price.active,
              livemode: price.livemode,
              currency: price.currency,
              unit_amount: price.unit_amount,
              interval,
              expected_interval: expectedInterval,
              built_in_trial_days: builtInTrialDays,
            };
          } catch {
            return {
              id: priceId,
              ok: false,
              active: false,
              livemode: null,
              error: 'price_unavailable',
            };
          }
        }),
      ),
      stripe.webhookEndpoints.list({ limit: 100 }),
    ]);

    const endpoint = webhookEndpoints.data.find(
      (candidate) => candidate.url === expectedWebhookUrl && candidate.status === 'enabled',
    );
    const enabledEvents = new Set(endpoint?.enabled_events ?? []);
    const missingEvents = REQUIRED_WEBHOOK_EVENTS.filter(
      (event) => !enabledEvents.has('*') && !enabledEvents.has(event),
    );
    const missingPriceSlots = configuredPrices
      .filter(({ priceId }) => !isConfiguredEnv(priceId))
      .map(({ plan, period }) => `${plan}/${period}`);
    const pricesOk = prices.length > 0 && prices.every((price) => price.ok);
    const webhookOk = Boolean(endpoint) && missingEvents.length === 0;
    const livemode = prices.length > 0 ? prices.every((price) => price.livemode === true) : null;
    // `livemode` used to be reported but never enforced, so a production
    // deploy carrying a test-mode key and test prices still answered
    // `launch_ready: true`.
    const modeOk = process.env.NODE_ENV === 'production' ? livemode === true : true;

    return {
      ok:
        account.charges_enabled &&
        account.details_submitted &&
        missingPriceSlots.length === 0 &&
        pricesOk &&
        webhookOk &&
        modeOk,
      configured: true,
      status: 'checked',
      livemode,
      mode_ok: modeOk,
      account: {
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        details_submitted: account.details_submitted,
        country: account.country,
      },
      prices,
      missing_price_slots: missingPriceSlots,
      webhook: {
        ok: webhookOk,
        url: expectedWebhookUrl,
        status: endpoint?.status ?? 'missing',
        missing_events: missingEvents,
      },
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      status: 'request_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

import Stripe from 'stripe';

/**
 * Stripe billing utilities for international customers.
 * Saudi customers use Moyasar (lib/billing/moyasar.ts) for STC Pay + mada cards.
 */

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
  typescript: true,
});

const DEFAULT_PRICE_ID = process.env.STRIPE_PRICE_ID;

export const PLAN_PRICE_IDS: Record<string, Record<string, string | undefined>> = {
  starter: {
    monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY ?? DEFAULT_PRICE_ID,
    yearly: process.env.STRIPE_PRICE_STARTER_YEARLY ?? DEFAULT_PRICE_ID,
  },
  growth: {
    monthly: process.env.STRIPE_PRICE_GROWTH_MONTHLY ?? DEFAULT_PRICE_ID,
    yearly: process.env.STRIPE_PRICE_GROWTH_YEARLY ?? DEFAULT_PRICE_ID,
  },
  pro: {
    monthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? DEFAULT_PRICE_ID,
    yearly: process.env.STRIPE_PRICE_PRO_YEARLY ?? DEFAULT_PRICE_ID,
  },
};

export interface CheckoutParams {
  userId: string;
  email: string;
  plan: 'starter' | 'growth' | 'pro';
  period: 'monthly' | 'yearly';
  successUrl: string;
  cancelUrl: string;
  trialDays?: number;
}

export async function createCheckoutSession(params: CheckoutParams) {
  const priceId = PLAN_PRICE_IDS[params.plan]?.[params.period];
  if (!priceId) throw new Error(`Missing Stripe price for plan/period: ${params.plan}/${params.period}`);

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: params.email,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: params.trialDays ?? 14,
      metadata: {
        userId: params.userId,
        plan: params.plan,
        period: params.period,
      },
    },
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: { userId: params.userId },
    allow_promotion_codes: true,
  });
}

export async function createBillingPortalSession(customerId: string, returnUrl: string) {
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

export function constructWebhookEvent(payload: string | Buffer, signature: string): Stripe.Event {
  return stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET!);
}

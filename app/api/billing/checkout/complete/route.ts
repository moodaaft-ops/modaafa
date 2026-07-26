import { NextRequest, NextResponse } from 'next/server';
import { retrieveCheckoutSession, retrieveStripeSubscription } from '@/lib/billing/stripe';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { recordTrialGrant } from '@/lib/billing/checkout-policy';

export const runtime = 'nodejs';

/**
 * Stripe redirects here after Checkout. The webhook remains the primary event
 * source, while this verified readback makes activation resilient to delayed
 * webhook delivery.
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('session_id');
  if (!sessionId?.startsWith('cs_')) return billingError(req, 'invalid_session');

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login?error=session_expired', req.url));
  }

  try {
    const checkout = await retrieveCheckoutSession(sessionId);
    if (
      checkout.status !== 'complete' ||
      checkout.mode !== 'subscription' ||
      checkout.metadata?.userId !== user.id
    ) {
      return billingError(req, 'invalid_session');
    }

    const subscriptionId =
      typeof checkout.subscription === 'string'
        ? checkout.subscription
        : checkout.subscription?.id;
    if (!subscriptionId) return billingError(req, 'subscription_missing');

    const subscription =
      typeof checkout.subscription === 'object' && checkout.subscription
        ? checkout.subscription
        : await retrieveStripeSubscription(subscriptionId);

    const plan = normalizePlan(checkout.metadata?.plan ?? subscription.metadata?.plan);
    const period = normalizePeriod(checkout.metadata?.period ?? subscription.metadata?.period);
    const admin = createAdminClient();
    const { error } = await admin.from('subscriptions').upsert(
      {
        user_id: user.id,
        plan,
        billing_period: period,
        status: normalizeStatus(subscription.status),
        stripe_subscription_id: subscription.id,
        stripe_customer_id:
          typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer?.id,
        trial_ends_at: stripeTimestamp(subscription.trial_end),
        current_period_start: stripeTimestamp(subscription.current_period_start),
        current_period_end: stripeTimestamp(subscription.current_period_end),
      },
      { onConflict: 'stripe_subscription_id' },
    );
    if (error) throw error;
    if (subscription.trial_end) {
      await recordTrialGrant({
        supabase: admin,
        userId: user.id,
        stripeSubscriptionId: subscription.id,
        source: 'checkout_complete',
      });
    }

    return NextResponse.redirect(new URL('/dashboard?subscribed=1', req.url));
  } catch (error) {
    console.error('Failed to activate Stripe Checkout session', {
      sessionId,
      userId: user.id,
      error,
    });
    return billingError(req, 'activation_failed');
  }
}

function billingError(req: NextRequest, error: string) {
  return NextResponse.redirect(new URL(`/billing?error=${encodeURIComponent(error)}`, req.url));
}

function normalizePlan(value?: string | null): 'starter' | 'growth' | 'pro' {
  return value === 'growth' || value === 'pro' ? value : 'starter';
}

function normalizePeriod(value?: string | null): 'monthly' | 'yearly' {
  return value === 'yearly' ? 'yearly' : 'monthly';
}

function normalizeStatus(status?: string) {
  if (status === 'trialing' || status === 'active' || status === 'past_due' || status === 'paused') {
    return status;
  }
  if (status === 'canceled') return 'canceled';
  if (status === 'unpaid' || status === 'incomplete') return 'past_due';
  return 'paused';
}

function stripeTimestamp(value?: number | null) {
  return value ? new Date(value * 1000).toISOString() : null;
}

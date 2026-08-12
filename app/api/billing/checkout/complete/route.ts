import { NextRequest, NextResponse } from 'next/server';
import {
  planFromSubscription,
  retrieveCheckoutSession,
  retrieveStripeSubscription,
} from '@/lib/billing/stripe';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { recordTrialGrant } from '@/lib/billing/checkout-policy';
import {
  applySubscriptionEvent,
  LiveSubscriptionConflictError,
} from '@/lib/billing/subscription-events';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { sendOpsAlert } from '@/lib/notifications/email';

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
    const rateLimit = await checkRateLimit({
      req,
      scope: 'billing_checkout_complete',
      limit: 12,
      windowSeconds: 3600,
      identifier: user.id,
    });
    if (!rateLimit.allowed) {
      return billingError(req, 'too_many_requests', rateLimitHeaders(rateLimit));
    }
  } catch {
    return billingError(req, 'security_service_unavailable');
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

    // Derive the plan from the PRICE the subscription is actually billed on,
    // not from checkout metadata. Metadata is a creation-time snapshot Stripe
    // never updates, so a user who changed plans in the Customer Portal and
    // then landed back on this success URL would have the stale metadata plan
    // written over the correct price-derived one.
    const { plan, period } = planFromSubscription(subscription);
    const admin = createAdminClient();
    // Route the write through the same ordering-guarded path the webhook uses.
    // A bare upsert here skipped the `last_event_at` guard entirely and could
    // clobber a newer webhook-applied state with this readback. Using
    // current_period_start as the event time keeps this fallback a floor: a
    // real webhook (event.created) always sorts newer and wins.
    const periodStart = stripeTimestamp(subscription.current_period_start);
    await applySubscriptionEvent(admin, {
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
      current_period_start: periodStart,
      current_period_end: stripeTimestamp(subscription.current_period_end),
      last_event_at: periodStart ?? new Date(0).toISOString(),
    });
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
    if (error instanceof LiveSubscriptionConflictError) {
      await safeOpsAlert({
        subject: 'تعارض اشتراك Stripe حي',
        message: 'وصل اشتراك ثانٍ لمستخدم لديه اشتراك حي مختلف. لم يُخفَ التعارض ويحتاج مراجعة Stripe.',
        details: {
          user_id: error.userId,
          incoming_subscription_id: error.incomingSubscriptionId,
          source: 'checkout_complete',
        },
      });
      return billingError(req, 'subscription_conflict');
    }
    console.error('Failed to activate Stripe Checkout session', {
      sessionId,
      userId: user.id,
      error,
    });
    return billingError(req, 'activation_failed');
  }
}

function billingError(req: NextRequest, error: string, headers?: Record<string, string>) {
  return NextResponse.redirect(
    new URL(`/billing?error=${encodeURIComponent(error)}`, req.url),
    { status: 303, headers },
  );
}

async function safeOpsAlert(payload: Parameters<typeof sendOpsAlert>[0]) {
  try {
    await sendOpsAlert(payload);
  } catch (error) {
    console.error('Failed to send Stripe subscription-conflict alert', error);
  }
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

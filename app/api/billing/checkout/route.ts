import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { arabicCheckoutStripe, createCheckoutSession, ensureStripeCustomer } from '@/lib/billing/stripe';
import { refereeGiftPromotion } from '@/lib/partners/gift';

import { requireAppUrl } from '@/lib/platform/env';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { checkoutTrialDecision, getBillingCheckoutContext } from '@/lib/billing/checkout-policy';
import { isSameOriginRequest } from '@/lib/security/origin';
import { isModaafaOperator } from '@/lib/platform/operators';
import { readAccessOverrides } from '@/lib/billing/access-overrides';
import { ACCOUNT_SUSPENDED_MESSAGE } from '@/lib/billing/entitlements';
import { hasActiveGoogleAdsAccount } from '@/lib/accounts/selection';

/**
 * POST /api/billing/checkout
 * Body: { plan: "starter"|"growth"|"pro", period: "monthly"|"yearly" }
 *
 * Creates a Stripe Checkout session and returns the URL to redirect to.
 */
export async function POST(req: NextRequest) {

  // Defence in depth against cross-site POSTs; see lib/security/origin.ts.
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  }
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const rateLimit = await checkRateLimit({ req, scope: 'billing_checkout', limit: 8, windowSeconds: 3600, identifier: user.id });
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rateLimit) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const isForm = req.headers.get('content-type')?.includes('application/x-www-form-urlencoded');
  if (isModaafaOperator(user.email)) {
    if (isForm) {
      return NextResponse.redirect(new URL('/billing?error=internal_access', req.url), 303);
    }
    return NextResponse.json({ error: 'internal_access' }, { status: 409 });
  }
  // A suspended account cannot start a new subscription until an operator
  // lifts the suspension (the banner on every page says how to reach us).
  if ((await readAccessOverrides(supabase, user.id)).suspended) {
    if (isForm) return NextResponse.redirect(new URL('/billing?error=account_suspended', req.url), 303);
    return NextResponse.json({ error: 'account_suspended', message: ACCOUNT_SUSPENDED_MESSAGE }, { status: 403 });
  }
  const payload = isForm ? Object.fromEntries((await req.formData()).entries()) : await req.json();
  const { plan, period } = payload;
  if (!['starter', 'growth', 'pro'].includes(plan)) {
    return NextResponse.json({ error: 'invalid_plan' }, { status: 400 });
  }
  if (!['monthly', 'yearly'].includes(period)) {
    return NextResponse.json({ error: 'invalid_period' }, { status: 400 });
  }

  // Never fall back to the request origin: that is derived from the Host
  // header, so a spoofed host would steer Stripe's post-payment redirect
  // (with session_id attached) to a domain the attacker controls.
  let baseUrl: string;
  try {
    baseUrl = requireAppUrl(req.nextUrl.origin);
  } catch {
    return NextResponse.json({ error: 'app_url_not_configured' }, { status: 503 });
  }

  try {
    const billing = await getBillingCheckoutContext(supabase, user.id, user.email);
    if (billing.activeSubscriptionId) {
      if (isForm) {
        return NextResponse.redirect(new URL('/billing?error=already_subscribed', req.url), 303);
      }
      return NextResponse.json({ error: 'already_subscribed' }, { status: 409 });
    }

    // A trial with no linked, active Google Ads account can never produce a
    // plan or a recommendation, so it only burns the one-time trial.
    if (!(await hasActiveGoogleAdsAccount(supabase, user.id))) {
      if (isForm) {
        return NextResponse.redirect(new URL('/billing?error=google_ads_account_required', req.url), 303);
      }
      return NextResponse.json({ error: 'google_ads_account_required' }, { status: 409 });
    }

    // The eligibility check could not run. Do not fall through to a paid session:
    // that would turn a first-time trial into an immediate charge.
    const trialDecision = checkoutTrialDecision(billing);
    if (trialDecision.action === 'blocked') {
      if (isForm) {
        return NextResponse.redirect(new URL(`/billing?error=${trialDecision.error}`, req.url), 303);
      }
      return NextResponse.json({ error: trialDecision.error }, { status: 503 });
    }

    // Resolve the Stripe Customer BEFORE creating the session so the session
    // always carries an explicit id. Falling back to `customer_email` made
    // Stripe mint a new Customer per completed session, which is how two
    // concurrent checkouts turned into two live subscriptions and two charges.
    const customerId = await ensureStripeCustomer({
      userId: user.id,
      email: user.email!,
      existingCustomerId: billing.stripeCustomerId,
    });

    // A customer who came through a partner link gets the welcome discount when one
    // is configured (null in every other case, and it never blocks the checkout).
    const gift = await refereeGiftPromotion(
      { getDb: createAdminClient, stripe: arabicCheckoutStripe },
      { userId: user.id, customerId },
    );
    const session = await createCheckoutSession({
      userId: user.id,
      email: user.email!,
      plan,
      period,
      successUrl: `${baseUrl}/api/billing/checkout/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/billing?canceled=1`,
      trialDays: trialDecision.trialDays,
      customerId,
      promotionCodeId: gift?.id ?? null,
      idempotencyKey: checkoutIdempotencyKey(user.id, plan, period, gift?.id ?? null),
    });

    if (isForm && session.url) {
      return NextResponse.redirect(session.url, 303);
    }

    return NextResponse.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('Checkout failed', err);
    if (isForm) {
      return NextResponse.redirect(new URL('/billing?error=checkout_failed', req.url), 303);
    }
    return NextResponse.json({ error: 'checkout_failed' }, { status: 500 });
  }
}

function checkoutIdempotencyKey(userId: string, plan: string, period: string, promotionCodeId: string | null = null) {
  // Bucketed by 15 minutes rather than by wall-clock hour: the old
  // `Math.floor(Date.now() / 3600000)` rolled over at :00, so two identical
  // requests one second apart across the boundary were not idempotent at all.
  // A floating window still collapses the realistic double-submit case.
  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  return createHash('sha256')
    .update(`modaafa-checkout:${userId}:${plan}:${period}:${bucket}${promotionCodeId ? `:${promotionCodeId}` : ''}`)
    .digest('hex');
}

import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { createCheckoutSession, ensureStripeCustomer } from '@/lib/billing/stripe';
import { requireAppUrl } from '@/lib/platform/env';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { getBillingCheckoutContext } from '@/lib/billing/checkout-policy';
import { isSameOriginRequest } from '@/lib/security/origin';
import { isModaafaOperator } from '@/lib/platform/operators';

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

    // Resolve the Stripe Customer BEFORE creating the session so the session
    // always carries an explicit id. Falling back to `customer_email` made
    // Stripe mint a new Customer per completed session, which is how two
    // concurrent checkouts turned into two live subscriptions and two charges.
    const customerId = await ensureStripeCustomer({
      userId: user.id,
      email: user.email!,
      existingCustomerId: billing.stripeCustomerId,
    });

    const session = await createCheckoutSession({
      userId: user.id,
      email: user.email!,
      plan,
      period,
      successUrl: `${baseUrl}/api/billing/checkout/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/billing?canceled=1`,
      trialDays: billing.trialEligible ? 14 : 0,
      customerId,
      idempotencyKey: checkoutIdempotencyKey(user.id, plan, period),
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

function checkoutIdempotencyKey(userId: string, plan: string, period: string) {
  // Bucketed by 15 minutes rather than by wall-clock hour: the old
  // `Math.floor(Date.now() / 3600000)` rolled over at :00, so two identical
  // requests one second apart across the boundary were not idempotent at all.
  // A floating window still collapses the realistic double-submit case.
  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  return createHash('sha256')
    .update(`modaafa-checkout:${userId}:${plan}:${period}:${bucket}`)
    .digest('hex');
}

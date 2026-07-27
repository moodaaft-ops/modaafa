import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { createCheckoutSession, ensureStripeCustomer } from '@/lib/billing/stripe';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { getBillingCheckoutContext } from '@/lib/billing/checkout-policy';
import { requireAppUrl } from '@/lib/platform/env';
import { isSameOriginRequest } from '@/lib/security/origin';

const plans = ['starter', 'growth', 'pro'];

export async function POST(req: NextRequest) {

  // Defence in depth against cross-site POSTs; see lib/security/origin.ts.
  if (!isSameOriginRequest(req)) {
    return NextResponse.redirect(new URL('/billing?error=invalid_origin', req.url), 303);
  }
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.redirect(new URL('/login', req.url), 303);

  try {
    const rateLimit = await checkRateLimit({ req, scope: 'billing_trial', limit: 5, windowSeconds: 3600, identifier: user.id });
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rateLimit) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const form = await req.formData();
  const plan = String(form.get('plan') ?? 'starter');
  const period = String(form.get('period') ?? 'monthly');

  if (!plans.includes(plan) || !['monthly', 'yearly'].includes(period)) {
    return NextResponse.redirect(new URL('/billing?error=invalid_plan', req.url), 303);
  }

  try {
    const billing = await getBillingCheckoutContext(supabase, user.id, user.email);
    if (billing.activeSubscriptionId) {
      return NextResponse.redirect(new URL('/billing?error=already_subscribed', req.url), 303);
    }

    const baseUrl = requireAppUrl(req.nextUrl.origin);
    // Explicit customer id, never customer_email — see the note in
    // lib/billing/stripe.ts: customer_email mints a new Customer per session.
    const customerId = await ensureStripeCustomer({
      userId: user.id,
      email: user.email!,
      existingCustomerId: billing.stripeCustomerId,
    });
    const session = await createCheckoutSession({
      userId: user.id,
      email: user.email!,
      plan: plan as 'starter' | 'growth' | 'pro',
      period: period as 'monthly' | 'yearly',
      successUrl: `${baseUrl}/api/billing/checkout/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/billing?canceled=1`,
      trialDays: billing.trialEligible ? 14 : 0,
      customerId,
      idempotencyKey: checkoutIdempotencyKey(user.id, plan, period),
    });

    if (!session.url) throw new Error('Stripe checkout session did not return a URL');
    return NextResponse.redirect(session.url, 303);
  } catch (error) {
    console.error('Failed to create trial checkout', error);
    return NextResponse.redirect(new URL('/billing?error=checkout_failed', req.url), 303);
  }
}

function checkoutIdempotencyKey(userId: string, plan: string, period: string) {
  // Same 15-minute bucket as /api/billing/checkout so the two entry points
  // cannot produce two sessions for the same intent.
  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  return createHash('sha256')
    .update(`modaafa-checkout:${userId}:${plan}:${period}:${bucket}`)
    .digest('hex');
}

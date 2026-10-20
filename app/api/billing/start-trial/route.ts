import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { arabicCheckoutStripe, createCheckoutSession, ensureStripeCustomer } from '@/lib/billing/stripe';
import { refereeGiftPromotion } from '@/lib/partners/gift';

import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import {
  checkoutTrialDecision,
  getBillingCheckoutContext,
  ONBOARDING_CHECKOUT_RETURN,
} from '@/lib/billing/checkout-policy';
import { requireAppUrl } from '@/lib/platform/env';
import { isSameOriginRequest } from '@/lib/security/origin';
import { isModaafaOperator } from '@/lib/platform/operators';
import { readAccessOverrides } from '@/lib/billing/access-overrides';
import { hasActiveGoogleAdsAccount } from '@/lib/accounts/selection';

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

  if (isModaafaOperator(user.email)) {
    return NextResponse.redirect(new URL('/billing?error=internal_access', req.url), 303);
  }
  if ((await readAccessOverrides(supabase, user.id)).suspended) {
    return NextResponse.redirect(new URL('/billing?error=account_suspended', req.url), 303);
  }

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
  // The onboarding trial step returns to its own screens instead of /billing.
  const fromOnboarding = form.get('return_to') === ONBOARDING_CHECKOUT_RETURN;
  const errorBase = fromOnboarding ? '/onboarding/trial' : '/billing';

  if (!plans.includes(plan) || !['monthly', 'yearly'].includes(period)) {
    return NextResponse.redirect(new URL(`${errorBase}?error=invalid_plan`, req.url), 303);
  }

  try {
    const billing = await getBillingCheckoutContext(supabase, user.id, user.email);
    if (billing.activeSubscriptionId) {
      return NextResponse.redirect(new URL(`${errorBase}?error=already_subscribed`, req.url), 303);
    }

    // No linked, active Google Ads account: starting a trial would only burn it.
    if (!(await hasActiveGoogleAdsAccount(supabase, user.id))) {
      return NextResponse.redirect(new URL(`${errorBase}?error=google_ads_account_required`, req.url), 303);
    }

    // The eligibility check could not run. Do not fall through to a paid session:
    // that would turn a first-time trial into an immediate charge.
    const trialDecision = checkoutTrialDecision(billing);
    if (trialDecision.action === 'blocked') {
      return NextResponse.redirect(new URL(`${errorBase}?error=${trialDecision.error}`, req.url), 303);
    }

    const baseUrl = requireAppUrl(req.nextUrl.origin);
    // Explicit customer id, never customer_email — see the note in
    // lib/billing/stripe.ts: customer_email mints a new Customer per session.
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
      plan: plan as 'starter' | 'growth' | 'pro',
      period: period as 'monthly' | 'yearly',
      successUrl: fromOnboarding
        ? `${baseUrl}/api/billing/checkout/complete?session_id={CHECKOUT_SESSION_ID}&return_to=${ONBOARDING_CHECKOUT_RETURN}`
        : `${baseUrl}/api/billing/checkout/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: fromOnboarding ? `${baseUrl}/onboarding/trial?canceled=1` : `${baseUrl}/billing?canceled=1`,
      trialDays: trialDecision.trialDays,
      customerId,
      promotionCodeId: gift?.id ?? null,
      idempotencyKey: checkoutIdempotencyKey(user.id, plan, period, gift?.id ?? null),
    });

    if (!session.url) throw new Error('Stripe checkout session did not return a URL');
    return NextResponse.redirect(session.url, 303);
  } catch (error) {
    console.error('Failed to create trial checkout', error);
    return NextResponse.redirect(new URL(`${errorBase}?error=checkout_failed`, req.url), 303);
  }
}

function checkoutIdempotencyKey(userId: string, plan: string, period: string, promotionCodeId: string | null = null) {
  // Same 15-minute bucket as /api/billing/checkout so the two entry points
  // cannot produce two sessions for the same intent.
  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  return createHash('sha256')
    .update(`modaafa-checkout:${userId}:${plan}:${period}:${bucket}${promotionCodeId ? `:${promotionCodeId}` : ''}`)
    .digest('hex');
}

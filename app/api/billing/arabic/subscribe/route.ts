import { NextRequest, NextResponse } from 'next/server';
import { arabicCheckoutStripe, ensureStripeCustomer } from '@/lib/billing/stripe';
import { resolvePromotionCode, startArabicSubscription } from '@/lib/billing/arabic-checkout/flow';
import { checkoutFailure, describeFailure, fullGate } from '@/lib/billing/arabic-checkout/gate';
import { finishArabicActivation } from '@/lib/billing/arabic-checkout/finish';
import { refereeGiftPromotion } from '@/lib/partners/gift';
import { createAdminClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/**
 * POST /api/billing/arabic/subscribe
 * Body: { setup_intent_id: "seti_...", promo_code?: string, return_to?: "onboarding" }
 *
 * Step 2: the browser has saved the card. Create the subscription from it.
 * Plan, period and price come from the SetupIntent this server made, and the trial
 * length is decided again here, so nothing the browser sends can change either.
 */
export async function POST(req: NextRequest) {
  const gate = await fullGate(req, 'billing_arabic_subscribe', 10);
  if (!gate.ok) return gate.response;

  let body: { setup_intent_id?: unknown; promo_code?: unknown; return_to?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // Falls through to setup_not_completed.
  }
  const setupIntentId = typeof body.setup_intent_id === 'string' ? body.setup_intent_id : '';
  if (!/^seti_[A-Za-z0-9]+$/.test(setupIntentId)) return checkoutFailure('setup_not_completed', 400);
  const promoCode = typeof body.promo_code === 'string' ? body.promo_code.trim() : '';

  try {
    const customerId = await ensureStripeCustomer({
      userId: gate.user.id,
      email: gate.user.email,
      existingCustomerId: gate.stripeCustomerId,
    });
    // A code the customer typed wins. With none, a customer who came through a
    // partner link gets the welcome discount (null whenever it cannot apply).
    const promotion = promoCode
      ? await resolvePromotionCode(arabicCheckoutStripe, promoCode, { customerId })
      : await refereeGiftPromotion(
          { getDb: createAdminClient, stripe: arabicCheckoutStripe },
          { userId: gate.user.id, customerId },
        );

    const start = (promotionCodeId: string | null, idempotencySuffix = '') =>
      startArabicSubscription(arabicCheckoutStripe, {
        userId: gate.user.id,
        customerId,
        setupIntentId,
        trialDays: gate.trialDays,
        promotionCodeId,
        idempotencySuffix,
      });
    let outcome;
    try {
      outcome = await start(promotion?.id ?? null);
    } catch (error) {
      // Stripe can refuse a code for reasons the lookup cannot see (a minimum
      // amount, first-purchase only). The welcome gift is a bonus the customer
      // never asked for, so it must not stop them subscribing: retry once
      // without it, under its own idempotency key. A code the customer typed
      // keeps failing loudly, as before.
      const rejected = (error as { type?: string } | null)?.type === 'StripeInvalidRequestError';
      if (promoCode || !promotion || !rejected) throw error;
      console.error('[partners] referee gift rejected by Stripe, retrying without it');
      outcome = await start(null, ':nogift');
    }

    if (outcome.kind === 'requires_action') {
      // Only the pay-now path gets here: the bank wants a 3D Secure check on the
      // first charge. The browser runs it and calls /finalize.
      return NextResponse.json({
        status: 'requires_action',
        client_secret: outcome.clientSecret,
        subscription_id: outcome.subscriptionId,
      });
    }

    return await finishArabicActivation({
      userId: gate.user.id,
      subscription: outcome.subscription,
      returnTo: body.return_to,
    });
  } catch (error) {
    const failure = describeFailure(error);
    console.error('Arabic checkout subscribe failed', { code: failure.input.code, decline: failure.input.decline_code });
    return checkoutFailure(failure.input, failure.status);
  }
}

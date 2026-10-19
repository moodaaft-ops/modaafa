import { NextRequest, NextResponse } from 'next/server';
import { arabicCheckoutStripe, ensureStripeCustomer } from '@/lib/billing/stripe';
import { createArabicSetupIntent } from '@/lib/billing/arabic-checkout/flow';
import { checkoutFailure, describeFailure, fullGate } from '@/lib/billing/arabic-checkout/gate';

export const runtime = 'nodejs';

/**
 * POST /api/billing/arabic/intent
 * Body: { plan: "starter"|"growth"|"pro", period: "monthly"|"yearly" }
 *
 * Step 1 of the in-platform checkout: runs every gate the hosted checkout runs,
 * then creates a SetupIntent so the browser can take the card. Nothing is
 * charged and no subscription exists after this call.
 */
export async function POST(req: NextRequest) {
  const gate = await fullGate(req, 'billing_arabic_intent', 15);
  if (!gate.ok) return gate.response;

  let body: { plan?: unknown; period?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // An unreadable body fails the plan check below.
  }
  const plan = body.plan;
  const period = body.period;
  if (plan !== 'starter' && plan !== 'growth' && plan !== 'pro') return checkoutFailure('invalid_plan', 400);
  if (period !== 'monthly' && period !== 'yearly') return checkoutFailure('invalid_period', 400);

  try {
    const customerId = await ensureStripeCustomer({
      userId: gate.user.id,
      email: gate.user.email,
      existingCustomerId: gate.stripeCustomerId,
    });
    const intent = await createArabicSetupIntent(arabicCheckoutStripe, {
      userId: gate.user.id,
      customerId,
      plan,
      period,
      trialDays: gate.trialDays,
    });
    return NextResponse.json({
      client_secret: intent.clientSecret,
      setup_intent_id: intent.setupIntentId,
      plan,
      period,
      trial_days: gate.trialDays,
    });
  } catch (error) {
    const failure = describeFailure(error);
    console.error('Arabic checkout intent failed', { code: failure.input.code, error });
    return checkoutFailure(failure.input, failure.status);
  }
}

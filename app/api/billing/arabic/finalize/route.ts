import { NextRequest } from 'next/server';
import { arabicCheckoutStripe, ensureStripeCustomer } from '@/lib/billing/stripe';
import { finalizeArabicSubscription } from '@/lib/billing/arabic-checkout/flow';
import { checkoutFailure, describeFailure, lightGate } from '@/lib/billing/arabic-checkout/gate';
import { finishArabicActivation } from '@/lib/billing/arabic-checkout/finish';

export const runtime = 'nodejs';

/**
 * POST /api/billing/arabic/finalize
 * Body: { subscription_id: "sub_...", return_to?: "onboarding" }
 *
 * Step 3, only after the bank asked for a 3D Secure check on the first payment.
 * The browser has run the check; this reads the result from Stripe (never from
 * the browser) and activates the subscription if the payment went through, or
 * closes it if not.
 *
 * It uses the light gate on purpose: the webhook may already have written the
 * subscription, and "already subscribed" must not turn a finished payment into an
 * error. Activation is idempotent.
 */
export async function POST(req: NextRequest) {
  const gate = await lightGate(req, 'billing_arabic_finalize', 12);
  if (!gate.ok) return gate.response;
  if (!gate.user.email) return checkoutFailure('unauthorized', 401);

  let body: { subscription_id?: unknown; return_to?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // Falls through below.
  }
  const subscriptionId = typeof body.subscription_id === 'string' ? body.subscription_id : '';
  if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) return checkoutFailure('setup_not_completed', 400);

  try {
    const customerId = await ensureStripeCustomer({ userId: gate.user.id, email: gate.user.email });
    const subscription = await finalizeArabicSubscription(arabicCheckoutStripe, {
      userId: gate.user.id,
      customerId,
      subscriptionId,
    });
    return await finishArabicActivation({ userId: gate.user.id, subscription, returnTo: body.return_to });
  } catch (error) {
    const failure = describeFailure(error);
    console.error('Arabic checkout finalize failed', { code: failure.input.code, decline: failure.input.decline_code });
    return checkoutFailure(failure.input, failure.status);
  }
}

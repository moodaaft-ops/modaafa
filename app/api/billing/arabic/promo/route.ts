import { NextRequest, NextResponse } from 'next/server';
import { arabicCheckoutStripe, ensureStripeCustomer, getPlanPriceAmounts } from '@/lib/billing/stripe';
import { firstChargeAfterDiscount, resolvePromotionCode } from '@/lib/billing/arabic-checkout/flow';
import { checkoutFailure, describeFailure, lightGate } from '@/lib/billing/arabic-checkout/gate';

export const runtime = 'nodejs';

/**
 * POST /api/billing/arabic/promo
 * Body: { code: string, plan, period }
 *
 * Previews a discount code for the page. It changes nothing: the code is looked
 * up again, by the same function, when the subscription is created.
 */
export async function POST(req: NextRequest) {
  const gate = await lightGate(req, 'billing_arabic_promo', 30);
  if (!gate.ok) return gate.response;
  if (!gate.user.email) return checkoutFailure('unauthorized', 401);

  let body: { code?: unknown; plan?: unknown; period?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // Falls through to promo_invalid.
  }
  const { plan, period } = body;
  if (plan !== 'starter' && plan !== 'growth' && plan !== 'pro') return checkoutFailure('invalid_plan', 400);
  if (period !== 'monthly' && period !== 'yearly') return checkoutFailure('invalid_period', 400);

  try {
    const customerId = await ensureStripeCustomer({ userId: gate.user.id, email: gate.user.email });
    const promotion = await resolvePromotionCode(arabicCheckoutStripe, String(body.code ?? ''), { customerId });
    const price = (await getPlanPriceAmounts())?.[plan]?.[period] ?? null;
    return NextResponse.json({
      label: promotion.label,
      first_charge_amount: price ? firstChargeAfterDiscount(price.amount, price.currency, promotion) : null,
      currency: price?.currency ?? null,
    });
  } catch (error) {
    const failure = describeFailure(error);
    return checkoutFailure(failure.input, failure.status);
  }
}

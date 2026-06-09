import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { createCheckoutSession } from '@/lib/billing/stripe';

/**
 * POST /api/billing/checkout
 * Body: { plan: "starter"|"growth"|"pro", period: "monthly"|"yearly" }
 *
 * Creates a Stripe Checkout session and returns the URL to redirect to.
 */
export async function POST(req: NextRequest) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const isForm = req.headers.get('content-type')?.includes('application/x-www-form-urlencoded');
  const payload = isForm ? Object.fromEntries((await req.formData()).entries()) : await req.json();
  const { plan, period } = payload;
  if (!['starter', 'growth', 'pro'].includes(plan)) {
    return NextResponse.json({ error: 'invalid_plan' }, { status: 400 });
  }
  if (!['monthly', 'yearly'].includes(period)) {
    return NextResponse.json({ error: 'invalid_period' }, { status: 400 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL!;

  try {
    const session = await createCheckoutSession({
      userId: user.id,
      email: user.email!,
      plan,
      period,
      successUrl: `${baseUrl}/dashboard?subscribed=1&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/billing?canceled=1`,
      trialDays: 14,
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

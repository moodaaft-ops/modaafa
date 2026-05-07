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

  const { plan, period } = await req.json();
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

    return NextResponse.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('Checkout failed', err);
    return NextResponse.json({ error: 'checkout_failed' }, { status: 500 });
  }
}

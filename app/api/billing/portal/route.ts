import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { createBillingPortalSession } from '@/lib/billing/stripe';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { requireAppUrl } from '@/lib/platform/env';

export async function POST(req: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.redirect(new URL('/login', req.url), 303);

  try {
    const rateLimit = await checkRateLimit({
      req,
      scope: 'billing_portal',
      limit: 10,
      windowSeconds: 300,
      identifier: user.id,
    });
    if (!rateLimit.allowed) {
      return NextResponse.redirect(new URL('/billing?error=too_many_requests', req.url), 303);
    }
  } catch {
    return NextResponse.redirect(new URL('/billing?error=security_service_unavailable', req.url), 303);
  }

  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .not('stripe_customer_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!subscription?.stripe_customer_id) {
    return NextResponse.redirect(new URL('/billing?error=no_stripe_customer', req.url), 303);
  }

  try {
    const baseUrl = requireAppUrl(req.nextUrl.origin);
    const portal = await createBillingPortalSession(subscription.stripe_customer_id, `${baseUrl}/billing`);
    return NextResponse.redirect(portal.url, 303);
  } catch (error) {
    console.error('Failed to create Stripe billing portal session', error);
    return NextResponse.redirect(new URL('/billing?error=portal_failed', req.url), 303);
  }
}

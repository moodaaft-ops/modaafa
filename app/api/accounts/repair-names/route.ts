import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { getUserBusinessWithClient } from '@/lib/accounts/selection';
import { repairMissingGoogleAdsMetadata } from '@/lib/accounts/metadata-repair';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';

export const maxDuration = 300;

export async function POST(req: NextRequest) {

  // Defence in depth against cross-site POSTs; see lib/security/origin.ts.
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  }
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.redirect(new URL('/login', req.url), 303);

  try {
    const rateLimit = await checkRateLimit({ req, scope: 'account_name_repair', limit: 5, windowSeconds: 3600, identifier: user.id });
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rateLimit) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  // Every other endpoint that reaches the Google Ads API gates on an active
  // subscription first. This one issues a full discoverAccessibleCustomers()
  // (an MCC tree walk) per refresh token, so without the gate an expired or
  // never-subscribed user could burn shared developer-token QPS at will.
  const access = await getSubscriptionAccess(supabase, user.id);
  if (!access.active) {
    return respond(req, { error: 'subscription_required' }, 402);
  }

  const business = await getUserBusinessWithClient(supabase, user.id);
  if (!business) return respond(req, { error: 'business_not_found' }, 404);

  try {
    const result = await repairMissingGoogleAdsMetadata(supabase, business.id);
    return respond(req, { ok: true, ...result });
  } catch (error) {
    console.error('Google Ads account name repair failed', error);
    // Stable code only — the raw message can carry PostgREST/internal detail.
    return respond(req, { error: 'repair_failed' }, 500);
  }
}

function respond(req: NextRequest, body: Record<string, unknown>, status = 200) {
  const acceptsJson = req.headers.get('accept')?.includes('application/json');
  if (acceptsJson) return NextResponse.json(body, { status });

  const url = new URL('/dashboard', req.url);
  if (status >= 400) url.searchParams.set('name_repair_error', String(body.error ?? 'repair_failed'));
  else {
    url.searchParams.set('names_checked', String(body.checked ?? 0));
    url.searchParams.set('names_updated', String(body.updated ?? 0));
  }
  return NextResponse.redirect(url, 303);
}

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import {
  getLinkedGoogleAdsAccount,
  normalizeCustomerId,
  SELECTED_ADS_ACCOUNT_COOKIE,
} from '@/lib/accounts/selection';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';

export async function POST(req: NextRequest) {

  // Defence in depth against cross-site POSTs; see lib/security/origin.ts.
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  }
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const rateLimit = await checkRateLimit({ req, scope: 'account_select', limit: 120, windowSeconds: 60, identifier: user.id });
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rateLimit) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const contentType = req.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await req.json().catch(() => ({}))
    : Object.fromEntries((await req.formData()).entries());
  const customerId = normalizeCustomerId(String(payload.customerId ?? payload.customer_id ?? ''));

  if (!customerId) {
    return NextResponse.json({ error: 'customer_required' }, { status: 400 });
  }

  const { account, error } = await getLinkedGoogleAdsAccount({
    supabase,
    userId: user.id,
    customerId,
    select: 'customer_id',
  });

  if (error || !account) {
    return NextResponse.json({ error: 'account_not_found' }, { status: 404 });
  }

  const selectedCustomerId = normalizeCustomerId(account.customer_id);
  const res = NextResponse.json({ ok: true, customerId: selectedCustomerId });
  res.cookies.set(SELECTED_ADS_ACCOUNT_COOKIE, selectedCustomerId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 90,
    path: '/',
  });

  return res;
}

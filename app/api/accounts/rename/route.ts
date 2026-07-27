import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { getLinkedGoogleAdsAccount, normalizeCustomerId } from '@/lib/accounts/selection';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';

export async function POST(req: NextRequest) {

  // Defence in depth against cross-site POSTs; see lib/security/origin.ts.
  if (!isSameOriginRequest(req)) {
    return NextResponse.redirect(new URL('/settings?error=invalid_origin', req.url), 303);
  }
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.redirect(new URL('/login', req.url), 303);

  try {
    const rateLimit = await checkRateLimit({ req, scope: 'account_rename', limit: 20, windowSeconds: 300, identifier: user.id });
    if (!rateLimit.allowed) return respond(req, { error: 'too_many_requests' }, 429);
  } catch {
    return respond(req, { error: 'security_service_unavailable' }, 503);
  }

  const contentType = req.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await req.json().catch(() => ({}))
    : Object.fromEntries((await req.formData()).entries());
  const customerId = normalizeCustomerId(String(payload.customerId ?? payload.customer_id ?? ''));
  const customerName = String(payload.customerName ?? payload.customer_name ?? '').trim();

  if (!customerId || customerName.length < 2 || customerName.length > 120) {
    return respond(req, { error: 'invalid_name' }, 400);
  }

  const { account, error } = await getLinkedGoogleAdsAccount({
    supabase,
    userId: user.id,
    customerId,
    select: 'id, customer_id',
  });

  if (error || !account) {
    return respond(req, { error: 'account_not_found' }, 404);
  }

  const { error: updateError } = await supabase
    .from('google_ads_accounts')
    .update({ customer_name: customerName })
    .eq('id', account.id);

  if (updateError) {
    console.error('Failed to rename Google Ads account', updateError);
    return respond(req, { error: 'rename_failed' }, 500);
  }

  return respond(req, { ok: true, customerId, customerName });
}

function respond(req: NextRequest, body: Record<string, unknown>, status = 200) {
  const acceptsJson = req.headers.get('accept')?.includes('application/json');
  if (acceptsJson) return NextResponse.json(body, { status });

  const url = new URL('/settings', req.url);
  if (status >= 400) url.searchParams.set('rename_error', String(body.error ?? 'rename_failed'));
  else url.searchParams.set('renamed', '1');
  return NextResponse.redirect(url, 303);
}

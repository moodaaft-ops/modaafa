import { NextRequest, NextResponse } from 'next/server';
import { createServerClient, createAdminClient } from '@/lib/supabase/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { merchantPhoneEnabled, merchantPhoneE164 } from '@/lib/settings/merchant-phone';
export async function POST(req: NextRequest) {
  if (!merchantPhoneEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  const db = await createServerClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login', req.url), 303);
  const go = (outcome: string) => NextResponse.redirect(new URL(`/settings?phone=${outcome}`, req.url), 303);
  try {
    const limit = await checkRateLimit({ req, scope: 'merchant_phone', limit: 10, windowSeconds: 600, identifier: user.id });
    if (!limit.allowed) return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(limit) });
    const form = await req.formData();
    const phone = merchantPhoneE164(form.get('phone'));
    if (!phone || form.get('confirmed') !== 'on') return go('invalid');
    const { data: business } = await db.from('businesses').select('id').eq('id', String(form.get('business_id') ?? '')).eq('user_id', user.id).maybeSingle();
    if (!business) return go('failed');
    const { error } = await createAdminClient().from('merchant_call_phones').upsert({
      business_id: business.id, phone_e164: phone, confirmed_by: user.id, confirmed_at: new Date().toISOString(),
    }, { onConflict: 'business_id' });
    return go(error ? 'failed' : 'saved');
  } catch { return go('failed'); }
}

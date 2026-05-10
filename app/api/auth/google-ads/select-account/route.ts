import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';

/**
 * After the user picks an account from /onboarding/select-account,
 * we move the encrypted refresh token from pending_oauth_sessions → google_ads_accounts.
 */
export async function POST(req: NextRequest) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { sessionId, customerId } = await req.json().catch(() => ({}));
  if (!sessionId || !customerId) {
    return NextResponse.json({ error: 'بيانات ناقصة' }, { status: 400 });
  }

  // Verify session
  const { data: pending } = await supabase
    .from('pending_oauth_sessions')
    .select('refresh_token_encrypted, accessible_customer_ids, expires_at, user_id')
    .eq('id', sessionId)
    .single();

  if (!pending || pending.user_id !== user.id) {
    return NextResponse.json({ error: 'الجلسة غير صالحة' }, { status: 403 });
  }
  if (new Date(pending.expires_at) < new Date()) {
    return NextResponse.json({ error: 'انتهت صلاحية الجلسة' }, { status: 403 });
  }
  if (!pending.accessible_customer_ids.includes(customerId)) {
    return NextResponse.json({ error: 'هذا الحساب غير موجود في قائمتك' }, { status: 400 });
  }

  // Get business
  const { data: business } = await supabase
    .from('businesses')
    .select('id')
    .eq('user_id', user.id)
    .single();
  if (!business) {
    return NextResponse.json({ error: 'no_business' }, { status: 400 });
  }

  // Insert google_ads_accounts
  const { error: insertError } = await supabase.from('google_ads_accounts').upsert({
    business_id: business.id,
    customer_id: customerId,
    refresh_token_encrypted: pending.refresh_token_encrypted,
    permissions_scope: ['adwords'],
    status: 'active',
  });

  if (insertError) {
    console.error('[select-account] insert failed:', insertError);
    return NextResponse.json({ error: 'فشل ربط الحساب' }, { status: 500 });
  }

  // Cleanup the pending session
  await supabase.from('pending_oauth_sessions').delete().eq('id', sessionId);

  // Kick off the initial audit (non-blocking)
  void fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/audit/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId }),
  });

  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { listAccessibleCustomers } from '@/lib/google-ads/client';
import { decrypt } from '@/lib/crypto';

/**
 * POST /api/onboarding/switch-account
 * Body: { customerId: string }
 *
 * Activates the chosen Google Ads customer.
 *
 * Two flows:
 *  A. First-time linking: a 'pending' row exists (created by OAuth callback).
 *     We verify the customerId is accessible, then flip the pending row
 *     to active (and rename it to the chosen customer_id).
 *  B. Switching: an 'active' row exists. We verify accessibility, mark
 *     all current rows inactive, then upsert the chosen one as active.
 *
 * Both flows share the same refresh_token (one per Google account).
 */
export async function POST(req: NextRequest) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { customerId } = await req.json();
  if (!customerId || typeof customerId !== 'string') {
    return NextResponse.json({ error: 'customerId required' }, { status: 400 });
  }

  // Get the user's business (RLS-scoped)
  const { data: business } = await supabase
    .from('businesses')
    .select('id')
    .eq('user_id', user.id)
    .single();
  if (!business) {
    return NextResponse.json({ error: 'no_business' }, { status: 404 });
  }

  // Pull whichever row exists (pending or active) — we need the refresh_token
  const { data: pendingAccount } = await supabase
    .from('google_ads_accounts')
    .select('id, customer_id, refresh_token_encrypted')
    .eq('business_id', business.id)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle();

  const { data: activeAccount } = await supabase
    .from('google_ads_accounts')
    .select('id, customer_id, refresh_token_encrypted')
    .eq('business_id', business.id)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  const baseAccount = pendingAccount ?? activeAccount;
  if (!baseAccount) {
    return NextResponse.json({ error: 'no_linked_account' }, { status: 404 });
  }

  const isFirstLink = !!pendingAccount;

  // Switch mode + same active account → no-op
  if (!isFirstLink && activeAccount?.customer_id === customerId) {
    return NextResponse.json({ success: true, unchanged: true });
  }

  // Security: verify the customerId is actually accessible by this token
  let accessible: string[] = [];
  try {
    const refreshToken = decrypt(baseAccount.refresh_token_encrypted);
    accessible = await listAccessibleCustomers(refreshToken);
  } catch (err: any) {
    console.error('[switch-account] list customers failed:', err?.message);
    return NextResponse.json(
      { error: 'list_failed', message: err?.message },
      { status: 500 }
    );
  }

  if (!accessible.includes(customerId)) {
    return NextResponse.json(
      { error: 'customer_not_accessible' },
      { status: 403 }
    );
  }

  // Clear out any rows for this business — we'll insert exactly one active row.
  const { error: deleteErr } = await supabase
    .from('google_ads_accounts')
    .delete()
    .eq('business_id', business.id);
  if (deleteErr) {
    console.error('[switch-account] delete old rows failed:', deleteErr);
    return NextResponse.json({ error: 'delete_failed' }, { status: 500 });
  }

  // Insert the chosen account as active, reusing the same refresh_token
  const { error: insertErr } = await supabase
    .from('google_ads_accounts')
    .insert({
      business_id: business.id,
      customer_id: customerId,
      refresh_token_encrypted: baseAccount.refresh_token_encrypted,
      permissions_scope: ['adwords'],
      status: 'active',
    });
  if (insertErr) {
    console.error('[switch-account] insert failed:', insertErr);
    return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
  }

  // Kick off an initial audit on first link (non-blocking)
  if (isFirstLink && process.env.NEXT_PUBLIC_APP_URL) {
    void fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/audit/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId }),
    });
  }

  return NextResponse.json({
    success: true,
    customerId,
    wasFirstLink: isFirstLink,
  });
}

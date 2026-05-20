import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { listAccessibleCustomers } from '@/lib/google-ads/client';
import { decrypt } from '@/lib/crypto';

/**
 * POST /api/onboarding/switch-account
 * Body: { customerId: string }
 *
 * Switches the user's "active" Google Ads account to the given customerId.
 *
 * Flow:
 * 1. Verify the chosen customerId is in the list of customers accessible
 *    by the user's current refresh_token (security: prevent linking
 *    arbitrary customer_ids).
 * 2. Mark all of this business's google_ads_accounts rows as inactive.
 * 3. Upsert a row for the chosen customer_id with status='active',
 *    reusing the existing refresh_token.
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

  // Pull the currently-active account to reuse its refresh_token
  const { data: activeAccount } = await supabase
    .from('google_ads_accounts')
    .select('id, customer_id, refresh_token_encrypted')
    .eq('business_id', business.id)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (!activeAccount) {
    return NextResponse.json({ error: 'no_linked_account' }, { status: 404 });
  }

  // Same account → no-op
  if (activeAccount.customer_id === customerId) {
    return NextResponse.json({ success: true, unchanged: true });
  }

  // Security: verify the customerId is actually accessible by this token
  let accessible: string[] = [];
  try {
    const refreshToken = decrypt(activeAccount.refresh_token_encrypted);
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

  // Deactivate all current accounts for this business
  const { error: deactivateErr } = await supabase
    .from('google_ads_accounts')
    .update({ status: 'inactive' })
    .eq('business_id', business.id);
  if (deactivateErr) {
    console.error('[switch-account] deactivate failed:', deactivateErr);
    return NextResponse.json({ error: 'deactivate_failed' }, { status: 500 });
  }

  // Check if a row for the new customerId already exists; otherwise insert
  const { data: existing } = await supabase
    .from('google_ads_accounts')
    .select('id')
    .eq('business_id', business.id)
    .eq('customer_id', customerId)
    .maybeSingle();

  if (existing) {
    const { error: updateErr } = await supabase
      .from('google_ads_accounts')
      .update({
        refresh_token_encrypted: activeAccount.refresh_token_encrypted,
        status: 'active',
      })
      .eq('id', existing.id);
    if (updateErr) {
      console.error('[switch-account] update failed:', updateErr);
      return NextResponse.json({ error: 'update_failed' }, { status: 500 });
    }
  } else {
    const { error: insertErr } = await supabase
      .from('google_ads_accounts')
      .insert({
        business_id: business.id,
        customer_id: customerId,
        refresh_token_encrypted: activeAccount.refresh_token_encrypted,
        permissions_scope: ['adwords'],
        status: 'active',
      });
    if (insertErr) {
      console.error('[switch-account] insert failed:', insertErr);
      return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true, customerId });
}

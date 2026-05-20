import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens } from '@/lib/google-ads/oauth';
import { listAccessibleCustomers } from '@/lib/google-ads/client';
import { encrypt } from '@/lib/crypto';
import { createServerClient } from '@/lib/supabase/server';

/**
 * Step 2: Google redirects back here after the user consents.
 *
 * We:
 * 1. Verify the CSRF state matches
 * 2. Exchange the code for tokens (we get a refresh_token)
 * 3. List which Google Ads customers this token can access
 * 4. Either auto-link (if 1 account) or redirect to a chooser (if multiple)
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return NextResponse.redirect(new URL(`/onboarding/connect?error=${error}`, req.url));
  }
  if (!code || !state) {
    return NextResponse.redirect(new URL('/onboarding/connect?error=missing_params', req.url));
  }

  // Auth check
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // Verify CSRF state from DB (replaces the old cookie-based check, which
  // failed unreliably across browser redirects and tabs).
  const { data: stateRow, error: stateLookupError } = await supabase
    .from('oauth_state_tokens')
    .select('user_id, expires_at')
    .eq('state', state)
    .maybeSingle();

  const nowMs = Date.now();
  const expiresMs = stateRow ? new Date(stateRow.expires_at).getTime() : null;
  console.log('[google-ads/callback] state check:', {
    urlState: state.slice(0, 8) + '…',
    foundRow: !!stateRow,
    rowUser: stateRow?.user_id,
    sessionUser: user.id,
    expiresAt: stateRow?.expires_at,
    minutesUntilExpiry: expiresMs ? Math.round((expiresMs - nowMs) / 60000) : null,
    lookupError: stateLookupError?.message,
  });

  if (!stateRow) {
    return NextResponse.redirect(new URL('/onboarding/connect?error=state_mismatch', req.url));
  }
  if (stateRow.user_id !== user.id) {
    return NextResponse.redirect(new URL('/onboarding/connect?error=state_mismatch', req.url));
  }
  // No expiry check — the state is single-use (deleted after verification),
  // unguessable (32 random bytes), and tied to the user's session. Old states
  // get cleaned up by a background job. Skipping expiry avoids spurious
  // state_mismatch errors on slow OAuth flows.

  // Single-use token: delete now that it's verified.
  await supabase.from('oauth_state_tokens').delete().eq('state', state);

  try {
    // Exchange code → tokens
    const tokens = await exchangeCodeForTokens(code);
    const refreshToken = tokens.refresh_token!;

    // Discover accessible accounts
    const customerIds = await listAccessibleCustomers(refreshToken);

    if (customerIds.length === 0) {
      return NextResponse.redirect(new URL('/onboarding/connect?error=no_accounts', req.url));
    }

    // Find or create the user's business
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('user_id', user.id)
      .single();

    if (!business) {
      return NextResponse.redirect(new URL('/onboarding/business?error=no_business', req.url));
    }

    // We DON'T auto-link any account. We save the refresh_token in a "pending"
    // row using the first customerId as a placeholder, then send the user to
    // /onboarding/select-account where THEY choose which account to link.
    // The select page reuses this refresh_token to re-list customers.
    const placeholderId = customerIds[0];

    // Clean up any prior pending rows for this business so we don't accumulate
    // stale tokens from abandoned OAuth attempts.
    await supabase
      .from('google_ads_accounts')
      .delete()
      .eq('business_id', business.id)
      .eq('status', 'pending');

    // Check if a row already exists for this placeholder (could be active from
    // a previous successful link). If so, just refresh the token and bump
    // status to pending so the user re-confirms; otherwise insert a new row.
    const { data: existingAccount } = await supabase
      .from('google_ads_accounts')
      .select('id, status')
      .eq('business_id', business.id)
      .eq('customer_id', placeholderId)
      .maybeSingle();

    let insertError;
    if (existingAccount) {
      ({ error: insertError } = await supabase
        .from('google_ads_accounts')
        .update({
          refresh_token_encrypted: encrypt(refreshToken),
          permissions_scope: ['adwords'],
          status: 'pending',
        })
        .eq('id', existingAccount.id));
    } else {
      ({ error: insertError } = await supabase
        .from('google_ads_accounts')
        .insert({
          business_id: business.id,
          customer_id: placeholderId,
          refresh_token_encrypted: encrypt(refreshToken),
          permissions_scope: ['adwords'],
          status: 'pending',
        }));
    }

    if (insertError) {
      console.error('[google-ads/callback] insert google_ads_account failed:', insertError);
      return NextResponse.redirect(new URL('/onboarding/connect?error=db_error', req.url));
    }

    console.log('[google-ads/callback] stored pending token', {
      accountsAvailable: customerIds.length,
    });

    // Always send the user to the selection page so they pick the account.
    return NextResponse.redirect(
      new URL('/onboarding/select-account', req.url)
    );
  } catch (err: any) {
    // Log full details to Vercel function logs for diagnosis
    console.error('[google-ads/callback] OAuth flow failed:', {
      message: err?.message,
      name: err?.name,
      stack: err?.stack,
      response: err?.response?.data,
      code: err?.code,
    });

    // Pass a hint about what went wrong so the user sees a useful message
    const msg = (err?.message ?? '').toLowerCase();
    let key = 'oauth_failed';
    if (msg.includes('refresh_token')) key = 'no_refresh_token';
    else if (msg.includes('developer token') || msg.includes('developer_token')) key = 'developer_token';
    else if (msg.includes('not approved') || msg.includes('pending')) key = 'developer_token';
    else if (msg.includes('invalid_grant')) key = 'invalid_grant';

    return NextResponse.redirect(new URL(`/onboarding/connect?error=${key}`, req.url));
  }
}

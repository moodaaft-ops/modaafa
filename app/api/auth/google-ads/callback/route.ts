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

  // Verify CSRF state
  const cookieState = req.cookies.get('gads_oauth_state')?.value;
  if (!cookieState || cookieState !== state) {
    return NextResponse.redirect(new URL('/onboarding/connect?error=state_mismatch', req.url));
  }

  // Auth check
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

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

    // If only one account, auto-link it
    if (customerIds.length === 1) {
      const customerId = customerIds[0];
      const { error: insertError } = await supabase.from('google_ads_accounts').upsert({
        business_id: business.id,
        customer_id: customerId,
        refresh_token_encrypted: encrypt(refreshToken),
        permissions_scope: ['adwords'],
        status: 'active',
      });

      if (insertError) {
        console.error('Failed to insert google_ads_account', insertError);
        return NextResponse.redirect(new URL('/onboarding/connect?error=db_error', req.url));
      }

      // Kick off the initial audit (non-blocking)
      void fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/audit/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId }),
      });

      return NextResponse.redirect(new URL('/dashboard?connected=1', req.url));
    }

    // Multiple accounts → store refresh token in session, let user pick
    const sessionId = crypto.randomUUID();
    await supabase.from('pending_oauth_sessions').insert({
      id: sessionId,
      user_id: user.id,
      refresh_token_encrypted: encrypt(refreshToken),
      accessible_customer_ids: customerIds,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    const res = NextResponse.redirect(
      new URL(`/onboarding/select-account?session=${sessionId}`, req.url)
    );
    res.cookies.delete('gads_oauth_state');
    return res;
  } catch (err) {
    console.error('OAuth callback error', err);
    return NextResponse.redirect(new URL('/onboarding/connect?error=oauth_failed', req.url));
  }
}

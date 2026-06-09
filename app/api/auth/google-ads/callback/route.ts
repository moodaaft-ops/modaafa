import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens } from '@/lib/google-ads/oauth';
import { discoverAccessibleCustomers } from '@/lib/google-ads/client';
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

    // Discover direct accounts and MCC children without pulling manager metrics.
    const accounts = await discoverAccessibleCustomers(refreshToken);

    if (accounts.length === 0) {
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

    // Store the short-lived account chooser in an httpOnly cookie. This avoids
    // requiring a DB migration before the first OAuth connection works.
    const sessionId = crypto.randomUUID();
    const pendingPayload = Buffer.from(
      JSON.stringify({
        id: sessionId,
        user_id: user.id,
        refresh_token_encrypted: encrypt(refreshToken),
        accessible_customers: accounts,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      })
    ).toString('base64url');

    const res = NextResponse.redirect(
      new URL(`/onboarding/select-account?session=${sessionId}`, req.url)
    );
    res.cookies.set('gads_pending_session', pendingPayload, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 60,
      path: '/',
    });
    res.cookies.delete('gads_oauth_state');
    return res;
  } catch (err) {
    console.error('OAuth callback error', err);
    return NextResponse.redirect(new URL('/onboarding/connect?error=oauth_failed', req.url));
  }
}

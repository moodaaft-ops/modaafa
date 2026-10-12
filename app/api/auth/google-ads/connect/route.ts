import { after, NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { buildAuthUrl } from '@/lib/google-ads/oauth';
import { createServerClient } from '@/lib/supabase/server';
import {
  appendGoogleAdsOAuthState,
  GOOGLE_ADS_OAUTH_STATE_COOKIE,
} from '@/lib/auth/google-ads-oauth-state';
import { persistOAuthState } from '@/lib/auth/oauth-state-store';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { trackUserEvent } from '@/lib/events/user-events';

/**
 * Step 1: User clicks "Connect Google Ads" → we redirect them to Google's consent screen.
 *
 * CSRF state is stored server-side (Supabase `oauth_states`, 60-minute TTL,
 * single-use, tied to the user id). An httpOnly cookie keeps a copy as a
 * secondary defense / fallback if the table is unavailable.
 */
export async function GET(req: NextRequest) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL('/login?next=/onboarding/connect', req.url));
  }

  try {
    const rateLimit = await checkRateLimit({
      req,
      scope: 'google_ads_connect',
      limit: 10,
      windowSeconds: 900,
      identifier: user.id,
    });
    if (!rateLimit.allowed) {
      // This route is entered by a top-level navigation from the connect
      // button, so JSON here painted a bare `{"error":"too_many_requests"}`
      // page with no header and no way back. /onboarding/connect already has
      // Arabic copy for both of these codes.
      return NextResponse.redirect(
        new URL('/onboarding/connect?error=too_many_requests', req.url),
        { status: 303, headers: rateLimitHeaders(rateLimit) }
      );
    }
  } catch {
    return NextResponse.redirect(
      new URL('/onboarding/connect?error=security_service_unavailable', req.url),
      303
    );
  }

  // Funnel event. Written after the redirect is sent and swallowed on failure,
  // so it can never slow down or break the hand-off to Google. `source` is
  // read from a short allow-list, never stored as typed.
  const source = req.nextUrl.searchParams.get('source') === 'welcome' ? 'welcome' : 'other';
  const userId = user.id;
  after(() => trackUserEvent({ userId, event: 'connect_clicked', properties: { source } }));

  // CSRF protection: tie state to the user's session
  const state = randomBytes(32).toString('hex');
  let authUrl: string;
  try {
    authUrl = buildAuthUrl(state);
  } catch (error) {
    console.error('Google OAuth configuration is incomplete', error);
    return NextResponse.redirect(new URL('/onboarding/connect?error=oauth_config_missing', req.url));
  }

  const storedServerSide = await persistOAuthState({
    userId: user.id,
    state,
    purpose: 'google_ads_connect',
  });
  if (!storedServerSide) {
    console.warn('OAuth state not stored server-side; relying on cookie fallback');
  }

  const res = NextResponse.redirect(authUrl);
  res.cookies.set(GOOGLE_ADS_OAUTH_STATE_COOKIE, appendGoogleAdsOAuthState(req.cookies.get(GOOGLE_ADS_OAUTH_STATE_COOKIE)?.value, state), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    // Match the server-side TTL: slow/stuck Google consent screens were
    // outliving the previous 10-minute cookie and causing state_mismatch.
    maxAge: 3600,
    path: '/',
  });
  return res;
}

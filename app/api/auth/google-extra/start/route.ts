import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { persistOAuthState } from '@/lib/auth/oauth-state-store';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isExtraFeature, isExtraFeatureEnabled, statePurposeFor } from '@/lib/google-auth/features';
import { buildExtraAuthUrl } from '@/lib/google-auth/incremental';
import { callbackRedirect, newExtraState } from '@/lib/google-auth/state';

/**
 * Step 1 of a separate Google consent (Data Manager upload, GA4 read, Business
 * Profile read). A top-level navigation from a settings button:
 * /api/auth/google-extra/start?feature=ga4
 *
 * The state is stored server-side, single use and bound to the signed-in user
 * (the same store as the Google Ads connect). There is no cookie fallback: if
 * the state cannot be stored the consent is not started. With the feature's flag
 * off the route answers 404 and builds nothing.
 */
export async function GET(req: NextRequest) {
  const feature = req.nextUrl.searchParams.get('feature');
  if (!isExtraFeature(feature) || !isExtraFeatureEnabled(feature)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login?next=/settings', req.url));

  try {
    const limit = await checkRateLimit({ req, scope: 'google_extra_start', limit: 10, windowSeconds: 900, identifier: user.id });
    if (!limit.allowed) {
      return NextResponse.redirect(new URL(callbackRedirect(feature, 'too_many_requests'), req.url), {
        status: 303,
        headers: rateLimitHeaders(limit),
      });
    }
  } catch {
    return NextResponse.redirect(new URL(callbackRedirect(feature, 'security_service_unavailable'), req.url), 303);
  }

  const state = newExtraState(feature);
  let authUrl: string;
  try {
    authUrl = buildExtraAuthUrl(feature, state);
  } catch (error) {
    console.error('Google extra OAuth configuration is incomplete', error instanceof Error ? error.message : 'unknown');
    return NextResponse.redirect(new URL(callbackRedirect(feature, 'oauth_config_missing'), req.url), 303);
  }

  const stored = await persistOAuthState({
    userId: user.id,
    state,
    purpose: statePurposeFor(feature) as Parameters<typeof persistOAuthState>[0]['purpose'],
  });
  if (!stored) return NextResponse.redirect(new URL(callbackRedirect(feature, 'state_unavailable'), req.url), 303);

  return NextResponse.redirect(authUrl);
}

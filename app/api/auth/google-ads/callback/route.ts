import { after, NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens } from '@/lib/google-ads/oauth';
import { encrypt } from '@/lib/crypto';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { handleGoogleLoginCallback, isGoogleLoginCallback } from '@/lib/auth/google-login-callback';
import { GOOGLE_ADS_OAUTH_STATE_COOKIE } from '@/lib/auth/google-ads-oauth-state';
import { consumeOAuthState } from '@/lib/auth/oauth-state-store';
import { validateGoogleAdsOAuthState } from '@/lib/auth/oauth-state-validation';
import { runConnectJob, startConnectJob } from '@/lib/onboarding/connect-job';

// The background half (after()) shares this budget. The preparing screen
// treats a job still running past CONNECT_TIMEOUT_MS as killed.
export const maxDuration = 300;

/**
 * Step 2: Google redirects back here after the user consents.
 *
 * In the request:
 * 1. Verify the CSRF state (server-side single-use state, cookie fallback only
 *    when storage is down)
 * 2. Exchange the code for tokens (the code is single-use)
 * 3. Resolve the business and record a connect job
 * 4. Redirect at once to /onboarding/preparing
 *
 * After the response (lib/onboarding/connect-job.ts): discover accounts, read
 * names and statuses, link them, read 30-day spend, first data sync.
 */
export async function GET(req: NextRequest) {
  if (isGoogleLoginCallback(req)) {
    return handleGoogleLoginCallback(req);
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    const errorUrl = new URL('/onboarding/connect', req.url);
    errorUrl.searchParams.set('error', error);
    return NextResponse.redirect(errorUrl);
  }
  if (!code || !state) {
    return NextResponse.redirect(new URL('/onboarding/connect?error=missing_params', req.url));
  }

  // Auth check first: server-side state validation is tied to the user id.
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login?next=/onboarding/connect', req.url));
  }

  // Verify CSRF state.
  // Primary: server-side single-use state, bound to this user id (survives
  // slow consent screens, multi-tab retries, and host mismatches).
  //
  // The httpOnly cookie is a fallback for exactly one case: the state table
  // is unreachable (`unavailable`). It must NOT rescue `user_mismatch` or
  // `not_found` — the cookie is bound to the BROWSER, not to a user, and
  // holds several pending states at once. Accepting it on `user_mismatch`
  // meant that if user A started a link, signed out, and user B signed in on
  // the same browser before A finished consenting, A's refresh token and A's
  // ad accounts were written into B's business. That is a cross-tenant
  // credential leak, so those two results are now fatal.
  const serverStateResult = await consumeOAuthState({
    userId: user.id,
    state,
    purpose: 'google_ads_connect',
  });
  const stateValidation = validateGoogleAdsOAuthState({
    serverResult: serverStateResult,
    cookieValue: req.cookies.get(GOOGLE_ADS_OAUTH_STATE_COOKIE)?.value,
    returnedState: state,
  });
  if (!stateValidation.accepted) {
      console.warn(`Google Ads OAuth state rejected (server: ${serverStateResult})`);
      const res = NextResponse.redirect(
        new URL(`/onboarding/connect?error=${stateValidation.error}`, req.url)
      );
      // A rejected state must not stay replayable in the cookie.
      res.cookies.delete(GOOGLE_ADS_OAUTH_STATE_COOKIE);
      return res;
  }

  // Service client first: linking writes are service-owned, and the
  // background job needs it after the response is gone.
  let admin;
  try {
    admin = createAdminClient();
  } catch (adminError) {
    console.error('Google Ads linking service is unavailable', adminError instanceof Error ? adminError.message : 'unknown');
    return failureRedirect(req, '/onboarding/connect?error=security_service_unavailable');
  }

  let refreshToken: string;
  try {
    // The authorization code is single-use and short-lived, so the exchange
    // stays inside the request. Everything slow happens after the redirect.
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) throw new Error('Google returned no refresh token');
    refreshToken = tokens.refresh_token;
  } catch (err) {
    console.error('OAuth code exchange failed', err instanceof Error ? err.message : 'unknown');
    return failureRedirect(req, '/onboarding/connect?error=oauth_failed');
  }

  await ensureUserProfile(user);
  const business = await getOrCreateUserBusiness(supabase, user);
  if (!business) {
    return failureRedirect(req, '/onboarding/business?error=no_business');
  }

  let job;
  try {
    job = await startConnectJob(admin, user.id);
  } catch (err) {
    console.error('Google Ads connect job could not start', err instanceof Error ? err.message : 'unknown');
    return failureRedirect(req, '/onboarding/connect?error=db_error');
  }

  const encryptedRefreshToken = encrypt(refreshToken);
  // Discovery, metadata, linking and the first data read used to run here
  // before the redirect, up to the 300s function limit, with the user staring
  // at Google's blank tab and, on timeout, a raw Vercel error page. They now
  // run after the response; /onboarding/preparing polls the job row.
  after(() =>
    runConnectJob({
      admin,
      job,
      userId: user.id,
      business,
      refreshToken,
      encryptedRefreshToken,
    })
  );

  const res = NextResponse.redirect(new URL('/onboarding/preparing', req.url));
  res.cookies.delete(GOOGLE_ADS_OAUTH_STATE_COOKIE);
  return res;
}

function failureRedirect(req: NextRequest, path: string) {
  const res = NextResponse.redirect(new URL(path, req.url));
  // The state was consumed above; a stale cookie must not stay replayable.
  res.cookies.delete(GOOGLE_ADS_OAUTH_STATE_COOKIE);
  return res;
}

async function getOrCreateUserBusiness(
  supabase: any,
  user: { id: string; email?: string | null; user_metadata?: Record<string, any> }
) {
  const { data: existing, error: lookupError } = await supabase
    .from('businesses')
    .select('id, selected_google_ads_customer_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    console.warn('Failed to look up business before Google Ads linking', lookupError);
    return null;
  }

  if (existing) return existing;

  const fallbackName =
    user.user_metadata?.business_name ??
    user.user_metadata?.full_name ??
    user.user_metadata?.name ??
    user.email?.split('@')[0] ??
    'نشاطي';

  // Upsert on the (new) unique user_id so a request racing the onboarding
  // form cannot create a second workspace. A second businesses row silently
  // orphaned every linked ad account, because each reader takes the newest
  // business — that is what sent returning users back to onboarding.
  const { data: created, error: createError } = await supabase
    .from('businesses')
    .upsert(
      {
        user_id: user.id,
        name: fallbackName,
        primary_goal: 'leads',
        target_regions: [],
      },
      { onConflict: 'user_id', ignoreDuplicates: true }
    )
    .select('id, selected_google_ads_customer_id')
    .maybeSingle();

  if (createError) {
    console.warn('Failed to create fallback business before Google Ads linking', createError);
    return null;
  }

  if (created) return created;

  // ignoreDuplicates returns no row when the business already existed.
  const { data: reread } = await supabase
    .from('businesses')
    .select('id, selected_google_ads_customer_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return reread ?? null;
}

async function ensureUserProfile(user: { id: string; email?: string | null; user_metadata?: Record<string, any> }) {
  try {
    const admin = createAdminClient();
    await admin.from('users').upsert({
      id: user.id,
      email: user.email,
      name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? null,
      avatar_url: user.user_metadata?.avatar_url ?? user.user_metadata?.picture ?? null,
      last_login_at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('Unable to ensure public user profile before Google Ads linking', error);
  }
}

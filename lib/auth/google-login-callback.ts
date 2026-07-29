import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import {
  getGoogleLoginClient,
  getGoogleLoginVerificationType,
  getSafeNextPath,
  GOOGLE_LOGIN_NEXT_COOKIE,
  GOOGLE_LOGIN_STATE_COOKIE,
} from './google-login';
import { cookieHasOAuthState } from './google-ads-oauth-state';

/**
 * The login state cookie holds up to 8 pending states (multi-tab login), so
 * membership — not equality — is the correct test.
 */
export function isGoogleLoginCallback(req: NextRequest) {
  const state = new URL(req.url).searchParams.get('state');
  const cookieValue = req.cookies.get(GOOGLE_LOGIN_STATE_COOKIE)?.value;
  return Boolean(state && cookieValue && cookieHasOAuthState(cookieValue, state));
}

export async function handleGoogleLoginCallback(req: NextRequest) {
  const requestUrl = new URL(req.url);
  const origin = requestUrl.origin;
  const code = requestUrl.searchParams.get('code');
  const state = requestUrl.searchParams.get('state');
  const cookieValue = req.cookies.get(GOOGLE_LOGIN_STATE_COOKIE)?.value;
  const stateMatches = Boolean(state && cookieValue && cookieHasOAuthState(cookieValue, state));
  const next = getSafeNextPath(req.cookies.get(GOOGLE_LOGIN_NEXT_COOKIE)?.value ?? null);

  if (!code || !stateMatches) {
    return clearLoginCookies(
      NextResponse.redirect(new URL('/login?error=google_state_failed', origin), 303)
    );
  }

  try {
    const googleClient = getGoogleLoginClient(origin);
    const { tokens } = await googleClient.getToken(code);

    if (!tokens.id_token) {
      throw new Error('Google did not return an ID token.');
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload?.email || payload.email_verified !== true) {
      throw new Error('Google email is missing or unverified.');
    }

    const admin = createAdminClient();
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: payload.email,
      options: {
        data: {
          avatar_url: payload.picture,
          email: payload.email,
          email_verified: true,
          full_name: payload.name,
          name: payload.name,
          picture: payload.picture,
          provider: 'google',
          provider_id: payload.sub,
        },
      },
    });

    if (linkError || !linkData.properties?.hashed_token) {
      throw linkError ?? new Error('Unable to create a Supabase login token.');
    }

    const supabase = await createServerClient();
    const { error: verifyError } = await supabase.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: getGoogleLoginVerificationType(linkData.properties.verification_type),
    });

    if (verifyError) throw verifyError;

    return clearLoginCookies(NextResponse.redirect(new URL(next, origin), 303));
  } catch (error) {
    console.error('Google login failed', error);
    return clearLoginCookies(
      NextResponse.redirect(new URL('/login?error=google_login_failed', origin), 303)
    );
  }
}

export function clearLoginCookies(res: NextResponse) {
  res.cookies.set(GOOGLE_LOGIN_STATE_COOKIE, '', { maxAge: 0, path: '/' });
  res.cookies.set(GOOGLE_LOGIN_NEXT_COOKIE, '', { maxAge: 0, path: '/' });
  return res;
}

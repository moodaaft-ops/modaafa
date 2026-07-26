import { randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  getGoogleLoginClient,
  getSafeNextPath,
  GOOGLE_LOGIN_NEXT_COOKIE,
  GOOGLE_LOGIN_SCOPES,
  GOOGLE_LOGIN_STATE_COOKIE,
} from '@/lib/auth/google-login';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { appendOAuthStateToCookie } from '@/lib/auth/google-ads-oauth-state';

export async function GET(req: NextRequest) {
  try {
    const rateLimit = await checkRateLimit({ req, scope: 'google_login', limit: 10, windowSeconds: 600 });
    if (!rateLimit.allowed) {
      // Reached by a top-level navigation from the login button — returning
      // JSON dropped the user on a bare `{"error":"too_many_requests"}` page.
      return NextResponse.redirect(new URL('/login?error=too_many_requests', req.url), {
        status: 303,
        headers: rateLimitHeaders(rateLimit),
      });
    }
  } catch {
    return NextResponse.redirect(new URL('/login?error=security_service_unavailable', req.url), 303);
  }

  const url = new URL(req.url);
  const next = getSafeNextPath(url.searchParams.get('next'));
  const state = randomBytes(32).toString('hex');
  const client = getGoogleLoginClient(url.origin);

  const authUrl = client.generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: GOOGLE_LOGIN_SCOPES,
    state,
  });

  const res = NextResponse.redirect(authUrl, 303);
  const secure = process.env.NODE_ENV === 'production';
  // Keep up to 8 pending login states instead of a single slot. A single slot
  // was overwritten whenever the user opened the login page in a second tab
  // (or retried after a stuck Google screen), and the first tab then failed
  // with `google_state_failed` — "انتهت جلسة الدخول عبر Google قبل إكمالها".
  res.cookies.set(
    GOOGLE_LOGIN_STATE_COOKIE,
    appendOAuthStateToCookie(req.cookies.get(GOOGLE_LOGIN_STATE_COOKIE)?.value, state),
    {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: 900,
      path: '/',
    }
  );
  res.cookies.set(GOOGLE_LOGIN_NEXT_COOKIE, next, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });

  return res;
}

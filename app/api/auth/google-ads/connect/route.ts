import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { buildAuthUrl } from '@/lib/google-ads/oauth';
import { createServerClient } from '@/lib/supabase/server';

/**
 * Step 1: User clicks "Connect Google Ads" → we redirect them to Google's consent screen.
 *
 * We store a CSRF state in an httpOnly cookie so the callback can verify
 * it matches.
 */
export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL('/login?next=/onboarding/connect', req.url));
  }

  // CSRF protection: tie state to the user's session
  const state = randomBytes(32).toString('hex');
  const authUrl = buildAuthUrl(state);

  const res = NextResponse.redirect(authUrl);
  res.cookies.set('gads_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
    path: '/',
  });
  return res;
}

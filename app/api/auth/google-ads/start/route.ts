import { NextRequest, NextResponse } from 'next/server';
import { buildAuthUrl } from '@/lib/google-ads/oauth';
import { createServerClient } from '@/lib/supabase/server';

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const state = crypto.randomUUID();
  const authUrl = buildAuthUrl(state);

  const res = NextResponse.redirect(authUrl);
  res.cookies.set('gads_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });
  return res;
}

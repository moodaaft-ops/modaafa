import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { buildAuthUrl } from '@/lib/google-ads/oauth';
import { createServerClient } from '@/lib/supabase/server';

/**
 * Step 1: User clicks "Connect Google Ads" → we redirect them to Google's consent screen.
 *
 * CSRF state is stored in the `oauth_state_tokens` table (NOT a cookie).
 * Cookie-based state was unreliable across redirects/tabs and caused
 * spurious `state_mismatch` errors on legitimate flows.
 */
export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL('/login?next=/onboarding/connect', req.url));
  }

  const state = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error } = await supabase.from('oauth_state_tokens').insert({
    state,
    user_id: user.id,
    expires_at: expiresAt,
  });

  if (error) {
    console.error('[google-ads/connect] failed to store state:', error);
    return NextResponse.redirect(
      new URL('/onboarding/connect?error=state_init_failed', req.url)
    );
  }

  console.log('[google-ads/connect] state stored:', {
    state: state.slice(0, 8) + '…',
    user_id: user.id,
  });

  return NextResponse.redirect(buildAuthUrl(state));
}

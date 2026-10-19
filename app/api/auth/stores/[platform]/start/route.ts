import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { persistOAuthState } from '@/lib/auth/oauth-state-store';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isStoreSyncEnabled } from '@/lib/stores/flags';
import { buildStoreAuthUrl, storeOAuthConfig } from '@/lib/stores/oauth';
import { isStorePlatform, newStoreState, storeCallbackRedirect, storePurpose } from '@/lib/stores/state';

/**
 * Step 1 of connecting a Salla or Zid store: /api/auth/stores/salla/start.
 * State is stored server-side, single use, bound to the signed-in user (same
 * store as the Google connect). Flag off or unknown platform: 404.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!isStoreSyncEnabled() || !isStorePlatform(platform)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login?next=/settings', req.url));

  try {
    const limit = await checkRateLimit({ req, scope: 'store_connect_start', limit: 10, windowSeconds: 900, identifier: user.id });
    if (!limit.allowed) {
      return NextResponse.redirect(new URL(storeCallbackRedirect(platform, 'too_many_requests'), req.url), {
        status: 303,
        headers: rateLimitHeaders(limit),
      });
    }
  } catch {
    return NextResponse.redirect(new URL(storeCallbackRedirect(platform, 'security_service_unavailable'), req.url), 303);
  }

  const cfg = storeOAuthConfig(platform);
  if (!cfg) return NextResponse.redirect(new URL(storeCallbackRedirect(platform, 'oauth_config_missing'), req.url), 303);

  const state = newStoreState(platform);
  const stored = await persistOAuthState({ userId: user.id, state, purpose: storePurpose(platform) });
  if (!stored) return NextResponse.redirect(new URL(storeCallbackRedirect(platform, 'state_unavailable'), req.url), 303);
  return NextResponse.redirect(buildStoreAuthUrl(cfg, state));
}

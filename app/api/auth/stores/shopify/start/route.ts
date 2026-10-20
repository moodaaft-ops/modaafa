import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { persistOAuthState } from '@/lib/auth/oauth-state-store';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isStoreSyncEnabled } from '@/lib/stores/flags';
import { buildShopifyAuthUrl, normalizeShopDomain, shopifyConfig } from '@/lib/stores/oauth';
import { newStoreState, storeCallbackRedirect, storePurpose } from '@/lib/stores/state';

/** /api/auth/stores/shopify/start?shop=my-store.myshopify.com. Same state rules as Salla and Zid. */
export async function GET(req: NextRequest) {
  if (!isStoreSyncEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const back = (outcome: string, init?: ResponseInit) => NextResponse.redirect(new URL(storeCallbackRedirect('shopify', outcome), req.url), { status: 303, ...init });

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login?next=/settings', req.url));

  const shop = normalizeShopDomain(req.nextUrl.searchParams.get('shop'));
  if (!shop) return back('invalid_shop');
  try {
    const limit = await checkRateLimit({ req, scope: 'store_connect_start', limit: 10, windowSeconds: 900, identifier: user.id });
    if (!limit.allowed) return back('too_many_requests', { headers: rateLimitHeaders(limit) });
  } catch {
    return back('security_service_unavailable');
  }
  const cfg = shopifyConfig();
  if (!cfg) return back('oauth_config_missing');

  const state = newStoreState('shopify');
  // The callback trusts the shop only after verifying Shopify's HMAC over the redirect query.
  const stored = await persistOAuthState({ userId: user.id, state, purpose: storePurpose('shopify') });
  if (!stored) return back('state_unavailable');
  return NextResponse.redirect(buildShopifyAuthUrl(cfg, shop, state));
}

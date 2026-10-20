import { saveStoreConnection } from '@/lib/stores/connect';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { consumeOAuthState } from '@/lib/auth/oauth-state-store';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { encrypt } from '@/lib/crypto';
import { isStoreSyncEnabled } from '@/lib/stores/flags';
import { normalizeShopDomain, shopifyConfig } from '@/lib/stores/oauth';
import { verifyShopifyQuery } from '@/lib/stores/signature';
import { parseStoreState, storeCallbackRedirect, storePurpose } from '@/lib/stores/state';

/**
 * Shopify install redirect. Order: HMAC of the query (Shopify signs it, so
 * `shop` is authentic), state consumed (single use, same user), code exchanged
 * for an offline token (no expiry, so no refresh), connection stored encrypted,
 * order webhooks registered best effort. A shop connected by another user is refused.
 */
export async function GET(req: NextRequest) {
  if (!isStoreSyncEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const go = (outcome: string) => NextResponse.redirect(new URL(storeCallbackRedirect('shopify', outcome), req.url), 303);
  const cfg = shopifyConfig();
  if (!cfg) return go('oauth_config_missing');

  const params = new URL(req.url).searchParams;
  if (!verifyShopifyQuery(cfg.clientSecret, params).ok) return go('state_invalid');
  const shop = normalizeShopDomain(params.get('shop'));
  const code = params.get('code');
  const rawState = params.get('state');
  if (!shop || !code || !rawState || parseStoreState(rawState)?.platform !== 'shopify') return go('missing_params');

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login?next=/settings', req.url));

  const consumed = await consumeOAuthState({ userId: user.id, state: rawState, purpose: storePurpose('shopify') });
  if (consumed !== 'ok') return go(consumed === 'user_mismatch' ? 'state_user_mismatch' : 'state_invalid');

  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
    });
    if (!res.ok) return go('oauth_failed');
    const token = ((await res.json()) as { access_token?: string }).access_token;
    if (!token) return go('oauth_failed');

    const admin = createAdminClient();
    const { selectedAccount } = await getAccountWorkspace(user.id);
    const saved = await saveStoreConnection(admin,
      {
        user_id: user.id, account_id: selectedAccount?.id ?? null, platform: 'shopify', external_store_id: shop,
        access_token_encrypted: encrypt(token), refresh_token_encrypted: null, token_expires_at: null,
        status: 'active', last_error: null, updated_at: new Date().toISOString(),
      }
    );
    if (saved === 'store_taken') return go('store_taken');

    // Best effort: a failure here leaves the store connected; the merchant can register the webhooks in Shopify.
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
    if (appUrl.startsWith('https://')) {
      for (const topic of ['orders/create', 'orders/updated', 'orders/cancelled']) {
        await fetch(`https://${shop}/admin/api/2025-01/webhooks.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ webhook: { topic, address: `${appUrl}/api/webhooks/shopify`, format: 'json' } }),
        }).catch(() => null);
      }
    }
  } catch (error) {
    console.error('Shopify connect failed', error instanceof Error ? error.message : 'unknown');
    return go('oauth_failed');
  }
  return go('connected');
}

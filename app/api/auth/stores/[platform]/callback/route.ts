import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { consumeOAuthState } from '@/lib/auth/oauth-state-store';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { encrypt } from '@/lib/crypto';
import { isStoreSyncEnabled } from '@/lib/stores/flags';
import { exchangeStoreCode, storeOAuthConfig } from '@/lib/stores/oauth';
import { fetchStoreId } from '@/lib/stores/profile';
import { isStorePlatform, parseStoreState, storeCallbackRedirect, storePurpose } from '@/lib/stores/state';

/**
 * Step 2: the state is consumed (single use, same user) BEFORE the code is
 * exchanged. Tokens are encrypted and never reach the browser. A store already
 * connected by another user is refused, never taken over.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!isStoreSyncEnabled() || !isStorePlatform(platform)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const go = (outcome: string) => NextResponse.redirect(new URL(storeCallbackRedirect(platform, outcome), req.url), 303);

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const rawState = url.searchParams.get('state');
  const parsed = parseStoreState(rawState);
  if (!parsed || parsed.platform !== platform) return go('state_invalid');
  if (url.searchParams.get('error')) return go('declined');
  if (!code || !rawState) return go('missing_params');

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login?next=/settings', req.url));

  const consumed = await consumeOAuthState({ userId: user.id, state: rawState, purpose: storePurpose(platform) });
  if (consumed !== 'ok') return go(consumed === 'user_mismatch' ? 'state_user_mismatch' : 'state_invalid');

  const cfg = storeOAuthConfig(platform);
  if (!cfg) return go('oauth_config_missing');

  try {
    const tokens = await exchangeStoreCode(cfg, code);
    if (!tokens.access_token) return go('oauth_failed');
    const storeId = await fetchStoreId(platform, tokens);
    if (!storeId) return go('store_unreadable');

    const admin = createAdminClient();
    const { data: existing, error: lookupError } = await admin
      .from('store_connections')
      .select('id, user_id')
      .eq('platform', platform)
      .eq('external_store_id', storeId)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing && existing.user_id !== user.id) return go('store_taken');

    const { selectedAccount } = await getAccountWorkspace(user.id);
    const expiresIn = typeof tokens.expires_in === 'number' && tokens.expires_in > 0 ? tokens.expires_in : 14 * 86400;
    const { error } = await admin.from('store_connections').upsert(
      {
        user_id: user.id,
        account_id: selectedAccount?.id ?? null,
        platform,
        external_store_id: storeId,
        access_token_encrypted: encrypt(tokens.access_token),
        refresh_token_encrypted: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        status: 'active',
        last_error: null,
        refresh_lease_until: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'platform,external_store_id' }
    );
    if (error) throw error;
  } catch (error) {
    console.error('Store connect failed', platform, error instanceof Error ? error.message : 'unknown');
    return go('oauth_failed');
  }
  return go('connected');
}

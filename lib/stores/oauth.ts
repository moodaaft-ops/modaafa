import { isConfiguredEnv } from '@/lib/platform/env';

/** OAuth config comes from env only. Salla/Zid paths marked unverified are overridable. */
export type StoreOAuthConfig = {
  platform: 'salla' | 'zid';
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string | null;
};

export function storeOAuthConfig(platform: 'salla' | 'zid', env: Record<string, string | undefined> = process.env): StoreOAuthConfig | null {
  const P = platform.toUpperCase();
  const clientId = env[`${P}_CLIENT_ID`];
  const clientSecret = env[`${P}_CLIENT_SECRET`];
  const redirectUri = env[`${P}_REDIRECT_URI`];
  if (!isConfiguredEnv(clientId) || !isConfiguredEnv(clientSecret) || !isConfiguredEnv(redirectUri)) return null;
  if (platform === 'salla') {
    return {
      platform, clientId, clientSecret, redirectUri,
      authorizeUrl: env.SALLA_AUTHORIZE_URL || 'https://accounts.salla.sa/oauth2/auth',
      tokenUrl: env.SALLA_TOKEN_URL || 'https://accounts.salla.sa/oauth2/token',
      scope: env.SALLA_SCOPE || 'offline_access',
    };
  }
  return {
    platform, clientId, clientSecret, redirectUri,
    authorizeUrl: env.ZID_AUTHORIZE_URL || 'https://oauth.zid.sa/oauth/authorize', // path unverified
    tokenUrl: env.ZID_TOKEN_URL || 'https://oauth.zid.sa/oauth/token', // path unverified
    scope: env.ZID_SCOPE || null,
  };
}

export function buildStoreAuthUrl(cfg: StoreOAuthConfig, state: string): string {
  const u = new URL(cfg.authorizeUrl);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  if (cfg.scope) u.searchParams.set('scope', cfg.scope);
  return u.toString();
}

export async function exchangeStoreCode(cfg: StoreOAuthConfig, code: string, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: cfg.clientId,
      client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri,
    }).toString(),
  });
  if (!res.ok) throw new Error(`store_token_exchange_${res.status}`);
  return (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; authorization?: string };
}

/** Shopify: per-shop install. The shop domain is validated before any URL is built from it. */
export const SHOPIFY_SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function normalizeShopDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const shop = raw.trim().toLowerCase();
  return SHOPIFY_SHOP_PATTERN.test(shop) ? shop : null;
}

export function shopifyConfig(env: Record<string, string | undefined> = process.env) {
  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  const redirectUri = env.SHOPIFY_REDIRECT_URI;
  if (!isConfiguredEnv(clientId) || !isConfiguredEnv(clientSecret) || !isConfiguredEnv(redirectUri)) return null;
  return { clientId, clientSecret, redirectUri, scope: env.SHOPIFY_SCOPE || 'read_orders' };
}

export function buildShopifyAuthUrl(cfg: NonNullable<ReturnType<typeof shopifyConfig>>, shop: string, state: string): string {
  const u = new URL(`https://${shop}/admin/oauth/authorize`);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('scope', cfg.scope);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

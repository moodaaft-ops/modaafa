import { decrypt, encrypt } from '@/lib/crypto';
import type { StoreOAuthConfig } from './oauth';

/**
 * Access token for a connected store, refreshed when it is about to expire.
 *
 * Salla refresh tokens are single use, so only one caller may refresh. The
 * database lease (claim_store_token_refresh, one UPDATE) decides who. The
 * winner re-reads the row (someone may have just refreshed), calls the token
 * endpoint, and saves the new access AND refresh token in one update. Losers
 * wait briefly and re-read. If the provider rejects the refresh token the
 * connection is marked error so the merchant is asked to reconnect, and
 * nothing retries a dead token.
 */
type Db = any;

export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type TokenRow = {
  id: string;
  status: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
};

const COLS = 'id, status, access_token_encrypted, refresh_token_encrypted, token_expires_at';

export function needsRefresh(row: Pick<TokenRow, 'token_expires_at'>, now: Date): boolean {
  if (!row.token_expires_at) return true;
  return Date.parse(row.token_expires_at) - now.getTime() < REFRESH_MARGIN_MS;
}

export type RefreshDeps = {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  waitAttempts?: number;
};

async function load(db: Db, id: string): Promise<TokenRow | null> {
  const { data, error } = await db.from('store_connections').select(COLS).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as TokenRow | null) ?? null;
}

export async function getStoreAccessToken(
  db: Db,
  connectionId: string,
  cfg: StoreOAuthConfig,
  deps: RefreshDeps = {}
): Promise<string | null> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = deps.waitAttempts ?? 6;

  for (let i = 0; i < attempts; i++) {
    const row = await load(db, connectionId);
    if (!row || row.status !== 'active' || !row.access_token_encrypted) return null;
    if (!needsRefresh(row, now())) return decrypt(row.access_token_encrypted);
    if (!row.refresh_token_encrypted) return null;

    const { data: won, error } = await db.rpc('claim_store_token_refresh', { p_connection: connectionId, p_lease_seconds: 30 });
    if (error) throw error;
    if (won !== true) {
      await sleep(500 * (i + 1));
      continue;
    }

    // We hold the lease. Re-read: a refresh may have finished between our read and our claim.
    const fresh = await load(db, connectionId);
    if (!fresh || !fresh.refresh_token_encrypted) return null;
    if (!needsRefresh(fresh, now()) && fresh.access_token_encrypted) {
      await db.from('store_connections').update({ refresh_lease_until: null }).eq('id', connectionId);
      return decrypt(fresh.access_token_encrypted);
    }
    return refreshAndSave(db, connectionId, cfg, decrypt(fresh.refresh_token_encrypted), now, deps.fetchImpl ?? fetch);
  }
  return null;
}

async function refreshAndSave(
  db: Db,
  connectionId: string,
  cfg: StoreOAuthConfig,
  refreshToken: string,
  now: () => Date,
  fetchImpl: typeof fetch
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }).toString(),
    });
  } catch {
    // Network failure: the token was not spent. Release the lease so the next run retries.
    await db.from('store_connections').update({ refresh_lease_until: null }).eq('id', connectionId);
    return null;
  }

  if (res.status === 400 || res.status === 401) {
    await db
      .from('store_connections')
      .update({ status: 'error', last_error: 'refresh_rejected', refresh_lease_until: null, updated_at: now().toISOString() })
      .eq('id', connectionId);
    return null;
  }
  if (!res.ok) {
    await db.from('store_connections').update({ refresh_lease_until: null }).eq('id', connectionId);
    return null;
  }

  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!body.access_token) {
    await db.from('store_connections').update({ status: 'error', last_error: 'refresh_no_token', refresh_lease_until: null }).eq('id', connectionId);
    return null;
  }
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 14 * 86400;
  const patch: Record<string, unknown> = {
    access_token_encrypted: encrypt(body.access_token),
    token_expires_at: new Date(now().getTime() + expiresIn * 1000).toISOString(),
    last_error: null,
    refresh_lease_until: null,
    updated_at: now().toISOString(),
  };
  // The old refresh token is spent. Keep the new one; if the provider sent none, keep the old (Zid and Salla both rotate, so this is the odd case).
  if (body.refresh_token) patch.refresh_token_encrypted = encrypt(body.refresh_token);
  const { error } = await db.from('store_connections').update(patch).eq('id', connectionId);
  if (error) {
    // The new refresh token could not be saved, so the connection is unusable until reconnected.
    await db.from('store_connections').update({ status: 'error', last_error: 'refresh_save_failed' }).eq('id', connectionId);
    return null;
  }
  return body.access_token;
}

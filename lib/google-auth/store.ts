import { decrypt, encrypt } from '@/lib/crypto';
import type { ExtraFeature } from './features';

/**
 * Storage of the separate Google grants (table google_scope_grants, service
 * role only; the refresh token is encrypted with the same key as the Ads
 * tokens and never sent to the browser). Every function takes the client as an
 * argument so the tests can fake it.
 */
type Db = any;

export type StoredGrant = {
  user_id: string;
  feature: ExtraFeature;
  scopes: string[];
  google_email: string | null;
  status: 'active' | 'revoked' | 'error';
  refreshToken: string;
};

export async function saveGrant(
  db: Db,
  input: { userId: string; feature: ExtraFeature; refreshToken: string; scopes: string[]; email?: string | null },
  now: Date = new Date()
): Promise<void> {
  const { error } = await db.from('google_scope_grants').upsert(
    {
      user_id: input.userId,
      feature: input.feature,
      scopes: input.scopes,
      refresh_token_encrypted: encrypt(input.refreshToken),
      google_email: input.email ?? null,
      status: 'active',
      last_error: null,
      granted_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    { onConflict: 'user_id,feature' }
  );
  if (error) throw error;
}

export async function loadGrant(db: Db, userId: string, feature: ExtraFeature): Promise<StoredGrant | null> {
  const { data, error } = await db
    .from('google_scope_grants')
    .select('user_id, feature, scopes, google_email, status, refresh_token_encrypted')
    .eq('user_id', userId)
    .eq('feature', feature)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status !== 'active' || !data.refresh_token_encrypted) return null;
  return {
    user_id: data.user_id,
    feature: data.feature,
    scopes: data.scopes ?? [],
    google_email: data.google_email ?? null,
    status: data.status,
    refreshToken: decrypt(data.refresh_token_encrypted),
  };
}

/** The grant of the user who owns this Google Ads account (accounts -> businesses -> user). */
export async function loadGrantForAccount(db: Db, accountId: string, feature: ExtraFeature): Promise<StoredGrant | null> {
  const owner = await ownerOfAccount(db, accountId);
  return owner ? loadGrant(db, owner, feature) : null;
}

export async function ownerOfAccount(db: Db, accountId: string): Promise<string | null> {
  const { data: account, error } = await db.from('google_ads_accounts').select('business_id').eq('id', accountId).maybeSingle();
  if (error) throw error;
  if (!account?.business_id) return null;
  const { data: business, error: businessError } = await db.from('businesses').select('user_id').eq('id', account.business_id).maybeSingle();
  if (businessError) throw businessError;
  return business?.user_id ? String(business.user_id) : null;
}

export async function markGrantFailed(db: Db, userId: string, feature: ExtraFeature, status: 'revoked' | 'error', reason: string): Promise<void> {
  await db
    .from('google_scope_grants')
    .update({ status, last_error: reason.slice(0, 200), updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('feature', feature);
}

export async function grantStatuses(db: Db, userId: string): Promise<Record<ExtraFeature, 'active' | 'revoked' | 'error' | 'none'>> {
  const out: Record<ExtraFeature, 'active' | 'revoked' | 'error' | 'none'> = { data_manager: 'none', ga4: 'none', gbp: 'none' };
  const { data, error } = await db.from('google_scope_grants').select('feature, status').eq('user_id', userId);
  if (error) throw error;
  for (const row of data ?? []) if (row.feature in out) out[row.feature as ExtraFeature] = row.status;
  return out;
}

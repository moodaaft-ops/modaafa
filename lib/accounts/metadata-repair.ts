import { createHash } from 'node:crypto';
import { decrypt } from '@/lib/crypto';
import { discoverAccessibleCustomers, googleAdsAuthNeedsReconnect } from '@/lib/google-ads/client';
import { normalizeCustomerId } from './selection';

/** Back-off before retrying a name Google would not give us last time. */
const NAME_REPAIR_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

type GoogleAdsAccountRow = {
  id: string;
  customer_id: string;
  customer_name: string | null;
  manager_id: string | null;
  currency_code: string | null;
  time_zone: string | null;
  refresh_token_encrypted: string;
  name_repair_attempted_at?: string | null;
};

export async function repairMissingGoogleAdsMetadata(
  supabase: any,
  businessId: string
): Promise<{ checked: number; updated: number; unresolved: number; reconnectRequired: boolean }> {
  const { data, error } = await supabase
    .from('google_ads_accounts')
    .select(
      'id, customer_id, customer_name, manager_id, currency_code, time_zone, refresh_token_encrypted, name_repair_attempted_at'
    )
    .eq('business_id', businessId)
    .eq('status', 'active')
    .limit(100);

  if (error) {
    console.warn('Failed to load Google Ads accounts for metadata repair', error);
    return { checked: 0, updated: 0, unresolved: 0, reconnectRequired: false };
  }

  // Some accounts simply have no descriptive_name that this OAuth grant is
  // allowed to read. Retrying those on every visit meant a multi-minute
  // request that usually 504'd, and the user saw "تعذر تحديث أسماء الحسابات"
  // every single login. Back off for a week after an unsuccessful attempt.
  const retryCutoff = new Date(Date.now() - NAME_REPAIR_COOLDOWN_MS).toISOString();
  const candidates = ((data ?? []) as GoogleAdsAccountRow[])
    .filter(shouldRepairAccountName)
    .filter((account) => !account.name_repair_attempted_at || account.name_repair_attempted_at < retryCutoff);

  if (candidates.length === 0) {
    return { checked: 0, updated: 0, unresolved: 0, reconnectRequired: false };
  }

  // Group by the DECRYPTED token. `encrypt()` uses a random IV, so the same
  // refresh token stored twice produces different ciphertexts — grouping on
  // the ciphertext ran a full MCC tree walk once per duplicate.
  const byToken = new Map<string, { refreshToken: string; accounts: GoogleAdsAccountRow[] }>();
  for (const account of candidates) {
    let refreshToken: string;
    try {
      refreshToken = decrypt(account.refresh_token_encrypted);
    } catch (decryptError) {
      console.warn(`Unable to decrypt refresh token during name repair for ${account.customer_id}`, decryptError);
      continue;
    }
    const key = createHash('sha256').update(refreshToken).digest('hex');
    const group = byToken.get(key) ?? { refreshToken, accounts: [] };
    group.accounts.push(account);
    byToken.set(key, group);
  }

  let updated = 0;
  let reconnectRequired = false;

  const attemptedAt = new Date().toISOString();

  for (const [, { refreshToken, accounts }] of byToken) {
    let discoveredById: Map<string, Awaited<ReturnType<typeof discoverAccessibleCustomers>>[number]>;
    try {
      const discovered = await discoverAccessibleCustomers(refreshToken);
      discoveredById = new Map(discovered.map((account) => [normalizeCustomerId(account.customer_id), account]));
    } catch (error) {
      if (googleAdsAuthNeedsReconnect(error)) {
        reconnectRequired = true;
        console.info('Google Ads metadata repair requires account reconnect');
      } else {
        console.warn('Failed to discover Google Ads metadata during repair', error);
      }
      continue;
    }

    for (const account of accounts) {
      const metadata = discoveredById.get(normalizeCustomerId(account.customer_id));
      if (!metadata?.customer_name) {
        // Record the attempt so the cooldown applies even when Google has no
        // name to give us.
        await supabase
          .from('google_ads_accounts')
          .update({
            name_repair_attempted_at: attemptedAt,
            ...(metadata ? { is_manager: metadata.is_manager === true, google_status: metadata.status ?? null } : {}),
          })
          .eq('id', account.id);
        continue;
      }

      const patch: Record<string, unknown> = {
        customer_name: metadata.customer_name,
        name_repair_attempted_at: attemptedAt,
        is_manager: metadata.is_manager === true,
      };
      if (metadata.status) patch.google_status = metadata.status;
      if (metadata.manager_id) patch.manager_id = metadata.manager_id;
      if (metadata.currency_code) patch.currency_code = metadata.currency_code;
      if (metadata.time_zone) patch.time_zone = metadata.time_zone;

      const { error } = await supabase
        .from('google_ads_accounts')
        .update(patch)
        .eq('id', account.id);

      if (error) {
        console.warn(`Failed to repair Google Ads account metadata for ${account.customer_id}`, error);
        continue;
      }

      updated++;
    }
  }

  return {
    checked: candidates.length,
    updated,
    unresolved: Math.max(candidates.length - updated, 0),
    reconnectRequired,
  };
}

function shouldRepairAccountName(account: GoogleAdsAccountRow) {
  const name = account.customer_name?.trim();
  if (!name) return true;
  return /^Google Ads\s+\d{3}/i.test(name) || name.includes('بدون اسم');
}

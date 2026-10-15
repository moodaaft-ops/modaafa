import { createAdminClient } from '@/lib/supabase/server';
import { decrypt, encrypt } from '@/lib/crypto';
import type { ProvisioningContext } from '@/lib/google-ads/provisioning';
import { transportFromRefreshToken } from '@/lib/google-ads/provisioning';
import { AGENCY_MCC_ID, provisioningMccId } from './flag';

/**
 * The refresh token of the Google user who owns the dedicated manager account.
 * One row (provisioning_credentials, id = 1), encrypted with lib/crypto.ts.
 * The token never leaves the server: nothing here is returned to a browser.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

const TABLE = 'provisioning_credentials';

export async function saveProvisioningCredentials(
  admin: AdminClient,
  input: { mccId: string; refreshToken: string; connectedBy: string; connectedAt?: string }
) {
  if (input.mccId === AGENCY_MCC_ID) throw new Error('The agency manager account cannot be used for provisioning');
  const { error } = await admin.from(TABLE).upsert(
    {
      id: 1,
      mcc_id: input.mccId,
      google_email: null,
      refresh_token_encrypted: encrypt(input.refreshToken),
      connected_by: input.connectedBy,
      connected_at: input.connectedAt ?? new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) throw error;
}

export type ProvisioningTokenStatus = {
  /** A token is stored for the manager id the environment names. */
  connected: boolean;
  /** The manager id the stored token was connected for (may differ from the environment's). */
  storedMccId: string | null;
  connectedAt: string | null;
};

export async function readProvisioningTokenStatus(admin: AdminClient): Promise<ProvisioningTokenStatus> {
  const { data, error } = await admin.from(TABLE).select('mcc_id, connected_at').eq('id', 1).maybeSingle();
  if (error) throw error;
  const row = data as { mcc_id: string; connected_at: string } | null;
  const envMcc = provisioningMccId();
  return {
    connected: Boolean(row && envMcc && row.mcc_id === envMcc),
    storedMccId: row?.mcc_id ?? null,
    connectedAt: row?.connected_at ?? null,
  };
}

/**
 * The Google context for provisioning, or null when it is not fully set up:
 * no PROVISIONING_MCC_ID, no stored token, or a token stored for another
 * manager id than the environment names (the environment wins, the token must
 * match it). Never throws for "not set up"; throws only when the token cannot
 * be decrypted, which is a real fault.
 */
export async function loadProvisioningContext(admin: AdminClient): Promise<ProvisioningContext | null> {
  const mccId = provisioningMccId();
  if (!mccId || mccId === AGENCY_MCC_ID) return null;
  const { data, error } = await admin.from(TABLE).select('mcc_id, refresh_token_encrypted').eq('id', 1).maybeSingle();
  if (error) throw error;
  const row = data as { mcc_id: string; refresh_token_encrypted: string } | null;
  if (!row || row.mcc_id !== mccId) return null;
  return { mccId, transport: transportFromRefreshToken(decrypt(row.refresh_token_encrypted)) };
}

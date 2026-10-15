import { createAdminClient } from '@/lib/supabase/server';
import { readProvisioningTokenStatus } from './credentials';
import { isAccountProvisioning, provisioningMccId } from './flag';
import { supabaseProvisionStore } from './store';
import { PROVISIONING_UNAVAILABLE, provisionView, type ProvisioningInitial, type ProvisionRow } from './types';

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Is the «افتحه لي» button available to this user, and what is the state of
 * their account request? Fails CLOSED: the flag off, no manager id, no stored
 * token, the migration not applied or any read failing all mean "not
 * available", and the onboarding screens keep the WhatsApp button they have today.
 */
export async function loadProvisioningState(
  user: { id: string; email?: string | null },
  admin?: AdminClient
): Promise<{ available: boolean; row: ProvisionRow | null }> {
  if (!isAccountProvisioning(process.env, user.email) || !provisioningMccId()) return { available: false, row: null };
  try {
    const client = admin ?? createAdminClient();
    const token = await readProvisioningTokenStatus(client);
    if (!token.connected) return { available: false, row: null };
    return { available: true, row: await supabaseProvisionStore(client).get(user.id) };
  } catch {
    return { available: false, row: null };
  }
}

/** What a server page hands to the screens (no ids, no error detail). */
export async function loadProvisioningInitial(user: { id: string; email?: string | null }): Promise<ProvisioningInitial> {
  const state = await loadProvisioningState(user);
  if (!state.available) return PROVISIONING_UNAVAILABLE;
  return { available: true, view: state.row ? provisionView(state.row) : null };
}

/** True only when the user finished registering. Unlike the dashboard gate this fails CLOSED: it spends a manager slot. */
export async function isRegistrationStrictlyComplete(admin: AdminClient, userId: string) {
  const { data, error } = await admin.from('users').select('registered_at').eq('id', userId).maybeSingle();
  if (error) throw error;
  return Boolean((data as { registered_at: string | null } | null)?.registered_at);
}

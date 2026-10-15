import { NextResponse } from 'next/server';
import { exchangeCodeForTokens } from '@/lib/google-ads/oauth';
import { listAccessibleCustomers } from '@/lib/google-ads/client';
import { activeParentManagers, transportFromRefreshToken, verifyManagerAccess } from '@/lib/google-ads/provisioning';
import { createAdminClient } from '@/lib/supabase/server';
import { isOperatorUser, type OperatorCandidate } from '@/lib/platform/operators';
import { saveProvisioningCredentials } from './credentials';
import { AGENCY_MCC_ID, provisioningMccId } from './flag';

const PAGE = '/operations/provisioning';

/**
 * The return leg of «اربط حساب المدير» (plan 121, section 2.3). The callback
 * route has already consumed the single-use state issued for `provisioning_mcc`
 * for THIS signed-in user; what is left is to confirm the operator is still an
 * operator, exchange the code, make sure the token really sees the dedicated
 * manager account as a manager, and store it encrypted. The token is never sent
 * to the browser and never logged.
 */
export async function handleProvisioningConnect(input: {
  requestUrl: string;
  code: string;
  user: OperatorCandidate;
}): Promise<NextResponse> {
  const back = (error?: string) => NextResponse.redirect(new URL(error ? `${PAGE}?error=${error}` : `${PAGE}?connected=1`, input.requestUrl), 303);

  if (!isOperatorUser(input.user)) return back('not_operator');
  const mccId = provisioningMccId();
  if (!mccId) return back('mcc_not_set');

  let refreshToken: string;
  try {
    const tokens = await exchangeCodeForTokens(input.code);
    if (!tokens.refresh_token) return back('oauth_failed');
    refreshToken = tokens.refresh_token;
  } catch {
    return back('oauth_failed');
  }

  try {
    const accessible = await listAccessibleCustomers(refreshToken);
    if (!accessible.includes(mccId)) return back('mcc_not_visible');
    const manager = await verifyManagerAccess({ mccId, transport: transportFromRefreshToken(refreshToken) });
    if (!manager.manager) return back('not_a_manager');
    // It must stand alone: under the agency manager its accounts would appear in the agency's list.
    const parents = await activeParentManagers({ mccId, transport: transportFromRefreshToken(refreshToken) });
    if (parents?.includes(AGENCY_MCC_ID)) return back('under_agency');
  } catch (error) {
    // Includes the agency manager id being configured by mistake (verifyManagerAccess refuses it).
    console.warn('provisioning manager verification failed', error instanceof Error ? error.message : 'unknown');
    return back('verify_failed');
  }

  try {
    await saveProvisioningCredentials(createAdminClient(), { mccId, refreshToken, connectedBy: input.user.id ?? '' });
  } catch (error) {
    console.error('provisioning credentials could not be saved', error instanceof Error ? error.message : 'unknown');
    return back('save_failed');
  }
  return back();
}

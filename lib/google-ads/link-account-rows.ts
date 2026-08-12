import { normalizeCustomerId } from '@/lib/accounts/selection';
import { isGeneratedFallbackName } from '@/lib/accounts/display';

export type LinkableGoogleAdsAccount = {
  customer_id: string;
  customer_name?: string | null;
  manager_id?: string | null;
  currency_code?: string | null;
  time_zone?: string | null;
  is_manager?: boolean | null;
  status?: string | null;
};

export type ExistingGoogleAdsMetadata = {
  customer_name?: string | null;
  manager_id?: string | null;
  currency_code?: string | null;
  time_zone?: string | null;
};

export function buildGoogleAdsLinkRows(params: {
  businessId: string;
  encryptedRefreshToken: string;
  accounts: LinkableGoogleAdsAccount[];
  existingMetadata: Map<string, ExistingGoogleAdsMetadata>;
}) {
  return params.accounts.map((account) => {
    const customerId = normalizeCustomerId(account.customer_id);
    const existing = params.existingMetadata.get(customerId);

    return {
      business_id: params.businessId,
      customer_id: customerId,
      customer_name:
        account.customer_name ?? validExistingName(existing?.customer_name) ?? null,
      manager_id: account.manager_id ?? existing?.manager_id ?? null,
      refresh_token_encrypted: params.encryptedRefreshToken,
      permissions_scope: ['adwords'],
      // A successful OAuth reconnect is the authoritative recovery path for
      // rows marked revoked by background sync.
      status: 'active',
      currency_code: account.currency_code ?? existing?.currency_code ?? null,
      time_zone: account.time_zone ?? existing?.time_zone ?? null,
      is_manager: account.is_manager === true,
      google_status: account.status ?? null,
    };
  });
}

function validExistingName(name?: string | null) {
  const trimmed = name?.trim();
  return trimmed && !isGeneratedFallbackName(trimmed) ? trimmed : null;
}

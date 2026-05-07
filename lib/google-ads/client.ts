import { GoogleAdsApi, Customer } from 'google-ads-api';

/**
 * Wrapper around google-ads-api to centralize:
 * - Developer-token + login-customer-id config
 * - Per-customer client construction
 * - GAQL query helpers with sensible defaults
 */

let _api: GoogleAdsApi | null = null;

export function getGoogleAdsApi(): GoogleAdsApi {
  if (_api) return _api;

  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!developerToken || !clientId || !clientSecret) {
    throw new Error(
      'Missing Google Ads env vars. Required: GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET'
    );
  }

  _api = new GoogleAdsApi({
    client_id: clientId,
    client_secret: clientSecret,
    developer_token: developerToken,
  });

  return _api;
}

/**
 * Create a Customer client for a specific advertiser account.
 * - customerId: the end-customer's account (the one we're querying / managing)
 * - refreshToken: the customer's OAuth refresh token (decrypted from DB)
 * - loginCustomerId: usually our MCC (defaults to env)
 */
export function getCustomer(
  customerId: string,
  refreshToken: string,
  loginCustomerId?: string
): Customer {
  const api = getGoogleAdsApi();
  return api.Customer({
    customer_id: customerId.replace(/-/g, ''),
    refresh_token: refreshToken,
    login_customer_id: (loginCustomerId ?? process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? '').replace(/-/g, ''),
  });
}

/**
 * List all accessible customer IDs for a given refresh token.
 * Used right after OAuth to let the user pick which Google Ads account to link.
 */
export async function listAccessibleCustomers(refreshToken: string): Promise<string[]> {
  const api = getGoogleAdsApi();
  const result = await api.listAccessibleCustomers(refreshToken);
  return result.resource_names.map((name) => name.replace('customers/', ''));
}

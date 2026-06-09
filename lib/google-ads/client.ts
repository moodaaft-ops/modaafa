import { GoogleAdsApi, Customer } from 'google-ads-api';

/**
 * Wrapper around google-ads-api to centralize:
 * - Developer-token + login-customer-id config
 * - Per-customer client construction
 * - GAQL query helpers with sensible defaults
 */

let _api: GoogleAdsApi | null = null;

export interface DiscoveredGoogleAdsCustomer {
  customer_id: string;
  customer_name: string | null;
  manager_id: string | null;
  is_manager: boolean;
  status: string | null;
  currency_code: string | null;
  time_zone: string | null;
  source: 'direct' | 'manager_child';
  level: number;
}

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

/**
 * Discover every account a user can reasonably link:
 * - Direct customer accounts attached to a normal Google login.
 * - Child clients under any manager account the user can access.
 *
 * This intentionally does not query metrics, so manager accounts are safe here.
 */
export async function discoverAccessibleCustomers(
  refreshToken: string
): Promise<DiscoveredGoogleAdsCustomer[]> {
  const directIds = await listAccessibleCustomers(refreshToken);
  const seen = new Map<string, DiscoveredGoogleAdsCustomer>();

  function put(account: DiscoveredGoogleAdsCustomer) {
    const id = account.customer_id.replace(/-/g, '');
    const existing = seen.get(id);
    if (!existing || (existing.is_manager && !account.is_manager)) {
      seen.set(id, { ...account, customer_id: id });
    }
  }

  for (const directId of directIds) {
    const normalizedDirectId = directId.replace(/-/g, '');
    let isManager = false;

    try {
      const directCustomer = getCustomer(normalizedDirectId, refreshToken, normalizedDirectId);
      const directRows: any[] = await directCustomer.query(`
        SELECT
          customer.id,
          customer.descriptive_name,
          customer.manager,
          customer.currency_code,
          customer.time_zone
        FROM customer
        LIMIT 1
      `);
      const row = directRows[0]?.customer ?? {};
      isManager = Boolean(row.manager);
      put({
        customer_id: String(row.id ?? normalizedDirectId),
        customer_name: row.descriptive_name ?? null,
        manager_id: null,
        is_manager: isManager,
        status: 'ENABLED',
        currency_code: row.currency_code ?? null,
        time_zone: row.time_zone ?? null,
        source: 'direct',
        level: 0,
      });
    } catch (err) {
      put({
        customer_id: normalizedDirectId,
        customer_name: null,
        manager_id: null,
        is_manager: false,
        status: null,
        currency_code: null,
        time_zone: null,
        source: 'direct',
        level: 0,
      });
    }

    if (!isManager) continue;

    try {
      const managerCustomer = getCustomer(normalizedDirectId, refreshToken, normalizedDirectId);
      const childRows: any[] = await managerCustomer.query(`
        SELECT
          customer_client.id,
          customer_client.descriptive_name,
          customer_client.manager,
          customer_client.status,
          customer_client.currency_code,
          customer_client.time_zone,
          customer_client.level
        FROM customer_client
        WHERE customer_client.status != 'CANCELED'
      `);

      for (const row of childRows) {
        const child = row.customer_client ?? {};
        if (!child.id) continue;
        put({
          customer_id: String(child.id),
          customer_name: child.descriptive_name ?? null,
          manager_id: normalizedDirectId,
          is_manager: Boolean(child.manager),
          status: child.status ?? null,
          currency_code: child.currency_code ?? null,
          time_zone: child.time_zone ?? null,
          source: 'manager_child',
          level: Number(child.level ?? 1),
        });
      }
    } catch (err) {
      console.warn(`Failed to discover manager children for ${normalizedDirectId}`, err);
    }
  }

  return Array.from(seen.values()).sort((a, b) => {
    if (a.is_manager !== b.is_manager) return a.is_manager ? 1 : -1;
    return (a.customer_name ?? a.customer_id).localeCompare(b.customer_name ?? b.customer_id, 'ar');
  });
}

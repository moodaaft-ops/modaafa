/**
 * Google Ads API client — REST-based.
 *
 * We use the REST transport (HTTPS + JSON) instead of the gRPC-based
 * `google-ads-api` package because gRPC is unreliable on Vercel's serverless
 * runtime (HTTP/2 streams get reset before any error is returned, leading to
 * "undefined undefined: undefined" errors).
 *
 * Reference: https://developers.google.com/google-ads/api/rest/overview
 */

import { refreshAccessToken } from './oauth';

// Bumped from v17 (deprecated, returns 404) to v22 — current stable per
// Google Ads API release notes as of May 2026.
const API_VERSION = 'v22';
const API_BASE = `https://googleads.googleapis.com/${API_VERSION}`;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/**
 * Make an authenticated REST call to the Google Ads API.
 * Throws with a useful message if the response isn't 2xx.
 */
async function callApi<T = any>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
  options: { loginCustomerId?: string } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': requireEnv('GOOGLE_ADS_DEVELOPER_TOKEN'),
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };

  // login-customer-id is required for any call against a customer that's
  // managed by an MCC. Not required for listAccessibleCustomers.
  const loginCid =
    options.loginCustomerId ?? process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  if (loginCid) {
    headers['login-customer-id'] = String(loginCid).replace(/-/g, '');
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON response */
  }

  if (!res.ok) {
    const errMsg =
      data?.error?.message ??
      data?.error?.details?.[0]?.message ??
      text ??
      res.statusText;
    const err = new Error(
      `Google Ads API ${res.status} on ${path}: ${errMsg}`
    );
    (err as any).status = res.status;
    (err as any).response = data;
    throw err;
  }

  return data as T;
}

/**
 * List all Google Ads customer IDs accessible to the user holding `refreshToken`.
 * Used right after OAuth to let the user pick which account to link.
 *
 * REST endpoint: GET /customers:listAccessibleCustomers
 * Returns: { resourceNames: ["customers/1234567890", ...] }
 */
export async function listAccessibleCustomers(
  refreshToken: string
): Promise<string[]> {
  const accessToken = await refreshAccessToken(refreshToken);
  const data = await callApi<{ resourceNames?: string[] }>(
    accessToken,
    '/customers:listAccessibleCustomers',
    { method: 'GET' },
    // listAccessibleCustomers does NOT take login-customer-id
    { loginCustomerId: '' }
  );
  return (data.resourceNames ?? []).map((n) => n.replace('customers/', ''));
}

/**
 * Run a GAQL search query against a specific customer.
 *
 * REST endpoint: POST /customers/{customer_id}/googleAds:search
 * Body: { query: "SELECT ... FROM ... WHERE ..." }
 */
export async function searchCustomer<T = any>(
  customerId: string,
  refreshToken: string,
  query: string,
  options: { loginCustomerId?: string; pageSize?: number } = {}
): Promise<T[]> {
  const accessToken = await refreshAccessToken(refreshToken);
  const cleanCid = customerId.replace(/-/g, '');

  const results: T[] = [];
  let pageToken: string | undefined;

  do {
    const body: Record<string, any> = { query };
    if (options.pageSize) body.pageSize = options.pageSize;
    if (pageToken) body.pageToken = pageToken;

    const data = await callApi<{
      results?: T[];
      nextPageToken?: string;
    }>(
      accessToken,
      `/customers/${cleanCid}/googleAds:search`,
      { method: 'POST', body: JSON.stringify(body) },
      { loginCustomerId: options.loginCustomerId }
    );

    if (data.results) results.push(...data.results);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return results;
}

/**
 * Backwards-compatibility shim for callers that expect the old `getCustomer()`
 * gRPC-style API. Returns an object with a `.query()` method that uses REST
 * under the hood. Other methods on the original Customer object are not
 * implemented; add them here as needed.
 */
export function getCustomer(
  customerId: string,
  refreshToken: string,
  loginCustomerId?: string
) {
  return {
    query: <T = any>(gaql: string) =>
      searchCustomer<T>(customerId, refreshToken, gaql, { loginCustomerId }),
  };
}

// Legacy export for anything that still imports `getGoogleAdsApi`.
// The REST client doesn't need a singleton instance — kept as a no-op stub
// so old call sites don't break the build.
export function getGoogleAdsApi() {
  return {
    Customer: getCustomer,
    listAccessibleCustomers: (refreshToken: string) =>
      listAccessibleCustomers(refreshToken).then((ids) => ({
        resource_names: ids.map((id) => `customers/${id}`),
      })),
  };
}

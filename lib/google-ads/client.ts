import { createHash } from 'node:crypto';
import type { Customer } from 'google-ads-api';
import { refreshAccessToken } from './oauth';
import { mapLimit } from '../platform/concurrency';

/**
 * Google Ads API wrapper.
 *
 * The old google-ads-api gRPC client bundled in this repo targets a retired
 * Google Ads API version, which fails on Vercel with:
 * "UNIMPLEMENTED: GRPC target method can't be resolved".
 *
 * Keep the local app-facing `customer.query(...)` shape, but execute reads and
 * simple mutations through the supported REST API.
 */

// Keep the production fallback pinned to the version proven by the local
// Google Ads transfer kit. Unsupported future defaults make metadata reads
// silently fail in production and leave accounts without names.
const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION ?? 'v22';
const GOOGLE_ADS_BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const DISCOVERY_MAX_DEPTH = 8;

/** Hard per-request deadline; Vercel functions cap at 300s in total. */
const GOOGLE_ADS_REQUEST_TIMEOUT_MS = 20_000;
/** Reads only. Mutations are never retried — see isRetryableGoogleAdsError. */
const GOOGLE_ADS_MAX_ATTEMPTS = 3;
/**
 * How many login-customer-id candidates to try when reading an account's
 * metadata: no header, the account itself, then the two most likely managers.
 */
const METADATA_FALLBACK_ATTEMPTS = 4;
/** Parallel metadata reads. Google enforces a per-developer-token QPS cap. */
const METADATA_CONCURRENCY = 6;
/** Accounts to name inline during discovery; the rest go to repair-names. */
const NAME_BACKFILL_LIMIT = 60;

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

type CustomerMetadata = {
  customer_id: string;
  customer_name: string | null;
  is_manager: boolean;
  currency_code: string | null;
  time_zone: string | null;
};

export class GoogleAdsRestError extends Error {
  status: number;
  codes: string[];
  requestId: string | null;

  constructor(status: number, message: string, codes: string[] = [], requestId: string | null = null) {
    super([codes.join(', '), message].filter(Boolean).join(': '));
    this.name = 'GoogleAdsRestError';
    this.status = status;
    this.codes = codes;
    this.requestId = requestId;
  }
}

export function getGoogleAdsErrorCodes(error: unknown) {
  if (error instanceof GoogleAdsRestError) return error.codes;

  const oauthCode = extractOAuthErrorCode(error);
  if (oauthCode) return [oauthCode];

  const message = error instanceof Error ? error.message : String(error ?? '');
  return [
    'USER_PERMISSION_DENIED',
    'CUSTOMER_NOT_ENABLED',
    'REQUESTED_METRICS_FOR_MANAGER',
    'CUSTOMER_NOT_FOUND',
    'AUTHENTICATION_ERROR',
    'INVALID_GRANT',
    'INVALID_CLIENT',
  ].filter((code) => message.includes(code));
}

export function googleAdsAuthNeedsReconnect(error: unknown) {
  if (getGoogleAdsErrorCodes(error).some((code) =>
    ['UNAUTHORIZED_CLIENT', 'INVALID_CLIENT', 'INVALID_GRANT', 'AUTHENTICATION_ERROR'].includes(code)
  )) {
    return true;
  }
  // A bare 401 with no parseable Google errorCode (a revoked grant surfacing
  // mid-cache) carries none of the codes above, so the sync cron never marked
  // the account for reconnect and retried it every night forever.
  return error instanceof GoogleAdsRestError && error.status === 401;
}

function extractOAuthErrorCode(error: unknown) {
  const data = (error as any)?.response?.data;
  const code = data?.error;
  if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase();

  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.toLowerCase().includes('invalid_client')) return 'INVALID_CLIENT';
  return null;
}

function getDeveloperToken() {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) throw new Error('Missing GOOGLE_ADS_DEVELOPER_TOKEN');
  return developerToken;
}

function pickString(value: Record<string, any>, ...keys: string[]) {
  for (const key of keys) {
    const candidate = value?.[key];
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
      return String(candidate);
    }
  }
  return null;
}

function pickNumber(value: Record<string, any>, ...keys: string[]) {
  for (const key of keys) {
    const candidate = value?.[key];
    if (candidate !== undefined && candidate !== null && candidate !== '') {
      const parsed = Number(candidate);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

async function googleAdsRest<T>({
  refreshToken,
  path,
  method = 'GET',
  body,
  loginCustomerId,
}: {
  refreshToken: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  loginCustomerId?: string | null;
}): Promise<T> {
  const isMutation = path.includes(':mutate');
  const maxAttempts = isMutation ? 1 : GOOGLE_ADS_MAX_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const accessToken = await getCachedAccessToken(refreshToken);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': getDeveloperToken(),
      };

      if (body) headers['Content-Type'] = 'application/json';
      if (loginCustomerId) headers['login-customer-id'] = loginCustomerId.replace(/-/g, '');

      const response = await fetch(`${GOOGLE_ADS_BASE_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        // Node's fetch applies no total-request deadline, so a single hung
        // Google socket used to consume the whole 300s function budget and
        // the job died without recording progress.
        signal: AbortSignal.timeout(GOOGLE_ADS_REQUEST_TIMEOUT_MS),
      });

      const text = await response.text();
      // Google's frontend answers 502/504 with HTML. Parsing before checking
      // `response.ok` turned that into `SyntaxError: Unexpected token '<'`,
      // which no error classifier could read.
      let data: any = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          if (!response.ok) {
            throw new GoogleAdsRestError(response.status, text.slice(0, 300).trim(), [], null);
          }
          throw new GoogleAdsRestError(response.status, 'Unreadable Google Ads response body', [], null);
        }
      }

      if (!response.ok) {
        const message = data?.error?.message ?? response.statusText;
        throw new GoogleAdsRestError(
          response.status,
          message,
          extractGoogleAdsErrorCodes(data),
          extractGoogleAdsRequestId(data)
        );
      }

      return data as T;
    } catch (error) {
      lastError = error;
      // A 401 means the cached access token is stale, or the grant was revoked
      // while the token was still cached. Evict it so the next call re-mints
      // instead of failing against a dead cache entry for up to 45 minutes.
      if (error instanceof GoogleAdsRestError && error.status === 401) {
        invalidateAccessToken(refreshToken);
      }
      if (attempt >= maxAttempts || !isRetryableGoogleAdsError(error)) throw error;
      // Jittered backoff: 400ms, 1200ms.
      const delay = 400 * 3 ** (attempt - 1) + Math.floor(Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Transient-only. Mutations never reach here (maxAttempts is 1 for them), so
 * a retry can never double-apply a change to a live campaign.
 */
function isRetryableGoogleAdsError(error: unknown) {
  if (error instanceof GoogleAdsRestError) {
    if (error.status === 429 || error.status >= 500) return true;
    return error.codes.some((code) => code === 'RESOURCE_EXHAUSTED' || code === 'INTERNAL_ERROR');
  }
  const name = (error as { name?: string })?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Access-token cache.
 *
 * `refreshAccessToken` builds a brand-new OAuth2Client each call, which
 * defeats the library's own cache, so every single Google Ads REST call was
 * paying for a second HTTPS round trip to oauth2.googleapis.com. On an MCC
 * discovery pass that doubled the wall-clock cost of the whole operation.
 */
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

function accessTokenCacheKey(refreshToken: string) {
  return createHash('sha256').update(refreshToken).digest('hex');
}

function invalidateAccessToken(refreshToken: string) {
  accessTokenCache.delete(accessTokenCacheKey(refreshToken));
}

async function getCachedAccessToken(refreshToken: string) {
  const key = accessTokenCacheKey(refreshToken);
  const cached = accessTokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const token = await refreshAccessToken(refreshToken);
  // Refresh the entry (delete then set) so a re-minted token moves to the tail
  // of the insertion order and the eviction below drops a genuinely cold key
  // rather than the hot one we just refreshed.
  accessTokenCache.delete(key);
  // Google access tokens live ~3600s; refresh well before the edge.
  accessTokenCache.set(key, { token, expiresAt: Date.now() + 45 * 60 * 1000 });

  // Bound the map in a long-lived lambda.
  if (accessTokenCache.size > 50) {
    const oldest = accessTokenCache.keys().next().value;
    if (oldest) accessTokenCache.delete(oldest);
  }

  return token;
}

function extractGoogleAdsErrorCodes(data: any) {
  const codes = new Set<string>();
  const failures = data?.error?.details?.flatMap((detail: any) => detail?.errors ?? []) ?? [];

  for (const failure of failures) {
    const errorCode = failure?.errorCode ?? failure?.error_code ?? {};
    for (const value of Object.values(errorCode)) {
      if (typeof value === 'string' && value.trim()) codes.add(value);
    }
  }

  return Array.from(codes);
}

function extractGoogleAdsRequestId(data: any) {
  const details = data?.error?.details ?? [];
  for (const detail of details) {
    const requestId = detail?.requestId ?? detail?.request_id;
    if (requestId) return String(requestId);
  }
  return null;
}

export async function googleAdsSearch(
  refreshToken: string,
  customerId: string,
  query: string,
  loginCustomerId?: string | null
): Promise<any[]> {
  const rows: any[] = [];
  let pageToken: string | undefined;

  do {
    const data = await googleAdsRest<{ results?: any[]; nextPageToken?: string }>({
      refreshToken,
      path: `/customers/${customerId.replace(/-/g, '')}/googleAds:search`,
      method: 'POST',
      loginCustomerId,
      body: {
        query,
        // NOTE: pageSize was removed from googleAds:search in Google Ads API v17+.
        // Sending it fails every query with PAGE_SIZE_NOT_SUPPORTED (this broke
        // account-name discovery in production). Pages are a fixed 10k rows now;
        // pageToken pagination below still applies.
        ...(pageToken ? { pageToken } : {}),
      },
    });

    rows.push(...(data.results ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return rows;
}

export async function getCustomerMetadata(
  refreshToken: string,
  customerId: string,
  loginCustomerId?: string | null
): Promise<CustomerMetadata> {
  const normalizedCustomerId = customerId.replace(/-/g, '');
  const rows = await googleAdsSearch(
    refreshToken,
    normalizedCustomerId,
    `
      SELECT
        customer.id,
        customer.descriptive_name,
        customer.manager,
        customer.currency_code,
        customer.time_zone
      FROM customer
      LIMIT 1
    `,
    loginCustomerId
  );
  const customer = rows[0]?.customer ?? {};

  return {
    customer_id: String(customer.id ?? normalizedCustomerId).replace(/-/g, ''),
    customer_name: pickString(customer, 'descriptiveName', 'descriptive_name'),
    is_manager: Boolean(customer.manager),
    currency_code: pickString(customer, 'currencyCode', 'currency_code'),
    time_zone: pickString(customer, 'timeZone', 'time_zone'),
  };
}

export async function getCustomerMetadataWithFallback(
  refreshToken: string,
  customerId: string,
  loginCustomerIds: string[] = []
): Promise<{ metadata: CustomerMetadata; loginCustomerId: string | null }> {
  const normalizedCustomerId = customerId.replace(/-/g, '');
  // Bounded chain. It used to try EVERY manager id discovered anywhere in the
  // tree, and only stopped on a response that carried a name — so an account
  // Google genuinely will not name (a normal, permitted state) burned the
  // whole list. With 10 sub-managers and 50 unnamed accounts that was 600
  // serial searches, which timed out the OAuth callback.
  const attempts = [
    null,
    normalizedCustomerId,
    ...[...loginCustomerIds, ...configuredManagerIds()]
      .map((value) => value.replace(/-/g, ''))
      .filter((value, index, values) => value && values.indexOf(value) === index),
  ].slice(0, METADATA_FALLBACK_ATTEMPTS);

  let lastError: unknown;
  let firstSuccessfulResult: { metadata: CustomerMetadata; loginCustomerId: string | null } | null = null;
  for (const loginCustomerId of attempts) {
    try {
      const result = {
        metadata: await getCustomerMetadata(refreshToken, customerId, loginCustomerId),
        loginCustomerId,
      };
      if (result.metadata.customer_name) return result;
      firstSuccessfulResult ??= result;
    } catch (error) {
      lastError = error;
    }
  }

  if (firstSuccessfulResult) return firstSuccessfulResult;
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Customer metadata lookup failed'));
}

async function mutateResource(
  refreshToken: string,
  customerId: string,
  servicePath: string,
  operations: unknown[],
  loginCustomerId?: string | null,
  options?: { validateOnly?: boolean }
) {
  return googleAdsRest({
    refreshToken,
    path: `/customers/${customerId.replace(/-/g, '')}/${servicePath}:mutate`,
    method: 'POST',
    loginCustomerId,
    body: {
      operations: camelizeKeys(operations),
      ...(options?.validateOnly ? { validateOnly: true } : {}),
    },
  });
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
  const normalizedCustomerId = customerId.replace(/-/g, '');
  const normalizedLoginCustomerId = loginCustomerId?.replace(/-/g, '') || null;

  const restCustomer = {
    credentials: {
      customer_id: normalizedCustomerId,
      login_customer_id: normalizedLoginCustomerId,
    },
    query: (query: string) =>
      googleAdsSearch(refreshToken, normalizedCustomerId, query, normalizedLoginCustomerId),
    adGroupCriteria: {
      update: (items: unknown[], options?: { validateOnly?: boolean }) =>
        mutateResource(
          refreshToken,
          normalizedCustomerId,
          'adGroupCriteria',
          toUpdateOperations(items, ['status']),
          normalizedLoginCustomerId,
          options
        ),
      // Expansion path: add a positive keyword mined from a converting search
      // term. Same mutate service as pausing, different operation kind.
      create: (items: unknown[], options?: { validateOnly?: boolean }) =>
        mutateResource(
          refreshToken,
          normalizedCustomerId,
          'adGroupCriteria',
          toCreateOperations(items),
          normalizedLoginCustomerId,
          options
        ),
      remove: (resourceNames: string[], options?: { validateOnly?: boolean }) =>
        mutateResource(
          refreshToken,
          normalizedCustomerId,
          'adGroupCriteria',
          resourceNames.map((resourceName) => ({ remove: resourceName })),
          normalizedLoginCustomerId,
          options
        ),
    },
    campaignCriteria: {
      create: (items: unknown[], options?: { validateOnly?: boolean }) =>
        mutateResource(
          refreshToken,
          normalizedCustomerId,
          'campaignCriteria',
          toCreateOperations(items),
          normalizedLoginCustomerId,
          options
        ),
      remove: (resourceNames: string[], options?: { validateOnly?: boolean }) =>
        mutateResource(
          refreshToken,
          normalizedCustomerId,
          'campaignCriteria',
          resourceNames.map((resourceName) => ({ remove: resourceName })),
          normalizedLoginCustomerId,
          options
        ),
    },
    campaignBudgets: {
      update: (items: unknown[], options?: { validateOnly?: boolean }) =>
        mutateResource(
          refreshToken,
          normalizedCustomerId,
          'campaignBudgets',
          toUpdateOperations(items, ['amount_micros']),
          normalizedLoginCustomerId,
          options
        ),
    },
    adGroups: {
      update: (items: any[], options?: { validateOnly?: boolean }) =>
        mutateResource(
          refreshToken,
          normalizedCustomerId,
          'adGroups',
          items.map((item) => ({
            update: item,
            updateMask: toFieldMask(
              ['target_cpa_micros', 'target_roas'].filter((key) => item[key] !== undefined)
            ),
          })),
          normalizedLoginCustomerId,
          options
        ),
    },
    adGroupAds: {
      update: (items: unknown[], options?: { validateOnly?: boolean }) =>
        mutateResource(
          refreshToken,
          normalizedCustomerId,
          'adGroupAds',
          toUpdateOperations(items, ['status']),
          normalizedLoginCustomerId,
          options
        ),
    },
  };

  return restCustomer as unknown as Customer;
}

/**
 * List all accessible customer IDs for a given refresh token.
 * Used right after OAuth to let the user pick which Google Ads account to link.
 */
export async function listAccessibleCustomers(refreshToken: string): Promise<string[]> {
  const result = await googleAdsRest<{ resourceNames?: string[]; resource_names?: string[] }>({
    refreshToken,
    path: '/customers:listAccessibleCustomers',
  });
  const resourceNames = result.resourceNames ?? result.resource_names ?? [];
  return resourceNames.map((name) => name.replace('customers/', ''));
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
  const normalizedDirectIds = directIds.map((id) => id.replace(/-/g, '')).filter(Boolean);
  const seen = new Map<string, DiscoveredGoogleAdsCustomer>();
  const scannedManagers = new Set<string>();
  const queuedManagers = new Set<string>();
  const queue: Array<{ customerId: string; loginCustomerId: string; level: number }> = [];
  const configuredManagers = configuredManagerIds();
  const loginCandidates = [
    ...configuredManagers,
    ...normalizedDirectIds,
  ].filter((value, index, values) => value && values.indexOf(value) === index);

  function put(account: DiscoveredGoogleAdsCustomer) {
    const id = account.customer_id.replace(/-/g, '');
    const existing = seen.get(id);
    if (!existing) {
      seen.set(id, { ...account, customer_id: id });
      return;
    }

    const shouldReplace =
      (existing.is_manager && !account.is_manager) ||
      (!existing.customer_name && !!account.customer_name) ||
      (!existing.manager_id && !!account.manager_id) ||
      (!existing.currency_code && !!account.currency_code) ||
      (!existing.time_zone && !!account.time_zone);

    if (!shouldReplace) return;

    seen.set(id, {
      ...existing,
      ...account,
      customer_id: id,
      customer_name: account.customer_name ?? existing.customer_name,
      manager_id: account.manager_id ?? existing.manager_id,
      status: account.status ?? existing.status,
      currency_code: account.currency_code ?? existing.currency_code,
      time_zone: account.time_zone ?? existing.time_zone,
      is_manager: existing.is_manager && !account.is_manager ? false : account.is_manager,
    });
  }

  function enqueueManager(customerId: string, loginCustomerId = customerId, level = 0) {
    const normalizedCustomerId = customerId.replace(/-/g, '');
    const normalizedLoginCustomerId = loginCustomerId.replace(/-/g, '');
    if (
      !normalizedCustomerId ||
      scannedManagers.has(normalizedCustomerId) ||
      queuedManagers.has(normalizedCustomerId) ||
      level > DISCOVERY_MAX_DEPTH
    ) return;
    queuedManagers.add(normalizedCustomerId);
    queue.push({
      customerId: normalizedCustomerId,
      loginCustomerId: normalizedLoginCustomerId,
      level,
    });
  }

  for (const normalizedDirectId of normalizedDirectIds) {
    let isManager = false;

    try {
      const { metadata, loginCustomerId } = await getCustomerMetadataWithFallback(
        refreshToken,
        normalizedDirectId,
        loginCandidates
      );
      isManager = metadata.is_manager;
      put({
        customer_id: metadata.customer_id,
        customer_name: metadata.customer_name,
        manager_id: loginCustomerId && loginCustomerId !== normalizedDirectId ? loginCustomerId : null,
        is_manager: isManager,
        status: 'ENABLED',
        currency_code: metadata.currency_code,
        time_zone: metadata.time_zone,
        source: 'direct',
        level: 0,
      });
      if (isManager) enqueueManager(normalizedDirectId, normalizedDirectId, 0);
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
  }

  // Some OAuth users receive client customer IDs from listAccessibleCustomers,
  // while the readable names are only exposed through the customer_client view.
  // Trying each accessible ID as a possible root is cheap for normal accounts
  // and lets us discover manager-owned names without a preconfigured MCC env var.
  for (const directId of normalizedDirectIds) {
    enqueueManager(directId, directId, 0);
  }

  for (const managerId of configuredManagers) {
    enqueueManager(managerId, managerId, 0);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const managerId = current.customerId;
    if (scannedManagers.has(managerId)) continue;
    scannedManagers.add(managerId);

    try {
      const childRows: any[] = await googleAdsSearch(
        refreshToken,
        managerId,
        `
          SELECT
            customer_client.id,
            customer_client.descriptive_name,
            customer_client.manager,
            customer_client.status,
            customer_client.currency_code,
            customer_client.time_zone,
            customer_client.hidden,
            customer_client.level
          FROM customer_client
          WHERE customer_client.status != 'CANCELED'
        `,
        current.loginCustomerId
      );

      let sawChild = false;

      for (const row of childRows) {
        const child = row.customerClient ?? row.customer_client ?? {};
        if (!child.id) continue;
        // Hidden accounts are test/scratch containers the owner has chosen not
        // to see in the Google Ads UI. Linking them made the switcher look
        // full of accounts the user did not recognise.
        if (child.hidden === true || child.hidden === 'true') continue;
        const childId = String(child.id).replace(/-/g, '');
        const childIsManager = Boolean(child.manager);
        const childLevel = pickNumber(child, 'level') ?? current.level + 1;
        const isSelf = childId === managerId;
        if (!isSelf) sawChild = true;

        put({
          customer_id: childId,
          customer_name: pickString(child, 'descriptiveName', 'descriptive_name'),
          manager_id: isSelf ? null : managerId,
          is_manager: childIsManager,
          status: child.status ?? null,
          currency_code: pickString(child, 'currencyCode', 'currency_code'),
          time_zone: pickString(child, 'timeZone', 'time_zone'),
          source: isSelf ? 'direct' : 'manager_child',
          level: childLevel,
        });

        // customer_client is TRANSITIVE: one query from a root manager already
        // returns every direct and indirect client at every level, plus the
        // sub-managers themselves. Re-querying each sub-manager returned the
        // same rows again — an MCC with 40 sub-managers issued 41 identical
        // full-subtree scans. Only descend when this scan returned nothing but
        // the manager itself, which is the "no transitive visibility" case.
        if (childIsManager && !isSelf && childRows.length <= 1) {
          enqueueManager(childId, current.loginCustomerId, current.level + 1);
        }
      }

      if (!sawChild) {
        for (const row of childRows) {
          const child = row.customerClient ?? row.customer_client ?? {};
          const childId = child.id ? String(child.id).replace(/-/g, '') : null;
          if (childId && Boolean(child.manager) && childId !== managerId) {
            enqueueManager(childId, current.loginCustomerId, current.level + 1);
          }
        }
      }
    } catch (err) {
      console.warn(`Failed to discover manager children for ${managerId}`, err);
    }
  }

  const discoveredLoginCandidates = [
    ...loginCandidates,
    ...Array.from(seen.values())
      .flatMap((account) => [account.is_manager ? account.customer_id : null, account.manager_id])
      .filter((value): value is string => Boolean(value)),
  ].filter((value, index, values) => value && values.indexOf(value) === index);

  // Name backfill for whatever the tree scan could not name. Bounded in both
  // breadth and concurrency: this used to be a serial pass over every unnamed
  // account, each doing a long fallback chain, and it was the single biggest
  // contributor to OAuth-callback timeouts on agency MCCs. Anything left over
  // is picked up by /api/accounts/repair-names.
  const unnamed = Array.from(seen.values())
    .filter((item) => !item.customer_name)
    .slice(0, NAME_BACKFILL_LIMIT);

  const backfilled = await mapLimit(unnamed, METADATA_CONCURRENCY, async (account) => {
    try {
      const { metadata, loginCustomerId } = await getCustomerMetadataWithFallback(
        refreshToken,
        account.customer_id,
        discoveredLoginCandidates
      );
      return { account, metadata, loginCustomerId };
    } catch (err) {
      console.warn(`Failed to refresh discovered account metadata for ${account.customer_id}`, err);
      return null;
    }
  });

  for (const result of backfilled) {
    if (!result) continue;
    const { account, metadata, loginCustomerId } = result;
    put({
      ...account,
      customer_id: metadata.customer_id,
      customer_name: metadata.customer_name,
      manager_id:
        account.manager_id ??
        (loginCustomerId && loginCustomerId !== account.customer_id ? loginCustomerId : null),
      is_manager: metadata.is_manager,
      currency_code: metadata.currency_code,
      time_zone: metadata.time_zone,
    });
  }

  return Array.from(seen.values()).sort((a, b) => {
    if (a.is_manager !== b.is_manager) return a.is_manager ? 1 : -1;
    return (a.customer_name ?? a.customer_id).localeCompare(b.customer_name ?? b.customer_id, 'ar');
  });
}

function configuredManagerIds() {
  return [
    process.env.GOOGLE_ADS_MANAGER_CUSTOMER_ID,
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    process.env.GOOGLE_ADS_MCC_CUSTOMER_ID,
    process.env.MOODAAFT_MANAGER_CUSTOMER_ID,
  ]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.replace(/\D/g, ''))
    .filter(Boolean);
}

export function getConfiguredGoogleAdsManagerIds() {
  return configuredManagerIds();
}

function toCreateOperations(items: unknown[]) {
  return items.map((item) => ({ create: item }));
}

/**
 * proto3 JSON FieldMask paths are lower-camelCase.
 *
 * `camelizeKeys` (applied to the whole operations array before the request)
 * rewrites object KEYS but not the mask STRING, so a mask written as
 * `amount_micros` shipped alongside a payload of `{ amountMicros: … }` and the
 * two disagreed. Single-word masks like `status` happened to work, which is
 * why only budget and bid updates were affected.
 */
export function toFieldMask(mask: string[]) {
  return mask
    .map((path) =>
      path
        .split('.')
        .map((segment) => segment.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()))
        .join('.')
    )
    .join(',');
}

function toUpdateOperations(items: unknown[], mask: string[]) {
  return items.map((item) => ({
    update: item,
    updateMask: toFieldMask(mask),
  }));
}

function camelizeKeys(value: any): any {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()),
      camelizeKeys(nested),
    ])
  );
}

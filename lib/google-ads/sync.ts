import type { Customer } from 'google-ads-api';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  discoverAccessibleCustomers,
  getConfiguredGoogleAdsManagerIds,
  getCustomer,
  getGoogleAdsErrorCodes,
} from './client';

type MetricsWindow = 'metrics_30d' | 'metrics_7d' | 'metrics_today';

type CampaignAccumulator = {
  account_id: string;
  google_campaign_id: number;
  name: string | null;
  type: string | null;
  status: string | null;
  daily_budget: number | null;
  bidding_strategy: string | null;
  metrics_30d: CampaignMetrics | null;
  metrics_7d: CampaignMetrics | null;
  metrics_today: CampaignMetrics | null;
  last_synced_at: string;
};

export type CampaignMetrics = {
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  conversion_value: number;
  ctr: number;
  cpc: number;
  cpa: number;
  roas: number;
  currency_code: string;
};

const CAMPAIGN_METADATA_QUERY = `
  SELECT
    campaign.id,
    campaign.name,
    campaign.status,
    campaign.advertising_channel_type,
    campaign.bidding_strategy_type,
    campaign_budget.amount_micros
  FROM campaign
  WHERE campaign.status != 'REMOVED'
  ORDER BY campaign.id
  LIMIT 10000
`;

const CAMPAIGN_METRICS_QUERY = `
  SELECT
    campaign.id,
    campaign.name,
    campaign.status,
    campaign.advertising_channel_type,
    campaign.bidding_strategy_type,
    campaign_budget.amount_micros,
    metrics.cost_micros,
    metrics.clicks,
    metrics.impressions,
    metrics.conversions,
    metrics.conversions_value
  FROM campaign
  WHERE segments.date DURING __PERIOD__
  ORDER BY metrics.cost_micros DESC
  LIMIT 10000
`;

/** Metrics-free, and therefore safe to run against a manager account. */
const ACCOUNT_KIND_QUERY = `
  SELECT customer.id, customer.manager, customer.status
  FROM customer
  LIMIT 1
`;

/**
 * Thrown before any metrics query is issued for a manager (MCC) account.
 *
 * Google answers metrics-on-manager with REQUESTED_METRICS_FOR_MANAGER, and
 * previously nothing stopped the query from being sent: `is_manager` was read
 * during discovery but never persisted, so a manager row that slipped through
 * (a transient error on its metadata read was recorded as `is_manager: false`)
 * failed on every sync forever, with no self-healing path.
 */
export class ManagerAccountError extends Error {
  readonly code = 'REQUESTED_METRICS_FOR_MANAGER';

  constructor(customerId?: string | null) {
    super(`Refusing to request metrics for manager account ${customerId ?? ''}`.trim());
    this.name = 'ManagerAccountError';
  }
}

export async function assertNotManagerAccount(customer: Customer) {
  const rows: any[] = await customer.query(ACCOUNT_KIND_QUERY);
  const record = rows[0]?.customer ?? {};
  const isManager = record.manager === true || record.manager === 'true';
  if (isManager) throw new ManagerAccountError(record.id ? String(record.id) : null);
  return {
    isManager: false,
    status: (read(record, 'status') as string | null) ?? null,
  };
}

export async function syncCampaignCache({
  supabase,
  customer,
  accountId,
  currencyCode = 'SAR',
}: {
  supabase: SupabaseClient;
  customer: Customer;
  accountId: string;
  currencyCode?: string | null;
}) {
  const syncedAt = new Date().toISOString();
  const campaigns = new Map<string, CampaignAccumulator>();
  const normalizedCurrency = normalizeCurrency(currencyCode);

  // Pre-flight: never send a metrics query to a manager account. This is the
  // one guard that holds regardless of what the database believes about the
  // row, and it also repairs the stored flag below.
  const kind = await assertNotManagerAccount(customer);
  if (kind.status) {
    await supabase
      .from('google_ads_accounts')
      .update({ is_manager: false, google_status: kind.status })
      .eq('id', accountId);
  }

  await queryCampaignMetadata(customer, campaigns, accountId, syncedAt);

  await queryWindow(customer, 'LAST_30_DAYS', 'metrics_30d', campaigns, accountId, syncedAt, normalizedCurrency);
  await queryWindow(customer, 'LAST_7_DAYS', 'metrics_7d', campaigns, accountId, syncedAt, normalizedCurrency);
  await queryWindow(customer, 'TODAY', 'metrics_today', campaigns, accountId, syncedAt, normalizedCurrency);

  const rows = Array.from(campaigns.values()).filter((row) => row.status !== 'REMOVED');
  // Chunked: each row carries three JSONB metric blobs, and a 10 000-campaign
  // account produced a multi-megabyte PostgREST body in a single request.
  for (let index = 0; index < rows.length; index += 500) {
    const { error } = await supabase
      .from('campaigns_cache')
      .upsert(rows.slice(index, index + 500), { onConflict: 'account_id,google_campaign_id' });
    if (error) throw error;
  }

  await removeStaleCampaigns(supabase, accountId, rows.map((row) => row.google_campaign_id));

  return {
    updated: rows.length,
    active: rows.filter((row) => row.status === 'ENABLED').length,
  };
}

export async function syncCampaignCacheWithLoginFallback({
  supabase,
  customerId,
  refreshToken,
  accountId,
  currencyCode,
  loginCustomerIds = [],
  allowDiscoveryFallback = true,
}: {
  supabase: SupabaseClient;
  customerId: string;
  refreshToken: string;
  accountId: string;
  currencyCode?: string | null;
  loginCustomerIds?: Array<string | null | undefined>;
  /** Batch jobs disable this: a full MCC walk per account blows the budget. */
  allowDiscoveryFallback?: boolean;
}) {
  const normalizedCustomerId = customerId.replace(/\D/g, '');
  const tried = new Set<string>();
  let lastError: unknown;

  async function tryLoginCandidates(candidates: Array<string | null | undefined>) {
    for (const loginCustomerId of normalizeLoginCandidates(candidates, normalizedCustomerId)) {
      const key = loginCustomerId ?? 'direct';
      if (tried.has(key)) continue;
      tried.add(key);

      try {
        const customer = getCustomer(normalizedCustomerId, refreshToken, loginCustomerId ?? undefined);
        const result = await syncCampaignCache({ supabase, customer, accountId, currencyCode });
        return {
          ...result,
          loginCustomerId: loginCustomerId ?? null,
          attemptedLoginCustomerIds: Array.from(tried),
        };
      } catch (error) {
        lastError = error;
        // A manager account is a manager no matter which login-customer-id we
        // present, so retrying the whole chain only multiplies the failure.
        if (error instanceof ManagerAccountError) throw error;
        if (!canRetryWithAnotherLoginCustomer(error)) throw error;
      }
    }

    return null;
  }

  const directAndKnownManagers = await tryLoginCandidates([
    null,
    normalizedCustomerId,
    ...loginCustomerIds,
    ...getConfiguredGoogleAdsManagerIds(),
  ]);
  if (directAndKnownManagers) return directAndKnownManagers;

  // Full MCC re-discovery is expensive (a tree walk plus metadata reads), so
  // it is a last resort only, and only when the failure so far looks like a
  // wrong login-customer-id. Running it per account inside the nightly cron
  // loop is what pushed that job past its 300s budget.
  if (allowDiscoveryFallback && canRetryWithAnotherLoginCustomer(lastError)) {
    try {
      const discovered = await discoverAccessibleCustomers(refreshToken);
      const discoveredManagers = discovered.flatMap((account) => [
        account.manager_id,
        account.is_manager ? account.customer_id : null,
      ]);
      const discoveredAttempt = await tryLoginCandidates(discoveredManagers);
      if (discoveredAttempt) return discoveredAttempt;
    } catch (error) {
      if (!lastError) lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Google Ads sync failed'));
}

async function queryCampaignMetadata(
  customer: Customer,
  campaigns: Map<string, CampaignAccumulator>,
  accountId: string,
  syncedAt: string
) {
  const rows: any[] = await customer.query(CAMPAIGN_METADATA_QUERY);

  for (const row of rows) {
    const campaign = row.campaign ?? {};
    const budget = row.campaign_budget ?? row.campaignBudget ?? {};
    const campaignId = String(read(campaign, 'id') ?? '');
    if (!campaignId) continue;

    campaigns.set(campaignId, {
      account_id: accountId,
      google_campaign_id: Number(campaignId),
      name: read(campaign, 'name') ?? null,
      type: normalizeChannel(read(campaign, 'advertising_channel_type', 'advertisingChannelType')),
      status: read(campaign, 'status') ?? null,
      daily_budget: microsToNumber(read(budget, 'amount_micros', 'amountMicros')),
      bidding_strategy: read(campaign, 'bidding_strategy_type', 'biddingStrategyType') ?? null,
      metrics_30d: null,
      metrics_7d: null,
      metrics_today: null,
      last_synced_at: syncedAt,
    });
  }
}

async function queryWindow(
  customer: Customer,
  period: string,
  window: MetricsWindow,
  campaigns: Map<string, CampaignAccumulator>,
  accountId: string,
  syncedAt: string,
  currencyCode: string
) {
  const rows: any[] = await customer.query(CAMPAIGN_METRICS_QUERY.replace('__PERIOD__', period));

  for (const row of rows) {
    const campaign = row.campaign ?? {};
    const budget = row.campaign_budget ?? row.campaignBudget ?? {};
    const metrics = row.metrics ?? {};
    const campaignId = String(read(campaign, 'id') ?? '');
    if (!campaignId) continue;

    const existing =
      campaigns.get(campaignId) ??
      ({
        account_id: accountId,
        google_campaign_id: Number(campaignId),
        name: read(campaign, 'name') ?? null,
        type: normalizeChannel(read(campaign, 'advertising_channel_type', 'advertisingChannelType')),
        status: read(campaign, 'status') ?? null,
        daily_budget: microsToNumber(read(budget, 'amount_micros', 'amountMicros')),
        bidding_strategy: read(campaign, 'bidding_strategy_type', 'biddingStrategyType') ?? null,
        metrics_30d: null,
        metrics_7d: null,
        metrics_today: null,
        last_synced_at: syncedAt,
      } satisfies CampaignAccumulator);

    existing.name = existing.name ?? read(campaign, 'name') ?? null;
    existing.type =
      existing.type ?? normalizeChannel(read(campaign, 'advertising_channel_type', 'advertisingChannelType'));
    existing.status = existing.status ?? read(campaign, 'status') ?? null;
    existing.daily_budget =
      existing.daily_budget ?? microsToNumber(read(budget, 'amount_micros', 'amountMicros'));
    existing.bidding_strategy =
      existing.bidding_strategy ?? read(campaign, 'bidding_strategy_type', 'biddingStrategyType') ?? null;
    existing[window] = toMetrics(metrics, currencyCode);
    existing.last_synced_at = syncedAt;
    campaigns.set(campaignId, existing);
  }
}

function toMetrics(metrics: any, currencyCode: string): CampaignMetrics {
  const cost = microsToNumber(read(metrics, 'cost_micros', 'costMicros')) ?? 0;
  const clicks = Number(read(metrics, 'clicks') ?? 0);
  const impressions = Number(read(metrics, 'impressions') ?? 0);
  const conversions = Number(read(metrics, 'conversions') ?? 0);
  const conversionValue = Number(read(metrics, 'conversions_value', 'conversionsValue') ?? 0);

  return {
    cost: round(cost),
    clicks,
    impressions,
    conversions: round(conversions, 3),
    conversion_value: round(conversionValue),
    ctr: impressions > 0 ? round(clicks / impressions, 4) : 0,
    cpc: clicks > 0 ? round(cost / clicks) : 0,
    cpa: conversions > 0 ? round(cost / conversions) : 0,
    roas: cost > 0 ? round(conversionValue / cost, 2) : 0,
    currency_code: currencyCode,
  };
}

async function removeStaleCampaigns(
  supabase: SupabaseClient,
  accountId: string,
  currentCampaignIds: number[]
) {
  const { data: cached, error } = await supabase
    .from('campaigns_cache')
    .select('id, google_campaign_id')
    .eq('account_id', accountId);
  if (error) throw error;

  const current = new Set(currentCampaignIds.map(String));
  const staleIds = (cached ?? [])
    .filter((row: any) => !current.has(String(row.google_campaign_id)))
    .map((row: any) => row.id);

  for (let index = 0; index < staleIds.length; index += 200) {
    const chunk = staleIds.slice(index, index + 200);
    const { error: deleteError } = await supabase.from('campaigns_cache').delete().in('id', chunk);
    if (deleteError) throw deleteError;
  }
}

function read(source: any, ...keys: string[]) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) return source[key];
  }
  return null;
}

function microsToNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  return round(Number(value) / 1_000_000);
}

function normalizeChannel(value: unknown) {
  const channel = String(value ?? '');
  if (channel === 'PERFORMANCE_MAX') return 'PMAX';
  const allowed = ['SEARCH', 'DISPLAY', 'PMAX', 'SHOPPING', 'VIDEO', 'APP', 'LOCAL', 'DEMAND_GEN'];
  return allowed.includes(channel) ? channel : null;
}

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function normalizeCurrency(value?: string | null) {
  const normalized = String(value ?? 'SAR').toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : 'SAR';
}

function normalizeLoginCandidates(
  candidates: Array<string | null | undefined>,
  normalizedCustomerId: string
) {
  const normalized: Array<string | null> = [];

  for (const candidate of candidates) {
    if (!candidate) {
      if (!normalized.includes(null)) normalized.push(null);
      continue;
    }

    const id = candidate.replace(/\D/g, '');
    if (!id || normalized.includes(id)) continue;
    normalized.push(id);
  }

  return normalized;
}

function canRetryWithAnotherLoginCustomer(error: unknown) {
  const codes = getGoogleAdsErrorCodes(error);
  if (codes.some((code) => code === 'REQUESTED_METRICS_FOR_MANAGER' || code === 'INVALID_GRANT')) {
    return false;
  }

  if (
    codes.some((code) =>
      ['USER_PERMISSION_DENIED', 'CUSTOMER_NOT_FOUND', 'CUSTOMER_NOT_ENABLED', 'AUTHENTICATION_ERROR'].includes(code)
    )
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  return /permission|customer.*not.*found|not.*enabled|login-customer/i.test(message);
}

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdsAccountSummary } from '@/lib/accounts/selection';
import { getLinkedGoogleAdsAccount } from '@/lib/accounts/selection';
import { decrypt } from '@/lib/crypto';
import type { CampaignMetrics } from '@/lib/google-ads/sync';
import {
  queryCampaignRangePerformanceWithLoginFallback,
  type CampaignRangePerformance,
} from '@/lib/google-ads/range-performance';
import type { DateRangeSelection } from './date-range';

const LIVE_RANGE_CACHE_TTL_MS = 5 * 60 * 1000;
const LIVE_RANGE_CACHE_MAX_ENTRIES = 100;

type CachedRange = {
  expiresAt: number;
  promise: Promise<CampaignRangePerformance[]>;
};

const liveRangeCache = new Map<string, CachedRange>();

export type CampaignWithRangeMetrics = Record<string, any> & {
  range_metrics: CampaignMetrics;
};

export async function loadCampaignsForDateRange({
  supabase,
  userId,
  selectedAccount,
  campaigns,
  range,
}: {
  supabase: SupabaseClient;
  userId: string;
  selectedAccount: AdsAccountSummary;
  campaigns: Record<string, any>[];
  range: DateRangeSelection;
}): Promise<CampaignWithRangeMetrics[]> {
  const metricKey = range.metricKey;
  if (metricKey) {
    return campaigns.map((campaign) => ({
      ...campaign,
      range_metrics: normalizeMetrics(
        campaign[metricKey],
        selectedAccount.currency_code
      ),
    }));
  }

  const { account, error } = await getLinkedGoogleAdsAccount({
    supabase,
    userId,
    customerId: selectedAccount.customer_id,
    select:
      'id, customer_id, customer_name, manager_id, currency_code, refresh_token_encrypted',
  });
  if (error || !account) throw new Error('Linked Google Ads account not found');

  const cacheKey = [account.id, range.from, range.to].join(':');
  const liveRows = await cachedRangeQuery(cacheKey, () =>
    queryCampaignRangePerformanceWithLoginFallback({
      customerId: account.customer_id,
      refreshToken: decrypt(account.refresh_token_encrypted),
      loginCustomerId: account.manager_id,
      currencyCode: account.currency_code,
      from: range.from,
      to: range.to,
    })
  );

  return mergeCampaignRangeMetrics(campaigns, liveRows, selectedAccount.currency_code);
}

export function mergeCampaignRangeMetrics(
  campaigns: Record<string, any>[],
  liveRows: CampaignRangePerformance[],
  currencyCode?: string | null
): CampaignWithRangeMetrics[] {
  const liveById = new Map(liveRows.map((row) => [String(row.google_campaign_id), row]));
  const merged: CampaignWithRangeMetrics[] = campaigns.map((campaign) => {
    const campaignId = String(campaign.google_campaign_id ?? '');
    const live = liveById.get(campaignId);
    if (live) liveById.delete(campaignId);

    return {
      ...campaign,
      name: live?.name ?? campaign.name,
      type: live?.type ?? campaign.type,
      status: live?.status ?? campaign.status,
      daily_budget: live?.daily_budget ?? campaign.daily_budget,
      bidding_strategy: live?.bidding_strategy ?? campaign.bidding_strategy,
      range_metrics: live?.metrics ?? emptyMetrics(currencyCode),
    };
  });

  for (const live of liveById.values()) {
    merged.push({
      id: `live:${live.google_campaign_id}`,
      account_id: null,
      google_campaign_id: live.google_campaign_id,
      name: live.name,
      type: live.type,
      status: live.status,
      daily_budget: live.daily_budget,
      bidding_strategy: live.bidding_strategy,
      last_synced_at: null,
      range_metrics: live.metrics,
    });
  }

  return merged;
}

async function cachedRangeQuery(
  key: string,
  loader: () => Promise<CampaignRangePerformance[]>
) {
  const now = Date.now();
  const cached = liveRangeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  if (cached) liveRangeCache.delete(key);

  const promise = loader().catch((error) => {
    liveRangeCache.delete(key);
    throw error;
  });
  liveRangeCache.set(key, { expiresAt: now + LIVE_RANGE_CACHE_TTL_MS, promise });

  while (liveRangeCache.size > LIVE_RANGE_CACHE_MAX_ENTRIES) {
    const oldestKey = liveRangeCache.keys().next().value;
    if (!oldestKey) break;
    liveRangeCache.delete(oldestKey);
  }

  return promise;
}

function normalizeMetrics(value: unknown, currencyCode?: string | null): CampaignMetrics {
  const metrics = (value ?? {}) as Record<string, unknown>;
  const cost = finiteNumber(metrics.cost);
  const clicks = finiteNumber(metrics.clicks);
  const impressions = finiteNumber(metrics.impressions);
  const conversions = finiteNumber(metrics.conversions);
  const conversionValue = finiteNumber(metrics.conversion_value);

  return {
    cost,
    clicks,
    impressions,
    conversions,
    conversion_value: conversionValue,
    ctr: finiteNumber(metrics.ctr, impressions > 0 ? clicks / impressions : 0),
    cpc: finiteNumber(metrics.cpc, clicks > 0 ? cost / clicks : 0),
    cpa: finiteNumber(metrics.cpa, conversions > 0 ? cost / conversions : 0),
    roas: finiteNumber(metrics.roas, cost > 0 ? conversionValue / cost : 0),
    currency_code: normalizeCurrency(metrics.currency_code, currencyCode),
  };
}

function emptyMetrics(currencyCode?: string | null): CampaignMetrics {
  return normalizeMetrics({}, currencyCode);
}

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeCurrency(value: unknown, fallback?: string | null) {
  const normalized = String(value ?? fallback ?? 'SAR').toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : 'SAR';
}

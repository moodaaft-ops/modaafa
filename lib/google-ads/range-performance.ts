import type { Customer } from 'google-ads-api';
import {
  getConfiguredGoogleAdsManagerIds,
  getCustomer,
  getGoogleAdsErrorCodes,
} from './client';
import { assertNotManagerAccount, ManagerAccountError, type CampaignMetrics } from './sync';

export type CampaignRangePerformance = {
  google_campaign_id: number;
  name: string | null;
  type: string | null;
  status: string | null;
  daily_budget: number | null;
  bidding_strategy: string | null;
  metrics: CampaignMetrics;
};

export async function queryCampaignRangePerformanceWithLoginFallback({
  customerId,
  refreshToken,
  loginCustomerId,
  currencyCode,
  from,
  to,
}: {
  customerId: string;
  refreshToken: string;
  loginCustomerId?: string | null;
  currencyCode?: string | null;
  from: string;
  to: string;
}) {
  const normalizedCustomerId = customerId.replace(/\D/g, '');
  const candidates = normalizeLoginCandidates([
    null,
    loginCustomerId,
    ...getConfiguredGoogleAdsManagerIds(),
  ]);
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      const customer = getCustomer(normalizedCustomerId, refreshToken, candidate ?? undefined);
      return await queryCampaignRangePerformance({ customer, currencyCode, from, to });
    } catch (error) {
      lastError = error;
      if (error instanceof ManagerAccountError) throw error;
      if (!canRetryWithAnotherLoginCustomer(error)) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Google Ads range query failed');
}

export async function queryCampaignRangePerformance({
  customer,
  currencyCode,
  from,
  to,
}: {
  customer: Customer;
  currencyCode?: string | null;
  from: string;
  to: string;
}): Promise<CampaignRangePerformance[]> {
  assertSafeIsoDate(from);
  assertSafeIsoDate(to);
  await assertNotManagerAccount(customer);

  const rows: any[] = await customer.query(buildCampaignRangeQuery(from, to));
  const normalizedCurrency = normalizeCurrency(currencyCode);

  return rows.flatMap((row) => {
    const campaign = row.campaign ?? {};
    const budget = row.campaign_budget ?? row.campaignBudget ?? {};
    const campaignId = Number(read(campaign, 'id'));
    if (!Number.isFinite(campaignId) || campaignId <= 0) return [];

    return [{
      google_campaign_id: campaignId,
      name: stringOrNull(read(campaign, 'name')),
      type: normalizeChannel(read(campaign, 'advertising_channel_type', 'advertisingChannelType')),
      status: stringOrNull(read(campaign, 'status')),
      daily_budget: microsToNumber(read(budget, 'amount_micros', 'amountMicros')),
      bidding_strategy: stringOrNull(
        read(campaign, 'bidding_strategy_type', 'biddingStrategyType')
      ),
      metrics: toMetrics(row.metrics ?? {}, normalizedCurrency),
    }];
  });
}

export function buildCampaignRangeQuery(from: string, to: string) {
  assertSafeIsoDate(from);
  assertSafeIsoDate(to);

  return `
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
    WHERE campaign.status != 'REMOVED'
      AND segments.date BETWEEN '${from}' AND '${to}'
    ORDER BY metrics.cost_micros DESC
    LIMIT 10000
  `;
}

function toMetrics(metrics: any, currencyCode: string): CampaignMetrics {
  const cost = microsToNumber(read(metrics, 'cost_micros', 'costMicros')) ?? 0;
  const clicks = numberOrZero(read(metrics, 'clicks'));
  const impressions = numberOrZero(read(metrics, 'impressions'));
  const conversions = numberOrZero(read(metrics, 'conversions'));
  const conversionValue = numberOrZero(read(metrics, 'conversions_value', 'conversionsValue'));

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

function normalizeLoginCandidates(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: Array<string | null> = [];

  for (const value of values) {
    if (!value) {
      if (!seen.has('direct')) {
        seen.add('direct');
        result.push(null);
      }
      continue;
    }

    const normalized = value.replace(/\D/g, '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
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

function assertSafeIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Invalid Google Ads date range');
  }
}

function read(source: any, ...keys: string[]) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) return source[key];
  }
  return null;
}

function numberOrZero(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function microsToNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? round(parsed / 1_000_000) : null;
}

function stringOrNull(value: unknown) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeChannel(value: unknown) {
  const channel = String(value ?? '');
  if (channel === 'PERFORMANCE_MAX') return 'PMAX';
  const allowed = ['SEARCH', 'DISPLAY', 'PMAX', 'SHOPPING', 'VIDEO', 'APP', 'LOCAL', 'DEMAND_GEN'];
  return allowed.includes(channel) ? channel : null;
}

function normalizeCurrency(value?: string | null) {
  const normalized = String(value ?? 'SAR').toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : 'SAR';
}

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

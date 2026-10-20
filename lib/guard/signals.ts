/**
 * Reads for the morning guard. The hourly sync stores only 30 day, 7 day and
 * today totals per campaign (campaigns_cache), which cannot tell yesterday from
 * a normal day, so the daily history comes from small GAQL reads here. Every
 * read is separate and fail-soft: a read that fails marks its source as
 * unknown (`ok[source] = false`), and unknown is never treated as "all clear".
 */
import { getGoogleAdsErrorCodes } from '@/lib/google-ads/client';
import { BASELINE_DAYS } from './detectors';
import { isShoppingHealthEnabled } from '../shopping/flag';
import { readShoppingHealthOrThrow } from '../shopping/reader';
import { DEFAULT_TIME_ZONE, addDaysYmd, ymdInZone, zonedStringToEpoch } from './time';
import type {
  AdPolicyRow,
  BillingSignals,
  CampaignInfo,
  ChangeRow,
  DailyRow,
  GuardSignals,
  GuardOk,
  OwnAction,
} from './types';

export type GaqlReader = { query(gaql: string): Promise<any[]> };

export type AccountRef = {
  id: string;
  customerId: string;
  currency: string | null;
  timeZone: string | null;
  /** google_ads_accounts.google_status, used when Google cannot be asked. */
  storedGoogleStatus: string | null;
};

const ROW_LIMIT = 10_000;
const CHANGE_LIMIT = 500;
const POLICY_LIMIT = 1_000;

// ---------------------------------------------------------------------------
// Row reading: REST returns camelCase, older paths snake_case.
// ---------------------------------------------------------------------------
const camel = (segment: string) => segment.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

export function pick(row: unknown, path: string): unknown {
  let current: unknown = row;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    const object = current as Record<string, unknown>;
    const key = camel(segment);
    current = object[key] !== undefined ? object[key] : object[segment];
  }
  return current;
}

function num(row: unknown, path: string): number | null {
  const raw = pick(row, path);
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
const str = (row: unknown, path: string) => {
  const raw = pick(row, path);
  return raw === undefined || raw === null ? '' : String(raw);
};
const micros = (row: unknown, path: string) => (num(row, path) ?? 0) / 1_000_000;

function enumName(value: unknown): string {
  return String(value ?? '').toUpperCase();
}

function idFromResource(resource: string | undefined, segment: string): string | null {
  const match = new RegExp(`/${segment}/(\\d+)`).exec(resource ?? '');
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export const STATUS_QUERY = `SELECT customer.status FROM customer LIMIT 1`;

export const dailyQuery = (from: string, to: string) => `
  SELECT campaign.id, campaign.name, segments.date,
    metrics.cost_micros, metrics.conversions, metrics.clicks, metrics.impressions
  FROM campaign
  WHERE campaign.status = 'ENABLED' AND segments.date BETWEEN '${from}' AND '${to}'
  ORDER BY segments.date DESC
  LIMIT ${ROW_LIMIT}
`;

export const CAMPAIGN_INFO_QUERY = `
  SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status,
    campaign.primary_status_reasons, campaign_budget.amount_micros
  FROM campaign
  WHERE campaign.status = 'ENABLED'
  LIMIT 1000
`;

export const impressionShareQuery = (from: string, to: string) => `
  SELECT campaign.id, segments.date, metrics.search_impression_share,
    metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
  FROM campaign
  WHERE campaign.status = 'ENABLED' AND segments.date BETWEEN '${from}' AND '${to}'
  ORDER BY segments.date DESC
  LIMIT ${ROW_LIMIT}
`;

export const ADS_QUERY = `
  SELECT ad_group_ad.ad.id, campaign.id, campaign.name,
    ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.policy_topic_entries
  FROM ad_group_ad
  WHERE ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
    AND ad_group_ad.policy_summary.approval_status IN ('DISAPPROVED', 'APPROVED_LIMITED')
  LIMIT ${POLICY_LIMIT}
`;

export const BILLING_SETUP_QUERY = `SELECT billing_setup.status FROM billing_setup LIMIT 20`;

export const ACCOUNT_BUDGET_QUERY = `
  SELECT account_budget.name, account_budget.status, account_budget.approved_spending_limit_micros,
    account_budget.adjusted_spending_limit_micros, account_budget.amount_served_micros,
    account_budget.approved_end_date_time, account_budget.approved_end_time_type
  FROM account_budget
  LIMIT 20
`;

export const changesQuery = (from: string, to: string) => `
  SELECT change_event.change_date_time, change_event.client_type, change_event.change_resource_type,
    change_event.resource_change_operation, change_event.changed_fields,
    change_event.change_resource_name, change_event.campaign, campaign.name
  FROM change_event
  WHERE change_event.change_date_time >= '${from} 00:00:00' AND change_event.change_date_time <= '${to} 23:59:59'
  ORDER BY change_event.change_date_time DESC
  LIMIT ${CHANGE_LIMIT}
`;

// ---------------------------------------------------------------------------
// Parsers (exported so tests can feed raw rows)
// ---------------------------------------------------------------------------
export function parseDaily(rows: any[]): DailyRow[] {
  const out: DailyRow[] = [];
  for (const row of rows) {
    const id = str(row, 'campaign.id');
    const date = str(row, 'segments.date');
    if (!id || !date) continue;
    out.push({
      campaignId: id,
      campaignName: str(row, 'campaign.name'),
      date,
      cost: micros(row, 'metrics.cost_micros'),
      conversions: num(row, 'metrics.conversions') ?? 0,
      clicks: num(row, 'metrics.clicks') ?? 0,
      impressions: num(row, 'metrics.impressions') ?? 0,
    });
  }
  return out;
}

export function parseCampaignInfo(rows: any[]): CampaignInfo[] {
  const out: CampaignInfo[] = [];
  for (const row of rows) {
    const id = str(row, 'campaign.id');
    if (!id) continue;
    const reasons = pick(row, 'campaign.primary_status_reasons');
    const budgetMicros = num(row, 'campaign_budget.amount_micros');
    out.push({
      id,
      name: str(row, 'campaign.name'),
      status: enumName(pick(row, 'campaign.status')),
      dailyBudget: budgetMicros === null ? null : budgetMicros / 1_000_000,
      primaryStatus: enumName(pick(row, 'campaign.primary_status')) || null,
      primaryReasons: Array.isArray(reasons) ? reasons.map(enumName) : [],
      budgetLostIs: null,
      rankLostIs: null,
      impressionShare: null,
      baselineImpressionShare: null,
    });
  }
  return out;
}

/** Fills yesterday's lost shares and the 14 day impression share baseline into the campaign list. */
export function mergeImpressionShare(campaigns: CampaignInfo[], rows: any[], yesterday: string): CampaignInfo[] {
  const base = new Map<string, number[]>();
  const yest = new Map<string, { is: number | null; budget: number | null; rank: number | null }>();
  for (const row of rows) {
    const id = str(row, 'campaign.id');
    const date = str(row, 'segments.date');
    if (!id) continue;
    const is = num(row, 'metrics.search_impression_share');
    if (date === yesterday) {
      yest.set(id, {
        is,
        budget: num(row, 'metrics.search_budget_lost_impression_share'),
        rank: num(row, 'metrics.search_rank_lost_impression_share'),
      });
    } else if (is !== null) {
      base.set(id, [...(base.get(id) ?? []), is]);
    }
  }
  return campaigns.map((c) => {
    const y = yest.get(c.id);
    const b = base.get(c.id);
    return {
      ...c,
      budgetLostIs: y?.budget ?? null,
      rankLostIs: y?.rank ?? null,
      impressionShare: y?.is ?? null,
      baselineImpressionShare: b && b.length ? b.reduce((s, v) => s + v, 0) / b.length : null,
    };
  });
}

export function parseAds(rows: any[]): AdPolicyRow[] {
  const out: AdPolicyRow[] = [];
  for (const row of rows) {
    const approval = enumName(pick(row, 'ad_group_ad.policy_summary.approval_status'));
    if (approval !== 'DISAPPROVED' && approval !== 'APPROVED_LIMITED') continue;
    const entries = pick(row, 'ad_group_ad.policy_summary.policy_topic_entries');
    const topics = Array.isArray(entries)
      ? entries.map((e) => String((e as any)?.topic ?? '').toUpperCase()).filter(Boolean)
      : [];
    out.push({
      adId: str(row, 'ad_group_ad.ad.id'),
      campaignId: str(row, 'campaign.id'),
      campaignName: str(row, 'campaign.name'),
      approval,
      topics,
    });
  }
  return out.filter((a) => a.adId && a.campaignId);
}

export function parseBilling(setupRows: any[] | null, budgetRows: any[] | null, timeZone: string): BillingSignals {
  const budgets: BillingSignals['budgets'] = [];
  for (const row of budgetRows ?? []) {
    const adjusted = num(row, 'account_budget.adjusted_spending_limit_micros');
    const approved = num(row, 'account_budget.approved_spending_limit_micros');
    const limitMicros = adjusted && adjusted > 0 ? adjusted : approved && approved > 0 ? approved : null;
    const endType = enumName(pick(row, 'account_budget.approved_end_time_type'));
    const endText = str(row, 'account_budget.approved_end_date_time');
    budgets.push({
      name: str(row, 'account_budget.name'),
      status: enumName(pick(row, 'account_budget.status')),
      limit: limitMicros === null ? null : limitMicros / 1_000_000,
      served: micros(row, 'account_budget.amount_served_micros'),
      endsAt: endType === 'FOREVER' || !endText ? null : zonedStringToEpoch(endText, timeZone),
    });
  }
  return {
    setupStatuses: (setupRows ?? []).map((row) => enumName(pick(row, 'billing_setup.status'))).filter(Boolean),
    budgets,
  };
}

export function parseChanges(rows: any[], timeZone: string): ChangeRow[] {
  const out: ChangeRow[] = [];
  for (const row of rows) {
    const at = zonedStringToEpoch(str(row, 'change_event.change_date_time'), timeZone);
    if (at === null) continue;
    const fields = pick(row, 'change_event.changed_fields');
    out.push({
      at,
      clientType: enumName(pick(row, 'change_event.client_type')),
      resourceType: enumName(pick(row, 'change_event.change_resource_type')),
      operation: enumName(pick(row, 'change_event.resource_change_operation')),
      resourceName: str(row, 'change_event.change_resource_name'),
      campaignId: idFromResource(str(row, 'change_event.campaign'), 'campaigns'),
      campaignName: str(row, 'campaign.name') || null,
      fields: typeof fields === 'string' ? fields.slice(0, 120) : Array.isArray(fields) ? fields.map(String).join(',').slice(0, 120) : '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Our own execution log
// ---------------------------------------------------------------------------
const OWN_LOOKBACK_MS = 4 * 86_400_000;

export function toOwnActions(rows: Array<Record<string, any>>): OwnAction[] {
  const out: OwnAction[] = [];
  for (const row of rows) {
    if (row.action_type === 'approval_queued') continue;
    const at = [row.created_at, row.rollback_started_at, row.reverted_at]
      .map((value) => (value ? new Date(value).getTime() : NaN))
      .filter((value) => Number.isFinite(value));
    if (at.length === 0) continue;
    const payload = (row.rollback_payload ?? {}) as Record<string, any>;
    const resources: string[] = [];
    for (const key of ['budget_resource', 'resource_name', 'ad_group_resource', 'campaign_resource']) {
      if (typeof payload[key] === 'string') resources.push(payload[key]);
    }
    if (Array.isArray(payload.resource_names)) {
      for (const name of payload.resource_names) if (typeof name === 'string') resources.push(name);
    }
    out.push({ at, resources });
  }
  return out;
}

export async function loadOwnActions(supabase: any, accountId: string, now: Date): Promise<OwnAction[] | null> {
  try {
    const { data, error } = await supabase
      .from('ai_actions')
      .select('action_type, created_at, rollback_started_at, reverted_at, rollback_payload')
      .eq('account_id', accountId)
      .gte('created_at', new Date(now.getTime() - OWN_LOOKBACK_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return null;
    return toOwnActions((data ?? []) as Array<Record<string, any>>);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------
async function attempt<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function loadSignals(args: {
  account: AccountRef;
  customer: GaqlReader;
  supabase: any;
  now: Date;
}): Promise<GuardSignals> {
  const { account, customer, supabase, now } = args;
  const timeZone = account.timeZone || DEFAULT_TIME_ZONE;
  const today = ymdInZone(now, timeZone);
  const yesterday = addDaysYmd(today, -1);
  const ok: GuardOk = { status: false, daily: false, campaigns: false, ads: false, billing: false, changes: false };

  const base: GuardSignals = {
    accountId: account.id,
    customerId: account.customerId,
    currency: (account.currency || 'SAR').toUpperCase(),
    timeZone,
    now,
    today,
    yesterday,
    googleStatus: account.storedGoogleStatus,
    daily: [],
    campaigns: [],
    ads: [],
    billing: null,
    changes: [],
    ownActions: [],
    ok,
  };

  // Status first: a closed or suspended account answers nothing else.
  const status = await attempt(() => customer.query(STATUS_QUERY));
  if (status.ok) {
    ok.status = true;
    base.googleStatus = enumName(pick(status.value[0], 'customer.status')) || base.googleStatus;
  } else if (getGoogleAdsErrorCodes(status.error).includes('CUSTOMER_NOT_ENABLED')) {
    ok.status = true;
    base.googleStatus = 'CUSTOMER_NOT_ENABLED';
    return base;
  }
  if (ok.status && ['SUSPENDED', 'CANCELED', 'CLOSED'].includes(base.googleStatus ?? '')) return base;

  const dailyFrom = addDaysYmd(yesterday, -BASELINE_DAYS);
  const changeFrom = addDaysYmd(today, -3);
  const changeTo = addDaysYmd(today, 1);
  const [daily, info, ads, setups, budgets, changes, own, shopping] = await Promise.all([
    attempt(() => customer.query(dailyQuery(dailyFrom, yesterday))),
    attempt(() => customer.query(CAMPAIGN_INFO_QUERY)),
    attempt(() => customer.query(ADS_QUERY)),
    attempt(() => customer.query(BILLING_SETUP_QUERY)),
    attempt(() => customer.query(ACCOUNT_BUDGET_QUERY)),
    attempt(() => customer.query(changesQuery(changeFrom, changeTo))),
    loadOwnActions(supabase, account.id, now),
    isShoppingHealthEnabled() ? attempt(() => readShoppingHealthOrThrow(customer)) : Promise.resolve(null),
  ]);

  if (daily.ok) {
    ok.daily = true;
    base.daily = parseDaily(daily.value);
  }
  if (info.ok) {
    ok.campaigns = true;
    base.campaigns = parseCampaignInfo(info.value);
  }
  if (ads.ok) {
    ok.ads = true;
    base.ads = parseAds(ads.value);
  }
  if (setups.ok || budgets.ok) {
    ok.billing = true;
    base.billing = parseBilling(setups.ok ? setups.value : null, budgets.ok ? budgets.value : null, timeZone);
  }
  // Own log unreadable: outside changes cannot be told from ours, so they stay unknown.
  if (changes.ok && own !== null) {
    ok.changes = true;
    base.changes = parseChanges(changes.value, timeZone);
    base.ownActions = own;
  } else if (own !== null) {
    base.ownActions = own;
  }
  if (shopping && shopping.ok) {
    ok.shopping = true;
    base.shopping = shopping.value;
  }
  return base;
}

/** Phase 2, only when an anomaly needs it: lost impression share for the diagnosis. Fail-soft. */
export async function withImpressionShare(signals: GuardSignals, customer: GaqlReader): Promise<GuardSignals> {
  if (!signals.ok.campaigns) return signals;
  const read = await attempt(() => customer.query(impressionShareQuery(addDaysYmd(signals.yesterday, -BASELINE_DAYS), signals.yesterday)));
  if (!read.ok) return signals;
  return { ...signals, campaigns: mergeImpressionShare(signals.campaigns, read.value, signals.yesterday) };
}


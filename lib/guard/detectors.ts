/**
 * The morning guard's rules. Pure functions: a fixture in, findings out, no
 * model, no network, no clock. Thresholds are named constants so a test (and
 * Ayman) can read what "abnormal" means.
 *
 * Dedupe keys: a condition that stays true (a suspended account, an
 * unspent campaign, a disapproved ad) has a STABLE key, so it is one open
 * finding that is sent once and closed when it stops being true. A batch of
 * outside changes is keyed by the changes themselves.
 */
import { createHash } from 'node:crypto';
import { addDaysYmd } from './time';
import {
  ACTOR_AR,
  RESOURCE_TYPE_AR,
  accountStatusCopy,
  adDisapprovedCopy,
  adLimitedCopy,
  budgetEndsCopy,
  budgetExhaustedCopy,
  budgetNearCopy,
  cleanName,
  conversionsZeroCopy,
  cpaSpikeCopy,
  outsideChangeCopy,
  spendSpikeCopy,
  spendZeroCopy,
  BILLING_SETUP_COPY,
  type ChangeActor,
} from './copy';
import type { ChangeRow, DailyRow, GuardFinding, GuardSignals, OwnAction } from './types';

/** Days of history that define "normal". */
export const BASELINE_DAYS = 14;
/** Yesterday at or above this many times the median is a spike. */
export const SPEND_SPIKE_FACTOR = 2;
/** A series "normally spends" when at least this many of the 14 baseline days had spend. */
export const MIN_ACTIVE_DAYS = 8;
/** A spike smaller than this (account currency) is noise, whatever the ratio. */
export const MIN_SPIKE_DELTA = 20;
/** "Converts most days": at least this many of the 14 baseline days with a conversion. */
export const CONVERTS_MOST_DAYS = 10;
/** Clicks yesterday below this make a zero-conversion day unremarkable. */
export const MIN_CLICKS_FOR_TRACKING_SUSPICION = 3;
export const CPA_SPIKE_FACTOR = 2;
export const CPA_MIN_BASELINE_CONVERSIONS = 10;
/** Share of the approved limit already served that counts as "almost out". */
export const BUDGET_NEAR_RATIO = 0.85;
export const BUDGET_ENDS_SOON_MS = 3 * 86_400_000;
/** A change this close to one of our own executions, made through the API, is ours. */
export const OWN_CHANGE_WINDOW_MS = 20 * 60_000;
/** A change on a resource named in our rollback payloads is ours within this window of our timestamps. */
export const OWN_RESOURCE_WINDOW_MS = 6 * 3_600_000;
export const OUTSIDE_CHANGE_LOOKBACK_MS = 24 * 3_600_000;
/** At most this many campaign-level findings per rule per account per day; the rest ride in the evidence. */
export const MAX_CAMPAIGN_FINDINGS = 3;

const MATERIAL_TYPES = new Set([
  'CAMPAIGN',
  'CAMPAIGN_BUDGET',
  'AD_GROUP',
  'AD_GROUP_AD',
  'AD_GROUP_CRITERION',
  'CAMPAIGN_CRITERION',
  'AD_GROUP_BID_MODIFIER',
]);
export const isMaterialChange = (row: ChangeRow) => MATERIAL_TYPES.has(row.resourceType);

// ---------------------------------------------------------------------------
// Series helpers
// ---------------------------------------------------------------------------
type Day = { cost: number; conversions: number; clicks: number };
export type Series = {
  baseline: Day[];
  yesterday: Day;
  medianCost: number;
  activeDays: number;
  convDays: number;
  baselineCost: number;
  baselineConversions: number;
  medianClicks: number;
};

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function buildSeries(rows: DailyRow[], yesterday: string): Series {
  const byDate = new Map<string, Day>();
  for (const row of rows) {
    const day = byDate.get(row.date) ?? { cost: 0, conversions: 0, clicks: 0 };
    day.cost += row.cost;
    day.conversions += row.conversions;
    day.clicks += row.clicks;
    byDate.set(row.date, day);
  }
  const empty = (): Day => ({ cost: 0, conversions: 0, clicks: 0 });
  const baseline: Day[] = [];
  for (let offset = BASELINE_DAYS; offset >= 1; offset -= 1) {
    baseline.push(byDate.get(addDaysYmd(yesterday, -offset)) ?? empty());
  }
  return {
    baseline,
    yesterday: byDate.get(yesterday) ?? empty(),
    medianCost: median(baseline.map((d) => d.cost)),
    activeDays: baseline.filter((d) => d.cost > 0).length,
    convDays: baseline.filter((d) => d.conversions > 0).length,
    baselineCost: baseline.reduce((sum, d) => sum + d.cost, 0),
    baselineConversions: baseline.reduce((sum, d) => sum + d.conversions, 0),
    medianClicks: median(baseline.map((d) => d.clicks)),
  };
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const normallySpends = (series: Series) => series.activeDays >= MIN_ACTIVE_DAYS && series.medianCost > 0;

function campaigns(signals: GuardSignals) {
  const map = new Map<string, { id: string; name: string; rows: DailyRow[] }>();
  for (const row of signals.daily) {
    const entry = map.get(row.campaignId) ?? { id: row.campaignId, name: row.campaignName, rows: [] };
    entry.rows.push(row);
    map.set(row.campaignId, entry);
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Spend: zero and spike
// ---------------------------------------------------------------------------
export function detectSpend(signals: GuardSignals): GuardFinding[] {
  if (!signals.ok.daily || signals.daily.length === 0) return [];
  const { currency, yesterday } = signals;
  const out: GuardFinding[] = [];

  const account = buildSeries(signals.daily, yesterday);
  const accountZero = normallySpends(account) && account.yesterday.cost === 0;
  const accountSpike =
    normallySpends(account) &&
    account.yesterday.cost >= SPEND_SPIKE_FACTOR * account.medianCost &&
    account.yesterday.cost - account.medianCost >= MIN_SPIKE_DELTA;

  if (accountZero) {
    const copy = spendZeroCopy({ name: null }, account.medianCost, currency);
    out.push({
      code: 'spend_zero',
      severity: 'critical',
      entityType: 'account',
      entityId: signals.customerId,
      entityName: null,
      whatAr: copy.what,
      stepAr: copy.step,
      evidence: {
        yesterday: yesterday,
        yesterday_spend: 0,
        median_daily_spend_14d: round2(account.medianCost),
        active_days_14d: account.activeDays,
      },
      dedupeKey: 'spend_zero:account',
      escalation: 'none',
      cause: null,
    });
  }
  if (accountSpike) {
    const copy = spendSpikeCopy({ name: null }, account.yesterday.cost, account.medianCost, currency);
    out.push({
      code: 'spend_spike',
      severity: 'high',
      entityType: 'account',
      entityId: signals.customerId,
      entityName: null,
      whatAr: copy.what,
      stepAr: copy.step,
      evidence: {
        yesterday,
        yesterday_spend: round2(account.yesterday.cost),
        median_daily_spend_14d: round2(account.medianCost),
        ratio: round2(account.yesterday.cost / account.medianCost),
      },
      dedupeKey: 'spend_spike:account',
      escalation: 'none',
      cause: null,
    });
  }

  // Campaign level only when the account as a whole did not already say it.
  const perCampaign = campaigns(signals).map((c) => ({ ...c, series: buildSeries(c.rows, yesterday) }));
  const budgets = new Map(signals.campaigns.map((c) => [c.id, c.dailyBudget]));

  if (!accountZero) {
    const zeros = perCampaign
      .filter((c) => normallySpends(c.series) && c.series.yesterday.cost === 0)
      .sort((a, b) => b.series.medianCost - a.series.medianCost);
    // A campaign that is not ENABLED now was stopped on purpose; the daily read only lists enabled ones.
    for (const c of zeros.slice(0, MAX_CAMPAIGN_FINDINGS)) {
      const copy = spendZeroCopy({ name: c.name }, c.series.medianCost, currency);
      out.push({
        code: 'spend_zero',
        severity: 'high',
        entityType: 'campaign',
        entityId: c.id,
        entityName: cleanName(c.name),
        whatAr: copy.what,
        stepAr: copy.step,
        evidence: {
          yesterday,
          yesterday_spend: 0,
          median_daily_spend_14d: round2(c.series.medianCost),
          active_days_14d: c.series.activeDays,
          more_campaigns: Math.max(0, zeros.length - MAX_CAMPAIGN_FINDINGS),
        },
        dedupeKey: `spend_zero:campaign:${c.id}`,
        escalation: 'none',
        cause: null,
      });
    }
  }

  if (!accountSpike) {
    const spikes = perCampaign
      .filter(
        (c) =>
          normallySpends(c.series) &&
          c.series.yesterday.cost >= SPEND_SPIKE_FACTOR * c.series.medianCost &&
          c.series.yesterday.cost - c.series.medianCost >= MIN_SPIKE_DELTA
      )
      .sort((a, b) => b.series.yesterday.cost - b.series.medianCost - (a.series.yesterday.cost - a.series.medianCost));
    for (const c of spikes.slice(0, MAX_CAMPAIGN_FINDINGS)) {
      const budget = budgets.get(c.id) ?? null;
      const copy = spendSpikeCopy({ name: c.name }, c.series.yesterday.cost, c.series.medianCost, currency);
      out.push({
        code: 'spend_spike',
        // Google may spend up to twice the daily budget on one day; beyond that is not normal.
        severity: budget !== null && c.series.yesterday.cost > 2 * budget ? 'high' : 'medium',
        entityType: 'campaign',
        entityId: c.id,
        entityName: cleanName(c.name),
        whatAr: copy.what,
        stepAr: copy.step,
        evidence: {
          yesterday,
          yesterday_spend: round2(c.series.yesterday.cost),
          median_daily_spend_14d: round2(c.series.medianCost),
          ratio: round2(c.series.yesterday.cost / c.series.medianCost),
          daily_budget: budget,
          more_campaigns: Math.max(0, spikes.length - MAX_CAMPAIGN_FINDINGS),
        },
        dedupeKey: `spend_spike:campaign:${c.id}`,
        escalation: 'none',
        cause: null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tracking suspicion: converts most days, none yesterday
// ---------------------------------------------------------------------------
export type ConversionsZeroResult = { finding: GuardFinding | null; campaignIds: string[] };

export function detectConversionsZero(signals: GuardSignals): ConversionsZeroResult {
  if (!signals.ok.daily || signals.daily.length === 0) return { finding: null, campaignIds: [] };
  const { yesterday } = signals;
  const accountSeries = buildSeries(signals.daily, yesterday);
  const hits = campaigns(signals)
    .map((c) => ({ ...c, series: buildSeries(c.rows, yesterday) }))
    .filter(
      (c) =>
        c.series.convDays >= CONVERTS_MOST_DAYS &&
        c.series.yesterday.cost > 0 &&
        c.series.yesterday.clicks >= MIN_CLICKS_FOR_TRACKING_SUSPICION &&
        c.series.yesterday.conversions < 0.01
    )
    .sort((a, b) => b.series.baselineConversions - a.series.baselineConversions);
  if (hits.length === 0) return { finding: null, campaignIds: [] };

  const lostShare =
    accountSeries.baselineConversions > 0
      ? hits.reduce((sum, c) => sum + c.series.baselineConversions, 0) / accountSeries.baselineConversions
      : 0;
  const copy = conversionsZeroCopy(hits.map((c) => c.name));
  const finding: GuardFinding = {
    code: 'conversions_zero',
    severity: lostShare >= 0.5 ? 'high' : 'medium',
    entityType: 'account',
    entityId: signals.customerId,
    entityName: null,
    whatAr: copy.what,
    stepAr: copy.step,
    evidence: {
      yesterday,
      campaigns: hits.slice(0, 5).map((c) => ({
        id: c.id,
        name: cleanName(c.name),
        converting_days_14d: c.series.convDays,
        yesterday_clicks: c.series.yesterday.clicks,
        yesterday_spend: round2(c.series.yesterday.cost),
        median_daily_conversions_14d: round2(median(c.series.baseline.map((d) => d.conversions))),
      })),
      campaign_count: hits.length,
      share_of_14d_conversions: round2(lostShare),
    },
    dedupeKey: 'conversions_zero:account',
    escalation: 'none',
    cause: null,
  };
  return { finding, campaignIds: hits.map((c) => c.id) };
}

// ---------------------------------------------------------------------------
// CPA spike (account level)
// ---------------------------------------------------------------------------
export function detectCpaSpike(signals: GuardSignals): GuardFinding | null {
  if (!signals.ok.daily || signals.daily.length === 0) return null;
  const series = buildSeries(signals.daily, signals.yesterday);
  if (series.baselineConversions < CPA_MIN_BASELINE_CONVERSIONS) return null;
  if (series.yesterday.conversions < 1 || series.yesterday.cost <= 0) return null;
  const baselineCpa = series.baselineCost / series.baselineConversions;
  const cpa = series.yesterday.cost / series.yesterday.conversions;
  if (baselineCpa <= 0 || cpa < CPA_SPIKE_FACTOR * baselineCpa) return null;
  const copy = cpaSpikeCopy(cpa, baselineCpa, signals.currency);
  return {
    code: 'cpa_spike',
    severity: 'medium',
    entityType: 'account',
    entityId: signals.customerId,
    entityName: null,
    whatAr: copy.what,
    stepAr: copy.step,
    evidence: {
      yesterday: signals.yesterday,
      yesterday_cpa: round2(cpa),
      baseline_cpa_14d: round2(baselineCpa),
      ratio: round2(cpa / baselineCpa),
      yesterday_conversions: round2(series.yesterday.conversions),
      baseline_conversions_14d: round2(series.baselineConversions),
    },
    dedupeKey: 'cpa_spike:account',
    escalation: 'none',
    cause: null,
  };
}

// ---------------------------------------------------------------------------
// Ads: disapproved or limited by policy
// ---------------------------------------------------------------------------
export function detectAdPolicy(signals: GuardSignals): GuardFinding[] {
  if (!signals.ok.ads) return [];
  const groups = new Map<string, { campaignId: string; campaignName: string; approval: 'DISAPPROVED' | 'APPROVED_LIMITED'; adIds: string[]; topics: string[] }>();
  for (const ad of signals.ads) {
    const key = `${ad.campaignId}:${ad.approval}`;
    const group = groups.get(key) ?? { campaignId: ad.campaignId, campaignName: ad.campaignName, approval: ad.approval, adIds: [], topics: [] };
    group.adIds.push(ad.adId);
    group.topics.push(...ad.topics);
    groups.set(key, group);
  }
  const out: GuardFinding[] = [];
  for (const group of groups.values()) {
    const adIds = Array.from(new Set(group.adIds)).sort();
    const topics = Array.from(new Set(group.topics)).sort();
    const copy =
      group.approval === 'DISAPPROVED'
        ? adDisapprovedCopy(adIds.length, group.campaignName, topics)
        : adLimitedCopy(adIds.length, group.campaignName, topics);
    // The set of ads is in the key: one more disapproved ad is news, the same ads again is not.
    const setHash = createHash('sha1').update(adIds.join(',')).digest('hex').slice(0, 10);
    out.push({
      code: 'ad_policy',
      severity: group.approval === 'DISAPPROVED' ? 'high' : 'medium',
      entityType: 'ad_group_ads',
      entityId: group.campaignId,
      entityName: cleanName(group.campaignName),
      whatAr: copy.what,
      stepAr: copy.step,
      evidence: { approval_status: group.approval, ad_count: adIds.length, topics: topics.slice(0, 5), ad_ids: adIds.slice(0, 10) },
      dedupeKey: `ad_policy:${group.campaignId}:${group.approval}:${setHash}`,
      escalation: 'human',
      cause: null,
    });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Account status and billing
// ---------------------------------------------------------------------------
const BAD_STATUSES = new Set(['SUSPENDED', 'CANCELED', 'CANCELLED', 'CLOSED', 'CUSTOMER_NOT_ENABLED']);

export function detectAccountStatus(signals: GuardSignals): GuardFinding | null {
  if (!signals.ok.status) return null;
  const raw = String(signals.googleStatus ?? '').toUpperCase();
  if (!BAD_STATUSES.has(raw)) return null;
  const status = raw === 'CANCELLED' ? 'CANCELED' : raw;
  const copy = accountStatusCopy(status);
  return {
    code: 'account_status',
    severity: 'critical',
    entityType: 'account',
    entityId: signals.customerId,
    entityName: null,
    whatAr: copy.what,
    stepAr: copy.step,
    evidence: { google_status: status },
    dedupeKey: `account_status:${status}`,
    escalation: 'human',
    cause: null,
  };
}

export function detectBilling(signals: GuardSignals): GuardFinding[] {
  if (!signals.ok.billing || !signals.billing) return [];
  const { setupStatuses, budgets } = signals.billing;
  const out: GuardFinding[] = [];

  // Every setup cancelled and none approved, pending or held: nothing can be charged.
  const live = setupStatuses.some((s) => ['APPROVED', 'PENDING', 'APPROVED_HELD'].includes(s));
  if (setupStatuses.length > 0 && !live) {
    out.push({
      code: 'billing_setup',
      severity: 'high',
      entityType: 'account',
      entityId: signals.customerId,
      entityName: null,
      whatAr: BILLING_SETUP_COPY.what,
      stepAr: BILLING_SETUP_COPY.step,
      evidence: { setup_statuses: setupStatuses.slice(0, 5) },
      dedupeKey: 'billing_setup:inactive',
      escalation: 'human',
      cause: null,
    });
  }

  // Account budgets exist only for accounts on monthly invoicing; automatic payments have none, and that is fine.
  const now = signals.now.getTime();
  for (const budget of budgets) {
    if (budget.status !== 'APPROVED') continue;
    if (budget.endsAt !== null && budget.endsAt < now) continue;
    const key = budget.name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'budget';
    if (budget.limit !== null && budget.limit > 0) {
      const ratio = budget.served / budget.limit;
      if (ratio >= 1) {
        const copy = budgetExhaustedCopy(budget.served, budget.limit, signals.currency);
        out.push({
          code: 'billing_budget',
          severity: 'high',
          entityType: 'account',
          entityId: signals.customerId,
          entityName: null,
          whatAr: copy.what,
          stepAr: copy.step,
          evidence: { served: round2(budget.served), limit: round2(budget.limit), ratio: round2(ratio) },
          dedupeKey: `billing_budget:exhausted:${key}`,
          escalation: 'human',
          cause: null,
        });
        continue;
      }
      if (ratio >= BUDGET_NEAR_RATIO) {
        const copy = budgetNearCopy(budget.served, budget.limit, signals.currency);
        out.push({
          code: 'billing_budget',
          severity: 'medium',
          entityType: 'account',
          entityId: signals.customerId,
          entityName: null,
          whatAr: copy.what,
          stepAr: copy.step,
          evidence: { served: round2(budget.served), limit: round2(budget.limit), ratio: round2(ratio) },
          dedupeKey: `billing_budget:near:${key}`,
          escalation: 'human',
          cause: null,
        });
        continue;
      }
    }
    if (budget.endsAt !== null && budget.endsAt - now <= BUDGET_ENDS_SOON_MS) {
      const copy = budgetEndsCopy(budget.endsAt);
      out.push({
        code: 'billing_budget',
        severity: 'medium',
        entityType: 'account',
        entityId: signals.customerId,
        entityName: null,
        whatAr: copy.what,
        stepAr: copy.step,
        evidence: { ends_at: new Date(budget.endsAt).toISOString() },
        dedupeKey: `billing_budget:ends:${key}`,
        escalation: 'human',
        cause: null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Changes made outside Modaafa
// ---------------------------------------------------------------------------
export function changeActor(clientType: string): ChangeActor {
  switch (clientType) {
    case 'GOOGLE_ADS_RECOMMENDATIONS':
    case 'GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION':
    case 'GOOGLE_ADS_AUTOMATED_RULE':
    case 'INTERNAL_TOOL':
      return 'google_auto';
    case 'GOOGLE_ADS_WEB_CLIENT':
    case 'GOOGLE_ADS_MOBILE_APP':
    case 'GOOGLE_ADS_EDITOR':
    case 'GOOGLE_ADS_BULK_UPLOAD':
      return 'user';
    default:
      return 'tool';
  }
}

/**
 * Is this change one we made? Only the Google Ads API can be us. A match needs
 * the change to sit next to one of our logged executions or rollbacks in time,
 * or to name a resource that one of our rollback payloads names.
 */
export function isOwnChange(change: ChangeRow, own: OwnAction[]): boolean {
  if (change.clientType !== 'GOOGLE_ADS_API') return false;
  for (const action of own) {
    const near = (window: number) => action.at.some((at) => Math.abs(at - change.at) <= window);
    if (near(OWN_CHANGE_WINDOW_MS)) return true;
    if (change.resourceName && action.resources.includes(change.resourceName) && near(OWN_RESOURCE_WINDOW_MS)) return true;
  }
  return false;
}

export function detectOutsideChanges(signals: GuardSignals): GuardFinding[] {
  if (!signals.ok.changes) return [];
  const since = signals.now.getTime() - OUTSIDE_CHANGE_LOOKBACK_MS;
  const outside = signals.changes.filter((c) => c.at >= since && !isOwnChange(c, signals.ownActions));
  if (outside.length === 0) return [];

  const byActor = new Map<ChangeActor, ChangeRow[]>();
  for (const change of outside) {
    const actor = changeActor(change.clientType);
    byActor.set(actor, [...(byActor.get(actor) ?? []), change]);
  }
  const out: GuardFinding[] = [];
  for (const [actor, rows] of byActor) {
    const material = rows.some((r) => (r.resourceType === 'CAMPAIGN' || r.resourceType === 'CAMPAIGN_BUDGET') || r.operation === 'REMOVE');
    const typeCounts = new Map<string, number>();
    for (const r of rows) typeCounts.set(r.resourceType, (typeCounts.get(r.resourceType) ?? 0) + 1);
    const types = Array.from(typeCounts.keys())
      .map((t) => RESOURCE_TYPE_AR[t])
      .filter(Boolean)
      .slice(0, 3);
    const copy = outsideChangeCopy(rows.length, actor, types);
    const batch = createHash('sha1')
      .update(rows.map((r) => `${r.resourceName}@${r.at}`).sort().join('|'))
      .digest('hex')
      .slice(0, 12);
    out.push({
      code: 'outside_change',
      severity: material && (actor !== 'user' || rows.some((r) => r.resourceType === 'CAMPAIGN_BUDGET')) ? 'medium' : 'info',
      entityType: 'change',
      entityId: batch,
      entityName: null,
      whatAr: copy.what,
      stepAr: copy.step,
      evidence: {
        actor,
        actor_ar: ACTOR_AR[actor],
        count: rows.length,
        by_type: Object.fromEntries(typeCounts),
        latest_at: new Date(Math.max(...rows.map((r) => r.at))).toISOString(),
        campaigns: Array.from(new Set(rows.map((r) => r.campaignName).filter(Boolean).map((n) => cleanName(n)))).slice(0, 3),
      },
      dedupeKey: `outside_change:${actor}:${batch}`,
      escalation: 'none',
      cause: null,
    });
  }
  return out;
}

/**
 * Observed-impact measurement — the learning loop.
 *
 * When a recommendation is executed, the execution route stores a
 * `measurement` descriptor in ai_actions.payload: what entity to look at, a
 * 7-day BEFORE snapshot, and when it was captured. This module runs inside the
 * nightly optimize cron and, once an executed action is 7+ days old, reads the
 * same entity's last-7-days metrics and writes `observed_impact` — an honest
 * before/after with deltas.
 *
 * That column is what turns the product from "predicts impact" into "proves
 * impact": the optimizer page shows «النتيجة بعد التنفيذ», and future model
 * prompts can cite what actually worked on THIS account.
 */

import { recordOutcomeFact } from '../jarvis/outcomes';

export type MetricTotals = { cost: number; clicks: number; conversions: number; conversion_value: number };

/**
 * Untouched campaigns of the same account over the same two windows. Only read
 * when OUTCOME_MEMORY_ENABLED is on (see measureObservedImpacts).
 */
export type ControlBaseline = {
  before: MetricTotals;
  after: MetricTotals;
  /** How many campaigns make up the control group. */
  campaigns: number;
};

export type ImpactConfidence = 'low' | 'medium' | 'high';

export type DifferenceInDifferences = {
  method: 'difference_in_differences';
  control_campaigns: number;
  /** Relative change of the treated entity, in percent. null when it had nothing before. */
  treated_change_pct: { cost: number | null; conversions: number | null; cost_per_conversion: number | null };
  /** Relative change of the control group, in percent. */
  control_change_pct: { cost: number | null; conversions: number | null; cost_per_conversion: number | null };
  /** treated change minus control change, in percentage points. What the change did beyond the market and the season. */
  did_pct_points: { cost: number | null; conversions: number | null; cost_per_conversion: number | null };
  confidence: ImpactConfidence;
  /** Why the label is what it is. Fixed wording from the volumes, never from a model. */
  confidence_reason_ar: string;
};

type StoredMeasurement = {
  level: 'budget_campaigns' | 'ad_group' | 'criterion' | 'ad' | 'created_criterion' | 'campaign';
  resource: string | null;
  window_days?: number;
  before: MetricTotals | null;
  captured_at?: string;
};

export const MEASURED_ACTION_TYPES = [
  'pause_keyword',
  'add_negative_keyword',
  'add_keyword',
  'adjust_budget',
  'adjust_bid',
  'pause_ad',
  'pause_campaign',
  'enable_campaign',
  'add_negative_keywords_batch',
  // Extended operations: a campaign-level before/after window (EXTENDED_ACTIONS_ENABLED).
  'set_ad_schedule',
  'set_device_bid_modifier',
  'exclude_location',
  'set_location_bid_modifier',
  'set_geo_target_type',
  'set_network_settings',
  // Ad copy swap: measured at ad group level (ADS_STUDIO_ENABLED).
  'replace_rsa_assets',
];

const MEASURE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MEASURE_EXPIRY_MS = 45 * 24 * 60 * 60 * 1000;

const LEVEL_QUERIES: Record<StoredMeasurement['level'], { from: string; where: string }> = {
  budget_campaigns: { from: 'campaign', where: 'campaign.campaign_budget' },
  ad_group: { from: 'ad_group', where: 'ad_group.resource_name' },
  criterion: { from: 'keyword_view', where: 'ad_group_criterion.resource_name' },
  created_criterion: { from: 'keyword_view', where: 'ad_group_criterion.resource_name' },
  ad: { from: 'ad_group_ad', where: 'ad_group_ad.resource_name' },
  campaign: { from: 'campaign', where: 'campaign.resource_name' },
};

export function sumMetricRows(rows: any[]): MetricTotals {
  const totals: MetricTotals = { cost: 0, clicks: 0, conversions: 0, conversion_value: 0 };
  for (const row of rows ?? []) {
    const metrics = row?.metrics ?? {};
    totals.cost += Number(metrics.costMicros ?? metrics.cost_micros ?? 0) / 1_000_000;
    totals.clicks += Number(metrics.clicks ?? 0);
    totals.conversions += Number(metrics.conversions ?? 0);
    totals.conversion_value += Number(metrics.conversionsValue ?? metrics.conversions_value ?? 0);
  }
  totals.cost = round2(totals.cost);
  totals.conversions = Number(totals.conversions.toFixed(3));
  totals.conversion_value = round2(totals.conversion_value);
  return totals;
}

export function computeObservedImpact(before: MetricTotals | null, after: MetricTotals, baseline?: ControlBaseline | null) {
  const safeBefore = before ?? { cost: 0, clicks: 0, conversions: 0, conversion_value: 0 };
  const impact = {
    window_days: 7,
    before: safeBefore,
    after,
    delta: {
      cost: round2(after.cost - safeBefore.cost),
      clicks: after.clicks - safeBefore.clicks,
      conversions: Number((after.conversions - safeBefore.conversions).toFixed(3)),
      conversion_value: round2(after.conversion_value - safeBefore.conversion_value),
    },
    measured_at: new Date().toISOString(),
  };
  // Without a baseline argument the object is exactly what it always was.
  if (baseline === undefined) return impact;
  return {
    ...impact,
    baseline: baseline ?? null,
    diff_in_diff: computeDifferenceInDifferences({ before: safeBefore, after }, baseline ?? null),
  };
}

// ---------------------------------------------------------------------------
// Difference in differences against untouched campaigns
// ---------------------------------------------------------------------------

/** Conversions (before + after) the treated entity needs for a verdict that is not "low". */
export const DID_MIN_TREATED_CONVERSIONS = 15;
/** Conversions (before + after) the control group needs for a verdict that is not "low". */
export const DID_MIN_CONTROL_CONVERSIONS = 30;
/** Volumes for "high". */
export const DID_HIGH_TREATED_CONVERSIONS = 60;
export const DID_HIGH_CONTROL_CONVERSIONS = 100;

function changePct(before: number, after: number): number | null {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) return null;
  return round2(((after - before) / before) * 100);
}

function costPerConversion(totals: MetricTotals): number | null {
  return totals.conversions > 0 ? totals.cost / totals.conversions : null;
}

function costPerConversionChange(before: MetricTotals, after: MetricTotals): number | null {
  const a = costPerConversion(before);
  const b = costPerConversion(after);
  return a !== null && b !== null ? changePct(a, b) : null;
}

function subtract(treated: number | null, control: number | null): number | null {
  return treated === null || control === null ? null : round2(treated - control);
}

/**
 * What a change did beyond what happened to the rest of the account.
 *
 * The plain before and after of an entity mixes the change with the season, the
 * market and Google's own learning. The control group (campaigns nobody touched
 * in the same two windows) carries the same season and market, so
 *
 *   effect = (treated after / treated before - 1) - (control after / control before - 1)
 *
 * in percentage points, for cost, conversions and cost per conversion.
 *
 * The label is honest about volume. With fewer than 15 conversions on the
 * treated side, or fewer than 30 on the control side, or no control at all, the
 * result is "low" and says so: the number is shown, but it must not be sold as
 * proof. "high" needs 60 and 100. The control is a comparison group, not a
 * randomised one, so even "high" is evidence and not a guarantee.
 */
export function computeDifferenceInDifferences(
  treated: { before: MetricTotals; after: MetricTotals },
  control: ControlBaseline | null
): DifferenceInDifferences {
  const treatedChange = {
    cost: changePct(treated.before.cost, treated.after.cost),
    conversions: changePct(treated.before.conversions, treated.after.conversions),
    cost_per_conversion: costPerConversionChange(treated.before, treated.after),
  };
  const controlChange = control
    ? {
        cost: changePct(control.before.cost, control.after.cost),
        conversions: changePct(control.before.conversions, control.after.conversions),
        cost_per_conversion: costPerConversionChange(control.before, control.after),
      }
    : { cost: null, conversions: null, cost_per_conversion: null };

  const treatedConversions = treated.before.conversions + treated.after.conversions;
  const controlConversions = control ? control.before.conversions + control.after.conversions : 0;
  const controlCampaigns = control?.campaigns ?? 0;

  let confidence: ImpactConfidence;
  let reason: string;
  if (!control || controlCampaigns < 1 || control.before.cost <= 0) {
    confidence = 'low';
    reason = 'ما فيه حملات ما انلمست نقارن فيها، فالرقم مقارنة قبل وبعد بس';
  } else if (treated.before.cost <= 0 || treated.before.conversions <= 0) {
    confidence = 'low';
    reason = 'ما كان فيه تحويلات قبل التعديل نقيس منها';
  } else if (treatedConversions < DID_MIN_TREATED_CONVERSIONS) {
    confidence = 'low';
    reason = `التحويلات قليلة (${Math.round(treatedConversions)} في الفترتين)، الرقم يتغير بالصدفة`;
  } else if (controlConversions < DID_MIN_CONTROL_CONVERSIONS) {
    confidence = 'low';
    reason = `حملات المقارنة تحويلاتها قليلة (${Math.round(controlConversions)} في الفترتين)`;
  } else if (treatedConversions >= DID_HIGH_TREATED_CONVERSIONS && controlConversions >= DID_HIGH_CONTROL_CONVERSIONS) {
    confidence = 'high';
    reason = 'حجم التحويلات يكفي في الطرفين، والمقارنة بحملات ما انلمست';
  } else {
    confidence = 'medium';
    reason = 'حجم التحويلات مقبول، لكنه ما يوصل لدرجة التأكيد';
  }

  return {
    method: 'difference_in_differences',
    control_campaigns: controlCampaigns,
    treated_change_pct: treatedChange,
    control_change_pct: controlChange,
    did_pct_points: {
      cost: subtract(treatedChange.cost, controlChange.cost),
      conversions: subtract(treatedChange.conversions, controlChange.conversions),
      cost_per_conversion: subtract(treatedChange.cost_per_conversion, controlChange.cost_per_conversion),
    },
    confidence,
    confidence_reason_ar: reason,
  };
}

// ---------------------------------------------------------------------------
// Control group: untouched campaigns, same windows
// ---------------------------------------------------------------------------

export type MeasurementWindows = {
  before: { from: string; to: string };
  after: { from: string; to: string };
};

function addDaysIso(day: string, days: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function riyadhDayOf(instant: Date) {
  return new Date(instant.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * The two 7 day windows the plain measurement compares, as explicit dates: the
 * 7 full days before the moment the change was captured (what readSevenDayMetrics
 * read with LAST_7_DAYS then), and the 7 full days before now (LAST_7_DAYS now).
 */
export function measurementWindows(capturedAt: string | null | undefined, now: Date = new Date()): MeasurementWindows | null {
  const captured = capturedAt ? new Date(capturedAt) : null;
  if (!captured || Number.isNaN(captured.getTime())) return null;
  const beforeTo = addDaysIso(riyadhDayOf(captured), -1);
  const afterTo = addDaysIso(riyadhDayOf(now), -1);
  return {
    before: { from: addDaysIso(beforeTo, -6), to: beforeTo },
    after: { from: addDaysIso(afterTo, -6), to: afterTo },
  };
}

/** Campaign resource names a stored measurement or action touched, when it names them directly. */
export function directCampaignOf(row: { payload?: any }): string | null {
  const measurement = row?.payload?.measurement;
  if (measurement?.level === 'campaign' && typeof measurement.resource === 'string') return measurement.resource;
  const params = row?.payload?.action?.params ?? {};
  return typeof params.campaign_resource === 'string' ? params.campaign_resource : null;
}

const CAMPAIGN_LOOKUP: Partial<Record<StoredMeasurement['level'], { from: string; where: string }>> = {
  budget_campaigns: { from: 'campaign', where: 'campaign.campaign_budget' },
  ad_group: { from: 'ad_group', where: 'ad_group.resource_name' },
  criterion: { from: 'keyword_view', where: 'ad_group_criterion.resource_name' },
  ad: { from: 'ad_group_ad', where: 'ad_group_ad.resource_name' },
};

/**
 * Campaigns that any measured change of this account touched since `since`
 * (an ISO timestamp): they cannot be in the control group. Direct campaign
 * resources are read from the stored rows; budgets, ad groups, keywords and ads
 * are resolved with one small lookup each (at most 25). A lookup that fails
 * returns null: with an unknown touched set no honest control exists.
 */
export async function touchedCampaigns(args: {
  supabase: any;
  customer: any;
  accountId: string;
  since: string;
}): Promise<Set<string> | null> {
  const { data: rows, error } = await args.supabase
    .from('ai_actions')
    .select('payload, created_at')
    .eq('account_id', args.accountId)
    .in('action_type', MEASURED_ACTION_TYPES)
    .gte('created_at', args.since)
    .limit(100);
  if (error || !Array.isArray(rows)) return null;

  const touched = new Set<string>();
  const lookups = new Map<string, { level: StoredMeasurement['level']; resource: string }>();
  for (const row of rows) {
    const direct = directCampaignOf(row);
    if (direct) touched.add(direct);
    const measurement = (row as any)?.payload?.measurement as StoredMeasurement | undefined;
    if (measurement?.resource && CAMPAIGN_LOOKUP[measurement.level]) {
      lookups.set(`${measurement.level}:${measurement.resource}`, { level: measurement.level, resource: measurement.resource });
    }
    if (measurement?.level === 'created_criterion' || (!measurement && (row as any)?.payload?.action?.params?.ad_group_resource)) {
      const adGroup = (row as any)?.payload?.action?.params?.ad_group_resource;
      if (typeof adGroup === 'string') lookups.set(`ad_group:${adGroup}`, { level: 'ad_group', resource: adGroup });
    }
  }
  if (lookups.size > 25) return null;

  try {
    for (const { level, resource } of lookups.values()) {
      const spec = CAMPAIGN_LOOKUP[level]!;
      const found = await args.customer.query(`
        SELECT campaign.resource_name
        FROM ${spec.from}
        WHERE ${spec.where} = '${escapeGaqlValue(resource)}'
        LIMIT 20
      `);
      for (const item of found ?? []) {
        const name = item?.campaign?.resourceName ?? item?.campaign?.resource_name;
        if (typeof name === 'string') touched.add(name);
      }
    }
  } catch {
    return null;
  }
  return touched;
}

const CONTROL_MIN_CAMPAIGNS = 1;

/** Per-campaign totals of one window, keyed by campaign resource name. */
async function campaignTotals(customer: any, window: { from: string; to: string }): Promise<Map<string, MetricTotals>> {
  const rows: any[] = await customer.query(`
    SELECT campaign.resource_name, metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${window.from}' AND '${window.to}'
      AND campaign.status = 'ENABLED'
    LIMIT 1000
  `);
  const grouped = new Map<string, any[]>();
  for (const row of rows ?? []) {
    const name = row?.campaign?.resourceName ?? row?.campaign?.resource_name;
    if (typeof name !== 'string') continue;
    const list = grouped.get(name) ?? [];
    list.push(row);
    grouped.set(name, list);
  }
  return new Map([...grouped.entries()].map(([name, list]) => [name, sumMetricRows(list)]));
}

function addTotals(a: MetricTotals, b: MetricTotals): MetricTotals {
  return {
    cost: round2(a.cost + b.cost),
    clicks: a.clicks + b.clicks,
    conversions: Number((a.conversions + b.conversions).toFixed(3)),
    conversion_value: round2(a.conversion_value + b.conversion_value),
  };
}

/**
 * Totals of the untouched campaigns over the two windows. A campaign is in the
 * control group only when it spent in BOTH windows and nobody changed it.
 * Null when it cannot be built (a read failed, or nothing is left).
 */
export async function readControlBaseline(args: {
  customer: any;
  windows: MeasurementWindows;
  touched: Set<string>;
}): Promise<ControlBaseline | null> {
  try {
    const [before, after] = await Promise.all([
      campaignTotals(args.customer, args.windows.before),
      campaignTotals(args.customer, args.windows.after),
    ]);
    const empty: MetricTotals = { cost: 0, clicks: 0, conversions: 0, conversion_value: 0 };
    let beforeSum = empty;
    let afterSum = empty;
    let campaigns = 0;
    for (const [name, b] of before) {
      const a = after.get(name);
      if (!a || args.touched.has(name) || b.cost <= 0 || a.cost <= 0) continue;
      beforeSum = addTotals(beforeSum, b);
      afterSum = addTotals(afterSum, a);
      campaigns += 1;
    }
    return campaigns >= CONTROL_MIN_CAMPAIGNS ? { before: beforeSum, after: afterSum, campaigns } : null;
  } catch {
    return null;
  }
}

/**
 * Measure up to `limit` executed actions for one account. `customer` is the
 * account's Google Ads client; `supabase` must be the service-role client
 * (ai_actions writes are service-role only).
 */
export async function measureObservedImpacts({
  supabase,
  customer,
  accountId,
  limit = 5,
  withBaseline = false,
}: {
  supabase: any;
  customer: any;
  accountId: string;
  limit?: number;
  /**
   * Also compare against untouched campaigns of the same account over the same
   * windows and store diff_in_diff on observed_impact (OUTCOME_MEMORY_ENABLED).
   * False keeps the exact behaviour and the exact queries of before.
   */
  withBaseline?: boolean;
}): Promise<{ measured: number; errors: number }> {
  const now = Date.now();
  const oldest = new Date(now - MEASURE_EXPIRY_MS).toISOString();
  const newest = new Date(now - MEASURE_AFTER_MS).toISOString();

  const { data: rows, error } = await supabase
    .from('ai_actions')
    .select('id, action_type, payload, created_at')
    .eq('account_id', accountId)
    .is('observed_impact', null)
    .gte('created_at', oldest)
    .lte('created_at', newest)
    .in('action_type', MEASURED_ACTION_TYPES)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error || !rows?.length) return { measured: 0, errors: error ? 1 : 0 };

  let measured = 0;
  let errors = 0;
  // One control group per pair of windows: two actions measured in the same run
  // that were captured on the same day share it.
  const controlCache = new Map<string, Promise<ControlBaseline | null>>();

  for (const row of rows) {
    const measurement = (row.payload as any)?.measurement as StoredMeasurement | undefined;
    if (!measurement?.resource || !LEVEL_QUERIES[measurement.level]) {
      // Nothing to measure (older actions predate the learning loop). Mark it
      // so the queue does not re-inspect the same row every night.
      await supabase
        .from('ai_actions')
        .update({ observed_impact: { status: 'unmeasurable', measured_at: new Date().toISOString() } })
        .eq('id', row.id);
      continue;
    }

    try {
      const spec = LEVEL_QUERIES[measurement.level];
      const after = sumMetricRows(
        await customer.query(`
          SELECT metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value
          FROM ${spec.from}
          WHERE ${spec.where} = '${escapeGaqlValue(measurement.resource)}'
            AND segments.date DURING LAST_7_DAYS
        `)
      );
      let baseline: ControlBaseline | null | undefined;
      if (withBaseline) {
        baseline = null;
        try {
          const windows = measurementWindows(measurement.captured_at ?? row.created_at ?? null);
          if (windows) {
            const key = `${windows.before.from}|${windows.after.from}`;
            if (!controlCache.has(key)) {
              controlCache.set(
                key,
                (async () => {
                  const touched = await touchedCampaigns({
                    supabase,
                    customer,
                    accountId,
                    since: `${windows.before.from}T00:00:00Z`,
                  });
                  return touched ? readControlBaseline({ customer, windows, touched }) : null;
                })()
              );
            }
            baseline = await controlCache.get(key)!;
          }
        } catch {
          baseline = null;
        }
      }
      const impact = computeObservedImpact(measurement.before, after, baseline);
      const { error: writeError } = await supabase
        .from('ai_actions')
        .update({ observed_impact: impact })
        .eq('id', row.id);
      if (writeError) errors += 1;
      else {
        measured += 1;
        // Business memory (PR-J7): the brain can later cite what actually worked here.
        await recordOutcomeFact({
          supabase,
          accountId,
          actionId: row.id,
          actionType: String((row as any).action_type ?? ''),
          createdAt: row.created_at ?? null,
          impact,
        });
      }
    } catch {
      errors += 1;
    }
  }

  return { measured, errors };
}

function escapeGaqlValue(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

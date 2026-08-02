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

export type MetricTotals = { cost: number; clicks: number; conversions: number; conversion_value: number };

type StoredMeasurement = {
  level: 'budget_campaigns' | 'ad_group' | 'criterion' | 'ad' | 'created_criterion';
  resource: string | null;
  window_days?: number;
  before: MetricTotals | null;
  captured_at?: string;
};

const MEASURE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MEASURE_EXPIRY_MS = 45 * 24 * 60 * 60 * 1000;

const LEVEL_QUERIES: Record<StoredMeasurement['level'], { from: string; where: string }> = {
  budget_campaigns: { from: 'campaign', where: 'campaign.campaign_budget' },
  ad_group: { from: 'ad_group', where: 'ad_group.resource_name' },
  criterion: { from: 'keyword_view', where: 'ad_group_criterion.resource_name' },
  created_criterion: { from: 'keyword_view', where: 'ad_group_criterion.resource_name' },
  ad: { from: 'ad_group_ad', where: 'ad_group_ad.resource_name' },
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

export function computeObservedImpact(before: MetricTotals | null, after: MetricTotals) {
  const safeBefore = before ?? { cost: 0, clicks: 0, conversions: 0, conversion_value: 0 };
  return {
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
}: {
  supabase: any;
  customer: any;
  accountId: string;
  limit?: number;
}): Promise<{ measured: number; errors: number }> {
  const now = Date.now();
  const oldest = new Date(now - MEASURE_EXPIRY_MS).toISOString();
  const newest = new Date(now - MEASURE_AFTER_MS).toISOString();

  const { data: rows, error } = await supabase
    .from('ai_actions')
    .select('id, payload, created_at')
    .eq('account_id', accountId)
    .is('observed_impact', null)
    .gte('created_at', oldest)
    .lte('created_at', newest)
    .in('action_type', ['pause_keyword', 'add_negative_keyword', 'add_keyword', 'adjust_budget', 'adjust_bid', 'pause_ad'])
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error || !rows?.length) return { measured: 0, errors: error ? 1 : 0 };

  let measured = 0;
  let errors = 0;

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
      const { error: writeError } = await supabase
        .from('ai_actions')
        .update({ observed_impact: computeObservedImpact(measurement.before, after) })
        .eq('id', row.id);
      if (writeError) errors += 1;
      else measured += 1;
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

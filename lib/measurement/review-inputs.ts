import { bool, enumLabel, num0, str } from '@/lib/jarvis/tools/shared';
import type { ConversionTrackingInfo, CustomerGoalInfo, GoalActionInfo } from './goals';

/**
 * The extra reads the measurement review needs. Each one is optional: a query
 * that fails comes back as null and the review says so instead of guessing.
 * Used by the conversion-health tool (flag on only) and by the daily scan, so
 * both look at the same rows.
 */
export type Query = (gaql: string) => Promise<any[]>;

export type MeasurementInputs = {
  actions: GoalActionInfo[] | null;
  goals: CustomerGoalInfo[] | null;
  tracking: ConversionTrackingInfo | null;
  /** Primary conversions and clicks per day, last 30 days, whole account. */
  dailyTotals: Array<{ date: string; conversions: number; clicks: number }> | null;
  channelTypes: string[];
  timeZone: string | null;
};

async function attempt(query: Query, gaql: string): Promise<any[] | null> {
  try {
    const rows = await query(gaql);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.warn('[measurement] optional query failed', error instanceof Error ? error.message.slice(0, 200) : 'unknown');
    return null;
  }
}

export async function loadMeasurementInputs(query: Query): Promise<MeasurementInputs> {
  const [actionRows, goalRows, customerRows, dailyRows, perActionRows, channelRows] = await Promise.all([
    attempt(
      query,
      `SELECT conversion_action.resource_name, conversion_action.name, conversion_action.status,
        conversion_action.type, conversion_action.category, conversion_action.origin,
        conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric
       FROM conversion_action
       WHERE conversion_action.status != 'REMOVED'
       LIMIT 100`
    ),
    attempt(
      query,
      `SELECT customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable
       FROM customer_conversion_goal`
    ),
    attempt(
      query,
      `SELECT customer.time_zone, customer.conversion_tracking_setting.accepted_customer_data_terms,
        customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled
       FROM customer
       LIMIT 1`
    ),
    attempt(
      query,
      `SELECT segments.date, metrics.conversions, metrics.clicks
       FROM campaign
       WHERE segments.date DURING LAST_30_DAYS`
    ),
    attempt(
      query,
      `SELECT segments.conversion_action_name, metrics.all_conversions
       FROM campaign
       WHERE segments.date DURING LAST_30_DAYS`
    ),
    attempt(
      query,
      `SELECT campaign.advertising_channel_type
       FROM campaign
       WHERE campaign.status = 'ENABLED'`
    ),
  ]);

  const perAction = new Map<string, number>();
  for (const row of perActionRows ?? []) {
    const name = str(row, 'segments.conversion_action_name');
    if (name) perAction.set(name, (perAction.get(name) ?? 0) + num0(row, 'metrics.all_conversions'));
  }

  const actions: GoalActionInfo[] | null = actionRows
    ? actionRows.map((row) => ({
        name: str(row, 'conversion_action.name'),
        resourceName: str(row, 'conversion_action.resource_name'),
        status: enumLabel(str(row, 'conversion_action.status'), 'UNKNOWN'),
        type: enumLabel(str(row, 'conversion_action.type'), 'UNKNOWN'),
        category: enumLabel(str(row, 'conversion_action.category'), 'UNKNOWN'),
        origin: enumLabel(str(row, 'conversion_action.origin'), 'WEBSITE'),
        primaryForGoal: bool(row, 'conversion_action.primary_for_goal'),
        includeInConversionsMetric: bool(row, 'conversion_action.include_in_conversions_metric'),
        conversions30d: perActionRows ? Math.round((perAction.get(str(row, 'conversion_action.name')) ?? 0) * 100) / 100 : null,
      }))
    : null;

  const goals: CustomerGoalInfo[] | null = goalRows
    ? goalRows.map((row) => ({
        category: enumLabel(str(row, 'customer_conversion_goal.category'), 'UNKNOWN'),
        origin: enumLabel(str(row, 'customer_conversion_goal.origin'), 'WEBSITE'),
        biddable: bool(row, 'customer_conversion_goal.biddable'),
      }))
    : null;

  const customer = customerRows?.[0];
  const tracking: ConversionTrackingInfo | null = customer
    ? {
        acceptedCustomerDataTerms: bool(customer, 'customer.conversion_tracking_setting.accepted_customer_data_terms'),
        enhancedConversionsForLeads: bool(
          customer,
          'customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled'
        ),
      }
    : null;

  const totals = new Map<string, { conversions: number; clicks: number }>();
  for (const row of dailyRows ?? []) {
    const date = str(row, 'segments.date');
    if (!date) continue;
    const entry = totals.get(date) ?? { conversions: 0, clicks: 0 };
    entry.conversions += num0(row, 'metrics.conversions');
    entry.clicks += num0(row, 'metrics.clicks');
    totals.set(date, entry);
  }

  return {
    actions,
    goals,
    tracking,
    dailyTotals: dailyRows ? [...totals.entries()].map(([date, value]) => ({ date, ...value })) : null,
    channelTypes: [...new Set((channelRows ?? []).map((row) => str(row, 'campaign.advertising_channel_type')).filter(Boolean))],
    timeZone: customer ? str(customer, 'customer.time_zone') || null : null,
  };
}

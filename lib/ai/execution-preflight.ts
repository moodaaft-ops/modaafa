import type { OptimizerAction } from './optimizer-agent';

/** Where and how the nightly measurement pass evaluates an applied action. */
export type MeasurementDescriptor = {
  level: 'budget_campaigns' | 'ad_group' | 'criterion' | 'ad' | 'created_criterion';
  resource: string | null;
  window_days: number;
  before: { cost: number; clicks: number; conversions: number; conversion_value: number } | null;
  captured_at: string;
};

export async function prepareActionForExecution(action: OptimizerAction, customer: any) {
  const params = { ...action.params };
  let rollbackPayload: Record<string, unknown> = { reversible: true };
  const capturedAt = new Date().toISOString();
  let measurement: MeasurementDescriptor | null = null;

  if (action.type === 'adjust_budget') {
    const resourceName = String(params.budget_resource);
    const rows = await customer.query(`
      SELECT campaign_budget.resource_name, campaign_budget.amount_micros
      FROM campaign_budget
      WHERE campaign_budget.resource_name = '${escapeGaql(resourceName)}'
      LIMIT 1
    `);
    const budget = rows[0]?.campaignBudget ?? rows[0]?.campaign_budget;
    const currentAmountMicros = Number(budget?.amountMicros ?? budget?.amount_micros ?? 0);
    if (!currentAmountMicros) throw new Error('Unable to read current campaign budget before execution');

    if (!(Number(params.new_amount_micros) > 0)) {
      const deltaPct = Number(params.delta_pct);
      if (!Number.isFinite(deltaPct) || deltaPct === 0) {
        throw new Error('Budget action carries neither an absolute amount nor a delta');
      }
      params.new_amount_micros = Math.round(currentAmountMicros * (1 + deltaPct / 100));
    }
    params.current_amount_micros = currentAmountMicros;
    params.delta_pct =
      ((Number(params.new_amount_micros) - currentAmountMicros) / currentAmountMicros) * 100;
    rollbackPayload = {
      reversible: true,
      action_type: 'adjust_budget',
      budget_resource: resourceName,
      amount_micros: currentAmountMicros,
    };
    measurement = {
      level: 'budget_campaigns',
      resource: resourceName,
      window_days: 7,
      before: await readSevenDayMetrics(customer, 'campaign', 'campaign.campaign_budget', resourceName),
      captured_at: capturedAt,
    };
  } else if (action.type === 'pause_keyword') {
    const rows = await customer.query(`
      SELECT ad_group_criterion.resource_name, ad_group_criterion.status
      FROM keyword_view
      WHERE ad_group_criterion.resource_name = '${escapeGaql(action.target_id)}'
      LIMIT 1
    `);
    const criterion = rows[0]?.adGroupCriterion ?? rows[0]?.ad_group_criterion;
    const previousStatus = criterion?.status;
    if (!previousStatus) throw new Error('Unable to read keyword status before execution');
    rollbackPayload = {
      reversible: true,
      action_type: 'pause_keyword',
      resource_name: action.target_id,
      status: previousStatus,
    };
    measurement = {
      level: 'criterion',
      resource: action.target_id,
      window_days: 7,
      before: await readSevenDayMetrics(
        customer,
        'keyword_view',
        'ad_group_criterion.resource_name',
        action.target_id
      ),
      captured_at: capturedAt,
    };
  } else if (action.type === 'pause_ad') {
    const rows = await customer.query(`
      SELECT ad_group_ad.resource_name, ad_group_ad.status
      FROM ad_group_ad
      WHERE ad_group_ad.resource_name = '${escapeGaql(action.target_id)}'
      LIMIT 1
    `);
    const ad = rows[0]?.adGroupAd ?? rows[0]?.ad_group_ad;
    const previousStatus = ad?.status;
    if (!previousStatus) throw new Error('Unable to read ad status before execution');
    rollbackPayload = {
      reversible: true,
      action_type: 'pause_ad',
      resource_name: action.target_id,
      status: previousStatus,
    };
    measurement = {
      level: 'ad',
      resource: action.target_id,
      window_days: 7,
      before: await readSevenDayMetrics(customer, 'ad_group_ad', 'ad_group_ad.resource_name', action.target_id),
      captured_at: capturedAt,
    };
  } else if (action.type === 'adjust_bid') {
    const resourceName = String(params.ad_group_resource);
    const rows = await customer.query(`
      SELECT ad_group.resource_name, ad_group.target_cpa_micros, ad_group.target_roas
      FROM ad_group
      WHERE ad_group.resource_name = '${escapeGaql(resourceName)}'
      LIMIT 1
    `);
    const adGroup = rows[0]?.adGroup ?? rows[0]?.ad_group;
    if (!adGroup) throw new Error('Unable to read ad group bid targets before execution');
    const currentTargetCpa = adGroup.targetCpaMicros ?? adGroup.target_cpa_micros ?? null;
    const currentTargetRoas = adGroup.targetRoas ?? adGroup.target_roas ?? null;
    if (currentTargetCpa !== null) params.current_target_cpa_micros = Number(currentTargetCpa);
    if (currentTargetRoas !== null) params.current_target_roas = Number(currentTargetRoas);
    rollbackPayload = {
      reversible: true,
      action_type: 'adjust_bid',
      ad_group_resource: resourceName,
      target_cpa_micros: currentTargetCpa,
      target_roas: currentTargetRoas,
    };
    measurement = {
      level: 'ad_group',
      resource: resourceName,
      window_days: 7,
      before: await readSevenDayMetrics(customer, 'ad_group', 'ad_group.resource_name', resourceName),
      captured_at: capturedAt,
    };
  } else if (action.type === 'add_negative_keyword') {
    rollbackPayload = {
      reversible: true,
      action_type: 'remove_created_negative_keyword',
      resource_name_from_result: true,
    };
  } else if (action.type === 'add_keyword') {
    const keywordText = String(params.keyword_text ?? '').trim();
    const matchType = String(params.match_type ?? '').trim();
    const existing = await customer.query(`
      SELECT ad_group_criterion.resource_name
      FROM keyword_view
      WHERE ad_group_criterion.keyword.text = '${escapeGaql(keywordText)}'
        AND ad_group_criterion.keyword.match_type = '${escapeGaql(matchType)}'
        AND ad_group_criterion.status != 'REMOVED'
      LIMIT 1
    `);
    if (existing.length > 0) {
      throw new Error('Keyword already exists in this account; promotion skipped to avoid duplicate serving.');
    }
    rollbackPayload = {
      reversible: true,
      action_type: 'remove_created_keyword',
      resource_name_from_result: true,
    };
    measurement = {
      level: 'created_criterion',
      resource: null,
      window_days: 7,
      before: { cost: 0, clicks: 0, conversions: 0, conversion_value: 0 },
      captured_at: capturedAt,
    };
  }

  return { action: { ...action, params }, rollbackPayload, measurement };
}

async function readSevenDayMetrics(
  customer: any,
  fromClause: string,
  whereField: string,
  resourceName: string
) {
  try {
    const rows = await customer.query(`
      SELECT metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM ${fromClause}
      WHERE ${whereField} = '${escapeGaql(resourceName)}'
        AND segments.date DURING LAST_7_DAYS
    `);
    return sumMetricRows(rows);
  } catch {
    return null;
  }
}

function sumMetricRows(rows: any[]) {
  const totals = { cost: 0, clicks: 0, conversions: 0, conversion_value: 0 };
  for (const row of rows ?? []) {
    const metrics = row?.metrics ?? {};
    totals.cost += Number(metrics.costMicros ?? metrics.cost_micros ?? 0) / 1_000_000;
    totals.clicks += Number(metrics.clicks ?? 0);
    totals.conversions += Number(metrics.conversions ?? 0);
    totals.conversion_value += Number(metrics.conversionsValue ?? metrics.conversions_value ?? 0);
  }
  totals.cost = Number(totals.cost.toFixed(2));
  totals.conversions = Number(totals.conversions.toFixed(3));
  totals.conversion_value = Number(totals.conversion_value.toFixed(2));
  return totals;
}

function escapeGaql(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

import { escapeGaql, pickNum, pickStr, type GrowthCustomer } from '../growth/types';
import { accountDate, addDaysIso } from './plan';
import { decideExperiment, RAMP_UP_DAYS, type ArmTotals, type ExperimentMetric, type Verdict } from './significance';

export type ArmReading = {
  resource: string;
  control: boolean;
  traffic_split: number | null;
  campaigns: string[];
  totals: ArmTotals;
};

export type ExperimentReading = {
  experiment_resource: string;
  name: string;
  status: string;
  start_date: string;
  end_date: string;
  arms: ArmReading[];
  window: { from: string; to: string; days_after_ramp: number; days_running: number };
  verdict: Verdict;
};

const num = (n: number | null) => (n === null || !Number.isFinite(n) ? 0 : n);

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

async function armTotals(customer: GrowthCustomer, campaigns: string[], from: string, to: string): Promise<ArmTotals> {
  const totals: ArmTotals = { clicks: 0, impressions: 0, cost: 0, conversions: 0 };
  if (campaigns.length === 0 || to < from) return totals;
  const rows = await customer.query(
    `SELECT campaign.resource_name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE campaign.resource_name IN (${campaigns
      .map((c) => `'${escapeGaql(c)}'`)
      .join(', ')}) AND segments.date BETWEEN '${from}' AND '${to}'`
  );
  for (const row of rows) {
    totals.impressions += num(pickNum(row, 'metrics.impressions'));
    totals.clicks += num(pickNum(row, 'metrics.clicks'));
    totals.cost += num(pickNum(row, 'metrics.cost_micros')) / 1_000_000;
    totals.conversions += num(pickNum(row, 'metrics.conversions'));
  }
  return totals;
}

/**
 * Reads an experiment and decides. The window starts after the first week
 * (learning) and ends yesterday or at the end date. Reads only.
 */
export async function readExperimentResults(
  customer: GrowthCustomer,
  experimentResource: string,
  metric: ExperimentMetric,
  options: { now?: Date; timeZone?: string | null } = {}
): Promise<ExperimentReading> {
  const now = options.now ?? new Date();
  const r = escapeGaql(experimentResource);
  const expRows = await customer.query(
    `SELECT experiment.resource_name, experiment.name, experiment.status, experiment.start_date, experiment.end_date FROM experiment WHERE experiment.resource_name = '${r}' LIMIT 1`
  );
  const exp = expRows[0];
  if (!exp) throw new Error('The experiment was not found.');
  const start = pickStr(exp, 'experiment.start_date');
  const end = pickStr(exp, 'experiment.end_date');

  const armRows = await customer.query(
    `SELECT experiment_arm.resource_name, experiment_arm.control, experiment_arm.traffic_split, experiment_arm.campaigns FROM experiment_arm WHERE experiment_arm.experiment = '${r}'`
  );
  const yesterday = accountDate(now, options.timeZone, -1);
  const from = start ? addDaysIso(start, RAMP_UP_DAYS) : yesterday;
  const to = end && end < yesterday ? end : yesterday;
  const daysAfterRamp = to >= from ? daysBetween(from, to) + 1 : 0;
  const daysRunning = start && yesterday >= start ? daysBetween(start, yesterday) + 1 : 0;

  const arms: ArmReading[] = [];
  for (const row of armRows) {
    const camp = (row as any)?.experimentArm?.campaigns ?? (row as any)?.experiment_arm?.campaigns ?? [];
    const campaigns = (Array.isArray(camp) ? camp : []).filter((c): c is string => typeof c === 'string');
    const control = ((row as any)?.experimentArm?.control ?? (row as any)?.experiment_arm?.control) === true;
    arms.push({
      resource: pickStr(row, 'experiment_arm.resource_name'),
      control,
      traffic_split: pickNum(row, 'experiment_arm.traffic_split'),
      campaigns,
      totals: await armTotals(customer, campaigns, from, to),
    });
  }

  const control = arms.find((a) => a.control);
  const treatment = arms.find((a) => !a.control);
  const verdict: Verdict =
    control && treatment
      ? decideExperiment({ metric, control: control.totals, treatment: treatment.totals, daysAfterRamp, daysRunning })
      : { status: 'not_enough_data', reason: 'no_traffic', detail_ar: 'ما قدرنا نقرا طرفين التجربة' };

  return {
    experiment_resource: experimentResource,
    name: pickStr(exp, 'experiment.name'),
    status: pickStr(exp, 'experiment.status'),
    start_date: start,
    end_date: end,
    arms,
    window: { from, to, days_after_ramp: daysAfterRamp, days_running: daysRunning },
    verdict,
  };
}

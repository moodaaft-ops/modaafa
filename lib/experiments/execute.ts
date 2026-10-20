import { escapeGaql, pickStr, resultNames, safeQuery, type GrowthCustomer, type MutateOperation } from '../growth/types';
import { readReadiness } from '../growth/readiness';
import { buildExperimentPlan, readCampaign, validateStoredExperimentPlan, type ExperimentPlan } from './plan';
import { readExperimentResults } from './results';
import type { ExperimentMetric } from './significance';

/**
 * Experiment executors. Three cards, all approval only:
 *
 *  create_experiment    experiment (SETUP) -> two arms -> the ONE change on the draft campaign
 *                       -> schedule. If anything fails before the schedule call the experiment is
 *                       removed again (a SETUP experiment serves nothing). Undo = end the experiment.
 *  end_experiment       ExperimentService.EndExperiment. The treatment stops, nothing is deleted.
 *                       It cannot be started again, so it is not reversible.
 *  promote_experiment   PromoteExperiment: copies the treatment's change into the control campaign.
 *                       Re-checks the verdict with fresh data and refuses unless the treatment won.
 *                       Not reversible; the control's previous settings are recorded in the result.
 *
 * The experiment and both arms are validated together using a temporary experiment ID.
 * The treatment is also validated before its live change. End/promote accept validate_only.
 */

export const END_EXPERIMENT_ROLLBACK = 'growth_end_experiment';
export const NOT_REVERSIBLE = 'growth_not_reversible';
const EXPERIMENT_RE = /^customers\/\d+\/experiments\/\d+$/;
const ARM_RE = /^customers\/\d+\/experimentArms\/[\d~]+$/;
const CAMPAIGN_RE = /^customers\/\d+\/campaigns\/\d+$/;

export class ExperimentBlockedError extends Error {
  constructor(readonly codes: string[], message: string) {
    super(message);
    this.name = 'ExperimentBlockedError';
  }
}

function need(customer: GrowthCustomer) {
  if (!customer.experiments || !customer.experimentArms) throw new Error('This Google Ads client does not support experiments.');
  return { experiments: customer.experiments, arms: customer.experimentArms };
}

async function uniqueExperimentName(customer: GrowthCustomer, base: string, nonce: () => string) {
  const rows = await safeQuery(customer, `SELECT experiment.name FROM experiment WHERE experiment.name = '${escapeGaql(base)}' LIMIT 1`);
  return rows.length === 0 ? base : `${base} ${nonce()}`.slice(0, 80);
}


/** The experiment resource's create operation (ExperimentService wraps each operation as {create:{...}}). */
export function experimentCreate(plan: ExperimentPlan, name: string) {
  return {
    create: {
      name,
      description: 'تجربة من مُضاعِف',
      suffix: plan.suffix,
      type: 'SEARCH_CUSTOM',
      status: 'SETUP',
      start_date: plan.start_date,
      end_date: plan.end_date,
      // Changes made to the control while the test runs must not leak into the treatment.
      sync_enabled: false,
    },
  };
}

export function armsCreate(plan: ExperimentPlan, experimentResource: string) {
  return [
    {
      create: {
        experiment: experimentResource,
        name: 'الأصل',
        control: true,
        campaigns: [plan.campaign_resource],
        traffic_split: 100 - plan.treatment_split,
      },
    },
    { create: { experiment: experimentResource, name: 'التجربة', control: false, traffic_split: plan.treatment_split } },
  ];
}

/** Validate the complete setup without creating a real experiment or draft. */
export function experimentSetupOperations(plan: ExperimentPlan, name: string, customerId: string): MutateOperation[] {
  const temp = `customers/${customerId.replace(/\D/g, '')}/experiments/-1`;
  return [{ experiment_operation: { create: { ...experimentCreate(plan, name).create, resource_name: temp } } },
    ...armsCreate(plan, temp).map((operation) => ({ experiment_arm_operation: operation }))];
}

/** The one change, applied to the draft campaign (or its ads) of the treatment arm. */
export function treatmentChangeOperations(plan: ExperimentPlan, draftCampaign: string, draftAds: string[]): MutateOperation[] {
  if (plan.change.type === 'bidding') {
    if (plan.change.strategy === 'MAXIMIZE_CONVERSIONS') {
      return [{ campaign_operation: { update: { resource_name: draftCampaign, maximize_conversions: {} }, update_mask: 'maximize_conversions.target_cpa_micros' } }];
    }
    return [
      {
        campaign_operation: {
          update: { resource_name: draftCampaign, target_cpa: { target_cpa_micros: plan.change.target_cpa_micros } },
          update_mask: 'target_cpa.target_cpa_micros',
        },
      },
    ];
  }
  return draftAds.map((ad) => ({
    ad_operation: { update: { resource_name: ad, final_urls: [(plan.change as { final_url: string }).final_url] }, update_mask: 'final_urls' },
  }));
}

async function preflightCreate(rawPlan: unknown, customer: GrowthCustomer, customerId: string, now: Date) {
  const checked = validateStoredExperimentPlan(rawPlan, customerId);
  if (!checked.ok) throw new ExperimentBlockedError(['plan'], `Experiment plan rejected: ${checked.reason}`);
  const plan = checked.plan;
  // The rules ran when the card was proposed; the account may have changed since.
  const [campaign, readiness] = await Promise.all([readCampaign(customer, plan.campaign_resource), readReadiness(customer, now)]);
  const proposal = buildExperimentPlan(
    plan.change.type === 'bidding'
      ? {
          campaign_resource: plan.campaign_resource,
          kind: 'bidding_strategy',
          strategy: plan.change.strategy,
          target_cpa_sar: plan.change.target_cpa_micros ? plan.change.target_cpa_micros / 1_000_000 : undefined,
          treatment_split: plan.treatment_split,
          duration_days: plan.duration_days,
        }
      : { campaign_resource: plan.campaign_resource, kind: 'landing_page', final_url: plan.change.final_url, treatment_split: plan.treatment_split, duration_days: plan.duration_days },
    campaign,
    readiness,
    now
  );
  if (!proposal.ok) {
    throw new ExperimentBlockedError(proposal.blockers.map((b) => b.code), proposal.blockers.map((b) => b.message_ar).join(' | '));
  }
  // The start date must still be in the future.
  const tomorrow = proposal.plan.start_date;
  if (plan.start_date < tomorrow) throw new ExperimentBlockedError(['start_date_passed'], 'تاريخ بداية التجربة فات. اطلب التجربة من جديد');
  return plan;
}

export async function validateCreateExperiment(rawPlan: unknown, customer: GrowthCustomer, customerId: string, deps: { nonce: () => string; now?: () => Date }) {
  const plan = await preflightCreate(rawPlan, customer, customerId, deps.now?.() ?? new Date());
  const name = await uniqueExperimentName(customer, plan.name, deps.nonce);
  await customer.mutateOperations(experimentSetupOperations(plan, name, customerId), { validateOnly: true });
  return { validate_only: 'passed' as const, experiment_name: name };
}

export type CreateExperimentResult = {
  experiment_resource: string;
  experiment_name: string;
  control_arm: string;
  treatment_arm: string;
  draft_campaign: string;
  start_date: string;
  end_date: string;
  validate_only: 'passed';
  readback: { ok: boolean; status: string | null; mismatches: string[] };
  rollback_payload: {
    reversible: true;
    action_type: typeof END_EXPERIMENT_ROLLBACK;
    experiment_resource: string;
    resource_names: string[];
  };
};

async function draftCampaignOf(customer: GrowthCustomer, armResource: string): Promise<string> {
  const rows = await customer.query(
    `SELECT experiment_arm.in_design_campaigns FROM experiment_arm WHERE experiment_arm.resource_name = '${escapeGaql(armResource)}' PARAMETERS include_drafts = true`
  );
  const list = (rows[0] as any)?.experimentArm?.inDesignCampaigns ?? (rows[0] as any)?.experiment_arm?.in_design_campaigns ?? [];
  const draft = Array.isArray(list) ? list.find((c: unknown) => typeof c === 'string' && CAMPAIGN_RE.test(c)) : null;
  if (!draft) throw new Error('Google did not return the treatment draft campaign.');
  return draft;
}

async function draftAdsOf(customer: GrowthCustomer, draftCampaign: string): Promise<string[]> {
  const rows = await customer.query(
    `SELECT ad_group_ad.ad.resource_name FROM ad_group_ad WHERE campaign.resource_name = '${escapeGaql(draftCampaign)}' AND ad_group_ad.status = 'ENABLED' PARAMETERS include_drafts = true`
  );
  const out: string[] = [];
  for (const row of rows) {
    const name = pickStr(row, 'ad_group_ad.ad.resource_name');
    if (/^customers\/\d+\/ads\/\d+$/.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

export async function executeCreateExperiment(
  rawPlan: unknown,
  customer: GrowthCustomer,
  customerId: string,
  deps: { nonce: () => string; now?: () => Date }
): Promise<CreateExperimentResult> {
  const now = deps.now?.() ?? new Date();
  const plan = await preflightCreate(rawPlan, customer, customerId, now);
  const { experiments, arms } = need(customer);
  const prefix = `customers/${customerId.replace(/\D/g, '')}/`;
  const name = await uniqueExperimentName(customer, plan.name, deps.nonce);

  const operation = experimentCreate(plan, name);
  await customer.mutateOperations(experimentSetupOperations(plan, name, customerId), { validateOnly: true });
  const created = await experiments.mutate([operation]);
  const experiment = resultNames(created)[0];
  if (!experiment || !EXPERIMENT_RE.test(experiment) || !experiment.startsWith(prefix)) {
    throw new Error('Google Ads did not return the created experiment name.');
  }

  let control = '';
  let treatment = '';
  let draft = '';
  try {
    const armResult = await arms.mutate(armsCreate(plan, experiment), { responseContentType: 'MUTABLE_RESOURCE' });
    [control, treatment] = resultNames(armResult);
    if (!control || !treatment || !ARM_RE.test(control) || !ARM_RE.test(treatment)) throw new Error('Google Ads did not return the experiment arms.');
    draft = await draftCampaignOf(customer, treatment);
    const ads = plan.change.type === 'landing_page' ? await draftAdsOf(customer, draft) : [];
    if (plan.change.type === 'landing_page' && ads.length === 0) throw new Error('The treatment draft has no ads to change.');
    const changeOps = treatmentChangeOperations(plan, draft, ads);
    await customer.mutateOperations(changeOps, { validateOnly: true });
    await customer.mutateOperations(changeOps);
    await experiments.schedule(experiment, { validateOnly: true });
  } catch (error) {
    // Nothing is scheduled yet, so nothing serves. Take the half-built experiment away.
    try {
      await experiments.mutate([{ remove: experiment }]);
    } catch {
      // Left in SETUP; it serves nothing and the error below tells the merchant.
    }
    throw error;
  }
  // The live schedule call is the point of no return. An ambiguous failure here is rethrown untouched
  // (the handler keeps the card locked for a manual check), and the experiment is NOT removed.
  await experiments.schedule(experiment);

  let readback: CreateExperimentResult['readback'];
  try {
    readback = await readbackCreate(customer, experiment, plan);
  } catch {
    readback = { ok: false, status: null, mismatches: ['readback_failed'] };
  }
  return {
    experiment_resource: experiment,
    experiment_name: name,
    control_arm: control,
    treatment_arm: treatment,
    draft_campaign: draft,
    start_date: plan.start_date,
    end_date: plan.end_date,
    validate_only: 'passed',
    readback,
    rollback_payload: {
      reversible: true,
      action_type: END_EXPERIMENT_ROLLBACK,
      experiment_resource: experiment,
      resource_names: [experiment],
    },
  };
}

export async function readbackCreate(customer: GrowthCustomer, experiment: string, plan: ExperimentPlan) {
  const r = escapeGaql(experiment);
  const mismatches: string[] = [];
  const rows = await customer.query(
    `SELECT experiment.resource_name, experiment.status, experiment.start_date, experiment.end_date, experiment.type FROM experiment WHERE experiment.resource_name = '${r}' LIMIT 1`
  );
  const row = rows[0];
  const status = row ? pickStr(row, 'experiment.status') : null;
  if (!row) mismatches.push('experiment_missing');
  else {
    if (!['INITIATED', 'ENABLED'].includes(status ?? '')) mismatches.push(`status_${status}`);
    if (pickStr(row, 'experiment.start_date') !== plan.start_date) mismatches.push('start_date');
    if (pickStr(row, 'experiment.end_date') !== plan.end_date) mismatches.push('end_date');
  }
  const armRows = await customer.query(
    `SELECT experiment_arm.control, experiment_arm.traffic_split, experiment_arm.campaigns FROM experiment_arm WHERE experiment_arm.experiment = '${r}'`
  );
  if (armRows.length !== 2) mismatches.push(`arms:${armRows.length}/2`);
  const controlArm = armRows.find((a) => ((a as any)?.experimentArm?.control ?? (a as any)?.experiment_arm?.control) === true);
  if (controlArm) {
    const camp = (controlArm as any)?.experimentArm?.campaigns ?? (controlArm as any)?.experiment_arm?.campaigns ?? [];
    if (!Array.isArray(camp) || !camp.includes(plan.campaign_resource)) mismatches.push('control_campaign');
  } else mismatches.push('control_arm');
  return { ok: mismatches.length === 0, status, mismatches };
}

// ---------------------------------------------------------------------------
// End and promote
// ---------------------------------------------------------------------------

export type EndParams = { experiment_resource: string };
export type PromoteParams = { experiment_resource: string; metric: ExperimentMetric };

export function validateEndParams(raw: unknown, customerId?: string | null): { ok: true; value: EndParams } | { ok: false; code: string } {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const scope = customerId ? String(customerId).replace(/\D/g, '') : '\\d+';
  const resource = String(p?.experiment_resource ?? '');
  if (!new RegExp(`^customers/${scope}/experiments/\\d+$`).test(resource)) return { ok: false, code: 'experiment' };
  return { ok: true, value: { experiment_resource: resource } };
}

export function validatePromoteParams(raw: unknown, customerId?: string | null): { ok: true; value: PromoteParams } | { ok: false; code: string } {
  const end = validateEndParams(raw, customerId);
  if (!end.ok) return end;
  const metric = (raw as Record<string, unknown>).metric;
  if (metric !== 'conversion_rate' && metric !== 'cost_per_conversion') return { ok: false, code: 'metric' };
  return { ok: true, value: { experiment_resource: end.value.experiment_resource, metric } };
}

async function experimentStatus(customer: GrowthCustomer, resource: string) {
  const rows = await customer.query(
    `SELECT experiment.resource_name, experiment.status FROM experiment WHERE experiment.resource_name = '${escapeGaql(resource)}' LIMIT 1`
  );
  return rows[0] ? pickStr(rows[0], 'experiment.status') : null;
}

export async function validateEndExperiment(rawParams: unknown, customer: GrowthCustomer, customerId: string) {
  const checked = validateEndParams(rawParams, customerId);
  if (!checked.ok) throw new Error(`Experiment end is malformed (${checked.code})`);
  const status = await experimentStatus(customer, checked.value.experiment_resource);
  if (!status || !['INITIATED', 'ENABLED', 'SETUP'].includes(status)) throw new Error(`The experiment is ${status ?? 'missing'}; only a running experiment can be ended.`);
  await need(customer).experiments.end(checked.value.experiment_resource, { validateOnly: true });
  return { validate_only: 'passed' as const, status_before: status };
}

export async function executeEndExperiment(rawParams: unknown, customer: GrowthCustomer, customerId: string) {
  const checked = validateEndParams(rawParams, customerId);
  if (!checked.ok) throw new Error(`Experiment end is malformed (${checked.code})`);
  const resource = checked.value.experiment_resource;
  const status = await experimentStatus(customer, resource);
  if (!status || !['INITIATED', 'ENABLED', 'SETUP'].includes(status)) throw new Error(`The experiment is ${status ?? 'missing'}; only a running experiment can be ended.`);
  const { experiments } = need(customer);
  await experiments.end(resource, { validateOnly: true });
  await experiments.end(resource);
  let readback: { ok: boolean; status: string | null; mismatches: string[] };
  try {
    const after = await experimentStatus(customer, resource);
    readback = after === 'HALTED' ? { ok: true, status: after, mismatches: [] } : { ok: false, status: after, mismatches: [`status_${after}`] };
  } catch {
    readback = { ok: false, status: null, mismatches: ['readback_failed'] };
  }
  return {
    experiment_resource: resource,
    status_before: status,
    validate_only: 'passed' as const,
    readback,
    rollback_payload: {
      reversible: false,
      action_type: NOT_REVERSIBLE,
      note: 'experiment_cannot_restart',
      experiment_resource: resource,
      resource_names: [resource],
    },
  };
}

async function readControlSnapshot(customer: GrowthCustomer, experiment: string) {
  const arms = await customer.query(
    `SELECT experiment_arm.control, experiment_arm.campaigns FROM experiment_arm WHERE experiment_arm.experiment = '${escapeGaql(experiment)}'`
  );
  const control = arms.find((a) => ((a as any)?.experimentArm?.control ?? (a as any)?.experiment_arm?.control) === true);
  const camp = (control as any)?.experimentArm?.campaigns ?? (control as any)?.experiment_arm?.campaigns ?? [];
  const campaign = Array.isArray(camp) ? camp.find((c: unknown) => typeof c === 'string' && CAMPAIGN_RE.test(c)) : null;
  if (!campaign) return null;
  const rows = await customer.query(
    `SELECT campaign.resource_name, campaign.bidding_strategy_type, campaign.target_cpa.target_cpa_micros FROM campaign WHERE campaign.resource_name = '${escapeGaql(campaign)}' LIMIT 1`
  );
  return {
    campaign_resource: campaign as string,
    bidding_strategy_type: rows[0] ? pickStr(rows[0], 'campaign.bidding_strategy_type') : null,
    target_cpa_micros: rows[0] ? Number(pickStr(rows[0], 'campaign.target_cpa.target_cpa_micros')) || null : null,
  };
}

async function promoteGate(rawParams: unknown, customer: GrowthCustomer, customerId: string, now: Date) {
  const checked = validatePromoteParams(rawParams, customerId);
  if (!checked.ok) throw new Error(`Experiment promotion is malformed (${checked.code})`);
  const { experiment_resource: resource, metric } = checked.value;
  const status = await experimentStatus(customer, resource);
  if (status !== 'ENABLED') throw new Error(`The experiment is ${status ?? 'missing'}; only a running experiment can be promoted.`);
  const reading = await readExperimentResults(customer, resource, metric, { now });
  const verdict = reading.verdict;
  if (verdict.status !== 'winner' || verdict.winner !== 'treatment') {
    throw new ExperimentBlockedError(['no_winner'], 'التجربة ما أثبتت إنها أحسن من الأصل، فما نعتمدها');
  }
  return { resource, reading };
}

export async function validatePromoteExperiment(rawParams: unknown, customer: GrowthCustomer, customerId: string, now = new Date()) {
  const { resource } = await promoteGate(rawParams, customer, customerId, now);
  await need(customer).experiments.promote(resource, { validateOnly: true });
  return { validate_only: 'passed' as const };
}

export async function executePromoteExperiment(rawParams: unknown, customer: GrowthCustomer, customerId: string, now = new Date()) {
  const { resource, reading } = await promoteGate(rawParams, customer, customerId, now);
  const before = await readControlSnapshot(customer, resource).catch(() => null);
  const { experiments } = need(customer);
  await experiments.promote(resource, { validateOnly: true });
  await experiments.promote(resource);
  let readback: { ok: boolean; status: string | null; mismatches: string[] };
  try {
    const after = await experimentStatus(customer, resource);
    // Promotion is asynchronous: «in progress» is a normal first reading.
    const fine = ['PROMOTED', 'PROMOTING', 'PROMOTE_IN_PROGRESS'].includes(after ?? '');
    readback = fine ? { ok: true, status: after, mismatches: [] } : { ok: false, status: after, mismatches: [`status_${after}`] };
  } catch {
    readback = { ok: false, status: null, mismatches: ['readback_failed'] };
  }
  return {
    experiment_resource: resource,
    verdict: reading.verdict,
    control_before: before,
    validate_only: 'passed' as const,
    readback,
    rollback_payload: {
      reversible: false,
      action_type: NOT_REVERSIBLE,
      note: 'promotion_cannot_be_undone_here',
      control_before: before,
      experiment_resource: resource,
      resource_names: [resource],
    },
  };
}

export async function executeExperimentRollback(rollback: Record<string, any>, customer: GrowthCustomer, options?: { validateOnly?: boolean }) {
  if (rollback.action_type !== END_EXPERIMENT_ROLLBACK) throw new Error('This action does not have a supported rollback operation');
  const resource = String(rollback.experiment_resource ?? '');
  if (!EXPERIMENT_RE.test(resource)) throw new Error('Experiment rollback descriptor is malformed.');
  return need(customer).experiments.end(resource, options);
}


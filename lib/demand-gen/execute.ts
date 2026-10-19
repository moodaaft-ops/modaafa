import { escapeGaql, resourceNamesFromMutate, uniqueCampaignName } from '../launch/execute';
import { pickNum, pickStr, safeQuery, type GrowthCustomer } from '../growth/types';
import { readReadiness, type Readiness } from '../growth/readiness';
import { ratioMatches, meetsMinimum, SLOT_SPECS, type ImageSlot } from '../image-assets/requirements';
import { buildDemandGenOperations, type BuiltDemandGen } from './operations';
import { evaluateDemandGenReadiness } from './plan';
import type { DemandGenBlocker, DemandGenPlan } from './types';

/**
 * Builds the Demand Gen plan in the merchant's account. Same order as the
 * Search launcher: read what the batch depends on, build ONE mutate batch,
 * validateOnly, the live mutate, a readback, and a rollback descriptor. The
 * campaign is PAUSED the whole time; enabling it is a separate approval
 * (the existing enable_campaign action).
 */

export const DEMAND_GEN_ROLLBACK_ACTION = 'growth_remove_demand_gen';
/** Lists below this are refused for targeting: Customer Match needs 100, and a fresh list shows 0. */
export const MIN_AUDIENCE_SIZE = 100;
/** Under this a website list still works but serves slowly (Google's Display and YouTube minimum is 1000). */
export const COMFORTABLE_AUDIENCE_SIZE = 1000;

export class DemandGenBlockedError extends Error {
  constructor(readonly blockers: DemandGenBlocker[]) {
    super(blockers.map((b) => b.message_ar).join(' | ') || 'blocked');
    this.name = 'DemandGenBlockedError';
  }
}

export type DemandGenDeps = {
  nonce: () => string;
  isAmbiguous: (error: unknown) => boolean;
  now?: () => Date;
};

export type DemandGenPreflight = {
  campaignName: string;
  readiness: Readiness;
  existingVideoAsset: string | null;
  audienceSizes: Record<string, number | null>;
  warnings_ar: string[];
};

const fieldOf = (rows: any[], dotted: string) => (rows[0] ? pickStr(rows[0], dotted) : '');

/** The IMAGE assets the plan names must exist and fit the slot they are used in. */
async function checkImageAssets(plan: DemandGenPlan, customer: GrowthCustomer): Promise<DemandGenBlocker[]> {
  const all = [...plan.images.marketing, ...plan.images.square, ...plan.images.portrait, ...plan.images.logo];
  if (all.length === 0) return [];
  const rows = await customer.query(
    `SELECT asset.resource_name, asset.type, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels FROM asset WHERE asset.resource_name IN (${all
      .map((a) => `'${escapeGaql(a)}'`)
      .join(', ')})`
  );
  const byName = new Map<string, { type: string; w: number; h: number }>();
  for (const row of rows) {
    byName.set(pickStr(row, 'asset.resource_name'), {
      type: pickStr(row, 'asset.type'),
      w: pickNum(row, 'asset.image_asset.full_size.width_pixels') ?? 0,
      h: pickNum(row, 'asset.image_asset.full_size.height_pixels') ?? 0,
    });
  }
  const out: DemandGenBlocker[] = [];
  for (const slot of ['marketing', 'square', 'portrait', 'logo'] as ImageSlot[]) {
    for (const name of plan.images[slot]) {
      const found = byName.get(name);
      const spec = SLOT_SPECS[slot];
      if (!found || found.type !== 'IMAGE') {
        out.push({ code: 'image_resource_invalid', message_ar: 'صورة من الصور المختارة مو موجودة في حسابك' });
      } else if (!ratioMatches(found.w, found.h, spec) || !meetsMinimum(found.w, found.h, spec)) {
        out.push({ code: 'image_resource_invalid', message_ar: `صورة مو بمقاس الخانة (${spec.ratioLabel} وأقل مقاس ${spec.minWidth}x${spec.minHeight})` });
      }
    }
  }
  return out;
}

async function checkAudiences(plan: DemandGenPlan, customer: GrowthCustomer) {
  const sizes: Record<string, number | null> = {};
  const blockers: DemandGenBlocker[] = [];
  const warnings: string[] = [];
  const names = [...plan.audience.user_lists, ...plan.audience.exclude_user_lists];
  if (names.length === 0) return { sizes, blockers, warnings };
  const rows = await customer.query(
    `SELECT user_list.resource_name, user_list.membership_status, user_list.size_for_display, user_list.size_for_search FROM user_list WHERE user_list.resource_name IN (${names
      .map((n) => `'${escapeGaql(n)}'`)
      .join(', ')})`
  );
  const byName = new Map<string, { status: string; size: number | null }>();
  for (const row of rows) {
    byName.set(pickStr(row, 'user_list.resource_name'), {
      status: pickStr(row, 'user_list.membership_status'),
      size: pickNum(row, 'user_list.size_for_display'),
    });
  }
  for (const name of names) {
    const found = byName.get(name);
    sizes[name] = found ? found.size : null;
    if (!found || found.status !== 'OPEN') {
      blockers.push({ code: 'audience_not_ready', message_ar: 'قائمة جمهور من اللي اخترتها مو موجودة أو مقفلة' });
    }
  }
  for (const name of plan.audience.user_lists) {
    const size = sizes[name];
    if (size === null || size === undefined || size < MIN_AUDIENCE_SIZE) {
      blockers.push({
        code: 'audience_not_ready',
        message_ar: `قائمة الجمهور لسا صغيرة (أقل من ${MIN_AUDIENCE_SIZE} عضو) وقوقل ما تخدمها. انتظر لين تتجمع`,
      });
    } else if (size < COMFORTABLE_AUDIENCE_SIZE) {
      warnings.push('قائمة الجمهور أقل من 1000 عضو، فالإعلان بيوصل ببطء');
    }
  }
  return { sizes, blockers, warnings };
}

export async function readDemandGenPreflight(plan: DemandGenPlan, customer: GrowthCustomer, now = new Date()): Promise<DemandGenPreflight> {
  const names = await customer.query(`SELECT campaign.name FROM campaign WHERE campaign.status != 'REMOVED' LIMIT 10000`);
  const campaignName = uniqueCampaignName(plan.name, names.map((row) => pickStr(row, 'campaign.name')));
  const readiness = await readReadiness(customer, now);

  const blockers: DemandGenBlocker[] = [
    ...evaluateDemandGenReadiness(plan, readiness),
    ...(await checkImageAssets(plan, customer)),
  ];
  const audience = await checkAudiences(plan, customer);
  blockers.push(...audience.blockers);
  if (blockers.length > 0) throw new DemandGenBlockedError(dedupeBlockers(blockers));

  let existingVideoAsset: string | null = null;
  if (plan.video) {
    const rows = await safeQuery(
      customer,
      `SELECT asset.resource_name FROM asset WHERE asset.type = 'YOUTUBE_VIDEO' AND asset.youtube_video_asset.youtube_video_id = '${escapeGaql(plan.video.youtube_video_id)}' LIMIT 1`
    );
    existingVideoAsset = fieldOf(rows, 'asset.resource_name') || null;
  }
  return { campaignName, readiness, existingVideoAsset, audienceSizes: audience.sizes, warnings_ar: audience.warnings };
}

function dedupeBlockers(list: DemandGenBlocker[]): DemandGenBlocker[] {
  const seen = new Set<string>();
  return list.filter((b) => {
    const key = `${b.code}|${b.message_ar}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function build(plan: DemandGenPlan, customerId: string, preflight: DemandGenPreflight, nonce: string): BuiltDemandGen {
  return buildDemandGenOperations(plan, {
    customerId,
    campaignName: preflight.campaignName,
    budgetName: `${preflight.campaignName} | ميزانية ${nonce}`,
    audienceName: `${preflight.campaignName} | جمهور ${nonce}`,
    existingVideoAsset: preflight.existingVideoAsset,
  });
}

/** Reads and builds the batch, then asks Google to validate it. Writes nothing. */
export async function validateDemandGenOnly(
  plan: DemandGenPlan,
  customer: GrowthCustomer,
  customerId: string,
  deps: Pick<DemandGenDeps, 'nonce' | 'now'>
) {
  const preflight = await readDemandGenPreflight(plan, customer, deps.now?.() ?? new Date());
  const built = build(plan, customerId, preflight, deps.nonce());
  await customer.mutateOperations(built.operations, { validateOnly: true });
  return {
    validate_only: 'passed' as const,
    operations: built.operations.length,
    campaign_name: preflight.campaignName,
    warnings_ar: preflight.warnings_ar,
  };
}

export type DemandGenRollbackPayload = {
  reversible: true;
  action_type: typeof DEMAND_GEN_ROLLBACK_ACTION;
  campaign_resource: string;
  budget_resource: string;
  campaign_shared_set_resource: null;
  shared_set_resource: null;
  resource_names: string[];
  /** Audiences and assets cannot be removed through the API; they stay in the account unlinked. */
  retained_resources: string[];
};

export type DemandGenReadback = { ok: boolean; status: string | null; mismatches: string[]; counts: Record<string, number> };

export type DemandGenExecution = {
  campaign_resource: string;
  budget_resource: string;
  campaign_name: string;
  operations: number;
  validate_only: 'passed';
  readback: DemandGenReadback;
  rollback_payload: DemandGenRollbackPayload;
  reconciled: boolean;
};

export async function readbackDemandGen(
  customer: GrowthCustomer,
  campaignResource: string,
  built: BuiltDemandGen,
  plan: DemandGenPlan
): Promise<DemandGenReadback> {
  const r = escapeGaql(campaignResource);
  const mismatches: string[] = [];
  const counts: Record<string, number> = {};
  const rows = await customer.query(
    `SELECT campaign.resource_name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros FROM campaign WHERE campaign.resource_name = '${r}' LIMIT 1`
  );
  const row = rows[0];
  const status = row ? pickStr(row, 'campaign.status') : null;
  if (!row) mismatches.push('campaign_missing');
  else {
    if (status !== 'PAUSED') mismatches.push(`campaign_status_${status}`);
    if (pickStr(row, 'campaign.advertising_channel_type') !== 'DEMAND_GEN') mismatches.push('campaign_type');
    if (pickNum(row, 'campaign_budget.amount_micros') !== plan.budget.daily_micros) mismatches.push('budget_amount');
  }
  const check = async (key: string, gaql: string, expected: number) => {
    const actual = (await customer.query(gaql)).length;
    counts[key] = actual;
    if (actual !== expected) mismatches.push(`${key}:${actual}/${expected}`);
  };
  await check('ad_groups', `SELECT ad_group.resource_name FROM ad_group WHERE campaign.resource_name = '${r}' AND ad_group.status != 'REMOVED'`, 1);
  await check('ads', `SELECT ad_group_ad.resource_name FROM ad_group_ad WHERE campaign.resource_name = '${r}' AND ad_group_ad.status != 'REMOVED'`, built.expected.ads);
  for (const [key, type, expected] of [
    ['locations', 'LOCATION', built.expected.locations],
    ['languages', 'LANGUAGE', built.expected.languages],
    ['audiences', 'AUDIENCE', built.expected.audience_criteria],
  ] as const) {
    await check(key, `SELECT ad_group_criterion.resource_name FROM ad_group_criterion WHERE campaign.resource_name = '${r}' AND ad_group_criterion.type = '${type}' AND ad_group_criterion.status != 'REMOVED'`, expected);
  }
  return { ok: mismatches.length === 0, status, mismatches, counts };
}

async function findCampaignByName(customer: GrowthCustomer, name: string) {
  const rows = await customer.query(
    `SELECT campaign.resource_name, campaign.campaign_budget FROM campaign WHERE campaign.name = '${escapeGaql(name)}' AND campaign.status != 'REMOVED' LIMIT 2`
  );
  if (rows.length !== 1) return null;
  const campaign = pickStr(rows[0], 'campaign.resource_name');
  const budget = pickStr(rows[0], 'campaign.campaign_budget');
  return campaign && budget ? { campaign, budget } : null;
}

/**
 * Runs the whole build. Throws before any live write if the batch is invalid.
 * A timed-out live call is reconciled by looking the campaign up by name.
 */
export async function executeDemandGen(
  plan: DemandGenPlan,
  customer: GrowthCustomer,
  customerId: string,
  deps: DemandGenDeps
): Promise<DemandGenExecution> {
  const preflight = await readDemandGenPreflight(plan, customer, deps.now?.() ?? new Date());
  const built = build(plan, customerId, preflight, deps.nonce());
  await customer.mutateOperations(built.operations, { validateOnly: true });

  const prefix = `customers/${customerId.replace(/\D/g, '')}/`;
  let rollback: DemandGenRollbackPayload;
  let reconciled = false;
  try {
    const result = await customer.mutateOperations(built.operations);
    const names = resourceNamesFromMutate(result, built.operations.length);
    const at = (role: BuiltDemandGen['roles'][number]) => {
      const i = built.roles.indexOf(role);
      return i >= 0 ? names[i] : null;
    };
    const campaign = at('campaign');
    const budget = at('budget');
    if (!campaign || !budget) throw new Error('Google Ads did not return the created campaign and budget names.');
    if (![campaign, budget].every((n) => n.startsWith(prefix))) throw new Error('Created resource outside the selected account.');
    const retained = built.roles
      .map((role, i) => (role === 'asset' || role === 'audience' ? names[i] : null))
      .filter((n): n is string => Boolean(n));
    rollback = {
      reversible: true,
      action_type: DEMAND_GEN_ROLLBACK_ACTION,
      campaign_resource: campaign,
      budget_resource: budget,
      campaign_shared_set_resource: null,
      shared_set_resource: null,
      resource_names: [campaign, budget],
      retained_resources: retained,
    };
  } catch (error) {
    if (!deps.isAmbiguous(error)) throw error;
    const found = await findCampaignByName(customer, preflight.campaignName).catch(() => null);
    if (!found) throw error;
    reconciled = true;
    rollback = {
      reversible: true,
      action_type: DEMAND_GEN_ROLLBACK_ACTION,
      campaign_resource: found.campaign,
      budget_resource: found.budget,
      campaign_shared_set_resource: null,
      shared_set_resource: null,
      resource_names: [found.campaign, found.budget].filter((n) => n.startsWith(prefix)),
      retained_resources: [],
    };
  }

  // The campaign exists from here on: nothing below may throw (a failed check is reported, never a failed build).
  let readback: DemandGenReadback;
  try {
    readback = await readbackDemandGen(customer, rollback.campaign_resource, built, plan);
  } catch {
    readback = { ok: false, status: null, mismatches: ['readback_failed'], counts: {} };
  }
  if (readback.status && readback.status !== 'PAUSED') {
    try {
      await customer.mutateOperations([
        { campaign_operation: { update: { resource_name: rollback.campaign_resource, status: 'PAUSED' }, update_mask: 'status' } },
      ]);
    } catch {
      readback.mismatches.push('pause_failed');
    }
  }

  return {
    campaign_resource: rollback.campaign_resource,
    budget_resource: rollback.budget_resource,
    campaign_name: preflight.campaignName,
    operations: built.operations.length,
    validate_only: 'passed',
    readback,
    rollback_payload: rollback,
    reconciled,
  };
}


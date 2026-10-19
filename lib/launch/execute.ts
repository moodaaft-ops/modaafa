import { buildLaunchOperations, reusableKeys, type BuiltOperations, type OperationContext } from './operations';
import type { LaunchPlan } from './types';

/**
 * Builds the launch plan in the merchant's Google Ads account.
 *
 * The order is fixed: read what the batch depends on, build ONE mutate batch,
 * validateOnly, the real mutate, a readback of what was created, and a rollback
 * descriptor that removes it. The campaign is PAUSED the whole time; enabling
 * it is a separate approval (the existing enable_campaign action).
 *
 * Nothing here talks to Supabase or the network on its own: the caller passes a
 * `LaunchCustomer` (the REST customer from getCustomer) so tests can stub it.
 */

export interface LaunchCustomer {
  query(gaql: string): Promise<any[]>;
  mutateOperations(operations: unknown[], options?: { validateOnly?: boolean }): Promise<any>;
}

export const LAUNCH_ROLLBACK_ACTION = 'remove_launched_campaign';

export type LaunchRollbackPayload = {
  reversible: true;
  action_type: typeof LAUNCH_ROLLBACK_ACTION;
  campaign_resource: string;
  budget_resource: string;
  campaign_shared_set_resource: string | null;
  /** Only when this launch created the shared set (a reused list is left alone). */
  shared_set_resource: string | null;
  /** Removal order. Every entry is under the account's own customer id. */
  resource_names: string[];
  /** Assets cannot be removed through the API; they stay unlinked in the account. */
  retained_asset_resources: string[];
};

export type LaunchReadback = {
  ok: boolean;
  status: string | null;
  mismatches: string[];
  counts: Record<string, number>;
};

export type LaunchExecution = {
  campaign_resource: string;
  budget_resource: string;
  campaign_name: string;
  operations: number;
  validate_only: 'passed';
  readback: LaunchReadback;
  rollback_payload: LaunchRollbackPayload;
  /** True when the live call timed out and the campaign was found afterwards by name. */
  reconciled: boolean;
  location: 'inherited' | 'linked' | 'none';
};

export type LaunchDeps = {
  nonce: () => string;
  /** Marks a thrown error as one that may have been committed (timeouts, resets). */
  isAmbiguous: (error: unknown) => boolean;
};

export function escapeGaql(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const num = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const pick = (row: any, ...paths: string[]) => {
  for (const path of paths) {
    let cursor = row;
    for (const part of path.split('.')) cursor = cursor?.[part];
    if (cursor !== undefined && cursor !== null) return cursor;
  }
  return undefined;
};
/** Rows come back camelCase over REST and snake_case from some helpers. */
const get = (row: any, dotted: string) => {
  const camel = dotted.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return pick(row, dotted, camel);
};

const SHARED_QUERY_LIMIT = 1000;

async function safeQuery(customer: LaunchCustomer, gaql: string): Promise<any[]> {
  try {
    return await customer.query(gaql);
  } catch {
    return [];
  }
}

/** A name nobody else in the account uses: the plan name, then «(2)», «(3)». */
export function uniqueCampaignName(base: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (${Date.now()})`;
}

export type LaunchPreflight = {
  campaignName: string;
  merchantId: number | null;
  locationSyncAssetSet: string | null;
  locationInherited: boolean;
  existingSharedSet: string | null;
  reusableAssets: NonNullable<OperationContext['reusableAssets']>;
};

/** Reads that the batch depends on. A failed optional read degrades to "none"; the merchant id is required for Shopping. */
export async function readLaunchPreflight(plan: LaunchPlan, customer: LaunchCustomer): Promise<LaunchPreflight> {
  const names = await customer.query(`SELECT campaign.name FROM campaign WHERE campaign.status != 'REMOVED' LIMIT 10000`);
  const campaignName = uniqueCampaignName(
    plan.name,
    names.map((row) => String(get(row, 'campaign.name') ?? ''))
  );

  let merchantId: number | null = null;
  if (plan.type === 'SHOPPING') {
    const rows = await customer.query(
      `SELECT campaign.id, campaign.shopping_setting.merchant_id FROM campaign WHERE campaign.status != 'REMOVED' LIMIT ${SHARED_QUERY_LIMIT}`
    );
    for (const row of rows) {
      const id = num(get(row, 'campaign.shopping_setting.merchant_id'));
      if (id && id > 0) {
        merchantId = id;
        break;
      }
    }
  }

  let locationInherited = false;
  let locationSyncAssetSet: string | null = null;
  if (plan.assets.use_location_sync) {
    const customerLevel = await safeQuery(
      customer,
      `SELECT asset_set.resource_name FROM customer_asset_set WHERE customer_asset_set.status = 'ENABLED' AND asset_set.status = 'ENABLED' AND asset_set.type = 'LOCATION_SYNC' LIMIT 1`
    );
    if (customerLevel.length > 0) {
      locationInherited = true;
    } else {
      const sets = await safeQuery(
        customer,
        `SELECT asset_set.resource_name FROM asset_set WHERE asset_set.status = 'ENABLED' AND asset_set.type = 'LOCATION_SYNC' LIMIT 1`
      );
      const name = sets[0] ? get(sets[0], 'asset_set.resource_name') : null;
      locationSyncAssetSet = typeof name === 'string' && name ? name : null;
    }
  }

  let existingSharedSet: string | null = null;
  if (plan.shared_negative_list.keywords.length > 0) {
    const sets = await safeQuery(
      customer,
      `SELECT shared_set.resource_name, shared_set.name FROM shared_set WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED' LIMIT ${SHARED_QUERY_LIMIT}`
    );
    const match = sets.find((row) => String(get(row, 'shared_set.name') ?? '') === plan.shared_negative_list.name);
    const name = match ? get(match, 'shared_set.resource_name') : null;
    existingSharedSet = typeof name === 'string' && name ? name : null;
  }

  const reusableAssets: LaunchPreflight['reusableAssets'] = {};
  if (plan.assets.sitelinks.length > 0) {
    reusableAssets.sitelinks = {};
    const rows = await safeQuery(
      customer,
      `SELECT asset.resource_name, asset.final_urls, asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2 FROM asset WHERE asset.type = 'SITELINK' LIMIT ${SHARED_QUERY_LIMIT}`
    );
    for (const row of rows) {
      const url = (get(row, 'asset.final_urls') as string[] | undefined)?.[0];
      const text = String(get(row, 'asset.sitelink_asset.link_text') ?? '');
      const resource = get(row, 'asset.resource_name');
      if (url && text && typeof resource === 'string') {
        reusableAssets.sitelinks[
          reusableKeys.sitelink(
            text,
            url,
            (get(row, 'asset.sitelink_asset.description1') as string) || null,
            (get(row, 'asset.sitelink_asset.description2') as string) || null
          )
        ] = resource;
      }
    }
  }
  if (plan.assets.callouts.length > 0) {
    reusableAssets.callouts = {};
    const rows = await safeQuery(
      customer,
      `SELECT asset.resource_name, asset.callout_asset.callout_text FROM asset WHERE asset.type = 'CALLOUT' LIMIT ${SHARED_QUERY_LIMIT}`
    );
    for (const row of rows) {
      const text = String(get(row, 'asset.callout_asset.callout_text') ?? '');
      const resource = get(row, 'asset.resource_name');
      if (text && typeof resource === 'string') reusableAssets.callouts[reusableKeys.callout(text)] = resource;
    }
  }
  if (plan.assets.structured_snippet) {
    reusableAssets.snippets = {};
    const rows = await safeQuery(
      customer,
      `SELECT asset.resource_name, asset.structured_snippet_asset.header, asset.structured_snippet_asset.values FROM asset WHERE asset.type = 'STRUCTURED_SNIPPET' LIMIT ${SHARED_QUERY_LIMIT}`
    );
    for (const row of rows) {
      const header = String(get(row, 'asset.structured_snippet_asset.header') ?? '');
      const values = get(row, 'asset.structured_snippet_asset.values');
      const resource = get(row, 'asset.resource_name');
      if (header && Array.isArray(values) && typeof resource === 'string') {
        reusableAssets.snippets[reusableKeys.snippet(header, values.map(String))] = resource;
      }
    }
  }
  if (plan.assets.call_phone) {
    reusableAssets.calls = {};
    const rows = await safeQuery(
      customer,
      `SELECT asset.resource_name, asset.call_asset.phone_number, asset.call_asset.country_code FROM asset WHERE asset.type = 'CALL' LIMIT ${SHARED_QUERY_LIMIT}`
    );
    for (const row of rows) {
      const phone = String(get(row, 'asset.call_asset.phone_number') ?? '');
      const country = String(get(row, 'asset.call_asset.country_code') ?? '');
      const resource = get(row, 'asset.resource_name');
      if (phone && country.toUpperCase() === 'SA' && typeof resource === 'string') reusableAssets.calls[phone] = resource;
    }
  }

  return { campaignName, merchantId, locationSyncAssetSet, locationInherited, existingSharedSet, reusableAssets };
}

/** One `<x>Result.resourceName` per operation, in order. */
export function resourceNamesFromMutate(result: any, count: number): Array<string | null> {
  const responses: any[] = Array.isArray(result?.mutateOperationResponses)
    ? result.mutateOperationResponses
    : Array.isArray(result?.mutate_operation_responses)
      ? result.mutate_operation_responses
      : [];
  const names: Array<string | null> = [];
  for (let i = 0; i < count; i += 1) {
    const entry = responses[i];
    const inner = entry && typeof entry === 'object' ? (Object.values(entry)[0] as any) : null;
    const name = inner?.resourceName ?? inner?.resource_name;
    names.push(typeof name === 'string' && name ? name : null);
  }
  return names;
}

function rollbackFrom(built: BuiltOperations, names: Array<string | null>, customerId: string): LaunchRollbackPayload {
  const at = (role: BuiltOperations['roles'][number]) => {
    const index = built.roles.indexOf(role);
    return index >= 0 ? names[index] : null;
  };
  const campaign = at('campaign');
  const budget = at('budget');
  if (!campaign || !budget) throw new Error('Google Ads did not return the created campaign and budget names.');
  const campaignSharedSet = at('campaign_shared_set');
  const sharedSet = at('shared_set');
  const assets = built.roles
    .map((role, i) => (role === 'asset' ? names[i] : null))
    .filter((name): name is string => Boolean(name));
  const prefix = `customers/${customerId.replace(/\D/g, '')}/`;
  const ordered = [campaignSharedSet, campaign, budget, sharedSet].filter((n): n is string => Boolean(n));
  if (!ordered.every((n) => n.startsWith(prefix))) throw new Error('Created resource outside the selected account.');
  return {
    reversible: true,
    action_type: LAUNCH_ROLLBACK_ACTION,
    campaign_resource: campaign,
    budget_resource: budget,
    campaign_shared_set_resource: campaignSharedSet,
    shared_set_resource: sharedSet,
    resource_names: ordered,
    retained_asset_resources: assets,
  };
}

async function count(customer: LaunchCustomer, gaql: string): Promise<number> {
  return (await customer.query(gaql)).length;
}

/** Reads back what was created and compares it with what the batch asked for. */
export async function readbackLaunch(
  customer: LaunchCustomer,
  campaignResource: string,
  built: BuiltOperations,
  plan: LaunchPlan
): Promise<LaunchReadback> {
  const r = escapeGaql(campaignResource);
  const mismatches: string[] = [];
  const counts: Record<string, number> = {};
  const rows = await customer.query(
    `SELECT campaign.resource_name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network FROM campaign WHERE campaign.resource_name = '${r}' LIMIT 1`
  );
  const row = rows[0];
  const status = row ? String(get(row, 'campaign.status') ?? '') : null;
  if (!row) mismatches.push('campaign_missing');
  else {
    if (status !== 'PAUSED') mismatches.push(`campaign_status_${status}`);
    if (num(get(row, 'campaign_budget.amount_micros')) !== plan.budget.daily_micros) mismatches.push('budget_amount');
    if (get(row, 'campaign.network_settings.target_search_network') === true) mismatches.push('search_partners_on');
    if (get(row, 'campaign.network_settings.target_content_network') === true) mismatches.push('display_network_on');
  }
  const check = async (key: string, gaql: string, expected: number) => {
    const actual = await count(customer, gaql);
    counts[key] = actual;
    if (actual !== expected) mismatches.push(`${key}:${actual}/${expected}`);
  };
  await check('ad_groups', `SELECT ad_group.resource_name FROM ad_group WHERE campaign.resource_name = '${r}' AND ad_group.status != 'REMOVED'`, built.expected.ad_groups);
  await check('ads', `SELECT ad_group_ad.resource_name FROM ad_group_ad WHERE campaign.resource_name = '${r}' AND ad_group_ad.status != 'REMOVED'`, built.expected.ads);
  if (plan.type === 'SEARCH') {
    await check('keywords', `SELECT ad_group_criterion.resource_name FROM ad_group_criterion WHERE campaign.resource_name = '${r}' AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'`, built.expected.keywords);
  }
  await check('campaign_negatives', `SELECT campaign_criterion.resource_name FROM campaign_criterion WHERE campaign.resource_name = '${r}' AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE`, built.expected.campaign_negatives);
  await check('locations', `SELECT campaign_criterion.resource_name FROM campaign_criterion WHERE campaign.resource_name = '${r}' AND campaign_criterion.type = 'LOCATION' AND campaign_criterion.negative = FALSE`, built.expected.locations);
  return { ok: mismatches.length === 0, status, mismatches, counts };
}

/** A campaign with this exact name that is not removed, found after an ambiguous (timed out) mutate. */
async function findCampaignByName(customer: LaunchCustomer, name: string) {
  const rows = await customer.query(
    `SELECT campaign.resource_name, campaign.campaign_budget FROM campaign WHERE campaign.name = '${escapeGaql(name)}' AND campaign.status != 'REMOVED' LIMIT 2`
  );
  if (rows.length !== 1) return null;
  const campaign = get(rows[0], 'campaign.resource_name');
  const budget = get(rows[0], 'campaign.campaign_budget');
  return typeof campaign === 'string' && typeof budget === 'string' ? { campaign, budget } : null;
}

export class LaunchBlockedError extends Error {
  constructor(readonly code: 'merchant_missing' | 'readback_failed', message: string) {
    super(message);
  }
}

/** Reads and builds the batch, then asks Google to validate it. Writes nothing. */
export async function validateLaunchOnly(plan: LaunchPlan, customer: LaunchCustomer, customerId: string, deps: Pick<LaunchDeps, 'nonce'>) {
  const preflight = await readLaunchPreflight(plan, customer);
  if (plan.type === 'SHOPPING' && !preflight.merchantId) {
    throw new LaunchBlockedError('merchant_missing', 'No Merchant Center account is linked to this Google Ads account.');
  }
  const built = buildLaunchOperations(plan, {
    customerId,
    campaignName: preflight.campaignName,
    budgetName: `${preflight.campaignName} | ميزانية ${deps.nonce()}`,
    merchantId: preflight.merchantId,
    locationSyncAssetSet: preflight.locationSyncAssetSet,
    existingSharedSet: preflight.existingSharedSet,
    reusableAssets: preflight.reusableAssets,
  });
  await customer.mutateOperations(built.operations, { validateOnly: true });
  return { validate_only: 'passed' as const, operations: built.operations.length, campaign_name: preflight.campaignName };
}

/**
 * Runs the whole launch. Throws before any live write if the batch is invalid.
 * An error thrown by the live mutate is rethrown as is (the caller decides
 * between "failed" and "unverified" with isAmbiguousGoogleAdsMutationError),
 * except that a timed-out call is reconciled by looking for the campaign by name.
 */
export async function executeLaunch(
  plan: LaunchPlan,
  customer: LaunchCustomer,
  customerId: string,
  deps: LaunchDeps
): Promise<LaunchExecution> {
  const preflight = await readLaunchPreflight(plan, customer);
  if (plan.type === 'SHOPPING' && !preflight.merchantId) {
    throw new LaunchBlockedError('merchant_missing', 'No Merchant Center account is linked to this Google Ads account.');
  }
  const nonce = deps.nonce();
  const built = buildLaunchOperations(plan, {
    customerId,
    campaignName: preflight.campaignName,
    budgetName: `${preflight.campaignName} | ميزانية ${nonce}`,
    merchantId: preflight.merchantId,
    locationSyncAssetSet: preflight.locationSyncAssetSet,
    existingSharedSet: preflight.existingSharedSet,
    reusableAssets: preflight.reusableAssets,
  });

  await customer.mutateOperations(built.operations, { validateOnly: true });

  let result: any;
  let reconciled = false;
  let rollback: LaunchRollbackPayload;
  try {
    result = await customer.mutateOperations(built.operations);
    rollback = rollbackFrom(built, resourceNamesFromMutate(result, built.operations.length), customerId);
  } catch (error) {
    if (!deps.isAmbiguous(error)) throw error;
    // The request may have been committed after our deadline. Look for it before reporting an unknown.
    const found = await findCampaignByName(customer, preflight.campaignName).catch(() => null);
    if (!found) throw error;
    reconciled = true;
    const link = await safeQuery(
      customer,
      `SELECT campaign_shared_set.resource_name FROM campaign_shared_set WHERE campaign.resource_name = '${escapeGaql(found.campaign)}' AND campaign_shared_set.status = 'ENABLED' LIMIT 1`
    );
    const linkName = link[0] ? get(link[0], 'campaign_shared_set.resource_name') : null;
    const prefix = `customers/${customerId.replace(/\D/g, '')}/`;
    const ordered = [typeof linkName === 'string' ? linkName : null, found.campaign, found.budget].filter(
      (n): n is string => Boolean(n) && (n as string).startsWith(prefix)
    );
    rollback = {
      reversible: true,
      action_type: LAUNCH_ROLLBACK_ACTION,
      campaign_resource: found.campaign,
      budget_resource: found.budget,
      campaign_shared_set_resource: typeof linkName === 'string' ? linkName : null,
      // A reconciled launch cannot tell whether the shared list was created by it, so the list is left in place.
      shared_set_resource: null,
      resource_names: ordered,
      retained_asset_resources: [],
    };
  }

  // From here the campaign exists. Nothing below may throw: a failed check is
  // reported in `readback`, never as a failed launch (that would invite a second build).
  let readback: LaunchReadback;
  try {
    readback = await readbackLaunch(customer, rollback.campaign_resource, built, plan);
  } catch {
    readback = { ok: false, status: null, mismatches: ['readback_failed'], counts: {} };
  }
  if (readback.status && readback.status !== 'PAUSED') {
    // The plan says PAUSED. If Google reports anything else, stop it now rather than leave it spending.
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
    location: preflight.locationInherited ? 'inherited' : preflight.locationSyncAssetSet ? 'linked' : 'none',
  };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

const RES = /^customers\/\d+\/(campaigns|campaignBudgets|campaignSharedSets|sharedSets)\/[\d~]+$/;

/**
 * Removes everything the launch created: the campaign (its ad groups, ads,
 * keywords, criteria and asset links go with it), the budget, the link to the
 * shared negative list and the list itself when this launch created it.
 * One atomic batch. Refuses while the campaign is ENABLED: stop it first, so an
 * undo can never switch off a campaign that is already spending.
 */
export async function executeLaunchRollback(
  rollback: Record<string, any>,
  customer: LaunchCustomer,
  options?: { validateOnly?: boolean }
) {
  const campaign = String(rollback.campaign_resource ?? '');
  const budget = String(rollback.budget_resource ?? '');
  const link = rollback.campaign_shared_set_resource ? String(rollback.campaign_shared_set_resource) : null;
  const sharedSet = rollback.shared_set_resource ? String(rollback.shared_set_resource) : null;
  const all = [campaign, budget, link, sharedSet].filter((v): v is string => Boolean(v));
  if (!campaign || !budget || !all.every((v) => RES.test(v))) throw new Error('Launch rollback descriptor is malformed.');
  const customerPrefix = campaign.split('/').slice(0, 2).join('/');
  if (!all.every((v) => v.startsWith(`${customerPrefix}/`))) throw new Error('Launch rollback spans more than one account.');

  const rows = await customer.query(
    `SELECT campaign.status FROM campaign WHERE campaign.resource_name = '${escapeGaql(campaign)}' LIMIT 1`
  );
  const status = rows[0] ? String(get(rows[0], 'campaign.status') ?? '') : null;
  if (status === 'ENABLED') throw new Error('The campaign is enabled. Pause it before undoing the launch.');

  const operations: unknown[] = [];
  if (status !== 'REMOVED') {
    if (link) operations.push({ campaign_shared_set_operation: { remove: link } });
    operations.push({ campaign_operation: { remove: campaign } });
  }
  operations.push({ campaign_budget_operation: { remove: budget } });
  if (sharedSet) operations.push({ shared_set_operation: { remove: sharedSet } });
  return customer.mutateOperations(operations, options);
}

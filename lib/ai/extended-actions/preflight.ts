import type { OptimizerAction } from '../optimizer-agent';
import type { MeasurementDescriptor } from '../execution-preflight';
import {
  APPLY_SUPPORTED_RECOMMENDATION_TYPES,
  MAX_ATTACH_CAMPAIGNS,
  SHARED_LIST_ACCOUNT_LIMIT,
  SHARED_LIST_MEMBER_LIMIT,
  SMART_BIDDING_STRATEGIES,
  type ExtendedOperation,
} from './types';
import { planAdSchedule, scheduleCriteriaFromRows } from './schedule';
import type { SharedKeyword } from './validate';
import { isAdsStudioOperation } from '../../ads/studio/types';
import { prepareAdsStudioAction } from '../../ads/studio/preflight';
import { isAdsStudioActive } from '../../ads/flag';
import { isStructureOperation } from '../../structure/types';
import { prepareStructureAction } from '../../structure/preflight';

/**
 * Pre-execution reads for the extended actions. Everything the live mutate
 * needs (resource names of criteria to update or remove, previous values for
 * rollback, conflict-free keyword lists) is read from the account HERE, stored
 * in `params.resolved`, and the executor sends exactly that. A payload coming
 * from a stored recommendation never carries `resolved`: validateExtendedPayload
 * builds params from a whitelist, so only this function can produce it.
 */

export class ExtendedPreflightError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ExtendedPreflightError';
  }
}

const refuse = (code: string, message: string): never => {
  throw new ExtendedPreflightError(code, message);
};

/** Functions owned by execution-preflight.ts, injected to avoid an import cycle. */
export type PreflightDeps = {
  filterNegativeKeywordBatch(
    customer: any,
    campaignResource: string,
    matchType: string,
    candidates: string[]
  ): Promise<{ keep: string[]; dropped: Array<{ text: string; reason: string }> }>;
  readSevenDayMetrics(
    customer: any,
    fromClause: string,
    whereField: string,
    resourceName: string
  ): Promise<{ cost: number; clicks: number; conversions: number; conversion_value: number } | null>;
  normalizeKeywordText(value: string): string;
};

export type ExtendedPrepared = {
  action: OptimizerAction;
  rollbackPayload: Record<string, unknown>;
  measurement: MeasurementDescriptor | null;
};

function esc(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** camelCase (REST) or snake_case (older paths), first one present. */
function f(object: any, camel: string, snake: string): any {
  if (!object || typeof object !== 'object') return undefined;
  return object[camel] !== undefined ? object[camel] : object[snake];
}

export type CampaignState = {
  resource: string;
  status: string;
  channel: string;
  bidding: string;
  positiveGeoTargetType: string;
  searchNetwork: boolean | null;
  contentNetwork: boolean | null;
};

export async function readCampaignState(customer: any, resource: string): Promise<CampaignState> {
  const rows = await customer.query(`
    SELECT campaign.resource_name, campaign.status, campaign.advertising_channel_type,
      campaign.bidding_strategy_type, campaign.geo_target_type_setting.positive_geo_target_type,
      campaign.network_settings.target_search_network, campaign.network_settings.target_content_network
    FROM campaign
    WHERE campaign.resource_name = '${esc(resource)}'
    LIMIT 1
  `);
  const campaign = rows?.[0]?.campaign;
  if (!campaign) return refuse('campaign_not_found', 'Unable to read the campaign before execution');
  const geo = f(campaign, 'geoTargetTypeSetting', 'geo_target_type_setting');
  const network = f(campaign, 'networkSettings', 'network_settings');
  const state: CampaignState = {
    resource,
    status: String(campaign.status ?? ''),
    channel: String(f(campaign, 'advertisingChannelType', 'advertising_channel_type') ?? ''),
    bidding: String(f(campaign, 'biddingStrategyType', 'bidding_strategy_type') ?? ''),
    positiveGeoTargetType: String(f(geo, 'positiveGeoTargetType', 'positive_geo_target_type') ?? ''),
    searchNetwork: boolOrNull(f(network, 'targetSearchNetwork', 'target_search_network')),
    contentNetwork: boolOrNull(f(network, 'targetContentNetwork', 'target_content_network')),
  };
  if (state.status === 'REMOVED') refuse('campaign_removed', 'Campaign is removed');
  return state;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function metricsMeasurement(
  deps: PreflightDeps,
  customer: any,
  campaignResource: string | null,
  capturedAt: string
): Promise<MeasurementDescriptor | null> {
  if (!campaignResource) return Promise.resolve(null);
  return deps
    .readSevenDayMetrics(customer, 'campaign', 'campaign.resource_name', campaignResource)
    .then((before) => ({
      level: 'campaign' as const,
      resource: campaignResource,
      window_days: 7,
      before,
      captured_at: capturedAt,
    }));
}

function withResolved(action: OptimizerAction, resolved: Record<string, unknown>): OptimizerAction {
  return { ...action, params: { ...action.params, resolved } };
}

function uniq(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export async function prepareExtendedAction(
  action: OptimizerAction,
  customer: any,
  deps: PreflightDeps
): Promise<ExtendedPrepared> {
  const capturedAt = new Date().toISOString();
  const params = action.params as Record<string, any>;
  const operation = action.type as ExtendedOperation;

  if (isAdsStudioOperation(operation)) {
    if (!isAdsStudioActive()) refuse('ads_studio_disabled', 'Ad assets actions are disabled');
    return prepareAdsStudioAction(action, customer, deps);
  }

  if (isStructureOperation(operation)) return prepareStructureAction(action, customer, deps);

  switch (operation) {
    case 'set_ad_schedule': {
      const campaign = await readCampaignState(customer, params.campaign_resource);
      const slots = params.slots as Array<{ bid_modifier: number }>;
      if (SMART_BIDDING_STRATEGIES.has(campaign.bidding) && slots.some((s) => s.bid_modifier !== 1)) {
        refuse('smart_bidding_ignores_modifier', `${campaign.bidding} ignores ad schedule bid modifiers`);
      }
      const rows = await customer.query(`
        SELECT campaign_criterion.resource_name, campaign_criterion.bid_modifier,
          campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour,
          campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour,
          campaign_criterion.ad_schedule.end_minute
        FROM campaign_criterion
        WHERE campaign_criterion.campaign = '${esc(params.campaign_resource)}'
          AND campaign_criterion.type = 'AD_SCHEDULE'
          AND campaign_criterion.status != 'REMOVED'
      `);
      const existing = scheduleCriteriaFromRows(rows);
      if (!existing) return refuse('schedule_unreadable', 'An existing ad schedule window could not be read');
      const planned = planAdSchedule(existing, params.slots, params.restrict_to_slots === true);
      if (!planned.ok) return refuse(planned.code, 'Ad schedule plan is not applicable');
      const { plan } = planned;

      // Operation order is removes, updates, creates (see buildMutateOperations);
      // created criteria are the tail of the results, so rollback can find them by index.
      const createdFrom = plan.removes.length + plan.updates.length;
      const resolved = {
        campaign: params.campaign_resource,
        creates: plan.creates,
        updates: plan.updates,
        removes: plan.removes,
        coverage_minutes: plan.coverage_minutes,
        had_schedule: existing.length > 0,
      };
      return {
        action: withResolved(action, resolved),
        rollbackPayload: {
          reversible: true,
          action_type: 'ext_restore_campaign_criteria',
          campaign_resource: params.campaign_resource,
          restore_modifiers: plan.updates.map((u) => ({ resource_name: u.resource_name, bid_modifier: u.previous_modifier })),
          recreate: plan.removes.map((r) => ({
            campaign: params.campaign_resource,
            kind: 'ad_schedule',
            spec: {
              day_of_week: r.day_of_week,
              start_hour: r.start_hour,
              start_minute: r.start_minute,
              end_hour: r.end_hour,
              end_minute: r.end_minute,
            },
            bid_modifier: r.bid_modifier,
          })),
          created_result_indexes: plan.creates.map((_, i) => createdFrom + i),
          touched_resources: uniq([
            params.campaign_resource,
            ...plan.updates.map((u) => u.resource_name),
            ...plan.removes.map((r) => r.resource_name),
          ]),
        },
        measurement: await metricsMeasurement(deps, customer, params.campaign_resource, capturedAt),
      };
    }

    case 'set_device_bid_modifier': {
      const campaign = await readCampaignState(customer, params.campaign_resource);
      if (SMART_BIDDING_STRATEGIES.has(campaign.bidding) && params.bid_modifier !== 0) {
        refuse('smart_bidding_ignores_modifier', `${campaign.bidding} ignores device bid modifiers (only opt-out works)`);
      }
      const rows = await customer.query(`
        SELECT campaign_criterion.resource_name, campaign_criterion.bid_modifier, campaign_criterion.device.type
        FROM campaign_criterion
        WHERE campaign_criterion.campaign = '${esc(params.campaign_resource)}'
          AND campaign_criterion.type = 'DEVICE'
          AND campaign_criterion.status != 'REMOVED'
      `);
      const devices = (rows ?? []).map((row: any) => {
        const criterion = row?.campaignCriterion ?? row?.campaign_criterion;
        return {
          resource_name: String(f(criterion, 'resourceName', 'resource_name') ?? ''),
          device: String(criterion?.device?.type ?? ''),
          bid_modifier: Number(f(criterion, 'bidModifier', 'bid_modifier') ?? 1),
        };
      });
      const mine = devices.find((d: any) => d.device === params.device);
      const othersOptedOut = devices.filter((d: any) => d.device !== params.device && d.bid_modifier === 0).length;
      if (params.bid_modifier === 0 && othersOptedOut >= 2) {
        refuse('all_devices_excluded', 'Excluding this device would leave no device that can serve');
      }
      const previous = mine ? Math.round(mine.bid_modifier * 100) / 100 : null;
      if (previous !== null && previous === params.bid_modifier) refuse('no_change', 'Device already has this modifier');
      const resolved = {
        campaign: params.campaign_resource,
        mode: mine ? 'update' : 'create',
        resource_name: mine?.resource_name ?? null,
        previous_modifier: previous,
      };
      return {
        action: withResolved(action, resolved),
        rollbackPayload: mine
          ? {
              reversible: true,
              action_type: 'ext_restore_campaign_criteria',
              campaign_resource: params.campaign_resource,
              restore_modifiers: [{ resource_name: mine.resource_name, bid_modifier: previous }],
              recreate: [],
              created_result_indexes: [],
              touched_resources: [params.campaign_resource, mine.resource_name],
            }
          : {
              reversible: true,
              action_type: 'ext_restore_campaign_criteria',
              campaign_resource: params.campaign_resource,
              restore_modifiers: [],
              recreate: [],
              created_result_indexes: [0],
              touched_resources: [params.campaign_resource],
            },
        measurement: await metricsMeasurement(deps, customer, params.campaign_resource, capturedAt),
      };
    }

    case 'exclude_location':
    case 'set_location_bid_modifier': {
      const campaign = await readCampaignState(customer, params.campaign_resource);
      if (
        operation === 'set_location_bid_modifier' &&
        SMART_BIDDING_STRATEGIES.has(campaign.bidding)
      ) {
        refuse('smart_bidding_ignores_modifier', `${campaign.bidding} ignores location bid modifiers`);
      }
      const rows = await customer.query(`
        SELECT campaign_criterion.resource_name, campaign_criterion.negative, campaign_criterion.bid_modifier,
          campaign_criterion.location.geo_target_constant
        FROM campaign_criterion
        WHERE campaign_criterion.campaign = '${esc(params.campaign_resource)}'
          AND campaign_criterion.type = 'LOCATION'
          AND campaign_criterion.status != 'REMOVED'
      `);
      const same = (rows ?? [])
        .map((row: any) => {
          const criterion = row?.campaignCriterion ?? row?.campaign_criterion;
          return {
            resource_name: String(f(criterion, 'resourceName', 'resource_name') ?? ''),
            negative: criterion?.negative === true,
            bid_modifier: Math.round(Number(f(criterion, 'bidModifier', 'bid_modifier') ?? 1) * 100) / 100,
            geo: String(f(criterion?.location, 'geoTargetConstant', 'geo_target_constant') ?? ''),
          };
        })
        .filter((c: any) => c.geo === params.geo_target_constant);

      if (operation === 'exclude_location') {
        if (same.some((c: any) => c.negative)) refuse('already_excluded', 'Location is already excluded');
        if (same.some((c: any) => !c.negative)) {
          refuse('location_is_targeted', 'The campaign targets this location; remove the target before excluding it');
        }
        return {
          action: withResolved(action, { campaign: params.campaign_resource }),
          rollbackPayload: {
            reversible: true,
            action_type: 'ext_restore_campaign_criteria',
            campaign_resource: params.campaign_resource,
            restore_modifiers: [],
            recreate: [],
            created_result_indexes: [0],
            touched_resources: [params.campaign_resource],
          },
          measurement: await metricsMeasurement(deps, customer, params.campaign_resource, capturedAt),
        };
      }

      // A modifier needs a location the campaign already targets. Creating a
      // positive location here would narrow a campaign that targets everywhere.
      const targeted = same.find((c: any) => !c.negative);
      if (!targeted) refuse('location_not_targeted', 'The campaign does not target this location');
      if (targeted!.bid_modifier === params.bid_modifier) refuse('no_change', 'Location already has this modifier');
      return {
        action: withResolved(action, {
          campaign: params.campaign_resource,
          resource_name: targeted!.resource_name,
          previous_modifier: targeted!.bid_modifier,
        }),
        rollbackPayload: {
          reversible: true,
          action_type: 'ext_restore_campaign_criteria',
          campaign_resource: params.campaign_resource,
          restore_modifiers: [{ resource_name: targeted!.resource_name, bid_modifier: targeted!.bid_modifier }],
          recreate: [],
          created_result_indexes: [],
          touched_resources: [params.campaign_resource, targeted!.resource_name],
        },
        measurement: await metricsMeasurement(deps, customer, params.campaign_resource, capturedAt),
      };
    }

    case 'set_geo_target_type': {
      const campaign = await readCampaignState(customer, params.campaign_resource);
      if (!['PRESENCE', 'PRESENCE_OR_INTEREST', 'SEARCH_INTEREST'].includes(campaign.positiveGeoTargetType)) {
        refuse('geo_type_unreadable', 'Current geo target type could not be read');
      }
      if (campaign.positiveGeoTargetType === params.positive_geo_target_type) {
        refuse('no_change', 'Campaign already uses this geo target type');
      }
      return {
        action: withResolved(action, { campaign: params.campaign_resource, previous: campaign.positiveGeoTargetType }),
        rollbackPayload: {
          reversible: true,
          action_type: 'ext_restore_campaign_fields',
          campaign_resource: params.campaign_resource,
          fields: { 'geo_target_type_setting.positive_geo_target_type': campaign.positiveGeoTargetType },
          touched_resources: [params.campaign_resource],
        },
        measurement: await metricsMeasurement(deps, customer, params.campaign_resource, capturedAt),
      };
    }

    case 'set_network_settings': {
      const campaign = await readCampaignState(customer, params.campaign_resource);
      if (campaign.channel !== 'SEARCH') {
        refuse('network_search_only', `Network switches are only changed on Search campaigns (this one is ${campaign.channel || 'unknown'})`);
      }
      const changes: Record<string, boolean> = {};
      const previous: Record<string, boolean> = {};
      if (params.target_search_network === false && campaign.searchNetwork === true) {
        changes['network_settings.target_search_network'] = false;
        previous['network_settings.target_search_network'] = true;
      }
      if (params.target_content_network === false && campaign.contentNetwork === true) {
        changes['network_settings.target_content_network'] = false;
        previous['network_settings.target_content_network'] = true;
      }
      if (Object.keys(changes).length === 0) refuse('no_change', 'The requested networks are already off');
      return {
        action: withResolved(action, { campaign: params.campaign_resource, changes, previous }),
        rollbackPayload: {
          reversible: true,
          action_type: 'ext_restore_campaign_fields',
          campaign_resource: params.campaign_resource,
          fields: previous,
          touched_resources: [params.campaign_resource],
        },
        measurement: await metricsMeasurement(deps, customer, params.campaign_resource, capturedAt),
      };
    }

    case 'create_shared_negative_list': {
      const lists = await readNegativeLists(customer);
      if (lists.length >= SHARED_LIST_ACCOUNT_LIMIT) {
        refuse('list_limit', `The account already has ${lists.length} negative keyword lists`);
      }
      const wanted = deps.normalizeKeywordText(params.name);
      if (lists.some((l: { name: string }) => deps.normalizeKeywordText(l.name) === wanted)) {
        refuse('list_name_taken', 'A negative keyword list with this name already exists');
      }
      const campaigns = params.campaign_resources as string[];
      await assertAttachable(customer, campaigns);
      const { keep, dropped } = await conflictFree(customer, deps, campaigns, params.keywords as SharedKeyword[]);
      if (keep.length === 0) refuse('all_dropped', droppedMessage(dropped));
      const resolved = { name: params.name, keywords: keep, dropped, campaigns };
      const criteriaFrom = 1;
      const attachFrom = criteriaFrom + keep.length;
      return {
        action: withResolved(action, resolved),
        rollbackPayload: {
          reversible: true,
          action_type: 'ext_shared_list_rollback',
          result_groups: {
            shared_sets: [0],
            shared_criteria: keep.map((_, i) => criteriaFrom + i),
            campaign_shared_sets: campaigns.map((_, i) => attachFrom + i),
          },
          touched_resources: uniq(campaigns),
        },
        measurement: await metricsMeasurement(deps, customer, campaigns[0] ?? null, capturedAt),
      };
    }

    case 'add_shared_negative_keywords': {
      const list = await readNegativeList(customer, params.shared_set_resource);
      const members = await readListMembers(customer, params.shared_set_resource);
      const attached = await readAttachedCampaigns(customer, params.shared_set_resource);
      if (attached.length > MAX_ATTACH_CAMPAIGNS * 2) {
        refuse('too_many_campaigns', 'Too many attached campaigns to verify conflicts against');
      }
      const have = new Set(members.map((m) => `${m.match_type}|${deps.normalizeKeywordText(m.text)}`));
      const fresh = (params.keywords as SharedKeyword[]).filter(
        (k) => !have.has(`${k.match_type}|${deps.normalizeKeywordText(k.text)}`)
      );
      const alreadyIn = (params.keywords as SharedKeyword[]).length - fresh.length;
      if (members.length + fresh.length > SHARED_LIST_MEMBER_LIMIT) {
        refuse('member_limit', `The list would exceed ${SHARED_LIST_MEMBER_LIMIT} keywords`);
      }
      const { keep, dropped } = await conflictFree(customer, deps, attached, fresh);
      if (alreadyIn > 0) {
        for (const k of params.keywords as SharedKeyword[]) {
          if (have.has(`${k.match_type}|${deps.normalizeKeywordText(k.text)}`)) dropped.push({ text: k.text, reason: 'already_in_list' });
        }
      }
      if (keep.length === 0) refuse('all_dropped', droppedMessage(dropped));
      return {
        action: withResolved(action, { shared_set: params.shared_set_resource, list_name: list.name, keywords: keep, dropped, campaigns: attached }),
        rollbackPayload: {
          reversible: true,
          action_type: 'ext_shared_list_rollback',
          result_groups: { shared_sets: [], shared_criteria: keep.map((_, i) => i), campaign_shared_sets: [] },
          touched_resources: [params.shared_set_resource],
        },
        measurement: await metricsMeasurement(deps, customer, attached[0] ?? null, capturedAt),
      };
    }

    case 'attach_shared_negative_list': {
      const list = await readNegativeList(customer, params.shared_set_resource);
      const campaigns = params.campaign_resources as string[];
      const attached = await readAttachedCampaigns(customer, params.shared_set_resource);
      const already = campaigns.filter((c) => attached.includes(c));
      if (already.length > 0) refuse('already_attached', 'The list is already attached to one of the campaigns');
      await assertAttachable(customer, campaigns);
      const members = await readListMembers(customer, params.shared_set_resource);
      if (members.length === 0) refuse('list_empty', 'The list has no keywords');
      // The list is shared, so a conflicting entry cannot be dropped for one campaign only.
      const { dropped } = await conflictFree(customer, deps, campaigns, members);
      const blocking = dropped.filter((d) => d.reason !== 'already_negative');
      if (blocking.length > 0) refuse('list_conflicts', droppedMessage(blocking));
      return {
        action: withResolved(action, { shared_set: params.shared_set_resource, list_name: list.name, campaigns }),
        rollbackPayload: {
          reversible: true,
          action_type: 'ext_shared_list_rollback',
          result_groups: { shared_sets: [], shared_criteria: [], campaign_shared_sets: campaigns.map((_, i) => i) },
          touched_resources: uniq([params.shared_set_resource, ...campaigns]),
        },
        measurement: await metricsMeasurement(deps, customer, campaigns[0] ?? null, capturedAt),
      };
    }

    case 'apply_google_recommendation': {
      const rec = await readRecommendationForApply(customer, params.recommendation_resource);
      if (rec.dismissed) refuse('recommendation_dismissed', 'The recommendation was dismissed');
      if (rec.type !== params.recommendation_type) refuse('recommendation_changed', 'The recommendation type changed');
      if (!(APPLY_SUPPORTED_RECOMMENDATION_TYPES as readonly string[]).includes(rec.type)) {
        refuse('recommendation_not_appliable', 'This recommendation type is not applied by the platform');
      }
      if (rec.assets.length === 0) refuse('no_recommended_assets', 'The recommendation carries no campaign-level assets');
      const key = rec.type === 'SITELINK_ASSET' ? 'sitelink_asset' : 'callout_asset';
      const resolved = {
        campaign: rec.campaign,
        apply_operation: {
          resource_name: params.recommendation_resource,
          [key]: { ad_asset_apply_parameters: { new_assets: rec.assets, scope: 'CAMPAIGN' } },
        },
        assets_preview: rec.assets.map(assetPreview),
      };
      return {
        action: withResolved(action, resolved),
        // Apply creates assets whose names Google does not return here; removing them is done in Google Ads.
        rollbackPayload: { reversible: false, action_type: 'none', note: 'google_recommendation_apply_not_reversible' },
        measurement: await metricsMeasurement(deps, customer, rec.campaign, capturedAt),
      };
    }

    case 'dismiss_google_recommendation': {
      const rec = await readRecommendationForApply(customer, params.recommendation_resource, false);
      if (rec.dismissed) refuse('recommendation_dismissed', 'The recommendation was already dismissed');
      if (rec.type !== params.recommendation_type) refuse('recommendation_changed', 'The recommendation type changed');
      return {
        action: withResolved(action, { campaign: rec.campaign }),
        // Google has no un-dismiss call: the card disappears from Google Ads and may be re-generated later.
        rollbackPayload: { reversible: false, action_type: 'none', note: 'google_recommendation_dismiss_not_reversible' },
        measurement: null,
      };
    }

    case 'pause_auto_apply': {
      const subs = await readSubscriptions(customer);
      const wanted = params.subscription_resources as string[];
      const targets = subs.filter((s: { resource_name: string; status: string }) => wanted.includes(s.resource_name) && s.status === 'ENABLED');
      if (targets.length === 0) refuse('no_change', 'No selected auto-apply subscription is enabled');
      return {
        action: withResolved(action, { subscriptions: targets }),
        rollbackPayload: {
          reversible: true,
          action_type: 'ext_restore_subscriptions',
          subscriptions: targets.map((s: { resource_name: string }) => ({ resource_name: s.resource_name, status: 'ENABLED' })),
          touched_resources: targets.map((s: { resource_name: string }) => s.resource_name),
        },
        measurement: null,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readNegativeLists(customer: any) {
  const rows = await customer.query(`
    SELECT shared_set.resource_name, shared_set.name, shared_set.member_count, shared_set.reference_count
    FROM shared_set
    WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'
  `);
  return (rows ?? []).map((row: any) => {
    const set = row?.sharedSet ?? row?.shared_set;
    return {
      resource_name: String(f(set, 'resourceName', 'resource_name') ?? ''),
      name: String(set?.name ?? ''),
      member_count: Number(f(set, 'memberCount', 'member_count') ?? 0),
      reference_count: Number(f(set, 'referenceCount', 'reference_count') ?? 0),
    };
  });
}

async function readNegativeList(customer: any, resource: string) {
  const list = (await readNegativeLists(customer)).find((l: any) => l.resource_name === resource);
  if (!list) return refuse('list_not_found', 'The negative keyword list is missing or not enabled');
  return list;
}

async function readListMembers(customer: any, sharedSet: string): Promise<SharedKeyword[]> {
  const rows = await customer.query(`
    SELECT shared_criterion.resource_name, shared_criterion.keyword.text, shared_criterion.keyword.match_type
    FROM shared_criterion
    WHERE shared_set.resource_name = '${esc(sharedSet)}' AND shared_criterion.type = 'KEYWORD'
  `);
  const out: SharedKeyword[] = [];
  for (const row of rows ?? []) {
    const keyword = (row?.sharedCriterion ?? row?.shared_criterion)?.keyword;
    const text = typeof keyword?.text === 'string' ? keyword.text : '';
    const matchType = String(f(keyword, 'matchType', 'match_type') ?? '');
    if (text) out.push({ text, match_type: (matchType === 'EXACT' ? 'EXACT' : 'PHRASE') as SharedKeyword['match_type'] });
  }
  return out;
}

async function readAttachedCampaigns(customer: any, sharedSet: string): Promise<string[]> {
  const rows = await customer.query(`
    SELECT campaign_shared_set.campaign
    FROM campaign_shared_set
    WHERE campaign_shared_set.shared_set = '${esc(sharedSet)}' AND campaign_shared_set.status = 'ENABLED'
  `);
  return (rows ?? [])
    .map((row: any) => (row?.campaignSharedSet ?? row?.campaign_shared_set)?.campaign)
    .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0);
}

async function assertAttachable(customer: any, campaigns: string[]) {
  for (const campaign of campaigns) {
    const state = await readCampaignState(customer, campaign);
    // Negative keyword lists attach to Search and Shopping campaigns; Performance Max takes account-level negatives.
    if (!['SEARCH', 'SHOPPING'].includes(state.channel)) {
      refuse('campaign_type_unsupported', `A negative keyword list cannot be attached to a ${state.channel || 'unknown'} campaign`);
    }
  }
}

/**
 * Candidates minus every one that would block a converting search term or an
 * enabled keyword of ANY campaign the list applies to. Reuses the exact
 * conflict logic of the campaign-level batch (filterNegativeKeywordBatch).
 */
async function conflictFree(
  customer: any,
  deps: PreflightDeps,
  campaigns: string[],
  candidates: SharedKeyword[]
): Promise<{ keep: SharedKeyword[]; dropped: Array<{ text: string; reason: string }> }> {
  const drop = new Map<string, string>();
  for (const campaign of campaigns) {
    for (const matchType of ['EXACT', 'PHRASE'] as const) {
      const group = candidates.filter((c) => c.match_type === matchType);
      if (group.length === 0) continue;
      const result = await deps.filterNegativeKeywordBatch(customer, campaign, matchType, group.map((g) => g.text));
      for (const d of result.dropped) {
        if (d.reason === 'blocks_converting_search_term' || d.reason === 'blocks_enabled_keyword') {
          drop.set(`${matchType}|${d.text}`, d.reason);
        }
      }
    }
  }
  const keep = candidates.filter((c) => !drop.has(`${c.match_type}|${c.text}`));
  const dropped = candidates
    .filter((c) => drop.has(`${c.match_type}|${c.text}`))
    .map((c) => ({ text: c.text, reason: drop.get(`${c.match_type}|${c.text}`) as string }));
  return { keep, dropped };
}

function droppedMessage(dropped: Array<{ text: string; reason: string }>) {
  return dropped
    .slice(0, 5)
    .map((d) => `${d.text}: ${d.reason}`)
    .join('; ');
}

async function readRecommendationForApply(customer: any, resource: string, withAssets = true) {
  const rows = await customer.query(`
    SELECT recommendation.resource_name, recommendation.type, recommendation.dismissed, recommendation.campaign
    ${
      withAssets
        ? ', recommendation.sitelink_asset_recommendation.recommended_campaign_sitelink_assets, recommendation.callout_asset_recommendation.recommended_campaign_callout_assets'
        : ''
    }
    FROM recommendation
    WHERE recommendation.resource_name = '${esc(resource)}'
    LIMIT 1
  `);
  const rec = rows?.[0]?.recommendation;
  if (!rec) return refuse('recommendation_not_found', 'The recommendation no longer exists');
  const type = String(rec.type ?? '');
  const sitelinks = f(f(rec, 'sitelinkAssetRecommendation', 'sitelink_asset_recommendation'), 'recommendedCampaignSitelinkAssets', 'recommended_campaign_sitelink_assets');
  const callouts = f(f(rec, 'calloutAssetRecommendation', 'callout_asset_recommendation'), 'recommendedCampaignCalloutAssets', 'recommended_campaign_callout_assets');
  const raw = type === 'SITELINK_ASSET' ? sitelinks : type === 'CALLOUT_ASSET' ? callouts : [];
  return {
    type,
    dismissed: rec.dismissed === true,
    campaign: typeof rec.campaign === 'string' ? rec.campaign : null,
    assets: cleanRecommendedAssets(type, raw),
  };
}

/** Keep only the creation fields of an Asset; everything else on the read row is output-only noise. */
export function cleanRecommendedAssets(type: string, raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const asset of raw.slice(0, 10)) {
    if (!asset || typeof asset !== 'object') continue;
    if (type === 'SITELINK_ASSET') {
      const sitelink = f(asset, 'sitelinkAsset', 'sitelink_asset');
      const linkText = f(sitelink, 'linkText', 'link_text');
      const urls = f(asset, 'finalUrls', 'final_urls');
      if (typeof linkText !== 'string' || !Array.isArray(urls) || urls.length === 0) continue;
      out.push({
        sitelink_asset: {
          link_text: linkText,
          ...(typeof sitelink.description1 === 'string' ? { description1: sitelink.description1 } : {}),
          ...(typeof sitelink.description2 === 'string' ? { description2: sitelink.description2 } : {}),
        },
        final_urls: urls.filter((u: unknown) => typeof u === 'string'),
      });
    } else if (type === 'CALLOUT_ASSET') {
      const callout = f(asset, 'calloutAsset', 'callout_asset');
      const text = f(callout, 'calloutText', 'callout_text');
      if (typeof text !== 'string' || !text.trim()) continue;
      out.push({ callout_asset: { callout_text: text } });
    }
  }
  return out;
}

function assetPreview(asset: Record<string, any>): string {
  if (asset.sitelink_asset) return String(asset.sitelink_asset.link_text ?? '');
  if (asset.callout_asset) return String(asset.callout_asset.callout_text ?? '');
  return '';
}

export async function readSubscriptions(customer: any) {
  const rows = await customer.query(`
    SELECT recommendation_subscription.resource_name, recommendation_subscription.type, recommendation_subscription.status
    FROM recommendation_subscription
  `);
  return (rows ?? []).map((row: any) => {
    const sub = row?.recommendationSubscription ?? row?.recommendation_subscription;
    return {
      resource_name: String(f(sub, 'resourceName', 'resource_name') ?? ''),
      type: String(sub?.type ?? ''),
      status: String(sub?.status ?? ''),
    };
  });
}

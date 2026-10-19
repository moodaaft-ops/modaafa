import type { OptimizerAction } from '../optimizer-agent';
import { readCampaignState, readNegativeLists, readSubscriptions } from './preflight';
import { scheduleCriteriaFromRows } from './schedule';
import { slotMinutes } from './validate';
import { isAdsStudioOperation } from '../../ads/studio/types';
import { isStructureOperation } from '../../structure/types';
import { readbackStructureAction } from '../../structure/readback';
import { readbackAdsStudioAction } from '../../ads/studio/readback';

/**
 * Read the account back after a live mutate and say whether the change is
 * really there. A mismatch does not undo anything (the mutate was accepted by
 * Google); it is recorded next to the result so the merchant and the ops alert
 * see it. Any read failure is `unavailable`, never an error: the change is
 * already applied and recorded.
 */

export type ReadbackResult = {
  status: 'verified' | 'mismatch' | 'unavailable';
  detail?: string;
};

const ok = (): ReadbackResult => ({ status: 'verified' });
const mismatch = (detail: string): ReadbackResult => ({ status: 'mismatch', detail });

function esc(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function criterionRows(rows: any[]) {
  return (rows ?? []).map((row: any) => {
    const c = row?.campaignCriterion ?? row?.campaign_criterion ?? {};
    return {
      resource_name: String(c.resourceName ?? c.resource_name ?? ''),
      negative: c.negative === true,
      bid_modifier: Math.round(Number(c.bidModifier ?? c.bid_modifier ?? 1) * 100) / 100,
      device: String(c.device?.type ?? ''),
      geo: String(c.location?.geoTargetConstant ?? c.location?.geo_target_constant ?? ''),
    };
  });
}

export async function readbackExtendedAction(action: OptimizerAction, customer: any): Promise<ReadbackResult> {
  if (isAdsStudioOperation(action.type)) return readbackAdsStudioAction(action, customer);
  if (isStructureOperation(action.type)) return readbackStructureAction(action, customer);
  try {
    const params = action.params as Record<string, any>;
    const resolved = (params.resolved ?? {}) as Record<string, any>;

    switch (action.type) {
      case 'set_ad_schedule': {
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
        const now = scheduleCriteriaFromRows(rows);
        if (!now) return { status: 'unavailable', detail: 'schedule_unreadable' };
        const names = new Set(now.map((c) => c.resource_name));
        const key = (s: any) => {
          const { from, to } = slotMinutes(s);
          return `${s.day_of_week}|${from}|${to}`;
        };
        const byKey = new Map(now.map((c) => [key(c), c.bid_modifier]));
        for (const c of resolved.creates ?? []) {
          if (byKey.get(key(c)) !== c.bid_modifier) return mismatch(`window ${key(c)} missing or wrong modifier`);
        }
        for (const u of resolved.updates ?? []) {
          const live = now.find((c) => c.resource_name === u.resource_name);
          if (!live || live.bid_modifier !== u.bid_modifier) return mismatch(`modifier of ${u.resource_name} not updated`);
        }
        for (const r of resolved.removes ?? []) if (names.has(r.resource_name)) return mismatch(`${r.resource_name} still present`);
        return ok();
      }

      case 'set_device_bid_modifier':
      case 'set_location_bid_modifier':
      case 'exclude_location': {
        const type = action.type === 'set_device_bid_modifier' ? 'DEVICE' : 'LOCATION';
        const rows = criterionRows(
          await customer.query(`
            SELECT campaign_criterion.resource_name, campaign_criterion.negative, campaign_criterion.bid_modifier,
              campaign_criterion.device.type, campaign_criterion.location.geo_target_constant
            FROM campaign_criterion
            WHERE campaign_criterion.campaign = '${esc(params.campaign_resource)}'
              AND campaign_criterion.type = '${type}'
              AND campaign_criterion.status != 'REMOVED'
          `)
        );
        if (action.type === 'set_device_bid_modifier') {
          const live = rows.find((r) => r.device === params.device);
          return live && live.bid_modifier === params.bid_modifier ? ok() : mismatch('device modifier differs');
        }
        const same = rows.filter((r) => r.geo === params.geo_target_constant);
        if (action.type === 'exclude_location') {
          return same.some((r) => r.negative) ? ok() : mismatch('location is not excluded');
        }
        return same.some((r) => !r.negative && r.bid_modifier === params.bid_modifier)
          ? ok()
          : mismatch('location modifier differs');
      }

      case 'set_geo_target_type': {
        const state = await readCampaignState(customer, params.campaign_resource);
        return state.positiveGeoTargetType === params.positive_geo_target_type ? ok() : mismatch('geo target type differs');
      }

      case 'set_network_settings': {
        const state = await readCampaignState(customer, params.campaign_resource);
        if (params.target_search_network === false && state.searchNetwork !== false) return mismatch('search partners still on');
        if (params.target_content_network === false && state.contentNetwork !== false) return mismatch('display network still on');
        return ok();
      }

      case 'create_shared_negative_list': {
        const lists = await readNegativeLists(customer);
        const live = lists.find((l: any) => l.name === params.name);
        if (!live) return mismatch('list not found');
        return live.member_count >= (resolved.keywords?.length ?? 0) ? ok() : mismatch('list has fewer keywords than sent');
      }

      case 'add_shared_negative_keywords': {
        const lists = await readNegativeLists(customer);
        const live = lists.find((l: any) => l.resource_name === params.shared_set_resource);
        return live ? ok() : mismatch('list not found');
      }

      case 'attach_shared_negative_list': {
        const rows = await customer.query(`
          SELECT campaign_shared_set.campaign
          FROM campaign_shared_set
          WHERE campaign_shared_set.shared_set = '${esc(params.shared_set_resource)}'
            AND campaign_shared_set.status = 'ENABLED'
        `);
        const attached = new Set(
          (rows ?? []).map((r: any) => (r?.campaignSharedSet ?? r?.campaign_shared_set)?.campaign)
        );
        const missing = (resolved.campaigns ?? []).filter((c: string) => !attached.has(c));
        return missing.length === 0 ? ok() : mismatch(`${missing.length} campaign link(s) missing`);
      }

      case 'apply_google_recommendation':
      case 'dismiss_google_recommendation': {
        const rows = await customer.query(`
          SELECT recommendation.resource_name, recommendation.dismissed
          FROM recommendation
          WHERE recommendation.resource_name = '${esc(params.recommendation_resource)}'
          LIMIT 1
        `);
        const rec = rows?.[0]?.recommendation;
        // An applied or dismissed recommendation leaves the open list.
        return !rec || rec.dismissed === true ? ok() : mismatch('recommendation is still open');
      }

      case 'pause_auto_apply': {
        const subs = await readSubscriptions(customer);
        const still = (resolved.subscriptions ?? []).filter((s: any) =>
          subs.some((live: any) => live.resource_name === s.resource_name && live.status === 'ENABLED')
        );
        return still.length === 0 ? ok() : mismatch(`${still.length} subscription(s) still enabled`);
      }

      default:
        return { status: 'unavailable', detail: 'no_readback_for_type' };
    }
  } catch (error) {
    return { status: 'unavailable', detail: error instanceof Error ? error.message.slice(0, 200) : 'read_failed' };
  }
}

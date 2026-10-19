import {
  APPLY_SUPPORTED_RECOMMENDATION_TYPES,
  BID_MODIFIER_MAX,
  BID_MODIFIER_MIN,
  DAYS_OF_WEEK,
  MAX_ATTACH_CAMPAIGNS,
  MAX_SCHEDULE_SLOTS_PAYLOAD,
  MAX_SCHEDULE_SLOTS_PER_DAY,
  MAX_SHARED_LIST_KEYWORDS,
  MINUTE_ENUM,
  MODIFIABLE_DEVICES,
  SHARED_LIST_MATCH_TYPES,
  type ExtendedOperation,
  type MinuteEnum,
} from './types';

/**
 * Pure payload validators for the extended action types. Each returns the
 * canonical `target_id` and `params` to store and execute, or a short code for
 * the refusal. Nothing here talks to Google.
 *
 * Resource names must live under the SELECTED account (same rule as
 * validGoogleAdsResource in executable-action.ts; repeated here because that
 * module imports this one).
 */

export type ExtendedValidation =
  | { ok: true; target_id: string; params: Record<string, unknown> }
  | { ok: false; code: string };

const bad = (code: string): ExtendedValidation => ({ ok: false, code });

export function resourceInAccount(value: unknown, resourceType: string, accountCustomerId?: string | null): boolean {
  if (typeof value !== 'string') return false;
  const customerPattern = accountCustomerId ? accountCustomerId.replace(/\D/g, '') : '\\d+';
  if (accountCustomerId && !customerPattern) return false;
  return new RegExp(`^customers/${customerPattern}/${resourceType}/[^/]+$`).test(value);
}

const GEO_CONSTANT = /^geoTargetConstants\/\d{1,12}$/;
const INVISIBLE_MARKS = /[​-‏‪-‮⁠-⁩﻿]/g;

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** A finite number inside [min, max], rounded to two decimals, or null. */
export function cleanModifier(value: unknown, { allowZero }: { allowZero: boolean }): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const r = round2(n);
  if (allowZero && r === 0) return 0;
  if (r < BID_MODIFIER_MIN || r > BID_MODIFIER_MAX) return null;
  return r;
}

export function pctToModifier(pct: number): number {
  return round2(1 + pct / 100);
}

export function modifierToPct(modifier: number): number {
  return Math.round((modifier - 1) * 100);
}

export type ScheduleSlot = {
  day_of_week: (typeof DAYS_OF_WEEK)[number];
  start_hour: number;
  start_minute: MinuteEnum;
  end_hour: number;
  end_minute: MinuteEnum;
  bid_modifier: number;
};

export function slotMinutes(slot: Pick<ScheduleSlot, 'start_hour' | 'start_minute' | 'end_hour' | 'end_minute'>) {
  return {
    from: slot.start_hour * 60 + MINUTE_ENUM[slot.start_minute],
    to: slot.end_hour * 60 + MINUTE_ENUM[slot.end_minute],
  };
}

function cleanSlot(raw: unknown): ScheduleSlot | null {
  if (!raw || typeof raw !== 'object') return null;
  const slot = raw as Record<string, unknown>;
  const day = slot.day_of_week;
  if (typeof day !== 'string' || !(DAYS_OF_WEEK as readonly string[]).includes(day)) return null;
  const startHour = Number(slot.start_hour);
  const endHour = Number(slot.end_hour);
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) return null;
  if (!Number.isInteger(endHour) || endHour < 1 || endHour > 24) return null;
  const startMinute = (slot.start_minute ?? 'ZERO') as string;
  const endMinute = (slot.end_minute ?? 'ZERO') as string;
  if (!(startMinute in MINUTE_ENUM) || !(endMinute in MINUTE_ENUM)) return null;
  // 24:00 is the end of the day; 24:15 does not exist.
  if (endHour === 24 && endMinute !== 'ZERO') return null;
  const modifier = cleanModifier(slot.bid_modifier ?? 1, { allowZero: false });
  if (modifier === null) return null;
  const cleaned: ScheduleSlot = {
    day_of_week: day as ScheduleSlot['day_of_week'],
    start_hour: startHour,
    start_minute: startMinute as MinuteEnum,
    end_hour: endHour,
    end_minute: endMinute as MinuteEnum,
    bid_modifier: modifier,
  };
  const { from, to } = slotMinutes(cleaned);
  if (to <= from) return null;
  return cleaned;
}

/** 1 to 42 slots, no overlap inside a day, at most six per day. Null when anything is wrong. */
export function cleanScheduleSlots(value: unknown): ScheduleSlot[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCHEDULE_SLOTS_PAYLOAD) return null;
  const slots: ScheduleSlot[] = [];
  for (const raw of value) {
    const slot = cleanSlot(raw);
    if (!slot) return null;
    slots.push(slot);
  }
  for (const day of DAYS_OF_WEEK) {
    const mine = slots.filter((slot) => slot.day_of_week === day).map(slotMinutes).sort((a, b) => a.from - b.from);
    if (mine.length > MAX_SCHEDULE_SLOTS_PER_DAY) return null;
    for (let i = 1; i < mine.length; i += 1) if (mine[i].from < mine[i - 1].to) return null;
  }
  return slots;
}

export type SharedKeyword = { text: string; match_type: (typeof SHARED_LIST_MATCH_TYPES)[number] };

/** Trim, drop invisible marks, enforce 80 chars and 10 words, de-duplicate. Null when ANY entry is invalid. */
export function cleanSharedKeywords(value: unknown, max = MAX_SHARED_LIST_KEYWORDS): SharedKeyword[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return null;
  const seen = new Set<string>();
  const out: SharedKeyword[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.text !== 'string') return null;
    const matchType = String(entry.match_type ?? '');
    if (!(SHARED_LIST_MATCH_TYPES as readonly string[]).includes(matchType)) return null;
    const text = entry.text.replace(INVISIBLE_MARKS, '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 80 || text.split(' ').length > 10) return null;
    const key = `${matchType}|${text.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, match_type: matchType as SharedKeyword['match_type'] });
  }
  return out.length > 0 ? out : null;
}

export function cleanListName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(INVISIBLE_MARKS, '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 60) return null;
  return name;
}

function cleanCampaignList(value: unknown, accountCustomerId: string | null | undefined, allowEmpty: boolean): string[] | null {
  if (value === undefined && allowEmpty) return [];
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return allowEmpty ? [] : null;
  if (value.length > MAX_ATTACH_CAMPAIGNS) return null;
  const out: string[] = [];
  for (const item of value) {
    if (!resourceInAccount(item, 'campaigns', accountCustomerId)) return null;
    if (!out.includes(item as string)) out.push(item as string);
  }
  return out;
}

export function validateExtendedPayload(
  operation: ExtendedOperation,
  targetId: string,
  paramsInput: unknown,
  accountCustomerId?: string | null
): ExtendedValidation {
  const params = paramsInput && typeof paramsInput === 'object' ? (paramsInput as Record<string, unknown>) : {};
  const campaign = String(params.campaign_resource ?? '');

  switch (operation) {
    case 'set_ad_schedule': {
      if (!resourceInAccount(campaign, 'campaigns', accountCustomerId)) return bad('campaign_invalid');
      const slots = cleanScheduleSlots(params.slots);
      if (!slots) return bad('slots_invalid');
      return {
        ok: true,
        target_id: campaign,
        params: { campaign_resource: campaign, slots, restrict_to_slots: params.restrict_to_slots === true },
      };
    }

    case 'set_device_bid_modifier': {
      if (!resourceInAccount(campaign, 'campaigns', accountCustomerId)) return bad('campaign_invalid');
      const device = String(params.device ?? '');
      if (!(MODIFIABLE_DEVICES as readonly string[]).includes(device)) return bad('device_invalid');
      const modifier = cleanModifier(params.bid_modifier, { allowZero: true });
      if (modifier === null || modifier === 1) return bad('modifier_invalid');
      return { ok: true, target_id: campaign, params: { campaign_resource: campaign, device, bid_modifier: modifier } };
    }

    case 'exclude_location':
    case 'set_location_bid_modifier': {
      if (!resourceInAccount(campaign, 'campaigns', accountCustomerId)) return bad('campaign_invalid');
      const geo = String(params.geo_target_constant ?? '');
      if (!GEO_CONSTANT.test(geo)) return bad('location_invalid');
      const out: Record<string, unknown> = { campaign_resource: campaign, geo_target_constant: geo };
      if (operation === 'set_location_bid_modifier') {
        const modifier = cleanModifier(params.bid_modifier, { allowZero: false });
        if (modifier === null || modifier === 1) return bad('modifier_invalid');
        out.bid_modifier = modifier;
      }
      return { ok: true, target_id: campaign, params: out };
    }

    case 'set_geo_target_type': {
      if (!resourceInAccount(campaign, 'campaigns', accountCustomerId)) return bad('campaign_invalid');
      const type = String(params.positive_geo_target_type ?? '');
      // SEARCH_INTEREST is deprecated for new use; only the two live settings.
      if (!['PRESENCE', 'PRESENCE_OR_INTEREST'].includes(type)) return bad('geo_type_invalid');
      return { ok: true, target_id: campaign, params: { campaign_resource: campaign, positive_geo_target_type: type } };
    }

    case 'set_network_settings': {
      if (!resourceInAccount(campaign, 'campaigns', accountCustomerId)) return bad('campaign_invalid');
      const out: Record<string, unknown> = { campaign_resource: campaign };
      let changes = 0;
      for (const key of ['target_search_network', 'target_content_network'] as const) {
        if (params[key] === undefined) continue;
        // The platform only narrows reach: turning a network back on is the merchant's call in Google Ads.
        if (params[key] !== false) return bad('network_only_off');
        out[key] = false;
        changes += 1;
      }
      if (changes === 0) return bad('network_empty');
      return { ok: true, target_id: campaign, params: out };
    }

    case 'create_shared_negative_list': {
      const name = cleanListName(params.name);
      const keywords = cleanSharedKeywords(params.keywords);
      const campaigns = cleanCampaignList(params.campaign_resources, accountCustomerId, true);
      if (!name) return bad('list_name_invalid');
      if (!keywords) return bad('keywords_invalid');
      if (!campaigns) return bad('campaigns_invalid');
      return { ok: true, target_id: '', params: { name, keywords, campaign_resources: campaigns } };
    }

    case 'add_shared_negative_keywords': {
      const sharedSet = String(params.shared_set_resource ?? '');
      if (!resourceInAccount(sharedSet, 'sharedSets', accountCustomerId)) return bad('shared_set_invalid');
      const keywords = cleanSharedKeywords(params.keywords);
      if (!keywords) return bad('keywords_invalid');
      return { ok: true, target_id: sharedSet, params: { shared_set_resource: sharedSet, keywords } };
    }

    case 'attach_shared_negative_list': {
      const sharedSet = String(params.shared_set_resource ?? '');
      if (!resourceInAccount(sharedSet, 'sharedSets', accountCustomerId)) return bad('shared_set_invalid');
      const campaigns = cleanCampaignList(params.campaign_resources, accountCustomerId, false);
      if (!campaigns) return bad('campaigns_invalid');
      return { ok: true, target_id: sharedSet, params: { shared_set_resource: sharedSet, campaign_resources: campaigns } };
    }

    case 'apply_google_recommendation':
    case 'dismiss_google_recommendation': {
      const resource = String(params.recommendation_resource ?? targetId ?? '');
      if (!resourceInAccount(resource, 'recommendations', accountCustomerId)) return bad('recommendation_invalid');
      const type = String(params.recommendation_type ?? '');
      if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(type)) return bad('recommendation_type_invalid');
      if (
        operation === 'apply_google_recommendation' &&
        !(APPLY_SUPPORTED_RECOMMENDATION_TYPES as readonly string[]).includes(type)
      ) {
        return bad('recommendation_not_appliable');
      }
      return {
        ok: true,
        target_id: resource,
        params: { recommendation_resource: resource, recommendation_type: type },
      };
    }

    case 'pause_auto_apply': {
      const list = params.subscription_resources;
      if (!Array.isArray(list) || list.length === 0 || list.length > 20) return bad('subscriptions_invalid');
      const out: string[] = [];
      for (const item of list) {
        if (!resourceInAccount(item, 'recommendationSubscriptions', accountCustomerId)) return bad('subscriptions_invalid');
        if (!out.includes(item as string)) out.push(item as string);
      }
      return { ok: true, target_id: '', params: { subscription_resources: out } };
    }
  }
}

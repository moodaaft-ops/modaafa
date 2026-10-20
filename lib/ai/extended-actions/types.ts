/**
 * Action types added behind EXTENDED_ACTIONS_ENABLED.
 *
 * Every field and enum name used by these actions was checked against the
 * Google Ads API v22 definitions (the version pinned in lib/google-ads/client.ts):
 *   CampaignCriterion.{bid_modifier, negative, ad_schedule, device, location}
 *   AdScheduleInfo.{day_of_week, start_hour, start_minute, end_hour, end_minute}
 *   Campaign.{network_settings, geo_target_type_setting}
 *   SharedSet / SharedCriterion / CampaignSharedSet
 *   RecommendationService.{ApplyRecommendation, DismissRecommendation}
 *   RecommendationSubscription (auto-apply)
 */

import { ADS_STUDIO_OPERATIONS } from '../../ads/studio/types';
import { VALUE_RULE_OPERATIONS } from '../../value-rules/types';
import { STRUCTURE_OPERATIONS, STRUCTURE_TARGETING_FAMILY } from '../../structure/types';

export const EXTENDED_OPERATIONS = [
  'set_ad_schedule',
  'set_device_bid_modifier',
  'exclude_location',
  'set_location_bid_modifier',
  'set_geo_target_type',
  'set_network_settings',
  'create_shared_negative_list',
  'add_shared_negative_keywords',
  'attach_shared_negative_list',
  'apply_google_recommendation',
  'dismiss_google_recommendation',
  'pause_auto_apply',
  // Ad copy and assets: also need ADS_STUDIO_ENABLED (see lib/ads/studio).
  ...ADS_STUDIO_OPERATIONS,
  // Conversion value rules: create a rule set (geo, device or audience) and edit a rule's multiplier or status.
  ...VALUE_RULE_OPERATIONS,
  // Account structure (AI Max, placement exclusions, shared budgets, portfolio strategies, listing groups).
  ...STRUCTURE_OPERATIONS,
] as const;

export type ExtendedOperation = (typeof EXTENDED_OPERATIONS)[number];

const EXTENDED_SET: ReadonlySet<string> = new Set(EXTENDED_OPERATIONS);

export function isExtendedOperation(value: unknown): value is ExtendedOperation {
  return typeof value === 'string' && EXTENDED_SET.has(value);
}

/** Operations that change targeting on one campaign: one change per campaign per family per 7 days. */
export const CAMPAIGN_TARGETING_FAMILY: Readonly<Record<string, string>> = {
  set_ad_schedule: 'schedule',
  set_device_bid_modifier: 'device',
  exclude_location: 'location',
  set_location_bid_modifier: 'location',
  set_geo_target_type: 'geo_type',
  set_network_settings: 'network',
  ...STRUCTURE_TARGETING_FAMILY,
};

export const DAYS_OF_WEEK = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

/** MinuteOfHour enum values and their minute number. */
export const MINUTE_ENUM = { ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 } as const;
export type MinuteEnum = keyof typeof MINUTE_ENUM;

export const MODIFIABLE_DEVICES = ['MOBILE', 'DESKTOP', 'TABLET'] as const;
export type ModifiableDevice = (typeof MODIFIABLE_DEVICES)[number];

/**
 * Product bounds for a bid modifier set by the platform. Google accepts 0.1 to
 * 10.0 (and 0 to opt a device out); the platform stays inside +-50% so one
 * approval can never swing bids hard. Excluding a device (0) is separate.
 */
export const BID_MODIFIER_MIN = 0.5;
export const BID_MODIFIER_MAX = 1.5;

/** Smart Bidding strategies ignore ad schedule, device (except opt-out) and location modifiers. */
export const SMART_BIDDING_STRATEGIES: ReadonlySet<string> = new Set([
  'TARGET_CPA',
  'TARGET_ROAS',
  'MAXIMIZE_CONVERSIONS',
  'MAXIMIZE_CONVERSION_VALUE',
]);

export const MAX_SCHEDULE_SLOTS_PER_DAY = 6;
export const MAX_SCHEDULE_SLOTS_PAYLOAD = 42;
export const MAX_SHARED_LIST_KEYWORDS = 50;
/** Skill limits (keywords-search-terms.md 7.3): 5000 negatives per list, 20 lists per account. */
export const SHARED_LIST_MEMBER_LIMIT = 5000;
export const SHARED_LIST_ACCOUNT_LIMIT = 20;
export const MAX_ATTACH_CAMPAIGNS = 10;
export const SHARED_LIST_MATCH_TYPES = ['EXACT', 'PHRASE'] as const;

/** Recommendation types the platform can apply itself, and what scope it uses. */
export const APPLY_SUPPORTED_RECOMMENDATION_TYPES = ['SITELINK_ASSET', 'CALLOUT_ASSET'] as const;

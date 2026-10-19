/**
 * Account-structure approval actions (shared budgets, portfolio bid
 * strategies, placement and content exclusions, AI Max, listing-group trees).
 *
 * They are part of EXTENDED_OPERATIONS (lib/ai/extended-actions/types.ts), so
 * they go through the same pipeline as the other extended actions: payload
 * validation, live preflight, guardrails, validateOnly, one atomic
 * googleAds:mutate, rollback record, readback. They need only
 * EXTENDED_ACTIONS_ENABLED=true. Flag off: they are refused like any unknown
 * operation.
 *
 * Field names were checked against the Google Ads API v22 protos (google-ads
 * python wheel 30): Campaign.ai_max_setting.enable_ai_max, Campaign.bidding_strategy,
 * CampaignBudget.explicitly_shared, BiddingStrategy.{maximize_conversions,
 * maximize_conversion_value, target_cpa, target_roas}, CustomerNegativeCriterion,
 * CampaignCriterion.{placement, youtube_channel, youtube_video, mobile_application,
 * content_label}, AdGroupCriterion.listing_group, AssetGroupListingGroupFilter.
 */

export const STRUCTURE_OPERATIONS = [
  'set_ai_max',
  'add_placement_exclusions',
  'create_shared_budget',
  'attach_shared_budget',
  'detach_shared_budget',
  'create_portfolio_strategy',
  'attach_portfolio_strategy',
  'detach_portfolio_strategy',
  'subdivide_shopping_listing_group',
  'subdivide_pmax_listing_group',
] as const;

export type StructureOperation = (typeof STRUCTURE_OPERATIONS)[number];

const SET: ReadonlySet<string> = new Set(STRUCTURE_OPERATIONS);

export function isStructureOperation(value: unknown): value is StructureOperation {
  return typeof value === 'string' && SET.has(value);
}

/** Rollback payloads of these actions carry this action_type prefix (they also start with ext_). */
export const STRUCTURE_ROLLBACK_PREFIX = 'ext_struct_';

export function isStructureRollback(rollback: unknown): boolean {
  const type = (rollback as { action_type?: unknown } | null | undefined)?.action_type;
  return typeof type === 'string' && type.startsWith(STRUCTURE_ROLLBACK_PREFIX);
}

/** One change per campaign per family per 7 days (same table as CAMPAIGN_TARGETING_FAMILY). */
export const STRUCTURE_TARGETING_FAMILY: Readonly<Record<string, string>> = {
  set_ai_max: 'ai_max',
};

/** Budget structure: a shared budget is a budget change, so the 7 day budget lock applies (titan red rule 6). */
export const STRUCTURE_BUDGET_OPERATIONS: ReadonlySet<string> = new Set([
  'create_shared_budget',
  'attach_shared_budget',
  'detach_shared_budget',
]);
export const STRUCTURE_BIDDING_OPERATIONS: ReadonlySet<string> = new Set([
  'create_portfolio_strategy',
  'attach_portfolio_strategy',
  'detach_portfolio_strategy',
]);
export const BUDGET_STRUCTURE_LOCK_DAYS = 7;
/** A strategy change resets learning; titan 5.2 keeps the gap at two weeks. */
export const BIDDING_STRUCTURE_LOCK_DAYS = 14;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_STRUCTURE_CAMPAIGNS = 10;
export const MIN_SHARED_BUDGET_CAMPAIGNS = 2;
export const MIN_PORTFOLIO_CAMPAIGNS = 2;
export const MAX_PLACEMENTS_PER_ACTION = 50;
export const MAX_SUBDIVISION_VALUES = 20;
/** Campaign types that can share a budget or join a portfolio strategy in this product. */
export const SHARED_BUDGET_CHANNELS: ReadonlySet<string> = new Set(['SEARCH', 'SHOPPING', 'DISPLAY']);
export const PORTFOLIO_CHANNELS: ReadonlySet<string> = new Set(['SEARCH', 'SHOPPING', 'DISPLAY']);
/** Campaigns that can carry campaign-level placement exclusions. Performance Max takes account-level only. */
export const CAMPAIGN_PLACEMENT_CHANNELS: ReadonlySet<string> = new Set(['DISPLAY', 'VIDEO', 'DEMAND_GEN']);

/** AI Max starts at the same volume as BROAD (titan 20.2): 30 conversions in 30 days. */
export const AI_MAX_MIN_CONVERSIONS_30D = 30;
/** Pooled conversions a numeric-target portfolio needs (titan 3.9, 5.2). */
export const PORTFOLIO_TARGET_MIN_CONVERSIONS_30D = 30;

/** Bidding strategy types that AI Max works with (Smart Bidding on conversions). */
export const AI_MAX_BIDDING: ReadonlySet<string> = new Set([
  'MAXIMIZE_CONVERSIONS',
  'MAXIMIZE_CONVERSION_VALUE',
  'TARGET_CPA',
  'TARGET_ROAS',
]);

export const PORTFOLIO_STRATEGIES = ['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS'] as const;
export type PortfolioStrategy = (typeof PORTFOLIO_STRATEGIES)[number];
export const DETACH_TARGETS = ['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE'] as const;

export const PLACEMENT_KINDS = ['website', 'youtube_channel', 'youtube_video', 'mobile_app', 'content_label'] as const;
export type PlacementKind = (typeof PLACEMENT_KINDS)[number];

/** ContentLabelType values the platform offers for exclusion (v22 enum, brand suitability tiers left out). */
export const CONTENT_LABELS = [
  'SEXUALLY_SUGGESTIVE',
  'BELOW_THE_FOLD',
  'PARKED_DOMAIN',
  'JUVENILE',
  'PROFANITY',
  'TRAGEDY',
  'VIDEO',
  'EMBEDDED_VIDEO',
  'LIVE_STREAMING_VIDEO',
  'SOCIAL_ISSUES',
] as const;

export const LISTING_DIMENSIONS = ['brand', 'product_type', 'category', 'custom_label', 'item_id'] as const;
export type ListingDimension = (typeof LISTING_DIMENSIONS)[number];

export const PORTFOLIO_TARGET_BAND = 0.2;
export const MAX_SHARED_NAME = 80;
/** A change smaller than this is a pure restructure (the money does not move). */
export const NEUTRAL_BUDGET_DELTA_PCT = 1;

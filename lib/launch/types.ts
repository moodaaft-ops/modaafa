import type { BuilderBidStrategy, BuilderCampaignType, BuilderObjective } from '@/lib/ai/builder-gates';
import type { PmaxBuild } from './pmax';

/**
 * The launch plan: everything needed to create ONE campaign, PAUSED, in one
 * GoogleAdsService:mutate batch. It is plain JSON (stored in the approval
 * card's action_payload) and is re-validated at execution time, never trusted.
 */

export const LAUNCH_PLAN_VERSION = 1;

/** Saudi Arabia's geo target constant id. Cities are resolved by name (lib/launch/geo.ts). */
export const SAUDI_GEO_TARGET_CONSTANT = 'geoTargetConstants/2682';

export type LaunchMatchType = 'EXACT' | 'PHRASE';
export type LaunchKeyword = { text: string; match_type: LaunchMatchType };
export type LaunchNegative = { text: string; match_type: LaunchMatchType };

export type LaunchBlockerCode =
  | 'not_sar'
  | 'budget_missing'
  | 'budget_unreasonable'
  | 'no_landing_page'
  | 'no_valid_ad_group'
  | 'regions_unresolved'
  | 'pmax_assets_required'
  | 'shopping_needs_merchant'
  | 'draft_incomplete'
  | 'unsupported_type';

export type LaunchBlocker = { code: LaunchBlockerCode; message_ar: string };

export type LaunchRsa = {
  headlines: string[];
  descriptions: string[];
  path1: string | null;
  path2: string | null;
};

export type LaunchAdGroup = {
  name: string;
  final_url: string;
  keywords: LaunchKeyword[];
  rsa: LaunchRsa | null;
};

export type LaunchSitelink = {
  link_text: string;
  description1: string | null;
  description2: string | null;
  final_url: string;
};

export type LaunchAssets = {
  sitelinks: LaunchSitelink[];
  callouts: string[];
  structured_snippet: { header: string; values: string[] } | null;
  /** E.164 style («+9665XXXXXXXX») or null. */
  call_phone: string | null;
  /** Attach the account's LOCATION_SYNC asset set when it exists (checked at execution). */
  use_location_sync: boolean;
};

export type LaunchPlan = {
  version: typeof LAUNCH_PLAN_VERSION;
  type: BuilderCampaignType;
  objective: BuilderObjective | null;
  name: string;
  language: 'ar' | 'en';
  business_name: string | null;
  business_kind: 'clinic' | 'services' | 'ecommerce' | 'local' | 'general';
  budget: { daily_sar: number; daily_micros: number };
  bidding: {
    /** MAXIMIZE_CONVERSION_VALUE is used only by a sales Performance Max plan (CAMPAIGN_LAUNCH_PMAX_ENABLED). */
    strategy: Extract<BuilderBidStrategy, 'MAXIMIZE_CLICKS' | 'MANUAL_CPC' | 'MAXIMIZE_CONVERSIONS'> | 'MAXIMIZE_CONVERSION_VALUE';
    cpc_ceiling_micros: number | null;
    note_ar: string;
  };
  settings: {
    search_partners: false;
    display_network: false;
    positive_geo_target_type: 'PRESENCE' | 'PRESENCE_OR_INTEREST';
    status: 'PAUSED';
  };
  geo: {
    country_constant: string;
    /** Region names the merchant asked for; each gets a geo target constant before execution. */
    regions: Array<{ name: string; geo_target_constant: string | null }>;
  };
  ad_groups: LaunchAdGroup[];
  campaign_negatives: LaunchNegative[];
  shared_negative_list: { name: string; keywords: LaunchNegative[] };
  assets: LaunchAssets;
  /** SHOPPING only. The merchant id is read from the account at execution. */
  shopping: { campaign_priority: 0 } | null;
  /** PMAX only. `build` is present only under CAMPAIGN_LAUNCH_PMAX_ENABLED; without it the plan is blocked. */
  pmax: { brand_exclusions: string[]; final_url: string; build?: PmaxBuild } | null;
  blockers: LaunchBlocker[];
  warnings_ar: string[];
  /** What was dropped and why, for the merchant to see. */
  removed_ar: string[];
  executable: boolean;
};

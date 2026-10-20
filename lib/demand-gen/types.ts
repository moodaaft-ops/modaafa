import type { BiddingChoice } from '../growth/readiness';

/**
 * The Demand Gen plan: everything needed to create ONE Demand Gen campaign,
 * PAUSED, in one GoogleAdsService:mutate batch. Plain JSON, stored in the
 * approval card and re-validated at execution (never trusted).
 */

export const DEMAND_GEN_PLAN_VERSION = 1;
export const SAUDI_COUNTRY_CONSTANT = 'geoTargetConstants/2682';
export const ARABIC_LANGUAGE_CONSTANT = 'languageConstants/1019';
export const ENGLISH_LANGUAGE_CONSTANT = 'languageConstants/1000';

export type DemandGenBlockerCode =
  | 'name_missing'
  | 'budget_missing'
  | 'budget_too_low'
  | 'budget_too_high'
  | 'budget_below_tcpa_multiple'
  | 'bidding_unsupported'
  | 'target_cpa_missing'
  | 'no_landing_page'
  | 'business_name_invalid'
  | 'too_few_headlines'
  | 'too_few_descriptions'
  | 'too_few_long_headlines'
  | 'logo_required'
  | 'creative_required'
  | 'video_id_invalid'
  | 'image_resource_invalid'
  | 'audience_resource_invalid'
  | 'regions_unresolved'
  | 'not_sar'
  | 'tracking_not_healthy'
  | 'strategy_history_missing'
  | 'audience_not_ready';

export type DemandGenBlocker = { code: DemandGenBlockerCode; message_ar: string };

export type DemandGenImages = {
  marketing: string[];
  square: string[];
  portrait: string[];
  logo: string[];
};

export type DemandGenPlan = {
  version: typeof DEMAND_GEN_PLAN_VERSION;
  type: 'DEMAND_GEN';
  name: string;
  language: 'ar' | 'en';
  business_name: string;
  budget: { daily_sar: number; daily_micros: number };
  bidding: {
    strategy: BiddingChoice;
    target_cpa_micros: number | null;
    cpc_ceiling_micros: number | null;
    note_ar: string;
  };
  geo: { country_constant: string; regions: Array<{ name: string; geo_target_constant: string }> };
  channels: {
    youtube_in_feed: boolean;
    youtube_in_stream: boolean;
    youtube_shorts: boolean;
    discover: boolean;
    gmail: boolean;
    /** Closed at launch (titan 22.3). */
    display: false;
  };
  ad_group_name: string;
  final_url: string;
  copy: { headlines: string[]; long_headlines: string[]; descriptions: string[] };
  /** Resource names of IMAGE assets that already exist in the account (lib/image-assets creates them). */
  images: DemandGenImages;
  video: { youtube_video_id: string } | null;
  audience: { user_lists: string[]; exclude_user_lists: string[] };
  blockers: DemandGenBlocker[];
  warnings_ar: string[];
  removed_ar: string[];
  executable: boolean;
};

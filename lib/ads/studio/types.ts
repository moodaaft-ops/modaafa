/**
 * Approval actions added by the ad copy and assets work (ADS_STUDIO_ENABLED).
 *
 * They are part of EXTENDED_OPERATIONS (lib/ai/extended-actions/types.ts), so
 * they go through the same pipeline: payload validation, live preflight,
 * guardrails, validateOnly, one atomic googleAds:mutate, rollback record,
 * readback. They additionally need ADS_STUDIO_ENABLED=true; with only
 * EXTENDED_ACTIONS_ENABLED on they are refused like any unknown operation.
 *
 * Field names checked against the Google Ads API v22 protos (google-ads python
 * wheel 29 to 31): Ad.responsive_search_ad{headlines,descriptions,path1,path2},
 * AdTextAsset{text,pinned_field}, AdGroupAd.status, Asset{sitelink_asset,
 * callout_asset, structured_snippet_asset, call_asset, final_urls},
 * CampaignAsset{campaign, asset, field_type}.
 */

export const ADS_STUDIO_OPERATIONS = [
  'replace_rsa_assets',
  'add_sitelinks',
  'add_callouts',
  'add_structured_snippet',
  'add_call_asset',
] as const;

export type AdsStudioOperation = (typeof ADS_STUDIO_OPERATIONS)[number];

const SET: ReadonlySet<string> = new Set(ADS_STUDIO_OPERATIONS);

export function isAdsStudioOperation(value: unknown): value is AdsStudioOperation {
  return typeof value === 'string' && SET.has(value);
}

/** Rollback payloads of these actions carry this action_type prefix (they also start with ext_). */
export const ADS_STUDIO_ROLLBACK_PREFIX = 'ext_ads_';

export function isAdsStudioRollback(rollback: unknown): boolean {
  const type = (rollback as { action_type?: unknown } | null | undefined)?.action_type;
  return typeof type === 'string' && type.startsWith(ADS_STUDIO_ROLLBACK_PREFIX);
}

/** Header values the structured snippet accepts (API v22 documentation list). */
export const SNIPPET_HEADERS = [
  'Amenities',
  'Brands',
  'Courses',
  'Degree programs',
  'Destinations',
  'Featured hotels',
  'Insurance coverage',
  'Models',
  'Neighborhoods',
  'Service catalog',
  'Shows',
  'Styles',
  'Types',
] as const;

export const SNIPPET_HEADER_AR: Readonly<Record<string, string>> = {
  Amenities: 'المرافق',
  Brands: 'الماركات',
  Courses: 'الدورات',
  'Degree programs': 'البرامج الدراسية',
  Destinations: 'الوجهات',
  'Featured hotels': 'الفنادق',
  'Insurance coverage': 'التغطيات التأمينية',
  Models: 'الموديلات',
  Neighborhoods: 'الأحياء',
  'Service catalog': 'الخدمات',
  Shows: 'العروض',
  Styles: 'الأنماط',
  Types: 'الأنواع',
};

export const MAX_REPLACEMENTS_PER_ACTION = 7;
export const MIN_SITELINKS_PER_ACTION = 2;
export const MAX_SITELINKS_PER_ACTION = 6;
/** Total per campaign after the action; Google serves a handful, the rest only add review surface. */
export const MAX_SITELINKS_PER_CAMPAIGN = 8;
export const MIN_CALLOUTS_PER_ACTION = 2;
export const MAX_CALLOUTS_PER_ACTION = 6;
export const MAX_CALLOUTS_PER_CAMPAIGN = 10;
export const MIN_SNIPPET_VALUES = 3;
export const MAX_SNIPPET_VALUES = 10;
/** Enabled responsive search ads per ad group: 3 is Google's limit; a test keeps it to two. */
export const MAX_ENABLED_RSA_PER_AD_GROUP = 3;
export const MAX_ENABLED_RSA_FOR_TEST = 2;

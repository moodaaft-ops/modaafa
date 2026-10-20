import { cleanCopyList, copyIssues } from '../launch/copy';
import { STRATEGY_MIN_CONVERSIONS_30D, type BiddingChoice } from '../growth/readiness';
import {
  DEMAND_GEN_MAX_DAILY_SAR,
  DEMAND_GEN_MIN_DAILY_SAR,
  MAX_DESCRIPTIONS,
  MAX_HEADLINES,
  MAX_LONG_HEADLINES,
  TCPA_BUDGET_MULTIPLE,
  YOUTUBE_ID_RE,
} from './plan';
import { DEMAND_GEN_PLAN_VERSION, SAUDI_COUNTRY_CONSTANT, type DemandGenPlan } from './types';

/**
 * A plan read back from the approval card is data from the database: it is
 * checked again right before anything goes to Google (shape, limits, PAUSED
 * campaign, closed Display, every line of copy, every resource name).
 */

type Rec = Record<string, any>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const httpsUrl = (v: unknown) => isStr(v) && /^https:\/\/[^\s/]+(\/\S*)?$/.test(v) && v.length <= 2000;
const ASSET_RE = /^customers\/\d+\/assets\/\d+$/;
const USER_LIST_RE = /^customers\/\d+\/userLists\/\d+$/;

export type StoredDemandGenCheck = { ok: true; plan: DemandGenPlan } | { ok: false; reason: string };

export function validateStoredDemandGenPlan(value: unknown, customerId?: string | null): StoredDemandGenCheck {
  const fail = (reason: string): StoredDemandGenCheck => ({ ok: false, reason });
  if (!isRec(value)) return fail('plan_missing');
  const plan = value as Rec;
  if (plan.version !== DEMAND_GEN_PLAN_VERSION) return fail('plan_version');
  if (plan.executable !== true || !isArr(plan.blockers) || plan.blockers.length > 0) return fail('plan_blocked');
  if (plan.type !== 'DEMAND_GEN') return fail('plan_type');
  if (!isStr(plan.name) || !plan.name.trim() || plan.name.length > 128) return fail('plan_name');
  const language = plan.language === 'en' ? 'en' : 'ar';
  if (!isStr(plan.business_name) || copyIssues(plan.business_name, { kind: 'callout', language: null, allowGuarantee: true }).length > 0) {
    return fail('plan_business_name');
  }

  const budget = plan.budget;
  if (
    !isRec(budget) ||
    !Number.isInteger(budget.daily_micros) ||
    budget.daily_micros < DEMAND_GEN_MIN_DAILY_SAR * 1_000_000 ||
    budget.daily_micros > DEMAND_GEN_MAX_DAILY_SAR * 1_000_000 ||
    budget.daily_micros % 10_000 !== 0 ||
    Math.round(Number(budget.daily_sar) * 1_000_000) !== budget.daily_micros
  ) {
    return fail('plan_budget');
  }

  const bidding = plan.bidding;
  if (!isRec(bidding) || !Object.prototype.hasOwnProperty.call(STRATEGY_MIN_CONVERSIONS_30D, bidding.strategy)) return fail('plan_bidding');
  const strategy = bidding.strategy as BiddingChoice;
  if (strategy === 'TARGET_CPA') {
    const t = bidding.target_cpa_micros;
    if (!Number.isInteger(t) || t < 10_000) return fail('plan_target_cpa');
    if (budget.daily_micros < t * TCPA_BUDGET_MULTIPLE) return fail('plan_budget_vs_tcpa');
  } else if (bidding.target_cpa_micros !== null) {
    return fail('plan_target_cpa_unexpected');
  }
  if (strategy === 'MAXIMIZE_CLICKS' && bidding.cpc_ceiling_micros !== null) return fail('plan_cpc_ceiling_unsupported');

  const geo = plan.geo;
  if (!isRec(geo) || geo.country_constant !== SAUDI_COUNTRY_CONSTANT || !isArr(geo.regions) || geo.regions.length > 10) return fail('plan_geo');
  for (const region of geo.regions) {
    if (!isRec(region) || !isStr(region.geo_target_constant) || !/^geoTargetConstants\/\d+$/.test(region.geo_target_constant)) {
      return fail('plan_geo_region');
    }
  }

  const channels = plan.channels;
  if (!isRec(channels) || channels.display !== false) return fail('plan_display_open');
  for (const key of ['youtube_in_feed', 'youtube_in_stream', 'youtube_shorts', 'discover', 'gmail']) {
    if (typeof channels[key] !== 'boolean') return fail('plan_channels');
  }
  if (!['youtube_in_feed', 'youtube_in_stream', 'youtube_shorts', 'discover', 'gmail'].some((k) => channels[k] === true)) return fail('plan_channels_none');

  if (!isStr(plan.ad_group_name) || !plan.ad_group_name.trim() || plan.ad_group_name.length > 255) return fail('plan_group_name');
  if (!httpsUrl(plan.final_url)) return fail('plan_url');

  const copy = plan.copy;
  if (!isRec(copy) || !isArr(copy.headlines) || !isArr(copy.long_headlines) || !isArr(copy.descriptions)) return fail('plan_copy');
  const common = { brand: plan.business_name as string, language, allowGuarantee: false } as const;
  const checkList = (lines: unknown[], kind: 'headline' | 'description', max: number, code: string) => {
    if (lines.length > max) return code;
    const cleaned = cleanCopyList(lines, { ...common, kind, max });
    return cleaned.dropped.length > 0 || cleaned.kept.length !== lines.length ? code : null;
  };
  const badCopy =
    checkList(copy.headlines, 'headline', MAX_HEADLINES, 'plan_headlines') ??
    checkList(copy.long_headlines, 'description', MAX_LONG_HEADLINES, 'plan_long_headlines') ??
    checkList(copy.descriptions, 'description', MAX_DESCRIPTIONS, 'plan_descriptions');
  if (badCopy) return fail(badCopy);
  if (copy.headlines.length < 1 || copy.descriptions.length < 1) return fail('plan_copy_empty');

  const images = plan.images;
  if (!isRec(images)) return fail('plan_images');
  const scope = customerId ? String(customerId).replace(/\D/g, '') : null;
  let stills = 0;
  for (const slot of ['marketing', 'square', 'portrait', 'logo']) {
    const items = images[slot];
    if (!isArr(items) || items.length > 10) return fail('plan_images');
    for (const item of items) {
      if (!isStr(item) || !ASSET_RE.test(item)) return fail('plan_image_resource');
      if (scope && !item.startsWith(`customers/${scope}/`)) return fail('plan_image_scope');
    }
    if (slot !== 'logo') stills += items.length;
  }
  const video = plan.video;
  if (video !== null && !(isRec(video) && isStr(video.youtube_video_id) && YOUTUBE_ID_RE.test(video.youtube_video_id))) return fail('plan_video');
  if (stills === 0 && video === null) return fail('plan_creative');
  if (images.logo.length === 0) return fail('plan_logo');
  if (video !== null && copy.long_headlines.length < 1) return fail('plan_long_headline');

  const audience = plan.audience;
  if (!isRec(audience) || !isArr(audience.user_lists) || !isArr(audience.exclude_user_lists)) return fail('plan_audience');
  for (const item of [...audience.user_lists, ...audience.exclude_user_lists]) {
    if (!isStr(item) || !USER_LIST_RE.test(item)) return fail('plan_audience_resource');
    if (scope && !item.startsWith(`customers/${scope}/`)) return fail('plan_audience_scope');
  }
  if (audience.user_lists.length > 5 || audience.exclude_user_lists.length > 5) return fail('plan_audience');
  if ((audience.user_lists as string[]).some((u) => (audience.exclude_user_lists as string[]).includes(u))) return fail('plan_audience_overlap');

  return { ok: true, plan: value as DemandGenPlan };
}

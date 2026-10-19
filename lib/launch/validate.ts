import { LAUNCH_MAX_AD_GROUPS, LAUNCH_MAX_DAILY_BUDGET_SAR, LAUNCH_MAX_KEYWORDS_PER_GROUP } from './plan';
import { copyIssues, RSA_MAX_DESCRIPTIONS, RSA_MAX_HEADLINES, RSA_MIN_DESCRIPTIONS, RSA_MIN_HEADLINES } from './copy';
import { LAUNCH_PLAN_VERSION, type LaunchPlan } from './types';

/**
 * A plan read back from the approval card is data from the database, so it is
 * checked again right before anything is sent to Google: shape, limits, the
 * PAUSED status, the closed networks and every line of ad text. A plan that
 * fails is not executed and the card goes to manual review.
 */

type Rec = Record<string, any>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const httpsUrl = (v: unknown) => isStr(v) && /^https:\/\/[^\s/]+(\/\S*)?$/.test(v) && v.length <= 2000;

export type StoredPlanCheck = { ok: true; plan: LaunchPlan } | { ok: false; reason: string };

export function validateStoredPlan(value: unknown): StoredPlanCheck {
  const fail = (reason: string): StoredPlanCheck => ({ ok: false, reason });
  if (!isRec(value)) return fail('plan_missing');
  const plan = value as Rec;
  if (plan.version !== LAUNCH_PLAN_VERSION) return fail('plan_version');
  if (plan.executable !== true || !isArr(plan.blockers) || plan.blockers.length > 0) return fail('plan_blocked');
  if (plan.type !== 'SEARCH' && plan.type !== 'SHOPPING') return fail('plan_type');
  if (!isStr(plan.name) || !plan.name.trim() || plan.name.length > 128) return fail('plan_name');

  const settings = plan.settings;
  if (!isRec(settings) || settings.status !== 'PAUSED') return fail('plan_not_paused');
  if (settings.search_partners !== false || settings.display_network !== false) return fail('plan_networks');
  if (settings.positive_geo_target_type !== 'PRESENCE' && settings.positive_geo_target_type !== 'PRESENCE_OR_INTEREST') {
    return fail('plan_geo_type');
  }

  const budget = plan.budget;
  if (
    !isRec(budget) ||
    !Number.isInteger(budget.daily_micros) ||
    budget.daily_micros < 10_000 ||
    budget.daily_micros > LAUNCH_MAX_DAILY_BUDGET_SAR * 1_000_000 ||
    budget.daily_micros % 10_000 !== 0
  ) {
    return fail('plan_budget');
  }

  const bidding = plan.bidding;
  if (!isRec(bidding) || !['MAXIMIZE_CLICKS', 'MANUAL_CPC', 'MAXIMIZE_CONVERSIONS'].includes(bidding.strategy)) {
    return fail('plan_bidding');
  }
  if (bidding.strategy === 'MAXIMIZE_CONVERSIONS' && plan.type === 'SHOPPING') return fail('plan_bidding_shopping');
  if (bidding.cpc_ceiling_micros !== null) {
    const ceiling = bidding.cpc_ceiling_micros;
    if (!Number.isInteger(ceiling) || ceiling < 10_000 || ceiling > budget.daily_micros) return fail('plan_cpc_ceiling');
  } else if (bidding.strategy !== 'MAXIMIZE_CONVERSIONS') {
    // An uncapped Maximize Clicks can pay any price (titan 3.9).
    return fail('plan_cpc_ceiling_missing');
  }

  const geo = plan.geo;
  if (!isRec(geo) || geo.country_constant !== 'geoTargetConstants/2682' || !isArr(geo.regions) || geo.regions.length > 10) {
    return fail('plan_geo');
  }
  for (const region of geo.regions) {
    if (!isRec(region) || !isStr(region.geo_target_constant) || !/^geoTargetConstants\/\d+$/.test(region.geo_target_constant)) {
      return fail('plan_geo_region');
    }
  }

  if (!isArr(plan.ad_groups) || plan.ad_groups.length < 1 || plan.ad_groups.length > LAUNCH_MAX_AD_GROUPS) {
    return fail('plan_ad_groups');
  }
  const language = plan.language === 'en' ? 'en' : 'ar';
  const brand = isStr(plan.business_name) ? plan.business_name : null;
  for (const group of plan.ad_groups) {
    if (!isRec(group) || !isStr(group.name) || !group.name.trim() || group.name.length > 255) return fail('plan_group_name');
    if (plan.type === 'SHOPPING') continue;
    if (!httpsUrl(group.final_url)) return fail('plan_group_url');
    if (!isArr(group.keywords) || group.keywords.length < 1 || group.keywords.length > LAUNCH_MAX_KEYWORDS_PER_GROUP) {
      return fail('plan_keywords');
    }
    for (const keyword of group.keywords) {
      if (
        !isRec(keyword) ||
        !isStr(keyword.text) ||
        !keyword.text.trim() ||
        keyword.text.length > 80 ||
        !['EXACT', 'PHRASE'].includes(keyword.match_type)
      ) {
        return fail('plan_keyword');
      }
    }
    const rsa = group.rsa;
    if (!isRec(rsa) || !isArr(rsa.headlines) || !isArr(rsa.descriptions)) return fail('plan_rsa');
    if (rsa.headlines.length < RSA_MIN_HEADLINES || rsa.headlines.length > RSA_MAX_HEADLINES) return fail('plan_rsa_headlines');
    if (rsa.descriptions.length < RSA_MIN_DESCRIPTIONS || rsa.descriptions.length > RSA_MAX_DESCRIPTIONS) {
      return fail('plan_rsa_descriptions');
    }
    // The guarantee check is the merchant's brief to waive; a stored plan was already through it, so it is not repeated here.
    const common = { brand, language, allowGuarantee: true } as const;
    for (const line of rsa.headlines) {
      if (copyIssues(line, { ...common, kind: 'headline' }).length > 0) return fail('plan_rsa_headline_text');
    }
    for (const line of rsa.descriptions) {
      if (copyIssues(line, { ...common, kind: 'description' }).length > 0) return fail('plan_rsa_description_text');
    }
    for (const path of [rsa.path1, rsa.path2]) {
      if (path !== null && path !== undefined && (!isStr(path) || copyIssues(path, { kind: 'path' }).length > 0)) {
        return fail('plan_rsa_path');
      }
    }
  }

  for (const list of [plan.campaign_negatives, plan.shared_negative_list?.keywords]) {
    if (!isArr(list) || list.length > 500) return fail('plan_negatives');
    for (const negative of list) {
      if (!isRec(negative) || !isStr(negative.text) || negative.text.length > 80 || !['EXACT', 'PHRASE'].includes(negative.match_type)) {
        return fail('plan_negative');
      }
    }
  }
  if (!isStr(plan.shared_negative_list?.name) || plan.shared_negative_list.name.length > 255) return fail('plan_shared_list');

  const assets = plan.assets;
  if (!isRec(assets) || !isArr(assets.sitelinks) || !isArr(assets.callouts)) return fail('plan_assets');
  if (assets.sitelinks.length > 6 || assets.callouts.length > 6) return fail('plan_assets_count');
  for (const link of assets.sitelinks) {
    if (!isRec(link) || !httpsUrl(link.final_url) || copyIssues(link.link_text, { kind: 'sitelink_text', language, brand, allowGuarantee: true }).length > 0) {
      return fail('plan_sitelink');
    }
  }
  for (const text of assets.callouts) {
    if (copyIssues(text, { kind: 'callout', language, brand, allowGuarantee: true }).length > 0) return fail('plan_callout');
  }
  if (assets.call_phone !== null && !(isStr(assets.call_phone) && /^\+966\d{8,9}$/.test(assets.call_phone))) return fail('plan_phone');
  const snippet = assets.structured_snippet;
  if (snippet !== null && (!isRec(snippet) || !isStr(snippet.header) || !isArr(snippet.values) || snippet.values.length < 3 || snippet.values.length > 10)) {
    return fail('plan_snippet');
  }

  return { ok: true, plan: value as LaunchPlan };
}

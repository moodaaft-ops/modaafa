import { readReadiness, readinessBlockers, strategyHistoryIssue, type BiddingChoice, type Readiness } from '../growth/readiness';
import { escapeGaql, pickNum, pickStr, safeQuery, type GrowthCustomer } from '../growth/types';
import { safeZone, zoneOffsetMinutes } from '../measurement/time';
import { MIN_CONVERSIONS_PER_ARM, RAMP_UP_DAYS, type ExperimentMetric } from './significance';

/**
 * A campaign experiment (Google ExperimentService): one control campaign, one
 * treatment arm that differs by ONE change, a traffic split, a start and an end.
 * Two kinds of test, in the order google-ads-titan audit-tests-reporting.md 14
 * ranks them: the landing page and the bidding strategy.
 *
 * Rules (the same file): one variable, no overlapping experiments on a campaign,
 * 50/50 by default, 4 to 6 weeks, the first week is learning, about 100 conversions
 * per arm is the goal. A campaign too small for that is told no instead of getting
 * a test that can never conclude.
 */

export const EXPERIMENT_PLAN_VERSION = 1;
export const EXPERIMENT_DURATIONS_DAYS = [28, 35, 42, 56, 70, 84] as const;
export const EXPERIMENT_MAX_DAYS = 84;
/** The campaign needs at least this many conversions in 30 days before a split test makes any sense. */
export const EXPERIMENT_MIN_CAMPAIGN_CONVERSIONS_30D = 15;
/** Planned conversions per arm over the readable part of the run (after the first week). */
export const PLANNED_CONVERSIONS_PER_ARM = 50;
export const SUFFIX = ' | تجربة';

export type ExperimentChange =
  | { type: 'bidding'; strategy: Exclude<BiddingChoice, 'MAXIMIZE_CLICKS'>; target_cpa_micros: number | null }
  | { type: 'landing_page'; final_url: string };

export type ExperimentPlan = {
  version: typeof EXPERIMENT_PLAN_VERSION;
  kind: 'bidding_strategy' | 'landing_page';
  name: string;
  campaign_resource: string;
  campaign_name: string;
  suffix: string;
  /** Percent of traffic on the treatment arm; the control gets the rest. */
  treatment_split: number;
  /** YYYY-MM-DD in the account's time zone. */
  start_date: string;
  end_date: string;
  duration_days: number;
  change: ExperimentChange;
  metric: ExperimentMetric;
  conversions_30d: number;
  expected_conversions_per_arm: number;
  warnings_ar: string[];
};

export type ExperimentBlocker = { code: string; message_ar: string };

export type ExperimentInput = {
  campaign_resource: string;
  kind: 'bidding_strategy' | 'landing_page';
  name?: string;
  treatment_split?: number;
  duration_days?: number;
  strategy?: string;
  target_cpa_sar?: number;
  final_url?: string;
};

export type CampaignReading = {
  name: string;
  status: string;
  channel: string;
  biddingStrategyType: string;
  portfolioStrategy: string;
  finalUrls: string[];
  conversions30d: number;
  inActiveExperiment: boolean;
};

/** Today's date in the account zone, YYYY-MM-DD. */
export function accountDate(now: Date, timeZone: string | null | undefined, plusDays = 0): string {
  const zone = safeZone(timeZone);
  const shifted = new Date(now.getTime() + zoneOffsetMinutes(now, zone) * 60_000 + plusDays * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function readCampaign(customer: GrowthCustomer, campaignResource: string): Promise<CampaignReading | null> {
  const r = escapeGaql(campaignResource);
  const rows = await customer.query(
    `SELECT campaign.resource_name, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.bidding_strategy FROM campaign WHERE campaign.resource_name = '${r}' LIMIT 1`
  );
  const row = rows[0];
  if (!row) return null;
  const metricRows = await safeQuery(
    customer,
    `SELECT metrics.conversions FROM campaign WHERE campaign.resource_name = '${r}' AND segments.date DURING LAST_30_DAYS`
  );
  const adRows = await safeQuery(
    customer,
    `SELECT ad_group_ad.ad.final_urls FROM ad_group_ad WHERE campaign.resource_name = '${r}' AND ad_group_ad.status = 'ENABLED' LIMIT 50`
  );
  const finalUrls: string[] = [];
  for (const ad of adRows) {
    const urls = (ad as any)?.adGroupAd?.ad?.finalUrls ?? (ad as any)?.ad_group_ad?.ad?.final_urls ?? [];
    for (const u of Array.isArray(urls) ? urls : []) if (typeof u === 'string' && !finalUrls.includes(u)) finalUrls.push(u);
  }
  return {
    name: pickStr(row, 'campaign.name'),
    status: pickStr(row, 'campaign.status'),
    channel: pickStr(row, 'campaign.advertising_channel_type'),
    biddingStrategyType: pickStr(row, 'campaign.bidding_strategy_type'),
    portfolioStrategy: pickStr(row, 'campaign.bidding_strategy'),
    finalUrls,
    conversions30d: metricRows.reduce((sum, m) => sum + (pickNum(m, 'metrics.conversions') ?? 0), 0),
    inActiveExperiment: await campaignInActiveExperiment(customer, campaignResource),
  };
}

/** True when the campaign is the control of an experiment that has not ended. */
export async function campaignInActiveExperiment(customer: GrowthCustomer, campaignResource: string): Promise<boolean> {
  const active = await customer.query(
    `SELECT experiment.resource_name FROM experiment WHERE experiment.status IN ('SETUP', 'INITIATED', 'ENABLED', 'DRAFT') LIMIT 50`
  );
  const names = active.map((row) => pickStr(row, 'experiment.resource_name')).filter(Boolean);
  if (names.length === 0) return false;
  const arms = await customer.query(
    `SELECT experiment_arm.resource_name, experiment_arm.campaigns FROM experiment_arm WHERE experiment_arm.experiment IN (${names
      .map((n) => `'${escapeGaql(n)}'`)
      .join(', ')})`
  );
  return arms.some((arm) => {
    const list = (arm as any)?.experimentArm?.campaigns ?? (arm as any)?.experiment_arm?.campaigns ?? [];
    return Array.isArray(list) && list.includes(campaignResource);
  });
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Smallest standard duration in which each arm can reach the planned conversions after the first week. */
export function suggestDuration(conversions30d: number, treatmentSplit: number): { days: number; perArm: number } | null {
  const smallestShare = Math.min(treatmentSplit, 100 - treatmentSplit) / 100;
  const perDayPerArm = (conversions30d / 30) * smallestShare;
  for (const days of EXPERIMENT_DURATIONS_DAYS) {
    const perArm = perDayPerArm * (days - RAMP_UP_DAYS);
    if (perArm >= PLANNED_CONVERSIONS_PER_ARM) return { days, perArm: Math.floor(perArm) };
  }
  return null;
}

export type ExperimentProposal =
  | { ok: true; plan: ExperimentPlan }
  | { ok: false; blockers: ExperimentBlocker[] };

/**
 * Decides whether a test may be proposed and, if so, builds the plan.
 * Pure: the readings come from `readCampaign` and `readReadiness`.
 */
export function buildExperimentPlan(
  input: ExperimentInput,
  campaign: CampaignReading | null,
  readiness: Readiness,
  now: Date
): ExperimentProposal {
  const blockers: ExperimentBlocker[] = [];
  const block = (code: string, message_ar: string) => blockers.push({ code, message_ar });
  const warnings: string[] = [];

  if (!campaign) return { ok: false, blockers: [{ code: 'campaign_missing', message_ar: 'الحملة مو موجودة في الحساب' }] };
  if (campaign.channel !== 'SEARCH') block('channel', 'التجارب هنا للحملات النصية (بحث) بس');
  if (campaign.status !== 'ENABLED') block('campaign_not_running', 'الحملة لازم تكون شغالة عشان نختبر عليها');
  if (campaign.inActiveExperiment) block('overlap', 'الحملة فيها تجربة شغالة. ما نشغل تجربتين على نفس الحملة');
  for (const message of readinessBlockers(readiness)) block('tracking_not_healthy', message);

  const split = input.treatment_split ?? 50;
  if (!Number.isInteger(split) || split < 20 || split > 50) block('split', 'نسبة التجربة من 20 إلى 50 بالمية');

  if (campaign.conversions30d < EXPERIMENT_MIN_CAMPAIGN_CONVERSIONS_30D) {
    block(
      'volume_too_low',
      `الحملة جابت ${Math.floor(campaign.conversions30d)} تحويل في آخر 30 يوم. تحت ${EXPERIMENT_MIN_CAMPAIGN_CONVERSIONS_30D} ما يستاهل نقسمها، التجربة ما تقدر تحكم`
    );
  }

  let change: ExperimentChange | null = null;
  if (input.kind === 'bidding_strategy') {
    if (campaign.portfolioStrategy) block('portfolio', 'الحملة على استراتيجية مشتركة، ما نختبر عليها');
    const strategy = String(input.strategy ?? '').toUpperCase();
    if (strategy !== 'MAXIMIZE_CONVERSIONS' && strategy !== 'TARGET_CPA') {
      block('strategy', 'نختبر أكثر تحويلات أو هدف تكلفة تحويل بس');
    } else {
      const current = campaign.biddingStrategyType;
      const same = (strategy === 'MAXIMIZE_CONVERSIONS' && current === 'MAXIMIZE_CONVERSIONS') || (strategy === 'TARGET_CPA' && current === 'TARGET_CPA');
      if (same) block('same_strategy', 'الحملة على هالمزايدة من الحين');
      const history = strategyHistoryIssue(strategy, readiness.conversions30d);
      if (history) block('strategy_history', history);
      let targetCpa: number | null = null;
      if (strategy === 'TARGET_CPA') {
        const cpa = Number(input.target_cpa_sar);
        if (!Number.isFinite(cpa) || cpa <= 0) block('target_cpa', 'هدف تكلفة التحويل ناقص');
        else targetCpa = Math.round((cpa * 1_000_000) / 10_000) * 10_000;
      }
      change = { type: 'bidding', strategy, target_cpa_micros: targetCpa };
    }
  } else if (input.kind === 'landing_page') {
    const url = String(input.final_url ?? '').trim();
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== 'https:' || /\s/.test(url) || url.length > 2000) {
      block('landing_url', 'رابط الصفحة الجديدة لازم يكون https وصحيح');
    } else {
      const hosts = new Set(campaign.finalUrls.map(hostOf).filter(Boolean));
      if (hosts.size > 0 && !hosts.has(hostOf(url))) block('landing_host', 'الصفحة الجديدة لازم تكون على نفس موقع الإعلانات الحالية');
      if (campaign.finalUrls.length === 0) block('no_ads', 'ما لقينا إعلانات شغالة في الحملة نغيّر رابطها في التجربة');
      if (campaign.finalUrls.includes(parsed.toString()) || campaign.finalUrls.includes(url)) block('same_url', 'الإعلانات على هالرابط من الحين');
      change = { type: 'landing_page', final_url: parsed.toString() };
    }
  } else {
    block('kind', 'نوع التجربة غير معروف');
  }

  const suggested = suggestDuration(campaign.conversions30d, Number.isInteger(split) ? split : 50);
  let durationDays = input.duration_days ?? suggested?.days ?? 0;
  if (!suggested && campaign.conversions30d >= EXPERIMENT_MIN_CAMPAIGN_CONVERSIONS_30D) {
    block(
      'duration_too_long',
      `بحجم الحملة الحالي ما نوصل ${PLANNED_CONVERSIONS_PER_ARM} تحويل لكل طرف حتى بعد ${EXPERIMENT_MAX_DAYS} يوم. التجربة ما تستاهل`
    );
  }
  if (input.duration_days !== undefined) {
    if (!Number.isInteger(durationDays) || durationDays < 28 || durationDays > EXPERIMENT_MAX_DAYS) {
      block('duration', `مدة التجربة من 28 إلى ${EXPERIMENT_MAX_DAYS} يوم`);
    } else if (suggested && durationDays < suggested.days) {
      warnings.push(`المدة اللي اخترتها أقصر من ${suggested.days} يوم المقترحة، وقد ما تكفي التحويلات لحكم واضح`);
    }
  }

  if (blockers.length > 0 || !change) return { ok: false, blockers };

  const startDate = accountDate(now, readiness.timeZone, 1);
  const perArm =
    Math.floor((campaign.conversions30d / 30) * (Math.min(split, 100 - split) / 100) * Math.max(0, durationDays - RAMP_UP_DAYS));
  if (perArm < MIN_CONVERSIONS_PER_ARM) warnings.push('عدد التحويلات المتوقع لكل طرف قليل، وقد تنتهي التجربة بدون حكم');
  warnings.push('أول 7 أيام تعلّم، ما نحسبها بالحكم');

  const name = (input.name ?? `${campaign.name} | ${input.kind === 'landing_page' ? 'صفحة' : 'مزايدة'}`).slice(0, 80);
  return {
    ok: true,
    plan: {
      version: EXPERIMENT_PLAN_VERSION,
      kind: input.kind,
      name,
      campaign_resource: input.campaign_resource,
      campaign_name: campaign.name,
      suffix: SUFFIX,
      treatment_split: split,
      start_date: startDate,
      end_date: addDaysIso(startDate, durationDays),
      duration_days: durationDays,
      change,
      metric: input.kind === 'landing_page' ? 'conversion_rate' : 'cost_per_conversion',
      conversions_30d: Math.round(campaign.conversions30d * 100) / 100,
      expected_conversions_per_arm: perArm,
      warnings_ar: warnings,
    },
  };
}

export async function proposeExperimentPlan(customer: GrowthCustomer, input: ExperimentInput, now = new Date()): Promise<ExperimentProposal> {
  const [campaign, readiness] = await Promise.all([readCampaign(customer, input.campaign_resource), readReadiness(customer, now)]);
  return buildExperimentPlan(input, campaign, readiness, now);
}

/** Stored plan check, run again at execution. */
export function validateStoredExperimentPlan(value: unknown, customerId?: string | null): { ok: true; plan: ExperimentPlan } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  const p = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
  if (!p) return fail('plan_missing');
  if (p.version !== EXPERIMENT_PLAN_VERSION) return fail('plan_version');
  if (p.kind !== 'bidding_strategy' && p.kind !== 'landing_page') return fail('plan_kind');
  const scope = customerId ? String(customerId).replace(/\D/g, '') : '\\d+';
  if (typeof p.campaign_resource !== 'string' || !new RegExp(`^customers/${scope}/campaigns/\\d+$`).test(p.campaign_resource)) return fail('plan_campaign');
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80) return fail('plan_name');
  if (typeof p.suffix !== 'string' || !p.suffix.trim() || p.suffix.length > 30) return fail('plan_suffix');
  if (!Number.isInteger(p.treatment_split) || p.treatment_split < 20 || p.treatment_split > 50) return fail('plan_split');
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!date.test(String(p.start_date)) || !date.test(String(p.end_date)) || String(p.end_date) <= String(p.start_date)) return fail('plan_dates');
  if (!Number.isInteger(p.duration_days) || p.duration_days < 28 || p.duration_days > EXPERIMENT_MAX_DAYS) return fail('plan_duration');
  if (p.metric !== 'conversion_rate' && p.metric !== 'cost_per_conversion') return fail('plan_metric');
  const change = p.change;
  if (!change || typeof change !== 'object') return fail('plan_change');
  if (p.kind === 'bidding_strategy') {
    if (change.type !== 'bidding' || !['MAXIMIZE_CONVERSIONS', 'TARGET_CPA'].includes(change.strategy)) return fail('plan_change');
    if (change.strategy === 'TARGET_CPA' && !(Number.isInteger(change.target_cpa_micros) && change.target_cpa_micros >= 10_000)) return fail('plan_change');
    if (change.strategy === 'MAXIMIZE_CONVERSIONS' && change.target_cpa_micros !== null) return fail('plan_change');
    if (p.metric !== 'cost_per_conversion') return fail('plan_metric');
  } else {
    if (change.type !== 'landing_page' || typeof change.final_url !== 'string' || !/^https:\/\/[^\s/]+(\/\S*)?$/.test(change.final_url)) return fail('plan_change');
    if (p.metric !== 'conversion_rate') return fail('plan_metric');
  }
  return { ok: true, plan: value as ExperimentPlan };
}

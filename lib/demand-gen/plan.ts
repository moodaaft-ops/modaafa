import { CPC_CAP_BUDGET_DIVISOR } from '../ai/builder-gates';
import { cleanKeywordText } from '../launch/arabic';
import { cleanCopyList, COPY_ISSUE_AR, copyIssues } from '../launch/copy';
import { resolveSiteUrl } from '../launch/assets';
import { STRATEGY_MIN_CONVERSIONS_30D, type BiddingChoice } from '../growth/readiness';
import {
  DEMAND_GEN_PLAN_VERSION,
  SAUDI_COUNTRY_CONSTANT,
  type DemandGenBlocker,
  type DemandGenBlockerCode,
  type DemandGenImages,
  type DemandGenPlan,
} from './types';

/**
 * Builds a Demand Gen plan from the merchant's brief. Pure: no I/O, no clock, no model.
 *
 * Numbers and where they come from (google-ads-titan references/video-demandgen-mastery.md 22.1, 22.5, and
 * pmax-shopping-demandgen.md «البيدنق والميزانية»):
 *  - Technical floor of the API: 5 USD a day, about 19 SAR. The plan floor is 20 SAR.
 *  - Google's best practice for Maximize strategies: 100 USD a day, about 375 SAR. Below it the plan still builds,
 *    with a warning that reading results will be slower.
 *  - With a target CPA the daily budget is at least 10 times the target (hard rule).
 *  - Bidding: Max Clicks (cold data gathering, capped CPC), Max Conversions, tCPA. tROAS and
 *    Max Conversion Value need the value rule (50 valued conversions in 35 days) and are not built here.
 *  - Text limits: headline 30, long headline and description 90, business name 25. Google's current Demand Gen
 *    headline limit may be 40; 30 is used because it is accepted everywhere.
 */

export const DEMAND_GEN_MIN_DAILY_SAR = 20;
export const DEMAND_GEN_RECOMMENDED_DAILY_SAR = 375;
export const DEMAND_GEN_MAX_DAILY_SAR = 5000;
export const TCPA_BUDGET_MULTIPLE = 10;
export const MAX_HEADLINES = 5;
export const MAX_LONG_HEADLINES = 5;
export const MAX_DESCRIPTIONS = 5;
const MAX_IMAGES_PER_SLOT = 10;
const MAX_USER_LISTS = 5;

type Rec = Record<string, any>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const finite = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const roundMicros = (sar: number) => Math.round((sar * 1_000_000) / 10_000) * 10_000;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const ASSET_RE = /^customers\/\d+\/assets\/\d+$/;
const USER_LIST_RE = /^customers\/\d+\/userLists\/\d+$/;
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** A YouTube watch, share or shorts URL, or the bare 11 character id. */
export function parseYoutubeId(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  if (YOUTUBE_ID_RE.test(text)) return text;
  try {
    const url = new URL(text);
    const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
    else if (host === 'youtube.com') {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else {
        const m = /^\/(?:shorts|embed|live)\/([^/?]+)/.exec(url.pathname);
        id = m ? m[1] : null;
      }
    }
    return id && YOUTUBE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export type DemandGenInput = {
  name?: unknown;
  daily_budget_sar?: unknown;
  bidding_strategy?: unknown;
  target_cpa_sar?: unknown;
  max_cpc_sar?: unknown;
  landing_page?: unknown;
  business_name?: unknown;
  language?: unknown;
  headlines?: unknown;
  long_headlines?: unknown;
  descriptions?: unknown;
  marketing_images?: unknown;
  square_images?: unknown;
  portrait_images?: unknown;
  logo_images?: unknown;
  youtube_video?: unknown;
  user_lists?: unknown;
  exclude_user_lists?: unknown;
  target_regions?: unknown;
};

export type DemandGenContext = {
  website?: string | null;
  businessName?: string | null;
  /** Region name -> geoTargetConstants/<id>. */
  resolvedRegions?: Record<string, string>;
};

const STRATEGIES: readonly BiddingChoice[] = ['MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS', 'TARGET_CPA'];

function cleanAssets(raw: unknown, removed: string[], bad: { value: boolean }): string[] {
  const out: string[] = [];
  for (const item of list(raw)) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (!ASSET_RE.test(text)) {
      bad.value = true;
      continue;
    }
    if (!out.includes(text)) out.push(text);
  }
  if (out.length > MAX_IMAGES_PER_SLOT) {
    removed.push(`الصور أكثر من ${MAX_IMAGES_PER_SLOT} في نفس الخانة، أخذنا أول ${MAX_IMAGES_PER_SLOT}`);
    return out.slice(0, MAX_IMAGES_PER_SLOT);
  }
  return out;
}

export function buildDemandGenPlan(input: DemandGenInput, context: DemandGenContext = {}): DemandGenPlan {
  const blockers: DemandGenBlocker[] = [];
  const warnings: string[] = [];
  const removed: string[] = [];
  const block = (code: DemandGenBlockerCode, message_ar: string) => blockers.push({ code, message_ar });

  const language: 'ar' | 'en' = input.language === 'en' ? 'en' : 'ar';
  const brandInput = cleanKeywordText(typeof input.business_name === 'string' ? input.business_name : context.businessName ?? '');
  const nameInput = cleanKeywordText(typeof input.name === 'string' ? input.name : '');
  const name = nameInput.slice(0, 100);
  if (!name) block('name_missing', 'اسم الحملة ناقص');

  // ---- Business name -------------------------------------------------------------
  let businessName = brandInput;
  if (!businessName || copyIssues(businessName, { kind: 'callout', language: null, allowGuarantee: true }).length > 0) {
    block('business_name_invalid', 'اسم النشاط التجاري ناقص أو أطول من 25 حرف');
    businessName = brandInput.slice(0, 25);
  }

  // ---- Budget --------------------------------------------------------------------
  const budgetSar = finite(input.daily_budget_sar);
  if (budgetSar === null || budgetSar <= 0) block('budget_missing', 'الميزانية اليومية ناقصة');
  else if (budgetSar < DEMAND_GEN_MIN_DAILY_SAR) {
    block('budget_too_low', `أقل ميزانية يومية لحملة ديماند جن ${DEMAND_GEN_MIN_DAILY_SAR} ريال`);
  } else if (budgetSar > DEMAND_GEN_MAX_DAILY_SAR) {
    block('budget_too_high', `الميزانية اليومية أكبر من ${DEMAND_GEN_MAX_DAILY_SAR} ريال، غالباً خطأ بالرقم`);
  } else if (budgetSar < DEMAND_GEN_RECOMMENDED_DAILY_SAR) {
    warnings.push('الميزانية أقل من اللي توصي فيه قوقل لهذا النوع من الحملات، فالنتايج تتأخر وقراءتها أبطأ');
  }
  const dailyMicros = budgetSar !== null && budgetSar > 0 ? roundMicros(budgetSar) : 0;

  // ---- Bidding -------------------------------------------------------------------
  const strategyRaw = String(input.bidding_strategy ?? 'MAXIMIZE_CONVERSIONS').toUpperCase();
  let strategy: BiddingChoice = 'MAXIMIZE_CONVERSIONS';
  if ((STRATEGIES as readonly string[]).includes(strategyRaw)) strategy = strategyRaw as BiddingChoice;
  else block('bidding_unsupported', 'نوع المزايدة هذا ما نبنيه الحين. المتاح: أكثر نقرات، أكثر تحويلات، أو هدف تكلفة تحويل');

  let targetCpaMicros: number | null = null;
  let cpcCeilingMicros: number | null = null;
  let note = '';
  if (strategy === 'TARGET_CPA') {
    const cpa = finite(input.target_cpa_sar);
    if (cpa === null || cpa <= 0) block('target_cpa_missing', 'هدف تكلفة التحويل ناقص');
    else {
      targetCpaMicros = roundMicros(cpa);
      if (budgetSar !== null && budgetSar > 0 && budgetSar < cpa * TCPA_BUDGET_MULTIPLE) {
        block(
          'budget_below_tcpa_multiple',
          `الميزانية اليومية لازم تكون ${TCPA_BUDGET_MULTIPLE} أضعاف هدف التكلفة على الأقل (${Math.ceil(cpa * TCPA_BUDGET_MULTIPLE)} ريال)`
        );
      }
    }
    note = 'قوقل تلاحق هدف تكلفة التحويل اللي حددته';
  } else if (strategy === 'MAXIMIZE_CONVERSIONS') {
    note = 'قوقل تجيب أكبر عدد تحويلات بالميزانية بدون هدف تكلفة';
  } else {
    // Uncapped Max Clicks can pay any price: a ceiling is always set.
    const ceiling = finite(input.max_cpc_sar);
    const fallback = budgetSar !== null && budgetSar > 0 ? budgetSar / CPC_CAP_BUDGET_DIVISOR : null;
    const chosen = ceiling !== null && ceiling > 0 ? ceiling : fallback;
    if (chosen !== null) {
      cpcCeilingMicros = roundMicros(chosen);
      if (dailyMicros > 0) cpcCeilingMicros = Math.min(Math.max(cpcCeilingMicros, 10_000), dailyMicros);
    }
    note = 'نقرات بسقف للنقرة، مناسبة لجمع بيانات أول أسبوعين أو ثلاثة بس';
    warnings.push('أكثر نقرات تجيب زيارات رخيصة وسطحية. استخدمها لجمع بيانات بس وبعدها حوّل لأكثر تحويلات');
  }

  // ---- Landing page --------------------------------------------------------------
  const finalUrl = resolveSiteUrl(typeof input.landing_page === 'string' ? input.landing_page : '', context.website ?? null);
  if (!finalUrl) block('no_landing_page', 'رابط صفحة الهبوط ناقص أو مو https');

  // ---- Copy ----------------------------------------------------------------------
  const common = { brand: businessName, allowGuarantee: false, language } as const;
  const headlines = cleanCopyList(input.headlines, { ...common, kind: 'headline', max: MAX_HEADLINES });
  const longHeadlines = cleanCopyList(input.long_headlines, { ...common, kind: 'description', max: MAX_LONG_HEADLINES });
  const descriptions = cleanCopyList(input.descriptions, { ...common, kind: 'description', max: MAX_DESCRIPTIONS });
  for (const dropped of [...headlines.dropped, ...longHeadlines.dropped, ...descriptions.dropped]) {
    removed.push(`«${dropped.text}»: ${dropped.issues.map((c) => COPY_ISSUE_AR[c]).join('، ')}`);
  }

  // ---- Creative --------------------------------------------------------------------
  const bad = { value: false };
  const images: DemandGenImages = {
    marketing: cleanAssets(input.marketing_images, removed, bad),
    square: cleanAssets(input.square_images, removed, bad),
    portrait: cleanAssets(input.portrait_images, removed, bad),
    logo: cleanAssets(input.logo_images, removed, bad),
  };
  if (bad.value) block('image_resource_invalid', 'فيه صورة مو معرّفة صح. الصور لازم ترفعها لحسابك أول');
  const videoRaw = input.youtube_video;
  const videoId = videoRaw === undefined || videoRaw === null || videoRaw === '' ? null : parseYoutubeId(videoRaw);
  if (videoRaw && !videoId) block('video_id_invalid', 'رابط اليوتيوب ما انفهم، حط رابط الفيديو كامل أو الـ11 حرف');

  const hasStills = images.marketing.length + images.square.length + images.portrait.length > 0;
  if (!hasStills && !videoId) block('creative_required', 'لازم صور أو فيديو يوتيوب للإعلان');
  if (images.logo.length === 0 && (hasStills || videoId)) block('logo_required', 'الإعلان يحتاج شعار مربع');

  if (headlines.kept.length < 1) block('too_few_headlines', 'ما بقي عنوان صالح للإعلان');
  if (descriptions.kept.length < 1) block('too_few_descriptions', 'ما بقي وصف صالح للإعلان');
  if (videoId && longHeadlines.kept.length < 1) block('too_few_long_headlines', 'إعلان الفيديو يحتاج عنوان طويل واحد على الأقل');
  if (hasStills && images.marketing.length === 0) {
    warnings.push('ما فيه صورة أفقية. قوقل توصي بصور أفقية ومربعة وعمودية في إعلان واحد');
  }
  if (videoId) warnings.push('الفيديو لازم 5 ثواني على الأقل، وتحت 10 ثواني ما يطلع في إعلانات ما قبل الفيديو');

  // ---- Audience --------------------------------------------------------------------
  const userLists: string[] = [];
  const excludeLists: string[] = [];
  let badList = false;
  for (const [source, target] of [
    [input.user_lists, userLists],
    [input.exclude_user_lists, excludeLists],
  ] as const) {
    for (const item of list(source)) {
      const text = typeof item === 'string' ? item.trim() : '';
      if (!USER_LIST_RE.test(text)) badList = true;
      else if (!target.includes(text)) target.push(text);
    }
  }
  if (badList) block('audience_resource_invalid', 'فيه قائمة جمهور مو معرّفة صح');
  if (userLists.length > MAX_USER_LISTS || excludeLists.length > MAX_USER_LISTS) {
    removed.push(`قوائم الجمهور أكثر من ${MAX_USER_LISTS}، أخذنا الأولى`);
    userLists.splice(MAX_USER_LISTS);
    excludeLists.splice(MAX_USER_LISTS);
  }
  if (userLists.some((u) => excludeLists.includes(u))) {
    block('audience_resource_invalid', 'نفس القائمة موجودة في الاستهداف وفي الاستبعاد');
  }
  if (userLists.length === 0) {
    warnings.push('بدون قائمة جمهور الحملة تنشر على جمهور مفتوح. الأفضل تبدأ بإعادة استهداف زوار موقعك');
  }

  // ---- Geo -------------------------------------------------------------------------
  const regionNames = Array.from(
    new Set(list(input.target_regions).map((r) => cleanKeywordText(typeof r === 'string' ? r : '')).filter(Boolean))
  ).slice(0, 10);
  const regions: Array<{ name: string; geo_target_constant: string }> = [];
  for (const regionName of regionNames) {
    const constant = context.resolvedRegions?.[regionName];
    if (constant && /^geoTargetConstants\/\d+$/.test(constant)) regions.push({ name: regionName, geo_target_constant: constant });
    else {
      block('regions_unresolved', `ما قدرنا نحدد المنطقة «${regionName}». ما نوسّع على كل السعودية بدون ما تقول`);
      break;
    }
  }

  const plan: DemandGenPlan = {
    version: DEMAND_GEN_PLAN_VERSION,
    type: 'DEMAND_GEN',
    name,
    language,
    business_name: businessName,
    budget: { daily_sar: budgetSar !== null && budgetSar > 0 ? dailyMicros / 1_000_000 : 0, daily_micros: dailyMicros },
    bidding: { strategy, target_cpa_micros: targetCpaMicros, cpc_ceiling_micros: cpcCeilingMicros, note_ar: note },
    geo: { country_constant: SAUDI_COUNTRY_CONSTANT, regions },
    channels: { youtube_in_feed: true, youtube_in_stream: true, youtube_shorts: true, discover: true, gmail: true, display: false },
    ad_group_name: name ? `${name} | مجموعة` : 'مجموعة',
    final_url: finalUrl ?? '',
    copy: { headlines: headlines.kept, long_headlines: longHeadlines.kept, descriptions: descriptions.kept },
    images,
    video: videoId ? { youtube_video_id: videoId } : null,
    audience: { user_lists: userLists, exclude_user_lists: excludeLists },
    blockers,
    warnings_ar: warnings,
    removed_ar: removed,
    executable: blockers.length === 0,
  };
  return plan;
}

/**
 * Account-level checks run against live readings. Returns blockers to add to the plan.
 * Used when the card is proposed and again at execution.
 */
export function evaluateDemandGenReadiness(
  plan: Pick<DemandGenPlan, 'bidding'>,
  readiness: { verdict: string | null; issues_ar: string[]; conversions30d: number | null; currency: string | null }
): DemandGenBlocker[] {
  const out: DemandGenBlocker[] = [];
  if (readiness.verdict === null) {
    out.push({ code: 'tracking_not_healthy', message_ar: 'ما قدرنا نتأكد من سلامة التتبع الحين، جرّب بعد شوي' });
  } else if (readiness.verdict !== 'healthy') {
    out.push({
      code: 'tracking_not_healthy',
      message_ar: `${readiness.issues_ar[0] ?? 'التتبع فيه خلل'}. نصلحه قبل لا نصرف على ديماند جن`,
    });
  }
  if (readiness.currency !== null && readiness.currency !== 'SAR') {
    out.push({ code: 'not_sar', message_ar: 'الحساب مو بالريال السعودي، ما نبني عليه حملة بميزانية بالريال' });
  }
  const need = STRATEGY_MIN_CONVERSIONS_30D[plan.bidding.strategy];
  if (need > 0) {
    const have = readiness.conversions30d;
    if (have === null || have < need) {
      out.push({
        code: 'strategy_history_missing',
        message_ar:
          have === null
            ? 'ما قدرنا نقرا تحويلات آخر 30 يوم، فما نثبت إن الحساب يكفي لهالمزايدة'
            : `هالمزايدة تحتاج ${need} تحويل في آخر 30 يوم والحساب عنده ${Math.floor(have)} بس. ابدأ بأكثر نقرات أو اجمع تحويلات من البحث أول`,
      });
    }
  }
  return out;
}

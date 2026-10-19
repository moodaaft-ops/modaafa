import {
  CPC_CAP_BUDGET_DIVISOR,
  TARGET_BIDDING_MIN_CONVERSIONS_30D,
  UNKNOWN_BUILDER_SIGNALS,
  applyBuilderGates,
  mentionsGuarantee,
  strategyNoteAr,
  type BuilderAccountSignals,
} from '@/lib/ai/builder-gates';
import { cleanKeywordText, expandAndDedupeKeywords, normalizeArabicKey } from './arabic';
import { buildAssets, resolveSiteUrl } from './assets';
import { buildRsa } from './copy';
import { buildNegativePlan } from './negatives';
import {
  LAUNCH_PLAN_VERSION,
  SAUDI_GEO_TARGET_CONSTANT,
  type LaunchAdGroup,
  type LaunchBlocker,
  type LaunchKeyword,
  type LaunchPlan,
} from './types';

/**
 * Turns the builder's gated draft into a launch plan. Pure: no I/O, no clock,
 * no model. The same draft and context always give the same plan.
 *
 * Campaign type (google-ads-titan 3.4, 21.12):
 *  - Search is the default.
 *  - A store with Merchant Center linked and under 30 conversions a month starts
 *    on Standard Shopping.
 *  - Performance Max only when builder-gates already allowed it; the plan is
 *    built for the preview but is not executable (no image assets yet).
 */

/** A typo guard on the daily budget, not a benchmark. */
export const LAUNCH_MAX_DAILY_BUDGET_SAR = 5000;
export const LAUNCH_MAX_AD_GROUPS = 6;
export const LAUNCH_MAX_KEYWORDS_PER_GROUP = 40;
export const LAUNCH_MAX_KEYWORDS_TOTAL = 200;
const MAX_REGIONS = 10;
const CAMPAIGN_NAME_MAX = 100;
const AD_GROUP_NAME_MAX = 80;
const KEYWORD_MAX_CHARS = 80;
const KEYWORD_MAX_WORDS = 10;

export type LaunchContext = {
  brief: string;
  businessName?: string | null;
  sector?: string | null;
  website?: string | null;
  phone?: string | null;
  monthlyBudgetSar?: number | null;
  currency?: string | null;
  signals?: BuilderAccountSignals | null;
  /** Region name -> geoTargetConstants/<id>, from lib/launch/geo.ts. */
  resolvedRegions?: Record<string, string>;
};

type Rec = Record<string, any>;
const asRecord = (value: unknown): Rec | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const roundMicros = (sar: number) => Math.round((sar * 1_000_000) / 10_000) * 10_000;

const CLINIC = /عياد|مستشف|مجمع\s*طبي|مركز\s*طبي|اسنان|أسنان|جلدي|طبيب|dental|clinic/i;
const LOCAL = /مطعم|كافيه|مقهى|صالون|حلاق|معرض|محل|سبا|spa|نادي|restaurant|cafe|salon/i;
const STORE = /متجر|سلة|شوبيفاي|shopify|store|shop|ecommerce|تجارة\s*الكترون/i;

export function inferBusinessKind(
  sector: string | null | undefined,
  objective: 'SALES' | 'LEADS' | null,
  type: string
): LaunchPlan['business_kind'] {
  const text = String(sector ?? '');
  if (CLINIC.test(text)) return 'clinic';
  if (STORE.test(text) || type === 'SHOPPING' || type === 'PMAX') return 'ecommerce';
  if (LOCAL.test(text)) return 'local';
  if (objective === 'LEADS') return 'services';
  if (objective === 'SALES') return 'ecommerce';
  return 'general';
}

function cleanRegions(draft: Rec): string[] {
  const names: string[] = [];
  const push = (value: unknown) => {
    const text = cleanKeywordText(typeof value === 'string' ? value : '');
    if (!text || text.length > 60) return;
    const key = normalizeArabicKey(text);
    // The whole country is the default; it is not a region to resolve.
    if (['السعوديه', 'المملكه', 'المملكه العربيه السعوديه', 'sa', 'saudi arabia', 'ksa'].includes(key)) return;
    if (!names.some((n) => normalizeArabicKey(n) === key)) names.push(text);
  };
  for (const target of Array.isArray(draft.geo_targets) ? draft.geo_targets : []) {
    for (const region of Array.isArray(asRecord(target)?.regions) ? asRecord(target)!.regions : []) push(region);
  }
  for (const region of Array.isArray(draft.target_regions) ? draft.target_regions : []) push(region);
  return names.slice(0, MAX_REGIONS);
}

function validKeyword(text: string): boolean {
  if (!text || text.length > KEYWORD_MAX_CHARS) return false;
  if (text.split(' ').length > KEYWORD_MAX_WORDS) return false;
  // Google rejects these inside a keyword.
  return !/[!@%^*()=\[\]{}<>,;:\\|~`"“”؟?]/.test(text);
}

function rawKeywords(group: Rec): Array<{ text: string; match_type: 'EXACT' | 'PHRASE' | 'BROAD' }> {
  const out: Array<{ text: string; match_type: 'EXACT' | 'PHRASE' | 'BROAD' }> = [];
  for (const item of Array.isArray(group.keywords) ? group.keywords : []) {
    const entry = typeof item === 'string' ? { text: item } : asRecord(item);
    if (!entry) continue;
    const text = cleanKeywordText(String(entry.text ?? ''));
    const type = String(entry.match_type ?? 'PHRASE').toUpperCase();
    out.push({ text, match_type: type === 'EXACT' ? 'EXACT' : type === 'BROAD' ? 'BROAD' : 'PHRASE' });
  }
  return out;
}

export function buildLaunchPlan(rawDraft: unknown, context: LaunchContext): LaunchPlan {
  const signals: BuilderAccountSignals = { ...UNKNOWN_BUILDER_SIGNALS, ...(context.signals ?? {}) };
  // Re-run the gates: a stored draft may predate a rule, and the plan must not depend on who saved it.
  const gated = applyBuilderGates(rawDraft, { brief: context.brief, signals });
  const draft = gated.draft as Rec;

  const blockers: LaunchBlocker[] = [];
  const warnings: string[] = [];
  const removed: string[] = [];
  const block = (code: LaunchBlocker['code'], message_ar: string) => blockers.push({ code, message_ar });

  const objective = draft.objective === 'SALES' || draft.objective === 'LEADS' ? draft.objective : null;
  const businessName = cleanKeywordText(String(context.businessName ?? draft.business_name ?? '')) || null;
  const kind = inferBusinessKind(context.sector, objective, String(draft.type ?? 'SEARCH'));
  const language: 'ar' | 'en' = String(draft.language ?? 'ar').toLowerCase().startsWith('en') ? 'en' : 'ar';
  const allowGuarantee = mentionsGuarantee(context.brief);

  // ---- Type ------------------------------------------------------------------
  let type = String(draft.type ?? 'SEARCH') as LaunchPlan['type'];
  if (type === 'DISPLAY' || type === 'VIDEO') {
    block('unsupported_type', 'نوع الحملة هذا ما نبنيه تلقائياً بعد. نبدأ بحملة بحث أو تسوق.');
  }
  const lowVolume = signals.conversions_30d === null || signals.conversions_30d < TARGET_BIDDING_MIN_CONVERSIONS_30D;
  if (type === 'SEARCH' && kind === 'ecommerce' && signals.merchant_center_linked === true && lowVolume) {
    type = 'SHOPPING';
    warnings.push(
      'حسابك فيه Merchant Center ومبيعاتك تحت 30 بالشهر، فنبدأ بحملة تسوق عادية. تتحكم بالسعر وتشوف أي المنتجات تبيع، وبعدها نفتح حملة البحث.'
    );
  }

  // ---- Currency and budget ----------------------------------------------------
  const currency = String(context.currency ?? 'SAR').toUpperCase();
  if (currency !== 'SAR') {
    block('not_sar', 'عملة حسابك مو الريال، وأرقام الخطة بالريال. ما نبني الحملة تلقائياً.');
  }
  const dailySar = finite(draft.daily_budget_sar);
  if (dailySar === null || dailySar <= 0) {
    block('budget_missing', 'حدد الميزانية اليومية قبل البناء.');
  } else if (
    dailySar > LAUNCH_MAX_DAILY_BUDGET_SAR ||
    (finite(context.monthlyBudgetSar) !== null && dailySar * 30.4 > (finite(context.monthlyBudgetSar) as number) * 1.25)
  ) {
    block('budget_unreasonable', 'الميزانية اليومية أعلى من المتوقع لميزانيتك الشهرية. تأكد من الرقم.');
  }
  const budgetSar = dailySar !== null && dailySar > 0 ? Math.round(dailySar * 100) / 100 : 0;

  // ---- Bidding ----------------------------------------------------------------
  let strategy: LaunchPlan['bidding']['strategy'];
  const gatedStrategy = String(draft.bidding_strategy ?? 'MAXIMIZE_CLICKS');
  if (gatedStrategy === 'MAXIMIZE_CONVERSIONS') strategy = 'MAXIMIZE_CONVERSIONS';
  else if (gatedStrategy === 'MANUAL_CPC') strategy = 'MANUAL_CPC';
  else if (gatedStrategy === 'MAXIMIZE_CLICKS') strategy = 'MAXIMIZE_CLICKS';
  else {
    // TARGET_CPA / TARGET_ROAS need a value from the merchant's margin; a first campaign never starts there.
    strategy = 'MAXIMIZE_CONVERSIONS';
    warnings.push('الهدف على التكلفة يحتاج رقم من هامشك ونسبة إغلاقك، فنبدأ بتعظيم التحويلات ونضيف الهدف بعدين.');
  }
  if (type === 'SHOPPING' && strategy === 'MAXIMIZE_CONVERSIONS') {
    // Standard Shopping takes Maximize Conversions only as a portfolio strategy; at campaign level it is clicks or manual.
    strategy = 'MAXIMIZE_CLICKS';
    warnings.push('حملة التسوق العادية تبدأ بتعظيم النقرات مع سقف لسعر النقرة، وننتقل بعد ما تتجمع مبيعات.');
  }
  let ceilingMicros: number | null = null;
  if (strategy !== 'MAXIMIZE_CONVERSIONS') {
    const maxByRule = budgetSar > 0 ? budgetSar / CPC_CAP_BUDGET_DIVISOR : 0;
    const requested = finite(draft.max_cpc_sar);
    let cap = requested !== null && requested > 0 ? requested : maxByRule;
    if (requested === null || requested <= 0) {
      warnings.push('ما حددت سقف لسعر النقرة، فحطينا الحد الأعلى المسموح: عُشر الميزانية اليومية. عدّله بعد أول أسبوع.');
    } else if (maxByRule > 0 && requested > maxByRule) {
      cap = maxByRule;
      warnings.push('سقف سعر النقرة كان أعلى من عُشر الميزانية اليومية، فنزلناه للحد المسموح.');
    }
    ceilingMicros = cap > 0 ? roundMicros(cap) : null;
    if (ceilingMicros !== null && ceilingMicros < 10_000) ceilingMicros = 10_000;
  }

  // ---- Geo --------------------------------------------------------------------
  const regionNames = cleanRegions(draft);
  const regions = regionNames.map((name) => ({ name, geo_target_constant: context.resolvedRegions?.[name] ?? null }));
  const unresolved = regions.filter((r) => !r.geo_target_constant).map((r) => r.name);
  if (unresolved.length > 0) {
    block('regions_unresolved', `ما قدرنا نحدد هذي المناطق في قوقل: ${unresolved.join('، ')}. بدون تحديدها الحملة تطلع على المملكة كلها.`);
  }
  const positiveGeo = draft.location_option === 'PRESENCE_OR_INTEREST' ? 'PRESENCE_OR_INTEREST' : 'PRESENCE';

  // ---- Landing page -------------------------------------------------------------
  const site = context.website ?? (typeof draft.landing_page === 'string' ? draft.landing_page : null);
  const rootUrl = resolveSiteUrl('/', site);
  if (!rootUrl && type !== 'SHOPPING') {
    block('no_landing_page', 'ما عندنا موقع أو صفحة هبوط للنشاط. أضفها قبل البناء.');
  }
  const draftLanding = resolveSiteUrl(draft.landing_page, site) ?? rootUrl;

  // ---- Ad groups ---------------------------------------------------------------
  const adGroups: LaunchAdGroup[] = [];
  const seenKeywords = new Set<string>();
  let keywordTotal = 0;
  if (type === 'SHOPPING') {
    adGroups.push({ name: 'كل المنتجات', final_url: draftLanding ?? '', keywords: [], rsa: null });
  } else if (type === 'SEARCH' || type === 'PMAX') {
    const groups = (Array.isArray(draft.ad_groups) ? draft.ad_groups : []).slice(0, LAUNCH_MAX_AD_GROUPS);
    for (const [index, item] of groups.entries()) {
      const group = asRecord(item);
      if (!group) continue;
      const name = (cleanKeywordText(String(group.name ?? '')) || `مجموعة ${index + 1}`).slice(0, AD_GROUP_NAME_MAX);

      const prepared = rawKeywords(group)
        .map((k) => ({ ...k, match_type: (k.match_type === 'BROAD' ? 'PHRASE' : k.match_type) as 'EXACT' | 'PHRASE' }))
        .filter((k) => {
          const ok = validKeyword(k.text);
          if (!ok && k.text) removed.push(`كلمة «${k.text}» ما تنقبل في قوقل (رموز أو طول زايد)`);
          return ok;
        });
      const expanded = expandAndDedupeKeywords(prepared, {
        seen: seenKeywords,
        maxTotal: Math.min(LAUNCH_MAX_KEYWORDS_PER_GROUP, Math.max(0, LAUNCH_MAX_KEYWORDS_TOTAL - keywordTotal)),
      });
      keywordTotal += expanded.keywords.length;
      const keywords = expanded.keywords as LaunchKeyword[];

      const finalUrl = resolveSiteUrl(group.final_url ?? group.landing_page, site) ?? draftLanding ?? '';
      const rsa = buildRsa({
        headlines: group.headlines_ar ?? group.headlines,
        descriptions: group.descriptions_ar ?? group.descriptions,
        path1: group.path1,
        path2: group.path2,
        brand: businessName,
        allowGuarantee,
        language,
      });
      for (const item2 of rsa.dropped) removed.push(`سطر إعلان «${item2.text}»: ${item2.issues.join('، ')}`);
      warnings.push(...rsa.warnings_ar.map((w) => `${name}: ${w}`));

      if (keywords.length === 0 || !rsa.rsa || !finalUrl) {
        removed.push(`المجموعة «${name}» ما اكتملت (كلمات أو إعلان أو رابط ناقص) فما انضافت`);
        continue;
      }
      adGroups.push({ name, final_url: finalUrl, keywords, rsa: rsa.rsa });
    }
    if (type === 'SEARCH' && adGroups.length === 0) {
      block('no_valid_ad_group', 'ما فيه ولا مجموعة إعلانية مكتملة (كلمات وإعلان). أعد توليد المسودة.');
    }
  }

  // ---- Negatives -----------------------------------------------------------------
  const positives = adGroups.flatMap((g) => g.keywords.map((k) => k.text));
  const negatives = buildNegativePlan({
    campaignNegatives: Array.isArray(draft.negative_keywords) ? draft.negative_keywords : [],
    positiveKeywords: positives,
  });
  for (const item of negatives.removed_for_collision) {
    removed.push(`سلبية «${item.text}» تمنع كلمتك «${item.blocks}» فما انضافت`);
  }

  // ---- Assets -----------------------------------------------------------------------
  const assetCheck = buildAssets({
    raw: {
      sitelinks: draft.sitelinks,
      callouts: draft.callouts,
      structured_snippet: draft.structured_snippet,
      phone: context.phone ?? draft.phone,
    },
    site,
    brand: businessName,
    language,
    kind,
    allowGuarantee,
  });
  if (type === 'SHOPPING') {
    // Standard Shopping carries no ad text assets.
    assetCheck.assets.sitelinks = [];
    assetCheck.assets.callouts = [];
    assetCheck.assets.structured_snippet = null;
    assetCheck.assets.call_phone = null;
    assetCheck.assets.use_location_sync = false;
  } else {
    warnings.push(...assetCheck.warnings_ar);
  }
  removed.push(...assetCheck.removed_ar);

  // ---- Type specifics -------------------------------------------------------------------
  let pmax: LaunchPlan['pmax'] = null;
  if (type === 'PMAX') {
    const brandNames = Array.isArray(draft.brand_names)
      ? draft.brand_names.map((b: unknown) => cleanKeywordText(String(b ?? ''))).filter(Boolean)
      : businessName
        ? [businessName]
        : [];
    pmax = { brand_exclusions: Array.from(new Set(brandNames)).slice(0, 10), final_url: draftLanding ?? '' };
    block('pmax_assets_required', 'الأداء الأقصى يحتاج صور وشعار. نبنيه في خطوة جاية، وللحين نبدأ بالبحث أو التسوق.');
  }

  // ---- Names ----------------------------------------------------------------------------
  const name =
    cleanKeywordText(String(draft.name ?? '')).slice(0, CAMPAIGN_NAME_MAX) ||
    `${businessName ?? 'حملة'} | ${type === 'SHOPPING' ? 'تسوق' : 'بحث'}`;

  // The gates' own notes (what they changed) belong in front of the merchant.
  warnings.unshift(...gated.notes_ar);

  return {
    version: LAUNCH_PLAN_VERSION,
    type,
    objective,
    name,
    language,
    business_name: businessName,
    business_kind: kind,
    budget: { daily_sar: budgetSar, daily_micros: budgetSar > 0 ? roundMicros(budgetSar) : 0 },
    bidding: {
      strategy,
      cpc_ceiling_micros: ceilingMicros,
      note_ar: strategyNoteAr(strategy),
    },
    settings: {
      search_partners: false,
      display_network: false,
      positive_geo_target_type: positiveGeo,
      status: 'PAUSED',
    },
    geo: { country_constant: SAUDI_GEO_TARGET_CONSTANT, regions },
    ad_groups: adGroups,
    campaign_negatives: negatives.campaign_negatives,
    shared_negative_list: negatives.shared_list,
    assets: assetCheck.assets,
    shopping: type === 'SHOPPING' ? { campaign_priority: 0 } : null,
    pmax,
    blockers,
    warnings_ar: Array.from(new Set(warnings)),
    removed_ar: removed,
    executable: blockers.length === 0,
  };
}

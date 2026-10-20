/**
 * Triage for Google's own recommendations (the `recommendation` resource).
 *
 * Pure and deterministic. Google's recommendations optimise Google's revenue
 * first, so nothing here is applied automatically: a verdict only decides what
 * the assistant proposes. `accept` and `reject` both still go through the
 * normal approval card (apply or dismiss); `needs_review` is shown to the
 * merchant with the reason and no proposed change.
 *
 * Rules come from the media-buyer skill: sitelinks and callouts are safe wins;
 * "remove redundant or unused keywords" hands traffic to Performance Max;
 * broad match needs enough conversions for Smart Bidding to steer it; a budget
 * raise is wasted while the target is not met; Search Partners, Display
 * expansion and Performance Max opt-ins stay off.
 *
 * Arabic: Saudi colloquial, no dashes.
 */

export type TriageVerdict = 'accept' | 'reject' | 'needs_review';

export type TriageContext = {
  /** Account conversions over the last 30 days; null when unreadable. */
  conversions_30d: number | null;
  /**
   * True only when the account is known to meet its CPA/ROAS target. Null
   * (unknown) is treated as "not proven", because a budget raise on an
   * unproven account is the expensive mistake.
   */
  target_met: boolean | null;
};

export type TriageInput = {
  type: string;
  dismissed?: boolean;
};

export type TriageResult = {
  verdict: TriageVerdict;
  reason_ar: string;
  /** The platform can execute `apply` for this type (assets only). */
  applicable: boolean;
};

/** Smart Bidding and broad match need this many conversions in 30 days (skill rule). */
export const MIN_CONVERSIONS_FOR_AUTOMATION = 30;

const APPLICABLE_TYPES: ReadonlySet<string> = new Set(['SITELINK_ASSET', 'CALLOUT_ASSET']);

const BUDGET_TYPES: ReadonlySet<string> = new Set([
  'CAMPAIGN_BUDGET',
  'FORECASTING_CAMPAIGN_BUDGET',
  'MARGINAL_ROI_CAMPAIGN_BUDGET',
  'MOVE_UNUSED_BUDGET',
]);

const BROAD_TYPES: ReadonlySet<string> = new Set(['USE_BROAD_MATCH_KEYWORD', 'KEYWORD_MATCH_TYPE']);

const ALWAYS_OFF_TYPES: ReadonlySet<string> = new Set([
  'SEARCH_PARTNERS_OPT_IN',
  'DISPLAY_EXPANSION_OPT_IN',
  'PERFORMANCE_MAX_OPT_IN',
  'PERFORMANCE_MAX_FINAL_URL_OPT_IN',
  'MAXIMIZE_CLICKS_OPT_IN',
  'ENHANCED_CPC_OPT_IN',
]);

const SMART_BIDDING_OPT_INS: ReadonlySet<string> = new Set([
  'TARGET_CPA_OPT_IN',
  'MAXIMIZE_CONVERSIONS_OPT_IN',
  'TARGET_ROAS_OPT_IN',
  'MAXIMIZE_CONVERSION_VALUE_OPT_IN',
]);

/**
 * Keyword clean-up types. The v22 enum has no type literally named "remove
 * redundant keywords", so this matches by name too: anything that reads as
 * removing, merging or pausing keywords is rejected.
 */
const KEYWORD_CLEANUP_PATTERN = /(REMOVE|REDUNDANT|DUPLICATE|UNUSED|NON_SERVING|LOW_SERVING)/;

function reject(reason_ar: string): TriageResult {
  return { verdict: 'reject', reason_ar, applicable: false };
}
function review(reason_ar: string): TriageResult {
  return { verdict: 'needs_review', reason_ar, applicable: false };
}

export function classifyGoogleRecommendation(input: TriageInput, ctx: TriageContext): TriageResult {
  const type = String(input.type ?? '').toUpperCase();
  const conversions = ctx.conversions_30d;
  const enoughData = conversions !== null && conversions >= MIN_CONVERSIONS_FOR_AUTOMATION;

  if (APPLICABLE_TYPES.has(type)) {
    return {
      verdict: 'accept',
      reason_ar: 'روابط وإضافات تحسّن ظهور الإعلان ولا تغيّر الاستهداف ولا الصرف',
      applicable: true,
    };
  }

  if (KEYWORD_CLEANUP_PATTERN.test(type) && /KEYWORD/.test(type)) {
    return reject('حذف الكلمات المكررة أو غير المستخدمة يسلّم الزيارات لحملة الأداء الأقصى، وما نسوي هذا');
  }

  if (BROAD_TYPES.has(type)) {
    return enoughData
      ? review('المطابقة الواسعة تنفع مع تحويلات كافية، لكن لازم تراجعها قبل ما تتفعل')
      : reject('المطابقة الواسعة تحتاج تحويلات كافية (30 تحويل خلال 30 يوم) عشان تتوجّه صح، وما وصلنا لها');
  }

  if (BUDGET_TYPES.has(type)) {
    return ctx.target_met === true
      ? review('الهدف متحقق، لكن زيادة الميزانية تكون خطوة من 5 إلى 20% وتمر على بوابة الميزانية')
      : reject('رفع الميزانية قبل ما يتحقق هدف التكلفة أو العائد يزيد الصرف بدون ما يزيد الربح');
  }

  if (type === 'SEARCH_PARTNERS_OPT_IN' || type === 'DISPLAY_EXPANSION_OPT_IN') {
    return reject('شركاء البحث وشبكة العرض نبقيها مقفولة عشان ما يروح الصرف على زيارات ضعيفة');
  }
  if (type === 'PERFORMANCE_MAX_OPT_IN' || type === 'PERFORMANCE_MAX_FINAL_URL_OPT_IN') {
    return reject('الأداء الأقصى ياخذ الزيارات من حملات البحث، وما نفعّله من توصية');
  }
  if (ALWAYS_OFF_TYPES.has(type)) {
    return reject('هالتحويل في المزايدة ما يناسب حسابك، ونحافظ على الاستراتيجية الحالية');
  }

  if (SMART_BIDDING_OPT_INS.has(type)) {
    return enoughData
      ? review('تغيير استراتيجية المزايدة يصفّر التعلم، راجعه قبل ما تقرر')
      : reject('المزايدة الذكية تحتاج 30 تحويل خلال 30 يوم على الأقل، وما وصلنا لها');
  }

  if (type === 'KEYWORD') {
    return review('كلمة جديدة تقترحها قوقل، تتأكد إنها تخدم نشاطك وبمطابقة عبارة أو تامة');
  }

  if (type === 'CALL_ASSET' || type === 'LEAD_FORM_ASSET') {
    return review('إضافة تحتاج رقم أو نموذج من عندك، فما ننفذها بدون ما تحددها');
  }

  return review('توصية ما لها قاعدة جاهزة عندنا، راجعها بنفسك قبل أي تغيير');
}

/** Counts per verdict, for the tool summary. */
export function summarizeVerdicts(results: Array<{ verdict: TriageVerdict }>) {
  const counts = { accept: 0, reject: 0, needs_review: 0 };
  for (const r of results) counts[r.verdict] += 1;
  return counts;
}

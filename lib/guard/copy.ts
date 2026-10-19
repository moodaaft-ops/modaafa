/**
 * Every Arabic sentence the guard says, in one place. Saudi colloquial, one
 * line each, Latin digits, no em or en dash, Arabic comma. Every number comes
 * from the evidence the caller passes in; nothing here invents one.
 */
import { formatDateAr, formatMoney, formatNumber } from '@/lib/lifecycle/format';
import { SUPPORT_WHATSAPP_DISPLAY } from '@/lib/lifecycle/copy';

export const WHATSAPP_LINE = `كلمنا واتساب ${SUPPORT_WHATSAPP_DISPLAY}`;

/** Merchant-written names go into our sentences: one line, no long dashes, bounded. */
export function cleanName(value: unknown, max = 40): string {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s*[—–]\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}

export const money = (amount: number, currency: string) => formatMoney(amount, currency);
export const num = (value: number, decimals?: number) => formatNumber(value, decimals === undefined ? {} : { decimals });
export const percent = (ratio: number) => `${formatNumber(Math.round(ratio * 100))}%`;
export const times = (ratio: number) => `${formatNumber(Math.round(ratio * 10) / 10, { decimals: 1 }).replace(/\.0$/, '')} ضعف`;

function quoted(name: string) {
  return `"${cleanName(name)}"`;
}

export function listNames(names: string[], max = 3): string {
  const shown = names.slice(0, max).map(quoted);
  return names.length > max ? `${shown.join('، ')} و${names.length - max} غيرها` : shown.join('، ');
}

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------
const ACCOUNT_STATUS_COPY: Record<string, { what: string; step: string }> = {
  SUSPENDED: {
    what: 'قوقل علّق حسابك الإعلاني والإعلانات واقفة',
    step: `لا تستأنف قبل ما نعرف السبب. ${WHATSAPP_LINE} ونراجعه معك`,
  },
  CANCELED: {
    what: 'حسابك الإعلاني ملغي في قوقل والإعلانات ما تشتغل',
    step: `مدير الحساب يقدر يعيد تفعيله من قوقل أدز. تبي مساعدة؟ ${WHATSAPP_LINE}`,
  },
  CLOSED: {
    what: 'حسابك الإعلاني مقفل نهائياً في قوقل وما يرجع',
    step: `نحتاج نفتح لك حساب جديد. ${WHATSAPP_LINE}`,
  },
  CUSTOMER_NOT_ENABLED: {
    what: 'قوقل يقول إن حسابك الإعلاني مو مفعّل (موقوف أو مقفل)',
    step: `${WHATSAPP_LINE} ونعرف وضعه بالضبط`,
  },
};

export function accountStatusCopy(status: string) {
  return ACCOUNT_STATUS_COPY[status] ?? ACCOUNT_STATUS_COPY.CUSTOMER_NOT_ENABLED;
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------
export const BILLING_SETUP_COPY = {
  what: 'ما فيه إعداد دفع فعّال لحسابك الإعلاني عند قوقل',
  step: `ادخل على الفوترة في قوقل أدز وتأكد من طريقة الدفع. ${WHATSAPP_LINE} لو احتجت مساعدة`,
};

export function budgetExhaustedCopy(served: number, limit: number, currency: string) {
  return {
    what: `الميزانية المعتمدة في قوقل خلصت (صرف ${money(served, currency)} من ${money(limit, currency)})`,
    step: 'ارفع حد الصرف من الفوترة في قوقل أدز، وإلا الإعلانات تقف',
  };
}

export function budgetNearCopy(served: number, limit: number, currency: string) {
  return {
    what: `الميزانية المعتمدة في قوقل قربت تخلص (صرف ${money(served, currency)} من ${money(limit, currency)}، يعني ${percent(served / limit)})`,
    step: 'ارفع حد الصرف من الفوترة في قوقل أدز قبل ما تقف الإعلانات',
  };
}

export function budgetEndsCopy(endsAt: number) {
  return {
    what: `الميزانية المعتمدة في قوقل تنتهي بتاريخ ${formatDateAr(new Date(endsAt))}`,
    step: 'مدّد تاريخ الانتهاء من الفوترة في قوقل أدز، وإلا الإعلانات تقف بعده',
  };
}

// ---------------------------------------------------------------------------
// Spend and results
// ---------------------------------------------------------------------------
export function spendZeroCopy(scope: { name: string | null }, median: number, currency: string) {
  const what = scope.name
    ? `حملة ${quoted(scope.name)} ما صرفت شي أمس، وعادةً تصرف حوالي ${money(median, currency)} باليوم`
    : `حسابك ما صرف شي أمس، وعادةً يصرف حوالي ${money(median, currency)} باليوم`;
  return { what, step: 'افحص الفوترة وحالة الحملات والإعلانات المرفوضة' };
}

export function spendSpikeCopy(scope: { name: string | null }, yesterday: number, median: number, currency: string) {
  const subject = scope.name ? `صرف حملة ${quoted(scope.name)}` : 'صرف حسابك';
  return {
    what: `${subject} أمس ${money(yesterday, currency)}، يعني حوالي ${times(yesterday / median)} معدله اليومي (${money(median, currency)})`,
    step: 'راجع الميزانيات وآخر التعديلات، وإذا ما عرفت السبب كلمنا',
  };
}

export function cpaSpikeCopy(cpa: number, baseline: number, currency: string) {
  return {
    what: `تكلفة التحويلة أمس ${money(cpa, currency)}، حوالي ${times(cpa / baseline)} معدلها آخر 14 يوم (${money(baseline, currency)})`,
    step: 'انتظر يوم قبل أي قرار لأن التحويلات تتأخر أحياناً، وإذا استمر الارتفاع راجع التتبع والتعديلات الأخيرة',
  };
}

export function conversionsZeroCopy(names: string[]) {
  const what =
    names.length === 1
      ? `حملة ${quoted(names[0])} تحوّل غالب الأيام وأمس ما سجّلت ولا تحويل`
      : `${names.length} حملات تحوّل غالب الأيام وأمس ما سجّلت ولا تحويل: ${listNames(names)}`;
  return {
    what,
    step: 'افحص التتبع أول: هل الطلبات والاتصالات نزلت فعلاً؟ وقبل ما تغيّر أي شي في الحملات',
  };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------
const POLICY_TOPIC_AR: Record<string, string> = {
  DESTINATION_NOT_WORKING: 'الرابط ما يفتح',
  DESTINATION_MISMATCH: 'الرابط ما يطابق الإعلان',
  TRADEMARKS: 'العلامات التجارية',
  HEALTH_IN_PERSONALIZED_ADS: 'استهداف حساس للصحة',
  UNRELIABLE_CLAIMS: 'ادعاءات غير موثوقة',
  MISREPRESENTATION: 'تضليل',
  EDITORIAL: 'مخالفة تحريرية',
  PROHIBITED_PRACTICES: 'ممارسات ممنوعة',
};

export function policyTopicAr(topic: string): string {
  return POLICY_TOPIC_AR[topic] ?? 'مخالفة سياسة';
}

export function adDisapprovedCopy(count: number, campaignName: string, topics: string[]) {
  const subject = count === 1 ? 'إعلان واحد' : count === 2 ? 'إعلانين' : count <= 10 ? `${count} إعلانات` : `${num(count)} إعلان`;
  const why = topics.length > 0 ? ` بسبب ${Array.from(new Set(topics.map(policyTopicAr))).slice(0, 2).join(' و')}` : '';
  return {
    what: `${subject} انرفض في حملة ${quoted(campaignName)}${why}`,
    step: `ما نعدّل شي بنفسنا هنا. ${WHATSAPP_LINE} وندلك على التصحيح قبل أي استئناف`,
  };
}

export function adLimitedCopy(count: number, campaignName: string, topics: string[]) {
  const subject = count === 1 ? 'إعلان واحد' : count === 2 ? 'إعلانين' : count <= 10 ? `${count} إعلانات` : `${num(count)} إعلان`;
  const why = topics.length > 0 ? ` بسبب ${Array.from(new Set(topics.map(policyTopicAr))).slice(0, 2).join(' و')}` : '';
  return {
    what: `${subject} ظهوره محدود بسبب سياسة قوقل في حملة ${quoted(campaignName)}${why}`,
    step: `الإعلان يشتغل بس بظهور أقل. ${WHATSAPP_LINE} ونراجع السبب`,
  };
}

// ---------------------------------------------------------------------------
// Changes from outside
// ---------------------------------------------------------------------------
export type ChangeActor = 'google_auto' | 'user' | 'tool';
export const ACTOR_AR: Record<ChangeActor, string> = {
  google_auto: 'قوقل نفسه عبر توصيات أو قواعد آلية',
  user: 'مستخدم دخل على الحساب',
  tool: 'أداة خارجية',
};

export const RESOURCE_TYPE_AR: Record<string, string> = {
  CAMPAIGN: 'الحملة',
  CAMPAIGN_BUDGET: 'الميزانية',
  AD_GROUP: 'مجموعة إعلانية',
  AD_GROUP_AD: 'إعلان',
  AD_GROUP_CRITERION: 'كلمات أو استهداف',
  CAMPAIGN_CRITERION: 'استهداف الحملة',
  AD_GROUP_BID_MODIFIER: 'تعديل مزايدة',
};

export function outsideChangeCopy(count: number, actor: ChangeActor, types: string[]) {
  const subject = count === 1 ? 'تعديل واحد' : count === 2 ? 'تعديلين' : count <= 10 ? `${count} تعديلات` : `${num(count)} تعديل`;
  const what = types.length > 0 ? ` (${types.join('، ')})` : '';
  return {
    what: `صار ${subject} على حسابك من برا مُضاعِف بواسطة ${ACTOR_AR[actor]}${what}`,
    step: 'لو انت اللي سويته عادي. لو لا، راجع سجل التغييرات في قوقل أدز وقل لنا',
  };
}

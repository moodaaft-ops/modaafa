const PLAN_LABELS: Record<string, string> = {
  starter: 'البداية',
  growth: 'النمو',
  pro: 'الاحتراف',
};

const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  trialing: 'تجربة',
  active: 'نشط',
  past_due: 'متأخر الدفع',
  canceled: 'ملغي',
  paused: 'متوقف',
  paid: 'مدفوعة',
  failed: 'فشلت',
  pending: 'بانتظار',
  draft: 'مسودة',
  refunded: 'مسترجعة',
};

const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  ENABLED: 'مفعلة',
  PAUSED: 'متوقفة',
  REMOVED: 'محذوفة',
  UNKNOWN: 'غير معروفة',
};

const RECOMMENDATION_STATUS_LABELS: Record<string, string> = {
  pending: 'بانتظار الموافقة',
  approved: 'معتمدة',
  executing: 'قيد التنفيذ',
  dismissed: 'متجاهلة',
  applied: 'منفذة',
  failed: 'فشلت',
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: 'حرجة',
  medium: 'متوسطة',
  growth: 'فرصة نمو',
};

const CAMPAIGN_TYPE_LABELS: Record<string, string> = {
  SEARCH: 'بحث',
  DISPLAY: 'شبكة العرض',
  PMAX: 'الأداء الأفضل',
  PERFORMANCE_MAX: 'الأداء الأفضل',
  SHOPPING: 'تسوق',
  VIDEO: 'فيديو',
  APP: 'تطبيق',
  LOCAL: 'محلي',
  DEMAND_GEN: 'توليد الطلب',
};

const BIDDING_LABELS: Record<string, string> = {
  MAXIMIZE_CONVERSIONS: 'تعظيم التحويلات',
  MAXIMIZE_CONVERSION_VALUE: 'تعظيم قيمة التحويل',
  TARGET_CPA: 'تكلفة مستهدفة للتحويل',
  TARGET_ROAS: 'عائد مستهدف على الإنفاق',
  MANUAL_CPC: 'نقرة يدوية',
  ENHANCED_CPC: 'نقرة محسنة',
};

export function planLabel(value?: string | null) {
  return labelFrom(PLAN_LABELS, value);
}

export function subscriptionStatusLabel(value?: string | null) {
  return labelFrom(SUBSCRIPTION_STATUS_LABELS, value);
}

export function campaignStatusLabel(value?: string | null) {
  return labelFrom(CAMPAIGN_STATUS_LABELS, value);
}

export function recommendationStatusLabel(value?: string | null) {
  return labelFrom(RECOMMENDATION_STATUS_LABELS, value);
}

export function severityLabel(value?: string | null) {
  return labelFrom(SEVERITY_LABELS, value);
}

export function campaignTypeLabel(value?: string | null) {
  return labelFrom(CAMPAIGN_TYPE_LABELS, value);
}

export function biddingLabel(value?: string | null) {
  return labelFrom(BIDDING_LABELS, value);
}

function labelFrom(labels: Record<string, string>, value?: string | null) {
  if (!value) return '—';
  return labels[value] ?? value;
}

/**
 * The English term for a value, for use as a `title` tooltip.
 *
 * Labels used to read "مفعلة / Enabled" and were rendered inside
 * `whitespace-nowrap` status pills and buttons — two of them side by side
 * pushed ~270px of unbreakable content into a 303px mobile card, and
 * "ابدأ تجربة النمو / Growth" as a button label mixed both languages in a
 * single heading. The UI is Arabic-only now; the English term stays
 * discoverable on hover.
 */
export function englishTermFor(value?: string | null) {
  if (!value) return undefined;
  return ENGLISH_TERMS[value];
}

const ENGLISH_TERMS: Record<string, string> = {
  starter: 'Starter',
  growth: 'Growth',
  pro: 'Pro',
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Past due',
  canceled: 'Canceled',
  paused: 'Paused',
  paid: 'Paid',
  failed: 'Failed',
  pending: 'Pending',
  approved: 'Approved',
  executing: 'Executing',
  dismissed: 'Dismissed',
  applied: 'Applied',
  draft: 'Draft',
  refunded: 'Refunded',
  ENABLED: 'Enabled',
  PAUSED: 'Paused',
  REMOVED: 'Removed',
  UNKNOWN: 'Unknown',
  critical: 'Critical',
  medium: 'Medium',
  SEARCH: 'Search',
  DISPLAY: 'Display',
  PMAX: 'Performance Max',
  PERFORMANCE_MAX: 'Performance Max',
  SHOPPING: 'Shopping',
  VIDEO: 'Video',
  APP: 'App',
  LOCAL: 'Local',
  DEMAND_GEN: 'Demand Gen',
  MAXIMIZE_CONVERSIONS: 'Maximize conversions',
  MAXIMIZE_CONVERSION_VALUE: 'Maximize conversion value',
  TARGET_CPA: 'Target CPA',
  TARGET_ROAS: 'Target ROAS',
  MANUAL_CPC: 'Manual CPC',
  ENHANCED_CPC: 'Enhanced CPC',
};

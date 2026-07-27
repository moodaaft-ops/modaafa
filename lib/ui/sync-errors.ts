import { featureAccessMessage } from '@/lib/billing/entitlements';

/**
 * Arabic copy for a failed Google Ads refresh.
 *
 * `/api/accounts/sync` forwards the specific Google Ads error code (it used to
 * flatten everything into `sync_failed`), so each failure gets the answer that
 * actually resolves it rather than one generic apology. Shared by /dashboard
 * and /campaigns, which both host a refresh button.
 */
export function syncErrorMessage(code: string) {
  const normalized = code.toLowerCase();

  if (['subscription_required', 'quota_exceeded', 'usage_storage_unavailable'].includes(normalized)) {
    return featureAccessMessage(normalized);
  }
  if (normalized === 'account_not_found') {
    return 'لم نجد الحساب الإعلاني المختار. اختر حساباً آخر أو أعد الربط.';
  }
  if (['invalid_grant', 'unauthorized_client', 'invalid_client'].includes(normalized)) {
    return 'انتهت صلاحية ربط Google Ads. افتح «ربط إعلانات Google» وأعد منح الصلاحية لتحديث البيانات.';
  }
  if (normalized === 'user_permission_denied') {
    return 'لا تملك صلاحية كافية على هذا الحساب الإعلاني في Google Ads. اطلب صلاحية القراءة والإدارة ثم أعد المحاولة.';
  }
  if (normalized === 'customer_not_enabled') {
    return 'هذا الحساب الإعلاني غير مفعّل في Google Ads (قد يكون مغلقاً أو معلقاً). اختر حساباً آخر.';
  }
  if (normalized === 'requested_metrics_for_manager') {
    return 'هذا حساب إداري (MCC) ولا يعرض أرقام أداء. اختر حساب عميل مباشر من مبدّل الحسابات.';
  }
  if (normalized === 'too_many_requests') {
    return 'طلبت التحديث عدة مرات خلال فترة قصيرة. انتظر قليلاً ثم أعد المحاولة.';
  }
  if (normalized === 'customer_required') {
    return 'اختر حساباً إعلانياً أولاً من مبدّل الحسابات ثم أعد التحديث.';
  }

  return 'تعذر تحديث بيانات الحساب الآن. احتفظنا بالبيانات السابقة ولم ننفذ أي تعديل على Google Ads.';
}

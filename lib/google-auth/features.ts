/**
 * Extra Google permissions that are asked for one at a time, in a consent of
 * their own, and never merged into the main sign-in or the Google Ads grant
 * (the stored Ads refresh token keeps carrying `adwords` and nothing else).
 *
 * Each feature has its own flag; with the flag off its routes answer 404 and
 * no consent URL can be built.
 *
 *  data_manager  DATA_MANAGER_UPLOAD_ENABLED  https://www.googleapis.com/auth/datamanager
 *  ga4           GA4_READ_ENABLED             https://www.googleapis.com/auth/analytics.readonly
 *  gbp           GBP_READ_ENABLED             https://www.googleapis.com/auth/business.manage
 *
 * Scope names: Data Manager API "Set up API access" page (datamanager),
 * Analytics Data API and Admin API authorization (analytics.readonly), Business
 * Profile APIs (business.manage). The `adwords` scope is NOT accepted for the
 * Data Manager API on its own: Google's setup page lists both scopes side by
 * side for credentials that call both APIs.
 */
export const EXTRA_FEATURES = ['data_manager', 'ga4', 'gbp'] as const;
export type ExtraFeature = (typeof EXTRA_FEATURES)[number];

export const FEATURE_SCOPE: Readonly<Record<ExtraFeature, string>> = {
  data_manager: 'https://www.googleapis.com/auth/datamanager',
  ga4: 'https://www.googleapis.com/auth/analytics.readonly',
  gbp: 'https://www.googleapis.com/auth/business.manage',
};

const FEATURE_FLAG: Readonly<Record<ExtraFeature, string>> = {
  data_manager: 'DATA_MANAGER_UPLOAD_ENABLED',
  ga4: 'GA4_READ_ENABLED',
  gbp: 'GBP_READ_ENABLED',
};

export function isExtraFeature(value: unknown): value is ExtraFeature {
  return typeof value === 'string' && (EXTRA_FEATURES as readonly string[]).includes(value);
}

/** Only the literal "true" turns a feature on. */
export function isExtraFeatureEnabled(feature: ExtraFeature, env: Record<string, string | undefined> = process.env): boolean {
  return env[FEATURE_FLAG[feature]] === 'true';
}

export const isDataManagerUploadEnabled = (env: Record<string, string | undefined> = process.env) =>
  isExtraFeatureEnabled('data_manager', env);
export const isGa4ReadEnabled = (env: Record<string, string | undefined> = process.env) => isExtraFeatureEnabled('ga4', env);
export const isGbpReadEnabled = (env: Record<string, string | undefined> = process.env) => isExtraFeatureEnabled('gbp', env);

/** The oauth_states purpose a consent for this feature is issued under. */
export function statePurposeFor(feature: ExtraFeature): string {
  return `google_scope_${feature}`;
}

/**
 * What the merchant is told BEFORE they are sent to Google, so the consent
 * screen is no surprise. Saudi colloquial, no dashes.
 */
export const FEATURE_CONSENT_COPY_AR: Readonly<Record<ExtraFeature, { title: string; body: string; google_screen: string }>> = {
  data_manager: {
    title: 'اسمح لمُضاعِف يرسل نتايج زبائنك لقوقل',
    body: 'قوقل نقلت رفع التحويلات من الواتساب والمبيعات لواجهة جديدة. تحتاج توافق مرة وحدة عشان نكمل نرسل لها الزبائن الفعليين.',
    google_screen: 'بتشوف في شاشة قوقل طلب واحد: رفع بيانات التحويلات لإعلاناتك. ما نقرأ بريدك ولا ملفاتك.',
  },
  ga4: {
    title: 'اربط قوقل أناليتكس للقراءة فقط',
    body: 'نقرأ أداء صفحات الهبوط ونسبة التفاعل عشان نعرف وين يضيع الزائر. ما نعدل شي في حسابك.',
    google_screen: 'بتشوف في شاشة قوقل طلب واحد: عرض بيانات أناليتكس. قراءة فقط.',
  },
  gbp: {
    title: 'اربط ملف نشاطك في قوقل ماب',
    body: 'نقرأ التقييم وعدد المراجعات وساعات العمل عشان نضبط ساعات الإعلان على دوامك الفعلي.',
    google_screen: 'بتشوف في شاشة قوقل طلب واحد: إدارة ملف النشاط التجاري. نحن نقرأ بس ولا نعدل ولا نرد على أحد.',
  },
};

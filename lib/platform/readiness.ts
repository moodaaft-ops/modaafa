import { isConfiguredEnv } from './env';

export type ReadinessItem = {
  id: string;
  label_ar: string;
  label_en: string;
  ok: boolean;
  severity: 'blocker' | 'warning' | 'info';
  fix_ar: string;
};

export function getPlatformReadiness(): ReadinessItem[] {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';

  return [
    {
      id: 'app_domain',
      label_ar: 'الدومين الإنتاجي',
      label_en: 'Production domain',
      ok: /^https:\/\/ai\.modaafa\.com\/?$/.test(appUrl),
      severity: 'blocker',
      fix_ar: 'اضبط NEXT_PUBLIC_APP_URL على https://ai.modaafa.com في بيئة الإنتاج.',
    },
    {
      id: 'supabase_public',
      label_ar: 'اتصال Supabase العام',
      label_en: 'Supabase public connection',
      ok:
        isConfiguredEnv(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
        isConfiguredEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      severity: 'blocker',
      fix_ar: 'أضف NEXT_PUBLIC_SUPABASE_URL و NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    },
    {
      id: 'supabase_admin',
      label_ar: 'صلاحيات Supabase الإدارية',
      label_en: 'Supabase service role',
      ok: isConfiguredEnv(process.env.SUPABASE_SERVICE_ROLE_KEY),
      severity: 'blocker',
      fix_ar: 'أضف SUPABASE_SERVICE_ROLE_KEY حتى تعمل webhooks والحذف النهائي ومهام الخلفية.',
    },
    {
      id: 'google_oauth',
      label_ar: 'Google OAuth',
      label_en: 'Google OAuth',
      ok:
        isConfiguredEnv(process.env.GOOGLE_OAUTH_CLIENT_ID) &&
        isConfiguredEnv(process.env.GOOGLE_OAUTH_CLIENT_SECRET) &&
        isConfiguredEnv(process.env.GOOGLE_OAUTH_REDIRECT_URI),
      severity: 'blocker',
      fix_ar: 'أكمل بيانات Google OAuth والـ redirect URI للإنتاج.',
    },
    {
      id: 'google_oauth_verification',
      label_ar: 'تحقق Google من التطبيق',
      label_en: 'Google app verification',
      ok: process.env.GOOGLE_OAUTH_APP_VERIFIED === 'true',
      severity: 'blocker',
      fix_ar: 'أكمل OAuth consent verification في Google Cloud. إذا بقيت شاشة "لم تثبت Google ملكية هذا التطبيق" فهذه خطوة خارجية من Google وليست مشكلة كود.',
    },
    {
      id: 'google_ads_api',
      label_ar: 'Google Ads API',
      label_en: 'Google Ads API',
      ok: isConfiguredEnv(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
      severity: 'blocker',
      fix_ar: 'أضف GOOGLE_ADS_DEVELOPER_TOKEN وتأكد من صلاحيات Google Ads API.',
    },
    {
      id: 'ai_backend',
      label_ar: 'محرك الذكاء الاصطناعي',
      label_en: 'AI backend',
      ok: isConfiguredEnv(process.env.ANTHROPIC_API_KEY),
      severity: 'blocker',
      fix_ar: 'أضف ANTHROPIC_API_KEY حتى لا يعمل المساعد بوضع fallback.',
    },
    {
      id: 'stripe',
      label_ar: 'Stripe Billing',
      label_en: 'Stripe Billing',
      ok: [
        process.env.STRIPE_SECRET_KEY,
        process.env.STRIPE_WEBHOOK_SECRET,
        process.env.STRIPE_PRICE_STARTER_MONTHLY,
        process.env.STRIPE_PRICE_STARTER_YEARLY,
        process.env.STRIPE_PRICE_GROWTH_MONTHLY,
        process.env.STRIPE_PRICE_GROWTH_YEARLY,
        process.env.STRIPE_PRICE_PRO_MONTHLY,
        process.env.STRIPE_PRICE_PRO_YEARLY,
      ].every(isConfiguredEnv),
      severity: 'blocker',
      fix_ar: 'أكمل مفتاح Stripe وسر webhook وأسعار الخطط الستة في بيئة الإنتاج.',
    },
    {
      id: 'cron',
      label_ar: 'مهام الخلفية',
      label_en: 'Background jobs',
      ok: isConfiguredEnv(process.env.CRON_SECRET),
      severity: 'blocker',
      fix_ar: 'أضف CRON_SECRET لتأمين مزامنة Google Ads والتحسينات المجدولة.',
    },
    {
      id: 'operational_email',
      label_ar: 'البريد التشغيلي',
      label_en: 'Operational email',
      ok:
        isConfiguredEnv(process.env.RESEND_API_KEY) &&
        isConfiguredEnv(process.env.RESEND_FROM_EMAIL) &&
        isConfiguredEnv(process.env.OPS_ALERT_EMAIL),
      severity: 'warning',
      fix_ar: 'تحقق من نطاق الإرسال في Resend ثم أضف RESEND_FROM_EMAIL وOPS_ALERT_EMAIL.',
    },
  ];
}

export function readinessSummary(items = getPlatformReadiness()) {
  const blockers = items.filter((item) => !item.ok && item.severity === 'blocker');
  const warnings = items.filter((item) => !item.ok && item.severity === 'warning');
  return {
    ok: blockers.length === 0,
    blockers: blockers.length,
    warnings: warnings.length,
    total: items.length,
  };
}

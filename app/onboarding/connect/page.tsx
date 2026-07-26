import { redirect } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, Info, Layers, Link2, ShieldCheck } from 'lucide-react';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { formatGoogleAdsCustomerId, googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { createServerClient } from '@/lib/supabase/server';
import { Alert } from '@/lib/ui/alert';
import { buttonClasses } from '@/lib/ui/button';
import { OnboardingProgress } from '../onboarding-progress';
import { ConnectGoogleAdsButton } from './connect-google-ads-button';

const errors: Record<string, string> = {
  no_accounts: 'لم نجد حسابات إعلانات Google على هذا المستخدم.',
  state_mismatch: 'انتهت جلسة الربط. أعد المحاولة.',
  state_user_mismatch:
    'بدأت عملية الربط بحساب مستخدم مختلف على هذا المتصفح. سجّل الدخول بالحساب الصحيح ثم أعد الربط من هذا الزر.',
  missing_params: 'لم تصل بيانات الربط من Google بشكل كامل. أعد المحاولة من زر الربط.',
  access_denied:
    'تم رفض الوصول من Google. إذا ظهرت رسالة أن التطبيق قيد الاختبار، أضف هذا البريد ضمن Test users أو انتظر اكتمال تحقق Google.',
  oauth_failed: 'فشل إكمال الربط من Google. غالباً السبب أن التطبيق لم يكتمل تحقق Google أو أن الصلاحية لم تُمنح.',
  oauth_config_missing: 'إعدادات Google OAuth غير مكتملة في بيئة الإنتاج. راجع جاهزية الإطلاق في الإعدادات.',
  no_client_accounts: 'وجدنا حسابات إدارية فقط. اربط بريداً يملك حساب عميل مباشر أو لديه عملاء تحت حساب إداري.',
  db_error: 'تعذر حفظ حسابات Google Ads في المنصة. أعد المحاولة.',
  session_expired: 'انتهت جلسة اختيار الحسابات. أعد الربط.',
  session_create_failed:
    'تعذر تجهيز جلسة اختيار الحسابات. حدّث الصفحة وأعد الربط، وإذا تكرر الخطأ فالمشكلة في صلاحية حفظ الجلسات وليس في عدد الحسابات.',
  too_many_requests: 'تم بدء الربط عدة مرات خلال فترة قصيرة. انتظر دقيقة ثم أعد المحاولة من هذا الزر.',
  security_service_unavailable: 'تعذر التحقق الآمن من طلب الربط الآن. أعد المحاولة بعد قليل.',
};

const points = [
  { icon: Link2, text: 'موافقة واحدة فقط — لا تحتاج ربط كل حساب على حدة.' },
  { icon: Layers, text: 'نسحب الحساب المباشر وكل حساب عميل تحت أي حساب إداري (MCC).' },
  { icon: ShieldCheck, text: 'الصلاحية للقراءة والإدارة فقط، وأي تعديل يمر عبر موافقتك داخل المنصة.' },
];

export default async function ConnectGoogleAdsPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding/connect');
  const { accounts } = await getAccountWorkspace(supabase, user.id);
  const hasAccounts = (accounts?.length ?? 0) > 0;

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <OnboardingProgress active="connect" />

        <div className="mb-6 mt-8">
          <h2 className="text-2xl font-bold sm:text-3xl">اربط إعلانات Google</h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
            موافقة واحدة تكفي لسحب كل حساباتك، ثم تختار الحساب الذي تعمل عليه من لوحة التحكم.
          </p>
        </div>

        {params?.error && (
          <div className="mb-5">
            <Alert tone="danger">{errors[params.error] ?? 'حدث خطأ أثناء الربط.'}</Alert>
          </div>
        )}

        <section className="rounded-lg border border-border bg-card p-5 shadow-soft sm:p-6">
          <h3 className="text-lg font-bold">ربط تلقائي لكل الحسابات</h3>
          <ul className="mt-4 space-y-3">
            {points.map((point) => {
              const Icon = point.icon;
              return (
                <li key={point.text} className="flex items-start gap-3 text-sm leading-7 text-foreground">
                  <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-500/15 text-brand-600">
                    <Icon className="h-4 w-4" />
                  </span>
                  {point.text}
                </li>
              );
            })}
          </ul>

          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
            <ConnectGoogleAdsButton />
            {hasAccounts && (
              <Link href="/dashboard" className={buttonClasses({ variant: 'ghost' })}>
                لدي حسابات — انتقل للوحة التحكم
              </Link>
            )}
          </div>
        </section>

        {/* Explain Google's verification state before redirecting. */}
        <div className="mt-5">
          <Alert tone="info" title="حالة تحقق Google">
            خلال الاختبار الداخلي يستطيع فقط المستخدمون المضافون كمختبرين إكمال الربط. أما الإطلاق العام فيبدأ بعد
            موافقة Google على شاشة الصلاحيات؛ إذا منعتك Google فلا تكرر المحاولة وانتظر اكتمال المراجعة.
          </Alert>
        </div>

        {hasAccounts && (
          <section className="mt-6 rounded-lg border border-border bg-card p-5 shadow-soft sm:p-6">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              حسابات مربوطة ({accounts.length})
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {(accounts ?? []).map((account) => (
                <div
                  key={account.customer_id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted px-4 py-3 text-sm"
                >
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {googleAdsAccountDisplayName(account)}
                  </span>
                  <span className="flex-shrink-0 text-xs text-muted-foreground" dir="ltr">
                    {formatGoogleAdsCustomerId(account.customer_id)}
                  </span>
                </div>
              ))}
            </div>
            <Link href="/dashboard" className={`${buttonClasses({ variant: 'primary' })} mt-5`}>
              الانتقال للوحة التحكم
            </Link>
          </section>
        )}
      </div>
    </main>
  );
}

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowUpLeft, CheckCircle2, Layers, Link2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { formatGoogleAdsCustomerId, googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { createServerClient } from '@/lib/supabase/server';
import { Alert } from '@/lib/ui/alert';
import { buttonClasses } from '@/lib/ui/button';
import { OnboardingProgress } from '../onboarding-progress';
import { ConnectGoogleAdsButton } from './connect-google-ads-button';

const errors: Record<string, string> = {
  invalid_origin: 'تعذر التحقق من مصدر الطلب. أعد المحاولة من داخل المنصة.',
  no_accounts: 'لم نجد حسابات إعلانات Google على هذا المستخدم.',
  state_mismatch: 'انتهت جلسة الربط. أعد المحاولة.',
  state_user_mismatch:
    'بدأت عملية الربط بحساب مستخدم مختلف على هذا المتصفح. سجّل الدخول بالحساب الصحيح ثم أعد الربط من هذا الزر.',
  missing_params: 'لم تصل بيانات الربط من Google بشكل كامل. أعد المحاولة من زر الربط.',
  access_denied:
    'تم رفض الوصول من Google. إذا ظهرت رسالة أن التطبيق قيد الاختبار، أضف هذا البريد ضمن Test users أو انتظر اكتمال تحقق Google.',
  oauth_failed: 'فشل إكمال الربط من Google. غالباً السبب أن التطبيق لم يكتمل تحقق Google أو أن الصلاحية لم تُمنح.',
  oauth_config_missing: 'إعدادات Google OAuth غير مكتملة في بيئة الإنتاج. راجع جاهزية الإطلاق في الإعدادات.',
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
  const googleVerified = process.env.GOOGLE_OAUTH_APP_VERIFIED === 'true';
  // `no_client_accounts` is not an error the user can fix by retrying the same
  // thing, so it gets its own recovery block instead of a red bar above an
  // unchanged page. See ManagerOnlyRecovery below.
  const managerOnly = params?.error === 'no_client_accounts';

  return (
    <main className="px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <OnboardingProgress active="connect" showDashboardLink={hasAccounts} />

        <div className="mb-6 mt-8">
          <h2 className="text-[26px] font-bold leading-tight tracking-tight sm:text-3xl">اربط إعلانات Google</h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
            موافقة واحدة تكفي لسحب كل حساباتك، ثم تختار الحساب الذي تعمل عليه من لوحة التحكم.
          </p>
        </div>

        <div className="mb-5">
          <Alert tone="info" title="هذه ليست إعادة تسجيل الدخول">
            أنت مسجّل في مُضاعِف بالفعل
            {user.email ? (
              <>
                {' '}
                بالبريد <span dir="ltr">{user.email}</span>
              </>
            ) : null}
            . تسجيل الدخول منحنا اسمك وبريدك فقط؛ أما هذه الخطوة فتطلب من Google صلاحية Google Ads حتى تستطيع
            المنصة قراءة حساباتك ومزامنتها.
          </Alert>
        </div>

        {params?.error && !managerOnly && (
          <div className="mb-5">
            <Alert tone="danger">{errors[params.error] ?? 'حدث خطأ أثناء الربط.'}</Alert>
          </div>
        )}

        {managerOnly && <ManagerOnlyRecovery />}

        <section className="surface-card p-5 sm:p-6">
          <h3 className="text-[15px] font-semibold tracking-tight">ربط تلقائي لكل الحسابات</h3>
          <ul className="mt-4 space-y-3">
            {points.map((point) => {
              const Icon = point.icon;
              return (
                <li key={point.text} className="flex items-start gap-3 text-[13px] leading-7 text-foreground">
                  <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
                    <Icon className="h-3.5 w-3.5" />
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

        <div className="mt-5">
          {googleVerified ? (
            <Alert tone="success" title="مُضاعِف موثّق لدى Google">
              ستفتح شاشة Google الرسمية لعرض صلاحية Google Ads المطلوبة. اختر البريد الذي يملك أو يدير حساباتك
              الإعلانية؛ ويمكن أن يكون مختلفاً عن بريد تسجيل الدخول.
            </Alert>
          ) : (
            <Alert tone="info" title="حالة تحقق Google">
              خلال الاختبار الداخلي يستطيع فقط المستخدمون المضافون كمختبرين إكمال الربط. أما الإطلاق العام فيبدأ بعد
              موافقة Google على شاشة الصلاحيات؛ إذا منعتك Google فلا تكرر المحاولة وانتظر اكتمال المراجعة.
            </Alert>
          )}
        </div>

        {hasAccounts && (
          <section className="mt-5 surface-card p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold text-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              حسابات مربوطة ({accounts.length})
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {(accounts ?? []).map((account) => (
                <div
                  key={account.customer_id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background-elevated px-4 py-3 text-[13px]"
                >
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {googleAdsAccountDisplayName(account)}
                  </span>
                  <span className="flex-shrink-0 text-xs text-muted-foreground numeric" dir="ltr">
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

/**
 * The one onboarding failure with no way forward.
 *
 * `no_client_accounts` means the Google account that just authorised owns only
 * manager (MCC) accounts and no client account under them. Retrying the same
 * button with the same Google account produces the same error forever, and the
 * old page said so in a single red line with no action — a genuine dead end at
 * the last step of setup.
 *
 * Each option below is something the user can actually do: switch Google
 * account (the consent screen already forces `select_account`, so the button
 * really does offer the chooser again), create a client account in Google Ads,
 * or leave setup entirely.
 */
function ManagerOnlyRecovery() {
  const options = [
    {
      title: 'جرّب بريد Google آخر',
      body: 'اضغط زر الربط بالأسفل واختر حساب Google الذي يملك الحساب الإعلاني نفسه، لا حساب الإدارة فقط.',
    },
    {
      title: 'أنشئ حساب عميل تحت حسابك الإداري',
      body: 'من داخل Google Ads: الحسابات ← إنشاء حساب جديد. بعدها ارجع هنا وأعد الربط بنفس البريد.',
      href: 'https://ads.google.com/aw/accounts/managed',
      cta: 'فتح إدارة الحسابات في Google Ads',
    },
    {
      title: 'اطلب دعوة من مالك الحساب',
      body: 'إذا كان الحساب الإعلاني عند عميلك أو زميلك، اطلب منه دعوتك كمدير على الحساب ثم أعد الربط.',
    },
  ];

  return (
    <section className="mb-5 overflow-hidden rounded-xl border border-amber-500/25 bg-amber-500/[0.06]">
      <div className="flex items-start gap-3 border-b border-amber-500/20 px-5 py-4">
        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-500">
          <TriangleAlert className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold tracking-tight text-amber-900 dark:text-amber-100">
            وجدنا حسابات إدارية فقط (MCC)
          </h3>
          <p className="mt-1 text-[13px] leading-7 text-amber-900/80 dark:text-amber-100/80">
            الحسابات الإدارية لا تحتوي على حملات أو بيانات أداء، ولا يمكن قراءة المقاييس منها. نحتاج حساب عميل واحداً
            على الأقل تحت الحساب الإداري، أو حساباً إعلانياً مباشراً.
          </p>
        </div>
      </div>

      <div className="grid gap-px bg-amber-500/15 sm:grid-cols-3">
        {options.map((option) => (
          <div key={option.title} className="flex flex-col bg-background p-5">
            <div className="text-[13px] font-semibold text-foreground">{option.title}</div>
            <p className="mt-2 flex-1 text-xs leading-6 text-muted-foreground">{option.body}</p>
            {option.href && (
              <a
                href={option.href}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
              >
                {option.cta}
                <ArrowUpLeft className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

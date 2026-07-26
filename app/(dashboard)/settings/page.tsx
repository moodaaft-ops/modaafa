import Link from 'next/link';
import { Building2, LogOut, Pencil, Settings as SettingsIcon } from 'lucide-react';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import {
  formatGoogleAdsCustomerId,
  googleAdsAccountDisplayName,
  googleAdsAccountNameMissing,
} from '@/lib/accounts/display';
import { createServerClient } from '@/lib/supabase/server';
import { getPlatformReadiness, readinessSummary } from '@/lib/platform/readiness';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { PageHeader } from '@/lib/ui/page-header';
import { Alert } from '@/lib/ui/alert';
import { StatusBadge } from '@/lib/ui/status-badge';
import { buttonClasses } from '@/lib/ui/button';

const deleteErrors: Record<string, string> = {
  confirmation_required: 'اكتب عبارة التأكيد كما هي: حذف حسابي',
  service_role_missing: 'الحذف النهائي يحتاج مفتاح Supabase الإداري في بيئة الإنتاج.',
  billing_check_failed: 'تعذر التأكد من حالة الفوترة، لذلك لم نحذف الحساب حمايةً لك.',
  billing_cancellation_required: 'يوجد اشتراك قائم لا يمكن إلغاؤه آلياً. افتح إدارة الاشتراك أو تواصل معنا.',
  billing_cancellation_failed: 'تعذر إلغاء اشتراك Stripe، لذلك لم نحذف حسابك ولم تتأثر بياناتك.',
  profile_delete_failed: 'تعذر حذف بيانات الحساب. أعد المحاولة أو تواصل معنا.',
  auth_delete_failed: 'حذفت بيانات الحساب لكن تعذر حذف مستخدم الدخول. تواصل معنا لإكمال الحذف.',
  google_revoke_failed:
    'تعذر إلغاء صلاحية Google Ads نهائياً، لذلك لم نحذف حسابك — الحذف بدون إلغاء الصلاحية يترك وصولاً مفتوحاً لا يمكن سحبه لاحقاً. أعد المحاولة بعد قليل أو تواصل معنا.',
  too_many_requests: 'طلبت الحذف عدة مرات خلال ساعة. انتظر قليلاً ثم أعد المحاولة.',
};

const renameErrors: Record<string, string> = {
  invalid_name: 'اكتب اسماً واضحاً (حرفين على الأقل).',
  account_not_found: 'لم نجد هذا الحساب المرتبط.',
  rename_failed: 'تعذر حفظ الاسم. أعد المحاولة.',
};

export const metadata = {
  title: 'الإعدادات',
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ delete_error?: string; rename_error?: string; renamed?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { business: workspaceBusiness, accounts } = await getAccountWorkspace(supabase, user?.id);
  const { data: business } = workspaceBusiness
    ? await supabase.from('businesses').select('*').eq('id', workspaceBusiness.id).maybeSingle()
    : { data: null };
  // The launch-readiness panel is an OPERATOR view: it names environment
  // variables and reports whether Google's OAuth verification has completed.
  // Rendering it as the first thing a paying customer sees told them the
  // product was broken (a red "N عائق إطلاق" badge on their own settings
  // page) and leaked deployment detail. Gate it on an explicit allowlist;
  // /api/health remains the real operator surface.
  const operatorEmails = (process.env.MODAAFA_OPERATOR_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const isOperator = Boolean(user?.email && operatorEmails.includes(user.email.toLowerCase()));
  const readiness = isOperator ? getPlatformReadiness() : [];
  const summary = readinessSummary(readiness);

  return (
    <>
      <PageHeader icon={SettingsIcon} title="الإعدادات" description="بيانات النشاط والحسابات المربوطة وإدارة الجلسة." />

      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        {params?.renamed && <Alert tone="success">تم حفظ اسم الحساب.</Alert>}
        {params?.rename_error && (
          <Alert tone="danger">{renameErrors[params.rename_error] ?? 'تعذر حفظ الاسم.'}</Alert>
        )}

        {/* Readiness — operators only */}
        {isOperator && (
        <section className="rounded-lg border border-border bg-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold">جاهزية الإطلاق</h2>
              <p className="mt-1 text-sm text-muted-foreground">فحص آمن للإعدادات الحرجة بدون عرض أي مفاتيح أو أسرار.</p>
            </div>
            <StatusBadge tone={summary.ok ? 'success' : 'danger'}>
              {summary.ok ? 'جاهز تقنياً' : `${summary.blockers} عائق إطلاق`}
            </StatusBadge>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {readiness.map((item) => (
              <div key={item.id} className="rounded-lg border border-border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-foreground">{item.label_ar}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground" dir="ltr">
                      {item.label_en}
                    </div>
                  </div>
                  <StatusBadge tone={item.ok ? 'success' : item.severity === 'blocker' ? 'danger' : 'warning'}>
                    {item.ok ? 'مكتمل' : item.severity === 'blocker' ? 'عائق' : 'تنبيه'}
                  </StatusBadge>
                </div>
                {!item.ok && <p className="mt-3 text-xs leading-6 text-muted-foreground">{item.fix_ar}</p>}
              </div>
            ))}
          </div>
        </section>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Business profile */}
          <section className="rounded-lg border border-border bg-card p-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-bold">النشاط</h2>
              <Link href="/onboarding/business" className="inline-flex items-center gap-1 text-sm font-semibold text-brand-700 dark:text-brand-300 hover:underline">
                <Pencil className="h-3.5 w-3.5" />
                تعديل
              </Link>
            </div>
            <dl className="mt-5 space-y-3 text-sm">
              <Row label="الاسم" value={business?.name} />
              <Row label="المجال" value={business?.sector} />
              <Row label="الموقع" value={business?.website} />
              <Row label="الميزانية" value={business?.monthly_budget ? `${business.monthly_budget} ر.س` : null} />
            </dl>
          </section>

          {/* Session */}
          <section className="flex flex-col rounded-lg border border-border bg-card p-6">
            <h2 className="text-lg font-bold">الجلسة</h2>
            <p className="mt-1 flex-1 text-sm leading-7 text-muted-foreground">
              أنت مسجّل الدخول بالبريد <span dir="ltr" className="font-medium text-foreground"><span className="break-all">{user?.email}</span></span>. يمكنك
              تسجيل الخروج في أي وقت والعودة بنفس الحساب.
            </p>
            <form action="/api/auth/signout" method="post" className="mt-4">
              <PendingSubmitButton pendingLabel="جاري الخروج..." className={buttonClasses({ variant: 'outline' })}>
                <LogOut className="h-4 w-4" />
                تسجيل الخروج
              </PendingSubmitButton>
            </form>
          </section>
        </div>

        {/* Linked accounts + rename */}
        <section className="rounded-lg border border-border bg-card p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold">حسابات إعلانات Google</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                سمِّ أي حساب باسم يسهل عليك تمييزه، خاصة الحسابات التي لم ترجع Google اسماً لها.
              </p>
            </div>
            <Link href="/onboarding/connect" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
              إضافة حساب
            </Link>
          </div>

          {(accounts ?? []).length === 0 ? (
            <div className="mt-5 rounded-lg border border-border bg-muted p-6 text-center text-sm text-muted-foreground">
              لا توجد حسابات مربوطة بعد.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {(accounts ?? []).map((account: any) => {
                const missing = googleAdsAccountNameMissing(account);
                return (
                  <div key={account.customer_id} className="rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <Building2 className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <div className="truncate font-semibold text-foreground">{googleAdsAccountDisplayName(account)}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span dir="ltr">{formatGoogleAdsCustomerId(account.customer_id)}</span>
                            <span>· {account.currency_code ?? '—'}</span>
                            <span>· {account.time_zone ?? '—'}</span>
                          </div>
                        </div>
                      </div>
                      {missing && <StatusBadge tone="warning">بدون اسم من Google</StatusBadge>}
                    </div>

                    <form
                      action="/api/accounts/rename"
                      method="post"
                      className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]"
                    >
                      <input type="hidden" name="customer_id" value={account.customer_id} />
                      <input
                        name="customer_name"
                        defaultValue={missing ? '' : account.customer_name ?? ''}
                        className="h-10 w-full rounded-lg border border-border px-3 text-sm outline-none focus:border-brand-500"
                        placeholder={missing ? 'اكتب اسم عرض لهذا الحساب' : 'اسم الحساب'}
                        aria-label={`اسم العرض للحساب ${account.customer_id}`}
                      />
                      <PendingSubmitButton
                        pendingLabel="جاري الحفظ..."
                        className={buttonClasses({ variant: 'outline' })}
                      >
                        حفظ الاسم
                      </PendingSubmitButton>
                    </form>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Danger zone */}
        <section className="rounded-lg border border-red-200 dark:border-red-500/25 bg-card p-6">
          <h2 className="text-lg font-bold text-red-700 dark:text-red-300">حذف الحساب نهائياً</h2>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-muted-foreground">
            هذا الإجراء يحذف حسابك من مُضاعِف، بيانات النشاط، الحسابات الإعلانية المربوطة، المحادثات، التقارير،
            والتوصيات. إذا كان لديك اشتراك Stripe نشط فسيتم إلغاؤه أولاً، ولن نحذف الحساب إذا تعذر الإلغاء.
          </p>
          {params?.delete_error && (
            <div className="mt-4">
              <Alert tone="danger">{deleteErrors[params.delete_error] ?? 'تعذر حذف الحساب.'}</Alert>
            </div>
          )}
          <form action="/api/account/delete" method="post" className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="text-sm">
              <span className="mb-2 block font-semibold text-foreground">للتأكيد اكتب: حذف حسابي</span>
              <input
                name="confirmation"
                className="h-12 w-full rounded-lg border border-red-200 dark:border-red-500/25 px-4 text-sm outline-none focus:border-red-500"
                placeholder="حذف حسابي"
                aria-label="اكتب عبارة التأكيد: حذف حسابي"
                autoComplete="off"
              />
            </label>
            <PendingSubmitButton
              pendingLabel="جاري حذف الحساب..."
              className={buttonClasses({ variant: 'danger', size: 'lg' })}
            >
              حذف حسابي نهائياً
            </PendingSubmitButton>
          </form>
        </section>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border pb-3 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-medium text-foreground">{value ?? '—'}</dd>
    </div>
  );
}

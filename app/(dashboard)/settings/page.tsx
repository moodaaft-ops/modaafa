import Link from 'next/link';
import { Activity, LogOut, Pencil } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import {
  formatGoogleAdsCustomerId,
  googleAdsAccountDisplayName,
  googleAdsAccountNameMissing,
} from '@/lib/accounts/display';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
import { getPlatformReadiness, readinessSummary } from '@/lib/platform/readiness';
import { isModaafaOperator } from '@/lib/platform/operators';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { CARD, CalmHeading, CalmNote, CalmPage, CalmTitle, FIELD, StatusWord, pill } from '../calm-page';

const deleteErrors: Record<string, string> = {
  invalid_origin: 'تعذر التحقق من مصدر الطلب. أعد المحاولة من داخل المنصة.',
  confirmation_required: 'اكتب عبارة التأكيد كما هي: حذف حسابي',
  service_role_missing: 'الحذف النهائي يحتاج مفتاح Supabase الإداري في بيئة الإنتاج.',
  billing_check_failed: 'تعذر التأكد من حالة الفوترة، لذلك لم نحذف الحساب حمايةً لك.',
  billing_cancellation_required: 'يوجد اشتراك قائم لا يمكن إلغاؤه آلياً. افتح إدارة الاشتراك أو تواصل معنا.',
  billing_cancellation_failed: 'تعذر إلغاء اشتراك Stripe، لذلك لم نحذف حسابك ولم تتأثر بياناتك.',
  profile_delete_failed: 'تعذر حذف بيانات الحساب. أعد المحاولة أو تواصل معنا.',
  auth_delete_failed: 'حذفت بيانات الحساب لكن تعذر حذف مستخدم الدخول. تواصل معنا لإكمال الحذف.',
  google_revoke_failed:
    'تعذر إلغاء صلاحية Google Ads نهائياً، لذلك لم نحذف حسابك، لأن الحذف بدون إلغاء الصلاحية يترك وصولاً مفتوحاً لا يمكن سحبه لاحقاً. أعد المحاولة بعد قليل أو تواصل معنا.',
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
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login');
  const { business, accounts } = await getAccountWorkspace(user.id);
  // The launch-readiness panel is an OPERATOR view: it names environment
  // variables and reports whether Google's OAuth verification has completed.
  // Rendering it as the first thing a paying customer sees told them the
  // product was broken (a red "N عائق إطلاق" badge on their own settings
  // page) and leaked deployment detail. Gate it on an explicit allowlist;
  // /api/health remains the real operator surface.
  const isOperator = isModaafaOperator(user.email);
  const readiness = isOperator ? getPlatformReadiness() : [];
  const summary = readinessSummary(readiness);


  return (
    <CalmPage>
      <CalmTitle title="الإعدادات" description="بيانات النشاط والحسابات المربوطة وإدارة الجلسة." />

      {(params?.renamed || params?.rename_error) && (
        <div className="mt-6 space-y-3">
          {params?.renamed && <CalmNote tone="success">تم حفظ اسم الحساب.</CalmNote>}
          {params?.rename_error && (
            <CalmNote tone="danger">{renameErrors[params.rename_error] ?? 'تعذر حفظ الاسم.'}</CalmNote>
          )}
        </div>
      )}

      {/* Linked accounts: the part of this page people actually use. */}
      <section className="mt-8" aria-labelledby="accounts-title">
        <CalmHeading
          id="accounts-title"
          title="حسابات إعلانات Google"
          hint="سمِّ أي حساب باسم يسهل عليك تمييزه، خاصة الحسابات التي لم ترجع Google اسماً لها."
          action={
            <Link href="/onboarding/connect" className={pill.quietSm}>
              إضافة حساب
            </Link>
          }
          className="mb-3"
        />

        {(accounts ?? []).length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-[17px] font-semibold leading-8">لا توجد حسابات مربوطة</p>
            <p className="mx-auto mt-1 max-w-[460px] text-[14.5px] leading-8 text-muted-foreground">
              اربط إعلانات Google بموافقة واحدة، ونسحب حسابك المباشر وكل حساب عميل تحت أي حساب إداري.
            </p>
            <Link href="/onboarding/connect" className={cn(pill.primary, 'mt-5')}>
              ربط إعلانات Google
            </Link>
          </div>
        ) : (
          <ul className={cn(CARD, 'divide-y divide-border/70 overflow-hidden')}>
            {(accounts ?? []).map((account: any) => {
              const missing = googleAdsAccountNameMissing(account);
              return (
                <li key={account.customer_id} className="px-5 py-5 sm:px-7">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0">
                      <div className="truncate text-[16px] font-semibold leading-7 text-foreground">
                        {googleAdsAccountDisplayName(account)}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 text-[13px] leading-6 text-muted-foreground">
                        <span className="numeric" dir="ltr">
                          {formatGoogleAdsCustomerId(account.customer_id)}
                        </span>
                        {account.currency_code && (
                          <>
                            <span aria-hidden>·</span>
                            <span dir="ltr">{account.currency_code}</span>
                          </>
                        )}
                        {account.time_zone && (
                          <>
                            <span aria-hidden>·</span>
                            <span dir="ltr">{account.time_zone}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {missing && <StatusWord tone="warning">بدون اسم من Google</StatusWord>}
                  </div>

                  <form
                    action="/api/accounts/rename"
                    method="post"
                    className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]"
                  >
                    <input type="hidden" name="customer_id" value={account.customer_id} />
                    <input
                      name="customer_name"
                      defaultValue={missing ? '' : account.customer_name ?? ''}
                      className={FIELD}
                      placeholder={missing ? 'اكتب اسم عرض لهذا الحساب' : 'اسم الحساب'}
                      aria-label={`اسم العرض للحساب ${account.customer_id}`}
                    />
                    <PendingSubmitButton pendingLabel="جاري الحفظ..." className={cn(pill.quiet, 'h-11')}>
                      حفظ الاسم
                    </PendingSubmitButton>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Business profile */}
      <section className="mt-10" aria-labelledby="business-title">
        <CalmHeading
          id="business-title"
          title="النشاط"
          action={
            <Link href="/onboarding/business" className={cn(pill.quietSm, 'gap-1.5')}>
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              تعديل
            </Link>
          }
          className="mb-3"
        />
        <dl className={cn(CARD, 'divide-y divide-border/70 px-5 sm:px-7')}>
          <Row label="الاسم" value={business?.name} />
          <Row label="المجال" value={business?.sector} />
          <Row label="الموقع" value={business?.website} />
          <Row label="الميزانية" value={business?.monthly_budget ? `${business.monthly_budget} ر.س` : null} />
        </dl>
      </section>

      {/* Session */}
      <section className="mt-10" aria-labelledby="session-title">
        <CalmHeading id="session-title" title="الجلسة" />
        <p className="mt-1 max-w-[640px] text-[14.5px] leading-8 text-muted-foreground">
          أنت مسجّل الدخول بالبريد <span dir="ltr" className="font-medium text-foreground"><span className="break-all">{user?.email}</span></span>. يمكنك
          تسجيل الخروج في أي وقت والعودة بنفس الحساب.
        </p>
        <form action="/api/auth/signout" method="post" className="mt-4">
          <PendingSubmitButton pendingLabel="جاري الخروج..." className={pill.quiet}>
            <LogOut className="h-4 w-4" aria-hidden />
            تسجيل الخروج
          </PendingSubmitButton>
        </form>
      </section>

      {/* Cancel without deleting: the subscription card lives on the billing page. */}
      <section className="mt-10" aria-labelledby="cancel-title">
        <CalmHeading id="cancel-title" title="إلغاء الاشتراك فقط" />
        <p className="mt-1 max-w-[640px] text-[14.5px] leading-8 text-muted-foreground">
          تبي توقف الدفع بدون ما تحذف حسابك؟ الإلغاء من صفحة الفوترة، وبياناتك تبقى كما هي.
        </p>
        <Link href="/billing#cancel" className={cn(pill.quiet, 'mt-4')}>
          إلغاء الاشتراك
        </Link>
      </section>

      {/* Danger zone */}
      <section className="mt-12 rounded-[18px] border border-danger/25 bg-danger-soft/40 p-6 sm:p-7" aria-labelledby="delete-title">
        <h2 id="delete-title" className="text-[16px] font-bold leading-8 text-danger">
          حذف الحساب نهائياً
        </h2>
        <p className="mt-1 max-w-[640px] text-[14.5px] leading-8 text-muted-foreground">
          هذا الإجراء يحذف حسابك من مُضاعِف، بيانات النشاط، الحسابات الإعلانية المربوطة، المحادثات، التقارير،
          والتوصيات. إذا كان لديك اشتراك Stripe نشط فسيتم إلغاؤه أولاً، ولن نحذف الحساب إذا تعذر الإلغاء.
        </p>
        {params?.delete_error && (
          <div className="mt-4">
            <CalmNote tone="danger">{deleteErrors[params.delete_error] ?? 'تعذر حذف الحساب.'}</CalmNote>
          </div>
        )}
        <form action="/api/account/delete" method="post" className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="text-sm">
            <span className="mb-2 block text-[14px] font-medium text-foreground">للتأكيد اكتب: حذف حسابي</span>
            <input
              name="confirmation"
              className={cn(FIELD, 'border-danger/40 focus:border-danger/70 focus:ring-danger/15')}
              placeholder="حذف حسابي"
              aria-label="اكتب عبارة التأكيد: حذف حسابي"
              autoComplete="off"
            />
          </label>
          <PendingSubmitButton pendingLabel="جاري حذف الحساب..." className={cn(pill.danger, 'h-11')}>
            حذف حسابي نهائياً
          </PendingSubmitButton>
        </form>
      </section>

      {/* Readiness: operators only, last, so it never looks like part of a customer's settings. */}
      {isOperator && (
        <section className="mt-12" aria-labelledby="readiness-title">
          <CalmHeading
            id="readiness-title"
            title="جاهزية الإطلاق"
            hint="فحص آمن للإعدادات الحرجة بدون عرض أي مفاتيح أو أسرار."
            action={
              <StatusWord tone={summary.ok ? 'success' : 'danger'}>
                {summary.ok ? 'جاهز تقنياً' : `${summary.blockers} عائق إطلاق`}
              </StatusWord>
            }
            className="mb-3"
          />
          <ul className={cn(CARD, 'divide-y divide-border/70 overflow-hidden')}>
            {readiness.map((item) => (
              <li key={item.id} className="px-5 py-4 sm:px-7">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold text-foreground">{item.label_ar}</div>
                    <div className="text-[12.5px] text-muted-foreground" dir="ltr">
                      {item.label_en}
                    </div>
                  </div>
                  <StatusWord tone={item.ok ? 'success' : item.severity === 'blocker' ? 'danger' : 'warning'}>
                    {item.ok ? 'مكتمل' : item.severity === 'blocker' ? 'عائق' : 'تنبيه'}
                  </StatusWord>
                </div>
                {!item.ok && <p className="mt-2 text-[13.5px] leading-7 text-muted-foreground">{item.fix_ar}</p>}
              </li>
            ))}
          </ul>
          <Link href="/operations" className={cn(pill.quiet, 'mt-4')}>
            <Activity className="h-4 w-4" aria-hidden />
            فتح مركز التشغيل
          </Link>
        </section>
      )}
    </CalmPage>
  );
}

function Row({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <dt className="text-[14.5px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-[15px] font-medium text-foreground">{value ?? 'ما فيه'}</dd>
    </div>
  );
}

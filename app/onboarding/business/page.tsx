import { redirect } from 'next/navigation';
import { ArrowLeft, Lightbulb, ShieldCheck } from 'lucide-react';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { buttonClasses } from '@/lib/ui/button';
import { Alert } from '@/lib/ui/alert';
import { Field, inputClasses } from '@/lib/ui/field';
import { OnboardingProgress } from '../onboarding-progress';

const goals = [
  { value: 'leads', label: 'عملاء محتملون' },
  { value: 'conversions', label: 'مبيعات وتحويلات' },
  { value: 'traffic', label: 'زيارات مؤهلة' },
  { value: 'awareness', label: 'انتشار ووعي' },
];

const errors: Record<string, string> = {
  invalid_origin: 'تعذر التحقق من مصدر الطلب. أعد المحاولة من داخل المنصة.',
  no_business: 'احفظ بيانات النشاط أولاً ثم اربط إعلانات Google.',
  business_name_required: 'أدخل اسماً صحيحاً للنشاط لا يتجاوز 120 حرفاً.',
  invalid_website: 'رابط الموقع غير صالح. استخدم رابطاً يبدأ بـ https:// أو http://.',
  invalid_monthly_budget: 'أدخل ميزانية شهرية صحيحة بقيمة موجبة.',
  invalid_primary_goal: 'اختر هدفاً رئيسياً من الخيارات المتاحة.',
  too_many_requests: 'تم إرسال النموذج عدة مرات خلال فترة قصيرة. انتظر دقيقة ثم أعد المحاولة.',
  security_service_unavailable: 'تعذر التحقق الآمن من الطلب الآن. أعد المحاولة بعد قليل.',
  save_failed: 'تعذر حفظ بيانات النشاط الآن. لم نفقد بيانات حسابك الإعلاني، وأعد المحاولة بعد قليل.',
};

export default async function BusinessOnboardingPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/onboarding/business');
  const [{ data: business }, { accounts }] = await Promise.all([
    supabase
      .from('businesses')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    getAccountWorkspace(user.id),
  ]);
  // Settings links here to EDIT an existing profile, so a user who arrives
  // that way is not onboarding at all and must be able to leave without
  // submitting the form.
  const canLeave = (accounts?.length ?? 0) > 0;

  return (
    <main className="px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <OnboardingProgress active="business" showDashboardLink={canLeave} />

        <div className="mb-6 mt-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-[26px] font-bold leading-tight sm:text-3xl">عرّفنا على نشاطك</h2>
            <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
              هذي البيانات لا تغيّر أي شيء في حسابك الإعلاني، لكنها تجعل التوصيات مناسبة لسوقك وميزانيتك.
            </p>
          </div>
          {user?.email && (
            <span
              className="rounded-lg border border-border bg-background-elevated px-3 py-2 text-xs text-muted-foreground"
              dir="ltr"
            >
              {user.email}
            </span>
          )}
        </div>

        <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
          <form action="/api/onboarding/business" method="post" className="surface-card p-5 sm:p-6">
            {params?.error && (
              <div className="mb-5">
                <Alert tone="danger">{errors[params.error] ?? 'تعذر حفظ بيانات النشاط.'}</Alert>
              </div>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="اسم النشاط" required>
                <input
                  name="name"
                  required
                  defaultValue={business?.name ?? ''}
                  className={inputClasses}
                  placeholder="مثلاً: عيادة، متجر، شركة خدمات"
                />
              </Field>

              <Field label="المجال">
                <input
                  name="sector"
                  defaultValue={business?.sector ?? ''}
                  className={inputClasses}
                  placeholder="صحة، تجارة إلكترونية، عقار..."
                />
              </Field>

              <Field label="الموقع الإلكتروني">
                <input
                  name="website"
                  defaultValue={business?.website ?? ''}
                  className={inputClasses}
                  placeholder="https://example.com"
                  dir="ltr"
                />
              </Field>

              <Field label="الميزانية الشهرية التقريبية" hint="بالريال السعودي">
                <input
                  name="monthly_budget"
                  type="number"
                  min="0"
                  max="1000000000"
                  defaultValue={business?.monthly_budget ?? ''}
                  className={inputClasses}
                  placeholder="15000"
                />
              </Field>
            </div>

            <fieldset className="mt-6">
              <legend className="mb-2 text-[13px] font-medium text-foreground">الهدف الأساسي</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {goals.map((goal) => (
                  <label
                    key={goal.value}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-background-elevated px-3.5 py-3 text-[13px] transition-colors duration-150 hover:border-border-strong has-[:checked]:border-primary/60 has-[:checked]:bg-primary/[0.08] has-[:checked]:font-semibold has-[:checked]:text-primary"
                  >
                    <input
                      type="radio"
                      name="primary_goal"
                      value={goal.value}
                      defaultChecked={(business?.primary_goal ?? 'leads') === goal.value}
                      className="h-4 w-4 accent-brand-600"
                    />
                    <span>{goal.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mt-6">
              <Field label="المدن أو المناطق المستهدفة" hint="افصل بينها بفاصلة">
                <input
                  name="target_regions"
                  defaultValue={(business?.target_regions ?? []).join('، ')}
                  className={inputClasses}
                  placeholder="الرياض، جدة، الدمام"
                />
              </Field>
            </div>

            <div className="mt-7 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-5">
              {canLeave && (
                <a href="/dashboard" className={buttonClasses({ variant: 'ghost' })}>
                  إلغاء
                </a>
              )}
              <PendingSubmitButton
                pendingLabel="جاري حفظ النشاط..."
                className={buttonClasses({ variant: 'primary', size: 'lg' })}
              >
                التالي: ربط إعلانات Google
                <ArrowLeft className="h-4 w-4" />
              </PendingSubmitButton>
            </div>
          </form>

          <aside className="space-y-3">
            <div className="surface-card p-5">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                <Lightbulb className="h-4 w-4 text-amber-500" />
                لماذا نطلب هذا؟
              </div>
              <p className="mt-3 text-[13px] leading-7 text-muted-foreground">
                نستخدم مجالك وميزانيتك وهدفك لضبط أولويات الفحص والتوصيات، فبدل توصيات عامة تحصل على قرارات مناسبة
                لحجم إنفاقك وسوقك.
              </p>
            </div>
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.08] p-5">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-emerald-700 dark:text-emerald-300">
                <ShieldCheck className="h-4 w-4" />
                خطوتك القادمة
              </div>
              <p className="mt-3 text-[13px] leading-7 text-emerald-800/90 dark:text-emerald-200/80">
                بعد الحفظ ننتقل مباشرة لربط إعلانات Google بموافقة واحدة تسحب كل حساباتك.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

import { redirect } from 'next/navigation';
import { ArrowLeft, Lightbulb, ShieldCheck } from 'lucide-react';
import { createServerClient } from '@/lib/supabase/server';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { buttonClasses } from '@/lib/ui/button';
import { Alert } from '@/lib/ui/alert';
import { OnboardingProgress } from '../onboarding-progress';

const goals = [
  { value: 'leads', label: 'عملاء محتملون' },
  { value: 'conversions', label: 'مبيعات وتحويلات' },
  { value: 'traffic', label: 'زيارات مؤهلة' },
  { value: 'awareness', label: 'انتشار ووعي' },
];

const errors: Record<string, string> = {
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
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding/business');
  const { data: business } = await supabase
    .from('businesses')
    .select('*')
    .eq('user_id', user?.id ?? '')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <OnboardingProgress active="business" />

        <div className="mb-6 mt-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold sm:text-3xl">عرّفنا على نشاطك</h2>
            <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
              هذي البيانات لا تغيّر أي شيء في حسابك الإعلاني، لكنها تجعل التوصيات مناسبة لسوقك وميزانيتك.
            </p>
          </div>
          {user?.email && (
            <span className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground" dir="ltr">
              {user.email}
            </span>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          <form
            action="/api/onboarding/business"
            method="post"
            className="rounded-lg border border-border bg-card p-5 shadow-soft sm:p-6"
          >
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
                  className={inputClass}
                  placeholder="مثلاً: عيادة، متجر، شركة خدمات"
                />
              </Field>

              <Field label="المجال">
                <input
                  name="sector"
                  defaultValue={business?.sector ?? ''}
                  className={inputClass}
                  placeholder="صحة، تجارة إلكترونية، عقار..."
                />
              </Field>

              <Field label="الموقع الإلكتروني">
                <input
                  name="website"
                  defaultValue={business?.website ?? ''}
                  className={inputClass}
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
                  className={inputClass}
                  placeholder="15000"
                />
              </Field>
            </div>

            <div className="mt-5">
              <span className="text-sm font-medium text-foreground">الهدف الأساسي</span>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {goals.map((goal) => (
                  <label
                    key={goal.value}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm transition hover:bg-muted has-[:checked]:border-brand-300 has-[:checked]:bg-brand-50 dark:has-[:checked]:bg-brand-500/15 has-[:checked]:font-semibold has-[:checked]:text-brand-800 dark:has-[:checked]:text-brand-300"
                  >
                    <input
                      type="radio"
                      name="primary_goal"
                      value={goal.value}
                      defaultChecked={(business?.primary_goal ?? 'leads') === goal.value}
                      className="accent-brand-600"
                    />
                    <span>{goal.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="mt-5">
              <Field label="المدن أو المناطق المستهدفة" hint="افصل بينها بفاصلة">
                <input
                  name="target_regions"
                  defaultValue={(business?.target_regions ?? []).join('، ')}
                  className={inputClass}
                  placeholder="الرياض، جدة، الدمام"
                />
              </Field>
            </div>

            <div className="mt-6 flex justify-end border-t border-border pt-5">
              <PendingSubmitButton
                pendingLabel="جاري حفظ النشاط..."
                className={buttonClasses({ variant: 'primary', size: 'lg' })}
              >
                التالي: ربط إعلانات Google
                <ArrowLeft className="h-4 w-4" />
              </PendingSubmitButton>
            </div>
          </form>

          <aside className="space-y-4">
            <div className="rounded-lg border border-border bg-card p-5 shadow-soft">
              <div className="flex items-center gap-2 font-semibold text-foreground">
                <Lightbulb className="h-5 w-5 text-amber-500" />
                لماذا نطلب هذا؟
              </div>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">
                نستخدم مجالك وميزانيتك وهدفك لضبط أولويات الفحص والتوصيات، فبدل توصيات عامة تحصل على قرارات مناسبة لحجم إنفاقك وسوقك.
              </p>
            </div>
            <div className="rounded-lg border border-emerald-100 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/15 p-5">
              <div className="flex items-center gap-2 font-semibold text-emerald-800 dark:text-emerald-300">
                <ShieldCheck className="h-5 w-5" />
                خطوتك القادمة
              </div>
              <p className="mt-3 text-sm leading-7 text-emerald-800/90 dark:text-emerald-300">
                بعد الحفظ ننتقل مباشرة لربط إعلانات Google بموافقة واحدة تسحب كل حساباتك.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

const inputClass =
  'mt-2 h-11 w-full rounded-lg border border-border px-3.5 text-sm outline-none transition focus:border-brand-500';

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-foreground">
        {label}
        {required && <span className="text-red-500"> *</span>}
        {hint && <span className="ms-1 text-xs font-normal text-muted-foreground"> — {hint}</span>}
      </span>
      {children}
    </label>
  );
}

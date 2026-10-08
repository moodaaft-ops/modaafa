import { redirect } from 'next/navigation';
import { Lightbulb, ShieldCheck } from 'lucide-react';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { OnboardingProgress } from '../onboarding-progress';
import { BusinessForm } from './business-form';

const errors: Record<string, string> = {
  invalid_origin: 'تعذر التحقق من مصدر الطلب. أعد المحاولة من داخل المنصة.',
  no_business: 'احفظ بيانات النشاط أولاً ثم اربط Google Ads.',
  business_name_required: 'أدخل اسماً صحيحاً للنشاط لا يتجاوز 120 حرفاً.',
  invalid_website: 'رابط الموقع غير صحيح. مثال صحيح: example.com',
  invalid_monthly_budget: 'اكتب الميزانية رقماً صحيحاً بالريال بدون كسور.',
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
              className="border border-border bg-background-elevated px-3 py-2 text-xs text-muted-foreground"
              dir="ltr"
            >
              {user.email}
            </span>
          )}
        </div>

        <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
          <BusinessForm
            initial={{
              name: business?.name ?? '',
              sector: business?.sector ?? '',
              website: business?.website ?? '',
              monthly_budget: business?.monthly_budget ? String(business.monthly_budget) : '',
              primary_goal: business?.primary_goal ?? 'leads',
              target_regions: (business?.target_regions ?? []).join('، '),
            }}
            serverError={params?.error ? errors[params.error] ?? 'تعذر حفظ بيانات النشاط.' : null}
            canLeave={canLeave}
          />

          <aside className="space-y-3">
            <div className="surface-card p-5">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                <Lightbulb className="h-4 w-4 text-warning" />
                لماذا نطلب هذا؟
              </div>
              <p className="mt-3 text-[13px] leading-7 text-muted-foreground">
                نستخدم مجالك وميزانيتك وهدفك لضبط أولويات الفحص والتوصيات، فبدل توصيات عامة تحصل على قرارات مناسبة
                لحجم إنفاقك وسوقك.
              </p>
            </div>
            <div className="surface-card p-5">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                <ShieldCheck className="h-4 w-4" />
                خطوتك القادمة
              </div>
              <p className="mt-3 text-[13px] leading-7 text-muted-foreground">
                بعد الحفظ ننتقل مباشرة لربط Google Ads بموافقة واحدة تسحب كل حساباتك.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

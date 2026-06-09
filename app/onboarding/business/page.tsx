import { createServerClient } from '@/lib/supabase/server';

const goals = [
  { value: 'leads', label: 'عملاء محتملون' },
  { value: 'conversions', label: 'مبيعات وتحويلات' },
  { value: 'traffic', label: 'زيارات مؤهلة' },
  { value: 'awareness', label: 'انتشار ووعي' },
];

export default async function BusinessOnboardingPage({
  searchParams,
}: {
  searchParams?: { error?: string };
}) {
  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: business } = await supabase
    .from('businesses')
    .select('*')
    .eq('user_id', user?.id ?? '')
    .single();

  return (
    <main className="min-h-screen bg-ink-50 px-6 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-brand-700">مُضاعِف</div>
            <h1 className="mt-2 text-3xl font-bold">إعداد نشاطك</h1>
            <p className="mt-2 text-sm text-ink-500">نحتاج هذه البيانات قبل قراءة حسابك الإعلاني حتى تكون التوصيات مناسبة لسوقك وميزانيتك.</p>
          </div>
          <div className="rounded-lg border border-ink-200 bg-white px-4 py-2 text-sm text-ink-500">
            {user?.email}
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <form
            action="/api/onboarding/business"
            method="post"
            className="rounded-lg border border-ink-100 bg-white p-6 shadow-sm"
          >
            {searchParams?.error && (
              <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                احفظ بيانات النشاط أولاً ثم اربط Google Ads.
              </div>
            )}

            <div className="grid gap-5 md:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium">اسم النشاط</span>
                <input
                  name="name"
                  required
                  defaultValue={business?.name ?? ''}
                  className="mt-2 w-full rounded-lg border border-ink-200 px-4 py-3 outline-none focus:border-brand-500"
                  placeholder="مثلاً: عيادة، متجر، شركة خدمات"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium">المجال</span>
                <input
                  name="sector"
                  defaultValue={business?.sector ?? ''}
                  className="mt-2 w-full rounded-lg border border-ink-200 px-4 py-3 outline-none focus:border-brand-500"
                  placeholder="صحة، تجارة إلكترونية، عقار..."
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium">الموقع الإلكتروني</span>
                <input
                  name="website"
                  defaultValue={business?.website ?? ''}
                  className="mt-2 w-full rounded-lg border border-ink-200 px-4 py-3 outline-none focus:border-brand-500"
                  placeholder="https://example.com"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium">الميزانية الشهرية التقريبية</span>
                <input
                  name="monthly_budget"
                  type="number"
                  min="0"
                  defaultValue={business?.monthly_budget ?? ''}
                  className="mt-2 w-full rounded-lg border border-ink-200 px-4 py-3 outline-none focus:border-brand-500"
                  placeholder="15000"
                />
              </label>
            </div>

            <div className="mt-5">
              <span className="text-sm font-medium">الهدف الأساسي</span>
              <div className="mt-2 grid gap-3 md:grid-cols-4">
                {goals.map((goal) => (
                  <label
                    key={goal.value}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-ink-200 px-3 py-3 text-sm hover:bg-ink-50"
                  >
                    <input
                      type="radio"
                      name="primary_goal"
                      value={goal.value}
                      defaultChecked={(business?.primary_goal ?? 'leads') === goal.value}
                    />
                    <span>{goal.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <label className="mt-5 block">
              <span className="text-sm font-medium">المدن أو المناطق المستهدفة</span>
              <input
                name="target_regions"
                defaultValue={(business?.target_regions ?? []).join(', ')}
                className="mt-2 w-full rounded-lg border border-ink-200 px-4 py-3 outline-none focus:border-brand-500"
                placeholder="الرياض، جدة، الدمام"
              />
            </label>

            <div className="mt-6 flex justify-end">
              <button className="rounded-lg bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700">
                حفظ والانتقال للربط
              </button>
            </div>
          </form>

          <aside className="rounded-lg border border-ink-100 bg-white p-6 shadow-sm">
            <div className="text-sm font-semibold text-ink-500">التدفق</div>
            <ol className="mt-4 space-y-4 text-sm">
              <li className="rounded-lg bg-brand-50 p-3 font-medium text-brand-800">1. بيانات النشاط</li>
              <li className="rounded-lg bg-ink-50 p-3 text-ink-600">2. ربط Google Ads</li>
              <li className="rounded-lg bg-ink-50 p-3 text-ink-600">3. اختيار الحسابات</li>
              <li className="rounded-lg bg-ink-50 p-3 text-ink-600">4. أول فحص ذكي</li>
            </ol>
          </aside>
        </div>
      </div>
    </main>
  );
}

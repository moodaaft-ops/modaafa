import { createServerClient } from '@/lib/supabase/server';
import { formatSAR } from '@/lib/utils';

const plans = [
  { id: 'starter', name: 'Starter', price: 500, limit: 'حساب إعلاني واحد' },
  { id: 'growth', name: 'Growth', price: 1200, limit: 'حتى 5 حسابات' },
  { id: 'pro', name: 'Pro', price: 2500, limit: 'فرق ووكالات' },
];

export default async function BillingPage() {
  const supabase = createServerClient();
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-ink-100 bg-white/80 px-8 py-4 backdrop-blur-xl">
        <h1 className="text-xl font-bold">الفوترة</h1>
        <p className="text-sm text-ink-500">إدارة الخطة والاشتراك.</p>
      </header>
      <div className="p-8">
        {subscription && (
          <section className="mb-6 rounded-lg border border-ink-100 bg-white p-5">
            <div className="text-sm text-ink-500">الخطة الحالية</div>
            <div className="mt-1 text-2xl font-bold">{subscription.plan} · {subscription.status}</div>
          </section>
        )}
        <div className="grid gap-5 lg:grid-cols-3">
          {plans.map((plan) => (
            <section key={plan.id} className="rounded-lg border border-ink-100 bg-white p-6">
              <h2 className="text-xl font-bold">{plan.name}</h2>
              <div className="mt-4 text-3xl font-bold">{formatSAR(plan.price)}<span className="text-sm font-normal text-ink-500"> / شهر</span></div>
              <p className="mt-3 text-sm text-ink-500">{plan.limit}</p>
              <form action="/api/billing/checkout" method="post" className="mt-6">
                <input type="hidden" name="plan" value={plan.id} />
                <input type="hidden" name="period" value="monthly" />
                <button className="w-full rounded-lg bg-brand-600 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-700">
                  اختيار الخطة
                </button>
              </form>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

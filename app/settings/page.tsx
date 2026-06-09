import Link from 'next/link';
import { createServerClient } from '@/lib/supabase/server';

export default async function SettingsPage() {
  const supabase = createServerClient();
  const { data: business } = await supabase.from('businesses').select('*').single();
  const { data: accounts } = await supabase
    .from('google_ads_accounts')
    .select('customer_id, customer_name, manager_id, currency_code, time_zone, status')
    .order('linked_at', { ascending: false });

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-ink-100 bg-white/80 px-8 py-4 backdrop-blur-xl">
        <h1 className="text-xl font-bold">الإعدادات</h1>
        <p className="text-sm text-ink-500">بيانات النشاط وحسابات Google Ads المربوطة.</p>
      </header>
      <div className="grid gap-6 p-8 lg:grid-cols-2">
        <section className="rounded-lg border border-ink-100 bg-white p-6">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-bold">النشاط</h2>
            <Link href="/onboarding/business" className="text-sm font-semibold text-brand-700">تعديل</Link>
          </div>
          <dl className="mt-5 space-y-3 text-sm">
            <Row label="الاسم" value={business?.name} />
            <Row label="المجال" value={business?.sector} />
            <Row label="الموقع" value={business?.website} />
            <Row label="الميزانية" value={business?.monthly_budget ? `${business.monthly_budget} ر.س` : null} />
          </dl>
        </section>
        <section className="rounded-lg border border-ink-100 bg-white p-6">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-bold">حسابات Google Ads</h2>
            <Link href="/onboarding/connect" className="text-sm font-semibold text-brand-700">إضافة حساب</Link>
          </div>
          <div className="mt-5 divide-y divide-ink-100">
            {(accounts ?? []).length === 0 ? (
              <div className="py-6 text-sm text-ink-500">لا توجد حسابات مربوطة.</div>
            ) : (
              (accounts ?? []).map((account: any) => (
                <div key={account.customer_id} className="py-4 text-sm">
                  <div className="font-semibold">{account.customer_name ?? 'Google Ads'}</div>
                  <div className="mt-1 text-xs text-ink-500" dir="ltr">{account.customer_id}</div>
                  <div className="mt-1 text-xs text-ink-400">{account.currency_code ?? '—'} · {account.time_zone ?? '—'}</div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="flex justify-between gap-4 border-b border-ink-100 pb-3">
      <dt className="text-ink-500">{label}</dt>
      <dd className="font-medium">{value ?? '—'}</dd>
    </div>
  );
}

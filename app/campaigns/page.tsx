import Link from 'next/link';
import { createServerClient } from '@/lib/supabase/server';
import { formatNumberAr, formatSAR } from '@/lib/utils';

export default async function CampaignsPage() {
  const supabase = createServerClient();
  const { data: accounts } = await supabase
    .from('google_ads_accounts')
    .select('id, customer_id, customer_name')
    .order('linked_at', { ascending: false });
  const { data: campaigns } = await supabase
    .from('campaigns_cache')
    .select('*')
    .order('last_synced_at', { ascending: false });

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-ink-100 bg-white/80 px-8 py-4 backdrop-blur-xl">
        <h1 className="text-xl font-bold">الحملات</h1>
        <p className="text-sm text-ink-500">عرض الحملات المخزنة بعد أول مزامنة أو فحص للحساب.</p>
      </header>
      <div className="p-8">
        {(accounts?.length ?? 0) === 0 ? (
          <EmptyState title="لم تربط حساباً إعلانياً بعد" href="/onboarding/connect" action="ربط Google Ads" />
        ) : (campaigns?.length ?? 0) === 0 ? (
          <EmptyState title="لا توجد حملات محفوظة بعد" href="/audit" action="تشغيل فحص الحساب" />
        ) : (
          <section className="overflow-hidden rounded-lg border border-ink-100 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-ink-500">
                <tr>
                  <th className="px-6 py-3 text-right font-medium">الحملة</th>
                  <th className="py-3 text-right font-medium">الحالة</th>
                  <th className="py-3 text-right font-medium">الميزانية</th>
                  <th className="py-3 text-right font-medium">الصرف 30 يوم</th>
                  <th className="py-3 text-right font-medium">التحويلات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {(campaigns ?? []).map((campaign: any) => (
                  <tr key={campaign.id}>
                    <td className="px-6 py-4 font-semibold">{campaign.name}</td>
                    <td>{campaign.status}</td>
                    <td>{formatSAR(campaign.daily_budget ?? 0)}</td>
                    <td>{formatSAR(campaign.metrics_30d?.cost_sar ?? 0)}</td>
                    <td>{formatNumberAr(campaign.metrics_30d?.conversions ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </>
  );
}

function EmptyState({ title, href, action }: { title: string; href: string; action: string }) {
  return (
    <section className="rounded-lg border border-ink-100 bg-white p-10 text-center">
      <h2 className="text-xl font-bold">{title}</h2>
      <Link href={href} className="mt-5 inline-block rounded-lg bg-brand-600 px-5 py-3 text-sm font-semibold text-white">
        {action}
      </Link>
    </section>
  );
}

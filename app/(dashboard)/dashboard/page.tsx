import Link from 'next/link';
import { createServerClient } from '@/lib/supabase/server';
import { formatSAR, formatNumberAr } from '@/lib/utils';

export default async function DashboardPage() {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Aggregate KPIs from latest campaigns_cache
  const { data: campaigns } = await supabase
    .from('campaigns_cache')
    .select('*')
    .order('last_synced_at', { ascending: false });

  const { data: actionsToday } = await supabase
    .from('ai_actions')
    .select('id, expected_impact')
    .gte('created_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString());

  const { data: latestAudit } = await supabase
    .from('audits')
    .select('health_score, estimated_monthly_waste, ran_at')
    .order('ran_at', { ascending: false })
    .limit(1)
    .single();

  const totalSpend = (campaigns ?? []).reduce(
    (sum, c) => sum + (c.metrics_today?.cost_sar ?? 0),
    0
  );
  const totalConversions = (campaigns ?? []).reduce(
    (sum, c) => sum + (c.metrics_today?.conversions ?? 0),
    0
  );

  return (
    <>
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-xl border-b border-ink-100 px-8 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">لوحة التحكم</h1>
          <p className="text-sm text-ink-500">نظرة عامة على أداء حسابك</p>
        </div>
      </header>

      <div className="p-8">
        {/* Hero alert */}
        <div className="rounded-2xl bg-gradient-to-l from-brand-600 to-cyan-600 p-6 mb-6 text-white relative overflow-hidden">
          <div className="absolute -left-12 -bottom-12 w-48 h-48 rounded-full bg-white/10"></div>
          <div className="relative flex items-center justify-between flex-wrap gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-emerald-300 animate-pulse"></span>
                <span className="text-sm">الـ AI نشط الآن — يراقب حسابك</span>
              </div>
              <h2 className="text-2xl font-bold mb-1">
                قام مُضاعِف بـ {formatNumberAr(actionsToday?.length ?? 0)} تحسيناً اليوم
              </h2>
            </div>
            <Link
              href="/optimizer"
              className="px-5 py-2.5 rounded-xl bg-white/20 backdrop-blur hover:bg-white/30 text-sm font-medium"
            >
              عرض التفاصيل ←
            </Link>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <KpiCard label="الإنفاق اليوم" value={formatSAR(totalSpend)} />
          <KpiCard label="التحويلات" value={formatNumberAr(totalConversions)} />
          <KpiCard
            label="صحة الحساب"
            value={`${latestAudit?.health_score ?? '—'}/100`}
            href="/audit"
          />
          <KpiCard
            label="تسريب الميزانية"
            value={formatSAR(latestAudit?.estimated_monthly_waste ?? 0)}
            tone="danger"
          />
        </div>

        {/* Active campaigns table */}
        <div className="bg-white rounded-2xl border border-ink-100 overflow-hidden">
          <div className="p-6 border-b border-ink-100 flex items-center justify-between">
            <div>
              <h3 className="font-bold">الحملات النشطة</h3>
              <p className="text-xs text-ink-500">
                {formatNumberAr(campaigns?.length ?? 0)} حملة قيد التشغيل
              </p>
            </div>
            <Link
              href="/campaigns/new"
              className="px-4 py-2 rounded-xl bg-brand-600 text-white text-sm font-medium hover:bg-brand-700"
            >
              + حملة جديدة
            </Link>
          </div>

          {(campaigns?.length ?? 0) === 0 ? (
            <div className="p-12 text-center text-ink-500">
              لا توجد حملات بعد. ابدأ بربط حسابك أو إنشاء حملة جديدة.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-ink-500 text-xs">
                <tr>
                  <th className="text-right py-3 px-6 font-medium">اسم الحملة</th>
                  <th className="text-right py-3 font-medium">الحالة</th>
                  <th className="text-right py-3 font-medium">الإنفاق ٣٠ يوم</th>
                  <th className="text-right py-3 font-medium">التحويلات</th>
                  <th className="text-right py-3 font-medium">ROAS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {(campaigns ?? []).map((c: any) => (
                  <tr key={c.id} className="hover:bg-ink-50">
                    <td className="py-4 px-6 font-medium">{c.name}</td>
                    <td>
                      <span className="px-2 py-1 rounded-md bg-emerald-50 text-emerald-700 text-xs">
                        {c.status}
                      </span>
                    </td>
                    <td>{formatSAR(c.metrics_30d?.cost_sar ?? 0)}</td>
                    <td>{formatNumberAr(c.metrics_30d?.conversions ?? 0)}</td>
                    <td className="font-bold text-emerald-600">
                      {(c.metrics_30d?.roas ?? 0).toFixed(1)}×
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function KpiCard({
  label,
  value,
  href,
  tone,
}: {
  label: string;
  value: string;
  href?: string;
  tone?: 'danger' | 'success';
}) {
  const cls =
    tone === 'danger'
      ? 'bg-gradient-to-br from-red-500 to-pink-600 text-white'
      : 'bg-white border border-ink-100';
  const inner = (
    <div className={`rounded-2xl p-5 ${cls}`}>
      <div className={`text-sm mb-1 ${tone ? 'opacity-90' : 'text-ink-500'}`}>{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

import { createServerClient } from '@/lib/supabase/server';
import { timeAgoAr } from '@/lib/utils';

export default async function ReportsPage() {
  const supabase = createServerClient();
  const { data: reports } = await supabase
    .from('reports')
    .select('*')
    .order('generated_at', { ascending: false })
    .limit(30);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-ink-100 bg-white/80 px-8 py-4 backdrop-blur-xl">
        <h1 className="text-xl font-bold">التقارير</h1>
        <p className="text-sm text-ink-500">ملخصات الأداء اليومية والأسبوعية بعد تشغيل الفحوصات والمزامنة.</p>
      </header>
      <div className="p-8">
        <section className="rounded-lg border border-ink-100 bg-white">
          {(reports ?? []).length === 0 ? (
            <div className="p-10 text-center text-sm text-ink-500">لا توجد تقارير محفوظة بعد.</div>
          ) : (
            <div className="divide-y divide-ink-100">
              {(reports ?? []).map((report: any) => (
                <article key={report.id} className="p-5">
                  <div className="flex items-center justify-between gap-4">
                    <h2 className="font-bold">{report.period_type}</h2>
                    <span className="text-xs text-ink-400">{timeAgoAr(report.generated_at)}</span>
                  </div>
                  <p className="mt-2 text-sm text-ink-600">{report.summary_ar ?? 'تقرير محفوظ بدون ملخص.'}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

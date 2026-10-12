import { Download, Filter } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import { createAdminClient, getRequestAuthContext } from '@/lib/supabase/server';
import { isModaafaOperator } from '@/lib/platform/operators';
import { loadFunnelReport } from '@/lib/stages/load-funnel';
import { formatPercent } from '@/lib/stages/funnel';
import { PageHeader } from '@/lib/ui/page-header';
import { Alert } from '@/lib/ui/alert';
import { buttonClasses } from '@/lib/ui/button';
import { formatNumberAr } from '@/lib/utils';

export const metadata = {
  title: 'مراحل المستخدمين',
};

export const dynamic = 'force-dynamic';

export default async function FunnelPage() {
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/operations/funnel');
  if (!isModaafaOperator(user.email)) notFound();

  let report;
  let loadError = false;
  try {
    report = await loadFunnelReport(createAdminClient());
  } catch (error) {
    console.error('[funnel] failed', error instanceof Error ? error.message : 'unknown');
    loadError = true;
  }

  return (
    <>
      <PageHeader
        icon={Filter}
        title="مراحل المستخدمين"
        description="كم مستخدم وصل لكل مرحلة، وكم نسبة اللي كمّلوا للمرحلة اللي بعدها."
        actions={
          <a href="/operations/funnel/export" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
            <Download className="size-4" aria-hidden />
            تصدير CSV
          </a>
        }
      />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        {loadError || !report ? (
          <Alert tone="danger">
            تعذر قراءة الأرقام. غالباً ملف قاعدة البيانات الخاص بالمراحل (20261012_user_stages.sql) ما انشغّل بعد.
          </Alert>
        ) : (
          <>
            <section className="surface-card overflow-hidden" aria-labelledby="funnel-title">
              <div className="border-b border-border px-5 py-4">
                <h2 id="funnel-title" className="text-sm font-semibold">
                  الكل مقابل آخر {formatNumberAr(report.windowDays)} أيام
                </h2>
                <p className="mt-1 text-xs leading-6 text-muted-foreground">
                  الكل: {formatNumberAr(report.allTime.total)} مستخدم. آخر {formatNumberAr(report.windowDays)} أيام:{' '}
                  {formatNumberAr(report.recent.total)} مستخدم سجّلوا خلال هالفترة.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="border-b border-border bg-background-elevated text-[11px] text-muted-foreground">
                    <tr>
                      <th rowSpan={2} className="px-5 py-2.5 text-start font-medium">المرحلة</th>
                      <th colSpan={3} className="px-3 py-2 text-start font-medium">الكل</th>
                      <th colSpan={3} className="px-3 py-2 text-start font-medium">
                        آخر {formatNumberAr(report.windowDays)} أيام
                      </th>
                    </tr>
                    <tr>
                      <th className="px-3 py-2 text-start font-medium">وصلوا</th>
                      <th className="px-3 py-2 text-start font-medium">الحاليون</th>
                      <th className="px-3 py-2 text-start font-medium">للتالية</th>
                      <th className="px-3 py-2 text-start font-medium">وصلوا</th>
                      <th className="px-3 py-2 text-start font-medium">الحاليون</th>
                      <th className="px-3 py-2 text-start font-medium">للتالية</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {report.allTime.rows.map((row, index) => {
                      const recent = report.recent.rows[index];
                      return (
                        <tr key={row.stage}>
                          <td className="px-5 py-3 font-medium">{row.label}</td>
                          <td className="px-3 py-3 numeric">{formatNumberAr(row.reached)}</td>
                          <td className="px-3 py-3 numeric text-muted-foreground">{formatNumberAr(row.current)}</td>
                          <td className="px-3 py-3 numeric">{formatPercent(row.rateToNext)}</td>
                          <td className="px-3 py-3 numeric">{formatNumberAr(recent.reached)}</td>
                          <td className="px-3 py-3 numeric text-muted-foreground">{formatNumberAr(recent.current)}</td>
                          <td className="px-3 py-3 numeric">{formatPercent(recent.rateToNext)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="surface-card p-5 text-xs leading-7 text-muted-foreground">
              <h2 className="mb-2 text-sm font-semibold text-foreground">كيف تنقرأ الأرقام</h2>
              <ul className="list-disc space-y-1 ps-5">
                <li>«وصلوا» يعني وصل للمرحلة أو تعداها. «الحاليون» من وقف عند هالمرحلة بالضبط.</li>
                <li>«للتالية» هي وصلوا للتالية مقسوماً على وصلوا للمرحلة هذي.</li>
                <li>
                  آخر {formatNumberAr(report.windowDays)} أيام تعدّ اللي سجّلوا خلالها وكم وصلوا لين الحين. اللي سجّل أمس
                  ما أخذ وقته، فنسبته تطلع أقل من الحقيقة.
                </li>
                <li>
                  «دفع الاشتراك» يحسب أول فاتورة بمبلغ أكبر من صفر. اللي بدأ تجربة بالبطاقة وما انسحب منه شي للحين
                  ما ينعدّ.
                </li>
                <li>
                  اللي سجّل قبل تشغيل التتبع أحداثه مبنية من بياناته القديمة، و«شاف التحليل» عندهم
                  معناه إن فيه فحص شغّلوه، مو إنهم فتحوا النتيجة فعلاً.
                </li>
              </ul>
            </section>
          </>
        )}
      </div>
    </>
  );
}

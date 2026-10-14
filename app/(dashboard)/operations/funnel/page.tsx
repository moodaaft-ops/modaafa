import { Download, Filter } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import { createAdminClient, getRequestAuthContext } from '@/lib/supabase/server';
import { isModaafaOperator } from '@/lib/platform/operators';
import { loadFunnelReport } from '@/lib/stages/load-funnel';
import { formatPercent } from '@/lib/stages/funnel';
import { loadEmailReport } from '@/lib/lifecycle/load-email-report';
import {
  NONE_AR,
  NOT_APPLICABLE_AR,
  UNAVAILABLE_AR,
  formatLift,
  formatShare,
  liftPoints,
  type EmailReport,
  type EmailReportRow,
} from '@/lib/lifecycle/email-report';
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
  let emailReport: EmailReport | null = null;
  let emailError = false;
  const admin = createAdminClient();
  try {
    report = await loadFunnelReport(admin);
  } catch (error) {
    console.error('[funnel] failed', error instanceof Error ? error.message : 'unknown');
    loadError = true;
  }
  // The email table is read on its own: if it fails the stage table above still shows.
  try {
    emailReport = await loadEmailReport(admin);
  } catch (error) {
    console.error('[funnel] email report failed', error instanceof Error ? error.message : 'unknown');
    emailError = true;
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
            تعذر قراءة الأرقام. غالباً ملف قاعدة البيانات الخاص بالمراحل (20261013_user_stages.sql) ما انشغّل بعد.
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

            <EmailSection report={emailReport} failed={emailError} />

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

/** count and its share of the mails sent, or the reason there is no number. */
function engagement(count: number, row: EmailReportRow, tracked: boolean) {
  if (!tracked) return UNAVAILABLE_AR;
  return `${formatNumberAr(count)} (${formatShare(count, row.sent)})`;
}

function EmailSection({ report, failed }: { report: EmailReport | null; failed: boolean }) {
  if (failed || !report) {
    return (
      <section className="surface-card p-5" aria-labelledby="email-title">
        <h2 id="email-title" className="mb-2 text-sm font-semibold">رسائل البريد</h2>
        <Alert tone="danger">
          تعذر قراءة أرقام رسائل البريد. جدول الرسائل أو الأحداث ما انقرأ، وجدول المراحل فوق ما تأثر.
        </Alert>
      </section>
    );
  }

  const tracked = report.engagementTracked;
  return (
    <section className="surface-card overflow-hidden" aria-labelledby="email-title">
      <div className="border-b border-border px-5 py-4">
        <h2 id="email-title" className="text-sm font-semibold">رسائل البريد</h2>
        <p className="mt-1 text-xs leading-6 text-muted-foreground">
          كل رسالة وش صار لها، وهل اللي وصلتهم الرسالة كملوا للمرحلة اللي بعدها أكثر من اللي ما أرسلنا لهم.
          مجموعة المقارنة {formatNumberAr(report.holdout.users)} من {formatNumberAr(report.holdout.total)} مستخدم
          (حوالي {formatNumberAr(report.holdout.percent)}%) ما نرسل لهم رسائل المسار عمداً.
        </p>
      </div>
      {!tracked && (
        <div className="border-b border-border px-5 py-3">
          <Alert tone="warning">
            أرقام الوصول والفتح والضغط ما تظهر لين ينشغّل ملف قاعدة البيانات 20261014_email_lifecycle.sql.
          </Alert>
        </div>
      )}
      {report.activatedAt === null && (
        <div className="border-b border-border px-5 py-3">
          <Alert tone="info">مقارنة مجموعة المقارنة ما بدأت، لأن مسار الرسائل ما انشغّل للحين.</Alert>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="border-b border-border bg-background-elevated text-[11px] text-muted-foreground">
            <tr>
              <th className="px-5 py-2.5 text-start font-medium">الرسالة</th>
              <th className="px-3 py-2.5 text-start font-medium">أُرسلت</th>
              <th className="px-3 py-2.5 text-start font-medium">وصلت</th>
              <th className="px-3 py-2.5 text-start font-medium">انفتحت</th>
              <th className="px-3 py-2.5 text-start font-medium">انضغط الرابط</th>
              <th className="px-3 py-2.5 text-start font-medium">أوقفوا الرسائل بعدها</th>
              <th className="px-3 py-2.5 text-start font-medium">ارتدّت</th>
              <th className="px-3 py-2.5 text-start font-medium">الهدف</th>
              <th className="px-3 py-2.5 text-start font-medium">المستلمون وصلوا</th>
              <th className="px-3 py-2.5 text-start font-medium">المقارنة وصلوا</th>
              <th className="px-3 py-2.5 text-start font-medium">الفرق</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {report.rows.map((row) => {
              const next = row.next;
              const holdout = next?.holdout ?? null;
              return (
                <tr key={row.group}>
                  <td className="px-5 py-3 font-medium">{row.label}</td>
                  <td className="px-3 py-3 numeric">{formatNumberAr(row.sent)}</td>
                  <td className="px-3 py-3 numeric">{engagement(row.delivered, row, tracked)}</td>
                  <td className="px-3 py-3 numeric">{engagement(row.opened, row, tracked)}</td>
                  <td className="px-3 py-3 numeric">{engagement(row.clicked, row, tracked)}</td>
                  <td className="px-3 py-3 numeric">{formatNumberAr(row.optOuts)}</td>
                  <td className="px-3 py-3 numeric">{tracked ? formatNumberAr(row.bounced) : UNAVAILABLE_AR}</td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {next ? `${next.targetLabel} خلال ${formatNumberAr(next.windowDays)} يوم` : NOT_APPLICABLE_AR}
                  </td>
                  <td className="px-3 py-3 numeric">
                    {next
                      ? `${formatNumberAr(next.recipients.reached)} من ${formatNumberAr(next.recipients.eligible)} (${formatShare(next.recipients.reached, next.recipients.eligible)})`
                      : ''}
                  </td>
                  <td className="px-3 py-3 numeric">
                    {next
                      ? holdout
                        ? `${formatNumberAr(holdout.reached)} من ${formatNumberAr(holdout.eligible)} (${formatShare(holdout.reached, holdout.eligible)})`
                        : NONE_AR
                      : ''}
                  </td>
                  <td className="px-3 py-3 numeric">{next ? formatLift(liftPoints(next.recipients, holdout)) : ''}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-border bg-background-elevated text-xs">
            <tr>
              <td className="px-5 py-3 font-semibold">المجموع</td>
              <td className="px-3 py-3 numeric">{formatNumberAr(report.totals.sent)}</td>
              <td className="px-3 py-3 numeric">
                {tracked ? `${formatNumberAr(report.totals.delivered)} (${formatShare(report.totals.delivered, report.totals.sent)})` : UNAVAILABLE_AR}
              </td>
              <td className="px-3 py-3 numeric">
                {tracked ? `${formatNumberAr(report.totals.opened)} (${formatShare(report.totals.opened, report.totals.sent)})` : UNAVAILABLE_AR}
              </td>
              <td className="px-3 py-3 numeric">
                {tracked ? `${formatNumberAr(report.totals.clicked)} (${formatShare(report.totals.clicked, report.totals.sent)})` : UNAVAILABLE_AR}
              </td>
              <td className="px-3 py-3 numeric">{formatNumberAr(report.totals.optOuts)}</td>
              <td className="px-3 py-3 numeric">{tracked ? formatNumberAr(report.totals.bounced) : UNAVAILABLE_AR}</td>
              <td colSpan={4} />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="border-t border-border p-5 text-xs leading-7 text-muted-foreground">
        <h3 className="mb-2 text-sm font-semibold text-foreground">كيف تنقرأ أرقام البريد</h3>
        <ul className="list-disc space-y-1 ps-5">
          <li>
            «وصلت» و«انفتحت» و«انضغط» و«ارتدّت» تجي من Resend، ونسبتها من اللي أُرسلت. الفتح يطلع أقل من الحقيقة
            لأن بعض برامج البريد تمنع صورة التتبع، والضغط أصدق منه.
          </li>
          <li>
            «أوقفوا الرسائل بعدها» من ضغط إلغاء الاشتراك خلال {formatNumberAr(7)} أيام من آخر رسالة وصلته، ويُحسب
            على هالرسالة بالذات. اللي غيّر تفضيلاته من الصفحة ما ينعدّ هنا لأن تغييره ما له وقت.
          </li>
          <li>
            «المستلمون وصلوا» هم اللي وصلتهم الرسالة وانتهت مدة الحساب بعدها وما كانوا وصلوا الهدف قبلها، ومنهم كم
            واحد وصل الهدف خلال المدة. اللي مدته ما خلصت للحين ما ينعدّ، عشان النسبة ما تطلع أقل من الحقيقة.
          </li>
          <li>
            «المقارنة وصلوا» نفس الحساب على مجموعة المقارنة، من الوقت اللي كانت الرسالة تنرسل فيه لو ما استثنيناهم.
            الفرق هو نسبة المستلمين ناقص نسبة المقارنة. لو العدد قليل لا تعتمد عليه، ويطلع «لا يوجد» لين يتجمع ناس
            من الطرفين.
          </li>
          <li>
            رسالة الترحيب والتقرير الأسبوعي يوصلون للكل، فما لهم مقارنة. وهدف مسار الخطة هو بدء التجربة أو الدفع،
            وهدف مسار التجربة هو الدفع خلال {formatNumberAr(14)} يوم.
          </li>
        </ul>
      </div>
    </section>
  );
}

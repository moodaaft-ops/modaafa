import { Activity, Building2, CreditCard, Database, ShieldCheck, Users } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import { createAdminClient, getRequestAuthContext } from '@/lib/supabase/server';
import { isModaafaOperator } from '@/lib/platform/operators';
import {
  operatorJobStatusLabel,
  operatorJobStatusTone,
  summarizeUsageEvents,
} from '@/lib/platform/operator-metrics';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { PageHeader } from '@/lib/ui/page-header';
import { MetricCard } from '@/lib/ui/metric-card';
import { StatusBadge } from '@/lib/ui/status-badge';
import { EmptyState } from '@/lib/ui/empty-state';
import { formatNumberAr, timeAgoAr } from '@/lib/utils';

export const metadata = {
  title: 'مركز التشغيل',
};

export default async function OperationsPage() {
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/operations');
  if (!isModaafaOperator(user.email)) notFound();

  const admin = createAdminClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [
    usersResult,
    businessesResult,
    accountsResult,
    subscriptionsResult,
    auditsResult,
    usageResult,
    jobsResult,
    failedWebhooksResult,
  ] = await Promise.all([
    admin.from('users').select('id', { count: 'exact', head: true }),
    admin.from('businesses').select('id', { count: 'exact', head: true }),
    admin
      .from('google_ads_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .eq('is_manager', false),
    admin
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['active', 'trialing']),
    admin.from('audits').select('id', { count: 'exact', head: true }),
    admin.from('usage_events').select('feature').gte('created_at', since).limit(10000),
    admin
      .from('job_runs')
      .select('id,job_name,status,started_at,finished_at,duration_ms,processed,error_count,error_message')
      .order('started_at', { ascending: false })
      .limit(12),
    admin
      .from('processed_webhook_events')
      .select('event_id', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('last_attempt_at', since),
  ]);

  assertSupabaseRead(usersResult.error, 'load operator user count');
  assertSupabaseRead(businessesResult.error, 'load operator business count');
  assertSupabaseRead(accountsResult.error, 'load operator account count');
  assertSupabaseRead(subscriptionsResult.error, 'load operator subscription count');
  assertSupabaseRead(auditsResult.error, 'load operator audit count');
  assertSupabaseRead(usageResult.error, 'load operator usage');
  assertSupabaseRead(jobsResult.error, 'load operator jobs');
  assertSupabaseRead(failedWebhooksResult.error, 'load operator webhook health');

  const usage = summarizeUsageEvents(usageResult.data ?? []);
  const jobs = jobsResult.data ?? [];
  const failedJobs = jobs.filter((job) => job.status === 'failed' || job.status === 'partial');
  const hasOperationalIssue = failedJobs.length > 0 || (failedWebhooksResult.count ?? 0) > 0;

  return (
    <>
      <PageHeader
        icon={Activity}
        title="مركز التشغيل"
        description="نظرة خاصة بالمالك على التفعيل والاستخدام والمهام الخلفية، من دون عرض بيانات العملاء أو الأسرار."
      />

      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <div>
            <div className="text-[13px] font-semibold text-foreground">حالة آخر 24 ساعة</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              المهام والويبهوكات والتفاعل الفعلي مع ميزات المنتج.
            </div>
          </div>
          <StatusBadge tone={hasOperationalIssue ? 'danger' : 'success'}>
            {hasOperationalIssue ? 'تحتاج مراجعة' : 'التشغيل مستقر'}
          </StatusBadge>
        </div>

        <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5" aria-label="مؤشرات التفعيل">
          <MetricCard label="المستخدمون" value={formatNumberAr(usersResult.count ?? 0)} icon={Users} />
          <MetricCard label="أنشطة مجهزة" value={formatNumberAr(businessesResult.count ?? 0)} icon={Building2} />
          <MetricCard label="حسابات إعلانية نشطة" value={formatNumberAr(accountsResult.count ?? 0)} icon={Database} />
          <MetricCard label="اشتراكات وتجارب نشطة" value={formatNumberAr(subscriptionsResult.count ?? 0)} icon={CreditCard} />
          <MetricCard label="فحوصات مكتملة" value={formatNumberAr(auditsResult.count ?? 0)} icon={ShieldCheck} />
        </section>

        <section className="surface-card overflow-hidden" aria-labelledby="usage-title">
          <div className="border-b border-border px-5 py-4">
            <h2 id="usage-title" className="text-[14px] font-semibold text-foreground">استخدام الميزات خلال 24 ساعة</h2>
            <p className="mt-1 text-xs text-muted-foreground">عدد الطلبات المسجلة، وليس تقديراً للتكلفة المالية.</p>
          </div>
          <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-5">
            {usage.map((item) => (
              <div key={item.feature} className="bg-card px-5 py-4">
                <div className="text-[12px] text-muted-foreground">{item.label}</div>
                <div className="mt-1 text-2xl font-bold numeric text-foreground">{formatNumberAr(item.count)}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="surface-card overflow-hidden" aria-labelledby="jobs-title">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h2 id="jobs-title" className="text-[14px] font-semibold text-foreground">آخر المهام الخلفية</h2>
              <p className="mt-1 text-xs text-muted-foreground">المزامنة والتحسين والمهام المجدولة كما سُجلت فعلياً.</p>
            </div>
            <StatusBadge tone={(failedWebhooksResult.count ?? 0) > 0 ? 'danger' : 'success'}>
              {(failedWebhooksResult.count ?? 0) > 0
                ? `${formatNumberAr(failedWebhooksResult.count ?? 0)} ويبهوك فاشل`
                : 'الويبهوكات سليمة'}
            </StatusBadge>
          </div>

          {jobs.length === 0 ? (
            <EmptyState
              bare
              icon={Activity}
              title="لا توجد مهام مسجلة بعد"
              description="ستظهر هنا نتائج المزامنة والتحسين بمجرد تشغيلها."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-sm">
                <thead className="border-b border-border bg-background-elevated text-[11px] text-muted-foreground">
                  <tr>
                    <th className="px-5 py-2.5 text-start font-medium">المهمة</th>
                    <th className="px-3 py-2.5 text-start font-medium">الحالة</th>
                    <th className="px-3 py-2.5 text-start font-medium">المعالج</th>
                    <th className="px-3 py-2.5 text-start font-medium">الأخطاء</th>
                    <th className="px-5 py-2.5 text-start font-medium">الوقت</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {jobs.map((job) => (
                    <tr key={job.id} className="hover:bg-muted/40">
                      <td className="px-5 py-3.5 font-medium text-foreground">{job.job_name}</td>
                      <td className="px-3 py-3.5">
                        <StatusBadge tone={operatorJobStatusTone(job.status)}>
                          {operatorJobStatusLabel(job.status)}
                        </StatusBadge>
                      </td>
                      <td className="px-3 py-3.5 numeric">{formatNumberAr(job.processed ?? 0)}</td>
                      <td className="px-3 py-3.5 numeric">{formatNumberAr(job.error_count ?? 0)}</td>
                      <td className="px-5 py-3.5 text-xs text-muted-foreground">{timeAgoAr(job.started_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

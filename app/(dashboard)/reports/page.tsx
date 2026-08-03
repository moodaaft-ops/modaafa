import { BarChart3, Link2 } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { formatCurrency, timeAgoAr } from '@/lib/utils';
import { PageHeader } from '@/lib/ui/page-header';
import { EmptyState } from '@/lib/ui/empty-state';
import { buttonClasses } from '@/lib/ui/button';

export const metadata = {
  title: 'التقارير',
};

export default async function ReportsPage() {
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login');
  const { accounts, selectedAccount } = await getAccountWorkspace(user.id);
  const { data: reports } = selectedAccount
    ? await supabase
        .from('reports')
        .select('*')
        .eq('account_id', selectedAccount.id)
        .order('generated_at', { ascending: false })
        .limit(30)
    : { data: [] };

  const accountName = selectedAccount ? googleAdsAccountDisplayName(selectedAccount) : 'الحساب المختار';

  return (
    <>
      <PageHeader
        icon={BarChart3}
        title="التقارير"
        description="تقرير أسبوعي ذكي يشرح لماذا تغيّر الأداء، وملخصات محفوظة بعد كل فحص."
        account={selectedAccount ? { name: accountName, customerId: selectedAccount.customer_id } : null}
      />
      <div className="p-4 sm:p-6 lg:p-8">
        {accounts.length === 0 ? (
          <EmptyState
            icon={Link2}
            title="اربط حساب إعلانات Google أولاً"
            description="بعد الربط وتشغيل الفحص ستظهر التقارير المحفوظة هنا."
            action={
              <a href="/onboarding/connect" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                ربط حساب
              </a>
            }
          />
        ) : (reports ?? []).length === 0 ? (
          <EmptyState
            icon={BarChart3}
            title="لا توجد تقارير محفوظة بعد"
            description="شغّل فحص الحساب لإنشاء أول تقرير أداء لهذا الحساب."
            action={
              <a href="/audit" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                تشغيل الفحص
              </a>
            }
          />
        ) : (
          <section className="surface-card overflow-hidden">
            <div className="divide-y divide-border">
              {(reports ?? []).map((report: any) =>
                report.metrics?.kind === 'weekly_performance' ? (
                  <WeeklyPerformanceReport
                    key={report.id}
                    report={report}
                    fallbackCurrency={selectedAccount?.currency_code}
                  />
                ) : (
                  <article key={report.id} className="p-5">
                    <div className="flex items-center justify-between gap-4">
                      <h2 className="text-[14px] font-semibold">{periodLabel(report.period_type)}</h2>
                      <span className="text-xs text-muted-foreground">{timeAgoAr(report.generated_at)}</span>
                    </div>
                    <p className="mt-2 text-sm leading-7 text-muted-foreground">
                      {report.summary_ar ?? 'تقرير محفوظ بدون ملخص.'}
                    </p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                      <ReportMetric
                        label="صحة الحساب"
                        value={report.metrics?.health_score ? `${report.metrics.health_score}/100` : '—'}
                      />
                      <ReportMetric label="عدد التوصيات" value={report.metrics?.recommendations_count ?? '—'} />
                      <ReportMetric
                        label="تسريب متوقع"
                        value={
                          report.metrics?.estimated_monthly_waste_sar
                            ? formatCurrency(
                                report.metrics.estimated_monthly_waste_sar,
                                report.metrics.currency_code ?? selectedAccount?.currency_code
                              )
                            : '—'
                        }
                      />
                    </div>
                  </article>
                )
              )}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

/**
 * The weekly «ليش؟» report: totals week-over-week, the campaigns that drove
 * the change, and what to focus on next — written by the reporter agent from
 * pre-computed numbers, so nothing here is invented.
 */
function WeeklyPerformanceReport({ report, fallbackCurrency }: { report: any; fallbackCurrency?: string | null }) {
  const metrics = report.metrics ?? {};
  const currency = metrics.currency_code ?? fallbackCurrency;
  const totals = metrics.totals ?? {};
  const current = totals.this_week ?? {};
  const prior = totals.prior_week ?? {};
  const delta = totals.delta ?? {};
  const highlights: string[] = Array.isArray(metrics.highlights_ar) ? metrics.highlights_ar : [];

  return (
    <article className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold">التقرير الأسبوعي الذكي</h2>
          <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[10.5px] font-semibold text-primary ring-1 ring-inset ring-primary/25">
            لماذا تغيّر الأداء؟
          </span>
        </div>
        <span className="text-xs text-muted-foreground">{timeAgoAr(report.generated_at)}</span>
      </div>

      <p className="mt-3 text-sm leading-8 text-foreground">{report.summary_ar}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <WeekDelta
          label="الإنفاق"
          current={formatCurrency(current.cost ?? 0, currency)}
          delta={delta.cost ?? 0}
          formatDelta={(value) => formatCurrency(Math.abs(value), currency)}
          // Spend rising is neutral, not "good" — direction is context.
          neutral
        />
        <WeekDelta
          label="التحويلات"
          current={String(current.conversions ?? 0)}
          delta={delta.conversions ?? 0}
          formatDelta={(value) => String(Math.abs(Number(value.toFixed(2))))}
        />
        <ReportMetric
          label="تكلفة التحويل"
          value={
            delta.cpa_this != null
              ? `${formatCurrency(delta.cpa_this, currency)}${delta.cpa_prior != null ? ` (كانت ${formatCurrency(delta.cpa_prior, currency)})` : ''}`
              : '—'
          }
        />
      </div>

      {highlights.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {highlights.map((item) => (
            <li key={item} className="flex items-start gap-2 text-[13px] leading-7 text-foreground-subtle">
              <span className="mt-2.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
      )}

      {metrics.next_week_ar && (
        <div className="mt-4 rounded-lg border border-primary/20 bg-primary/[0.05] px-4 py-3 text-[13px] leading-7 text-foreground-subtle">
          <span className="font-semibold text-primary">تركيز الأسبوع القادم: </span>
          {metrics.next_week_ar}
        </div>
      )}

      <div className="mt-3 text-[11px] text-muted-foreground">
        مقارنة آخر 7 أيام بالأسبوع الذي قبله{prior.cost != null ? ` (إنفاق الأسبوع السابق ${formatCurrency(prior.cost ?? 0, currency)})` : ''}.
      </div>
    </article>
  );
}

function WeekDelta({
  label,
  current,
  delta,
  formatDelta,
  neutral = false,
}: {
  label: string;
  current: string;
  delta: number;
  formatDelta: (value: number) => string;
  neutral?: boolean;
}) {
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const tone =
    direction === 'flat' || neutral
      ? 'text-muted-foreground'
      : direction === 'up'
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-red-600 dark:text-red-400';
  return (
    <div className="rounded-lg border border-border bg-background-elevated px-4 py-3">
      <div className="text-[11px] font-medium text-foreground-subtle">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[17px] font-semibold numeric">{current}</span>
        {direction !== 'flat' && (
          <span className={`text-[11.5px] font-semibold numeric ${tone}`}>
            {direction === 'up' ? '▲' : '▼'} {formatDelta(delta)}
          </span>
        )}
      </div>
    </div>
  );
}

function ReportMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-background-elevated px-4 py-3">
      <div className="text-[11px] font-medium uppercase text-foreground-subtle">{label}</div>
      <div className="mt-1.5 text-[17px] font-semibold numeric">{value}</div>
    </div>
  );
}

function periodLabel(period?: string) {
  const labels: Record<string, string> = {
    daily: 'تقرير يومي',
    weekly: 'تقرير أسبوعي',
    monthly: 'تقرير شهري',
    custom: 'تقرير مخصص',
  };
  return labels[period ?? ''] ?? period ?? 'تقرير';
}

import { ChevronLeft } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { cn, formatCurrency, timeAgoAr } from '@/lib/utils';
import { CARD, CalmEmpty, CalmHeading, CalmPage, CalmTitle, Tag, pill } from '../calm-page';

export const metadata = {
  title: 'التقارير',
};

export default async function ReportsPage() {
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login');
  const { accounts, selectedAccount } = await getAccountWorkspace(user.id);
  const reportsResult = selectedAccount
    ? await supabase
        .from('reports')
        .select('*')
        .eq('account_id', selectedAccount.id)
        .order('generated_at', { ascending: false })
        .limit(30)
    : { data: [], error: null };
  assertSupabaseRead(reportsResult.error, 'load reports page');
  const reports = reportsResult.data;

  const accountName = selectedAccount ? googleAdsAccountDisplayName(selectedAccount) : 'الحساب المختار';
  const [latest, ...earlier] = (reports ?? []) as any[];

  return (
    <CalmPage>
      <CalmTitle
        title="التقارير"
        description="تقرير أسبوعي ذكي يشرح لماذا تغيّر الأداء، وملخصات محفوظة بعد كل فحص."
        account={selectedAccount ? { name: accountName, customerId: selectedAccount.customer_id } : null}
      />

      {accounts.length === 0 ? (
        <CalmEmpty title="اربط حساب إعلانات Google أولاً" description="بعد الربط وتشغيل الفحص ستظهر التقارير المحفوظة هنا.">
          <a href="/onboarding/connect" className={pill.primary}>
            ربط حساب
          </a>
        </CalmEmpty>
      ) : !latest ? (
        <CalmEmpty title="لا توجد تقارير محفوظة بعد" description="شغّل فحص الحساب لإنشاء أول تقرير أداء لهذا الحساب.">
          <a href="/audit" className={pill.primary}>
            تشغيل الفحص
          </a>
        </CalmEmpty>
      ) : (
        <>
          {/* The newest report is the page: open, full size. */}
          <article className={cn(CARD, 'mt-8 p-5 sm:p-7')}>
            <ReportBody report={latest} fallbackCurrency={selectedAccount?.currency_code} />
          </article>

          {earlier.length > 0 && (
            <section className="mt-10" aria-labelledby="earlier-reports-title">
              <CalmHeading id="earlier-reports-title" title="تقارير سابقة" className="mb-3" />
              <div className={cn(CARD, 'divide-y divide-border/70 overflow-hidden')}>
                {earlier.map((report) => (
                  <details key={report.id} className="group">
                    <summary className="flex min-h-[64px] cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
                      <span className="min-w-0">
                        <span className="block text-[15px] font-semibold leading-7">{reportTitle(report)}</span>
                        <span className="block text-[13px] leading-6 text-muted-foreground">{timeAgoAr(report.generated_at)}</span>
                      </span>
                      <ChevronLeft className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-open:-rotate-90" aria-hidden />
                    </summary>
                    <div className="px-5 pb-6 pt-1">
                      <ReportBody report={report} fallbackCurrency={selectedAccount?.currency_code} showHeader={false} />
                    </div>
                  </details>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </CalmPage>
  );
}

function reportTitle(report: any) {
  if (report.metrics?.kind === 'weekly_performance') return 'التقرير الأسبوعي الذكي';
  return report.metrics?.kind === 'audit_summary' ? 'ملخص فحص الحساب' : periodLabel(report.period_type);
}

function ReportBody({
  report,
  fallbackCurrency,
  showHeader = true,
}: {
  report: any;
  fallbackCurrency?: string | null;
  showHeader?: boolean;
}) {
  return report.metrics?.kind === 'weekly_performance' ? (
    <WeeklyPerformanceReport report={report} fallbackCurrency={fallbackCurrency} showHeader={showHeader} />
  ) : (
    <SavedReport report={report} fallbackCurrency={fallbackCurrency} showHeader={showHeader} />
  );
}

function ReportHeader({ title, tag, generatedAt }: { title: string; tag?: string; generatedAt: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="text-[18px] font-bold leading-8">{title}</h2>
        {tag && <Tag>{tag}</Tag>}
      </div>
      <span className="text-[13px] text-muted-foreground">{timeAgoAr(generatedAt)}</span>
    </div>
  );
}

/** Audit summaries and the period reports saved before the weekly one existed. */
function SavedReport({
  report,
  fallbackCurrency,
  showHeader,
}: {
  report: any;
  fallbackCurrency?: string | null;
  showHeader: boolean;
}) {
  return (
    <div>
      {showHeader && <ReportHeader title={reportTitle(report)} generatedAt={report.generated_at} />}
      <p className={cn('text-[15.5px] leading-8 text-foreground', showHeader && 'mt-3')}>
        {report.summary_ar ?? 'تقرير محفوظ بدون ملخص.'}
      </p>
      <Stats>
        <Stat
          label="صحة الحساب"
          value={report.metrics?.health_score ? `${report.metrics.health_score}/100` : NONE}
        />
        <Stat label="عدد التوصيات" value={report.metrics?.recommendations_count ?? NONE} />
        <Stat
          label="تسريب متوقع"
          value={
            report.metrics?.estimated_monthly_waste_sar
              ? formatCurrency(
                  report.metrics.estimated_monthly_waste_sar,
                  report.metrics.currency_code ?? fallbackCurrency
                )
              : NONE
          }
        />
      </Stats>
    </div>
  );
}

/**
 * The weekly «ليش؟» report: totals week-over-week, the campaigns that drove
 * the change, and what to focus on next — written by the reporter agent from
 * pre-computed numbers, so nothing here is invented.
 */
function WeeklyPerformanceReport({
  report,
  fallbackCurrency,
  showHeader,
}: {
  report: any;
  fallbackCurrency?: string | null;
  showHeader: boolean;
}) {
  const metrics = report.metrics ?? {};
  const currency = metrics.currency_code ?? fallbackCurrency;
  const totals = metrics.totals ?? {};
  const current = totals.this_week ?? {};
  const prior = totals.prior_week ?? {};
  const delta = totals.delta ?? {};
  const highlights: string[] = Array.isArray(metrics.highlights_ar) ? metrics.highlights_ar : [];

  return (
    <div>
      {showHeader && (
        <ReportHeader title="التقرير الأسبوعي الذكي" tag="لماذا تغيّر الأداء؟" generatedAt={report.generated_at} />
      )}

      <p className={cn('text-[16px] leading-9 text-foreground', showHeader && 'mt-3')}>{report.summary_ar}</p>

      <Stats>
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
        <Stat
          label="تكلفة التحويل"
          value={delta.cpa_this != null ? formatCurrency(delta.cpa_this, currency) : NONE}
          note={delta.cpa_this != null && delta.cpa_prior != null ? `كانت ${formatCurrency(delta.cpa_prior, currency)}` : undefined}
        />
      </Stats>

      {highlights.length > 0 && (
        <ul className="mt-5 space-y-2">
          {highlights.map((item) => (
            <li key={item} className="flex items-start gap-3 text-[14.5px] leading-8 text-foreground">
              <span className="mt-3 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-foreground/50" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
      )}

      {metrics.next_week_ar && (
        <p className="mt-5 rounded-[14px] bg-muted px-4 py-3 text-[14.5px] leading-8 text-foreground">
          <span className="font-bold">تركيز الأسبوع القادم: </span>
          {metrics.next_week_ar}
        </p>
      )}

      <p className="mt-4 text-[12.5px] leading-6 text-muted-foreground">
        مقارنة آخر 7 أيام بالأسبوع الذي قبله{prior.cost != null ? ` (إنفاق الأسبوع السابق ${formatCurrency(prior.cost ?? 0, currency)})` : ''}.
      </p>
    </div>
  );
}

const NONE = 'ما فيه';

/** Three numbers in one strip with hairline dividers, like the week strip on the home. */
function Stats({ children }: { children: React.ReactNode }) {
  return (
    <dl className="mt-5 grid grid-cols-1 divide-y divide-border/70 overflow-hidden rounded-[16px] border border-border/80 sm:grid-cols-3 sm:divide-y-0">
      {children}
    </dl>
  );
}

const STAT_CELL =
  'flex items-baseline justify-between gap-3 px-4 py-3 sm:block sm:border-s sm:border-border/70 sm:py-3.5 sm:first:border-s-0';

function Stat({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className={STAT_CELL}>
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="text-end sm:mt-1 sm:text-start">
        <span className="numeric text-[18px] font-bold leading-7">{value}</span>
        {note && <span className="numeric block text-[12.5px] leading-5 text-muted-foreground">{note}</span>}
      </dd>
    </div>
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
        ? 'text-success'
        : 'text-danger';
  return (
    <div className={STAT_CELL}>
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="text-end sm:mt-1 sm:text-start">
        <span className="numeric text-[18px] font-bold leading-7">{current}</span>
        {direction !== 'flat' && (
          <span className={`numeric block text-[12.5px] font-semibold leading-5 ${tone}`}>
            {direction === 'up' ? '▲' : '▼'} {formatDelta(delta)}
          </span>
        )}
      </dd>
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

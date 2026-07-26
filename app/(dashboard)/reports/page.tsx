import { BarChart3, Link2 } from 'lucide-react';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { createServerClient } from '@/lib/supabase/server';
import { formatCurrency, timeAgoAr } from '@/lib/utils';
import { PageHeader } from '@/lib/ui/page-header';
import { EmptyState } from '@/lib/ui/empty-state';
import { buttonClasses } from '@/lib/ui/button';

export const metadata = {
  title: 'التقارير',
};

export default async function ReportsPage() {
  const supabase = await createServerClient();
  const { accounts, selectedAccount } = await getAccountWorkspace(supabase);
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
        description="ملخصات محفوظة بعد كل فحص أو مزامنة."
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
          <section className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="divide-y divide-border">
              {(reports ?? []).map((report: any) => (
                <article key={report.id} className="p-5">
                  <div className="flex items-center justify-between gap-4">
                    <h2 className="font-bold">{periodLabel(report.period_type)}</h2>
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
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function ReportMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-muted px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-bold tabular-nums">{value}</div>
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

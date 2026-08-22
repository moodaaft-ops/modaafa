import { Link2, Megaphone } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { formatCurrency, formatNumberAr } from '@/lib/utils';
import { moneyMetric } from '@/lib/google-ads/metrics';
import { campaignStatusLabel, campaignTypeLabel } from '@/lib/ui/labels';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { PageHeader } from '@/lib/ui/page-header';
import { EmptyState } from '@/lib/ui/empty-state';
import { StatusBadge, campaignStatusTone } from '@/lib/ui/status-badge';
import { buttonClasses } from '@/lib/ui/button';
import { Alert } from '@/lib/ui/alert';
import { syncErrorMessage } from '@/lib/ui/sync-errors';
import {
  dateRangeHref,
  resolveDateRange,
  type DateRangeSearchParams,
} from '@/lib/analytics/date-range';
import { loadCampaignsForDateRange } from '@/lib/analytics/campaign-performance';
import { DateRangePicker } from '@/lib/ui/date-range-picker';

export const metadata = {
  title: 'الحملات',
};

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    synced?: string;
    sync_error?: string;
  } & DateRangeSearchParams>;
}) {
  // /api/accounts/sync redirects back here with ?synced=1 or ?sync_error=…
  // but this page never read either, so a failed refresh looked exactly like a
  // successful one: same stale table, no message.
  const params = await searchParams;
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login');
  const { accounts, selectedAccount } = await getAccountWorkspace(user.id);
  const campaignsResult = selectedAccount
    ? await supabase
        .from('campaigns_cache')
        .select('*')
        .eq('account_id', selectedAccount.id)
        .order('last_synced_at', { ascending: false })
        .limit(500)
    : { data: [], error: null };
  assertSupabaseRead(campaignsResult.error, 'load campaigns page');
  const cachedCampaigns = campaignsResult.data ?? [];
  const requestedRange = resolveDateRange(params, '30d');
  let effectiveRange = requestedRange;
  let rangeLoadError: string | null = null;
  let campaigns = cachedCampaigns;

  if (selectedAccount) {
    try {
      campaigns = await loadCampaignsForDateRange({
        supabase,
        userId: user.id,
        selectedAccount,
        campaigns: cachedCampaigns,
        range: requestedRange,
      });
    } catch {
      effectiveRange = resolveDateRange(null, '30d');
      rangeLoadError =
        'تعذر تحميل الفترة المختارة مباشرة من Google Ads. عرضنا آخر 30 يوماً المحفوظة مؤقتاً، ويمكنك إعادة المحاولة.';
      campaigns = await loadCampaignsForDateRange({
        supabase,
        userId: user.id,
        selectedAccount,
        campaigns: cachedCampaigns,
        range: effectiveRange,
      });
    }
  }

  const sortedCampaigns = [...campaigns].sort((a, b) => {
    const aEnabled = a.status === 'ENABLED' ? 1 : 0;
    const bEnabled = b.status === 'ENABLED' ? 1 : 0;
    if (aEnabled !== bEnabled) return bEnabled - aEnabled;
    return moneyMetric(b.range_metrics, 'cost') - moneyMetric(a.range_metrics, 'cost');
  });

  const accountName = selectedAccount ? googleAdsAccountDisplayName(selectedAccount) : 'الحساب المختار';

  return (
    <>
      <PageHeader
        icon={Megaphone}
        title="الحملات"
        description={`مرتبة حسب الحالة والصرف خلال ${effectiveRange.label}.`}
        account={selectedAccount ? { name: accountName, customerId: selectedAccount.customer_id } : null}
        actions={
          selectedAccount && (
            <form action="/api/accounts/sync" method="post">
              <input type="hidden" name="customerId" value={selectedAccount.customer_id} />
              <input type="hidden" name="next" value={dateRangeHref('/campaigns', requestedRange)} />
              <PendingSubmitButton pendingLabel="جاري التحديث..." className={buttonClasses({ variant: 'primary' })}>
                تحديث الآن
              </PendingSubmitButton>
            </form>
          )
        }
      />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        {params?.synced && <Alert tone="success">تم تحديث بيانات الحساب المختار.</Alert>}
        {params?.sync_error && <Alert tone="danger">{syncErrorMessage(params.sync_error)}</Alert>}
        {rangeLoadError && <Alert tone="warning">{rangeLoadError}</Alert>}
        {accounts.length > 0 && <DateRangePicker selection={effectiveRange} />}
        {accounts.length === 0 ? (
          <EmptyState
            icon={Link2}
            title="لم تربط حساباً إعلانياً بعد"
            description="اربط إعلانات Google لجلب الحملات وعرض أدائها هنا."
            action={
              <a href="/onboarding/connect" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                ربط إعلانات Google
              </a>
            }
          />
        ) : campaigns.length === 0 ? (
          <EmptyState
            icon={Megaphone}
            title="لا توجد حملات محفوظة للحساب المختار"
            description="حدّث بيانات الحساب أو شغّل الفحص لجلب الحملات من إعلانات Google."
            action={
              <>
                {selectedAccount && (
                  <form action="/api/accounts/sync" method="post">
                    <input type="hidden" name="customerId" value={selectedAccount.customer_id} />
                    <input type="hidden" name="next" value={dateRangeHref('/campaigns', requestedRange)} />
                    <PendingSubmitButton pendingLabel="جاري التحديث..." className={buttonClasses({ variant: 'primary' })}>
                      تحديث البيانات الآن
                    </PendingSubmitButton>
                  </form>
                )}
                <a href="/audit" className={buttonClasses({ variant: 'outline' })}>
                  تشغيل الفحص
                </a>
              </>
            }
          />
        ) : (
          <section className="surface-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h2 className="text-[14px] font-semibold">قائمة الحملات</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatNumberAr(sortedCampaigns.filter((c) => c.status === 'ENABLED').length)} مفعلة من أصل{' '}
                  {formatNumberAr(campaigns.length)} خلال {effectiveRange.label}
                </p>
              </div>
              <div className="flex gap-2">
                <a href="/audit" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                  تحديث بالفحص
                </a>
                <a href="/assistant" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
                  اسأل المساعد
                </a>
              </div>
            </div>
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b border-border bg-background-elevated text-[11px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-5 py-2.5 text-start font-medium">الحملة</th>
                    <th className="px-3 py-2.5 text-start font-medium">الحالة</th>
                    <th className="px-3 py-2.5 text-start font-medium">النوع</th>
                    <th className="px-3 py-2.5 text-start font-medium">الميزانية</th>
                    <th className="px-3 py-2.5 text-start font-medium">الصرف — {effectiveRange.label}</th>
                    <th className="px-5 py-2.5 text-start font-medium">التحويلات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sortedCampaigns.map((campaign: any) => (
                    <tr key={campaign.id} className="transition-colors duration-150 hover:bg-muted/50">
                      <td className="px-5 py-3.5 font-medium text-foreground">{campaign.name}</td>
                      <td className="px-3 py-3.5">
                        <StatusBadge tone={campaignStatusTone(campaign.status)}>
                          {campaignStatusLabel(campaign.status)}
                        </StatusBadge>
                      </td>
                      <td className="px-3 py-3.5 text-muted-foreground">{campaignTypeLabel(campaign.type)}</td>
                      <td className="px-3 py-3.5 numeric">{formatCurrency(campaign.daily_budget ?? 0, selectedAccount?.currency_code)}</td>
                      <td className="px-3 py-3.5 numeric">{formatCurrency(moneyMetric(campaign.range_metrics, 'cost'), selectedAccount?.currency_code)}</td>
                      <td className="px-5 py-3.5 numeric">{formatNumberAr(campaign.range_metrics?.conversions ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

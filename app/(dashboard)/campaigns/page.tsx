import { redirect } from 'next/navigation';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { cn, formatCurrency, formatNumberAr } from '@/lib/utils';
import { moneyMetric } from '@/lib/google-ads/metrics';
import { campaignStatusLabel, campaignTypeLabel } from '@/lib/ui/labels';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { campaignStatusTone } from '@/lib/ui/status-badge';
import { syncErrorMessage } from '@/lib/ui/sync-errors';
import {
  dateRangeHref,
  resolveDateRange,
  type DateRangeSearchParams,
} from '@/lib/analytics/date-range';
import { loadCampaignsForDateRange } from '@/lib/analytics/campaign-performance';
import { DateRangePicker } from '@/lib/ui/date-range-picker';
import { CARD, CalmEmpty, CalmNote, CalmPage, CalmTitle, StatusWord, pill, type DotTone } from '../calm-page';

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

  const syncForm = (label: string, className: string) =>
    selectedAccount && (
      <form action="/api/accounts/sync" method="post">
        <input type="hidden" name="customerId" value={selectedAccount.customer_id} />
        <input type="hidden" name="next" value={dateRangeHref('/campaigns', requestedRange)} />
        <PendingSubmitButton pendingLabel="جاري التحديث..." className={className}>
          {label}
        </PendingSubmitButton>
      </form>
    );

  return (
    <CalmPage wide>
      <CalmTitle
        title="الحملات"
        description={`مرتبة حسب الحالة والصرف خلال ${effectiveRange.label}.`}
        account={selectedAccount ? { name: accountName, customerId: selectedAccount.customer_id } : null}
        actions={syncForm('تحديث الآن', pill.quiet)}
      />

      <div className="mt-6 space-y-4">
        {params?.synced && <CalmNote tone="success">تم تحديث بيانات الحساب المختار.</CalmNote>}
        {params?.sync_error && <CalmNote tone="danger">{syncErrorMessage(params.sync_error)}</CalmNote>}
        {rangeLoadError && <CalmNote tone="warning">{rangeLoadError}</CalmNote>}
        {accounts.length > 0 && <DateRangePicker selection={effectiveRange} variant="chat" />}
      </div>

      {accounts.length === 0 ? (
        <CalmEmpty
          title="لم تربط حساباً إعلانياً بعد"
          description="اربط إعلانات Google لجلب الحملات وعرض أدائها هنا."
        >
          <a href="/onboarding/connect" className={pill.primary}>
            ربط إعلانات Google
          </a>
        </CalmEmpty>
      ) : campaigns.length === 0 ? (
        <CalmEmpty
          title="لا توجد حملات محفوظة للحساب المختار"
          description="حدّث بيانات الحساب أو شغّل الفحص لجلب الحملات من إعلانات Google."
        >
          {syncForm('تحديث البيانات الآن', pill.primary)}
          <a href="/audit" className={pill.quiet}>
            تشغيل الفحص
          </a>
        </CalmEmpty>
      ) : (
        <section className="mt-8" aria-labelledby="campaigns-list-title">
          <h2 id="campaigns-list-title" className="sr-only">
            قائمة الحملات
          </h2>
          <p className="mb-3 text-[14.5px] leading-7 text-muted-foreground">
            {formatNumberAr(sortedCampaigns.filter((c) => c.status === 'ENABLED').length)} مفعلة من أصل{' '}
            {formatNumberAr(campaigns.length)} خلال {effectiveRange.label}
          </p>

          <div className={cn(CARD, 'overflow-hidden')}>
            {/* Phones get one row per campaign. A wide table forces a hidden
                sideways scroll that pushes spend and conversions off-screen. */}
            <ul className="divide-y divide-border/70 md:hidden">
              {sortedCampaigns.map((campaign: any) => (
                <li key={campaign.id} className="px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 break-words text-[15px] font-semibold leading-7 text-foreground">{campaign.name}</p>
                    <StatusWord tone={dotTone(campaign.status)}>{campaignStatusLabel(campaign.status)}</StatusWord>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[14px]">
                    <div>
                      <dt className="text-[12.5px] text-muted-foreground">النوع</dt>
                      <dd className="mt-0.5 text-foreground">{campaignTypeLabel(campaign.type)}</dd>
                    </div>
                    <div>
                      <dt className="text-[12.5px] text-muted-foreground">الميزانية</dt>
                      <dd className="mt-0.5 numeric text-foreground">{formatCurrency(campaign.daily_budget ?? 0, selectedAccount?.currency_code)}</dd>
                    </div>
                    <div>
                      <dt className="text-[12.5px] text-muted-foreground">الصرف · {effectiveRange.label}</dt>
                      <dd className="mt-0.5 numeric text-foreground">{formatCurrency(moneyMetric(campaign.range_metrics, 'cost'), selectedAccount?.currency_code)}</dd>
                    </div>
                    <div>
                      <dt className="text-[12.5px] text-muted-foreground">التحويلات</dt>
                      <dd className="mt-0.5 numeric text-foreground">{formatNumberAr(campaign.range_metrics?.conversions ?? 0)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
            <table className="hidden w-full text-[14.5px] md:table">
              <thead>
                <tr className="text-[13px] text-muted-foreground">
                  <th scope="col" className="px-6 py-3.5 text-start font-medium">الحملة</th>
                  <th scope="col" className="px-3 py-3.5 text-start font-medium">الحالة</th>
                  <th scope="col" className="px-3 py-3.5 text-start font-medium">النوع</th>
                  <th scope="col" className="px-3 py-3.5 text-start font-medium">الميزانية</th>
                  <th scope="col" className="px-3 py-3.5 text-start font-medium">الصرف · {effectiveRange.label}</th>
                  <th scope="col" className="px-6 py-3.5 text-start font-medium">التحويلات</th>
                </tr>
              </thead>
              <tbody>
                {sortedCampaigns.map((campaign: any) => (
                  <tr key={campaign.id} className="border-t border-border/70 transition-colors duration-150 hover:bg-muted/50">
                    <td className="px-6 py-4 font-semibold text-foreground">{campaign.name}</td>
                    <td className="px-3 py-4">
                      <StatusWord tone={dotTone(campaign.status)}>{campaignStatusLabel(campaign.status)}</StatusWord>
                    </td>
                    <td className="px-3 py-4 text-muted-foreground">{campaignTypeLabel(campaign.type)}</td>
                    <td className="px-3 py-4 numeric">{formatCurrency(campaign.daily_budget ?? 0, selectedAccount?.currency_code)}</td>
                    <td className="px-3 py-4 numeric">{formatCurrency(moneyMetric(campaign.range_metrics, 'cost'), selectedAccount?.currency_code)}</td>
                    <td className="px-6 py-4 numeric">{formatNumberAr(campaign.range_metrics?.conversions ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <a href="/assistant" className={pill.primarySm}>
              اسأل المساعد
            </a>
            <a href="/audit" className={pill.quietSm}>
              تحديث بالفحص
            </a>
          </div>
        </section>
      )}
    </CalmPage>
  );
}

/** The status colour for the dot; the word beside it says the same thing. */
function dotTone(status?: string | null): DotTone {
  const tone = campaignStatusTone(status);
  return tone === 'success' || tone === 'danger' ? tone : 'neutral';
}

import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  History,
  Lock,
  Megaphone,
  Plus,
} from 'lucide-react';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { formatCurrency, formatNumberAr, timeAgoAr } from '@/lib/utils';
import { moneyMetric } from '@/lib/google-ads/metrics';
import { campaignStatusLabel } from '@/lib/ui/labels';
import { PageHeader } from '@/lib/ui/page-header';
import { CampaignSpendChart } from './spend-chart';
import { EmptyState } from '@/lib/ui/empty-state';
import { StatusBadge, campaignStatusTone, type StatusTone } from '@/lib/ui/status-badge';
import { buttonClasses } from '@/lib/ui/button';
import { TikTokPixel } from '@/lib/analytics/tiktok-pixel';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { Alert } from '@/lib/ui/alert';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { syncErrorMessage } from '@/lib/ui/sync-errors';
import {
  DATE_RANGE_PRESETS,
  dateRangeHref,
  resolveDateRange,
  type DateRangeSearchParams,
  type DateRangeSelection,
} from '@/lib/analytics/date-range';
import { loadCampaignsForDateRange } from '@/lib/analytics/campaign-performance';
import { DateRangePicker } from '@/lib/ui/date-range-picker';
import {
  actionHistoryLabel,
  actionHistoryState,
  actionHistoryTone,
} from '@/lib/guidance/action-history';
import {
  KPI_LABELS,
  biggestExpectedImpact,
  computeKpi,
  kpiKeysForGoal,
  previousRange,
  recommendationCountLabel,
  spendChange,
  sumCampaignTotals,
  totalsFromMetrics,
  type KpiKey,
  type KpiValue,
  type SpendChange,
} from './dashboard-metrics';

const setupSteps = [
  { key: 'accounts', title: 'ربط Google Ads', href: '/onboarding/connect' },
  { key: 'campaigns', title: 'تحديث البيانات', href: '/campaigns' },
  { key: 'audit', title: 'أول فحص', href: '/audit' },
  { key: 'subscription', title: 'بدء التجربة', href: '/billing' },
] as const;

export const metadata = {
  title: 'لوحة التحكم',
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{
    sync_error?: string;
    synced?: string;
    subscribed?: string;
    connected?: string;
    accounts?: string;
  } & DateRangeSearchParams>;
}) {
  const params = await searchParams;
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login');
  const {
    business,
    accounts,
    revokedAccounts,
    selectedAccount,
  } = await getAccountWorkspace(user.id);

  const [campaignsResult, auditResult, pendingResult, actionsResult, subscription] =
    await Promise.all([
      selectedAccount
        ? supabase
            .from('campaigns_cache')
            .select('*')
            .eq('account_id', selectedAccount.id)
            .order('last_synced_at', { ascending: false })
            .limit(500)
        : Promise.resolve({ data: [], error: null }),
      selectedAccount
        ? supabase
            .from('audits')
            .select('health_score, estimated_monthly_waste, ran_at')
            .eq('account_id', selectedAccount.id)
            .order('ran_at', { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      // Counted on its own: the old shared query was capped at 30 mixed rows,
      // which under-reported pending decisions on a busy account.
      selectedAccount
        ? supabase
            .from('recommendations')
            .select('id,expected_impact', { count: 'exact' })
            .eq('account_id', selectedAccount.id)
            .eq('status', 'pending')
            .limit(500)
        : Promise.resolve({ data: [], error: null, count: 0 }),
      selectedAccount
        ? supabase
            .from('ai_actions')
            .select('id,action_type,description_ar,created_at,result,observed_impact,reverted_at')
            .eq('account_id', selectedAccount.id)
            .order('created_at', { ascending: false })
            .limit(4)
        : Promise.resolve({ data: [], error: null }),
      getSubscriptionAccess(supabase, user.id, user.email),
    ]);
  assertSupabaseRead(campaignsResult.error, 'load dashboard campaigns');
  assertSupabaseRead(auditResult.error, 'load dashboard audit');
  assertSupabaseRead(pendingResult.error, 'load dashboard recommendations');
  assertSupabaseRead(actionsResult.error, 'load dashboard actions');
  const cachedCampaigns = campaignsResult.data ?? [];
  const latestAudit = auditResult.data;
  const pendingRecommendations = pendingResult.data ?? [];
  const pendingCount = pendingResult.count ?? pendingRecommendations.length;
  const biggestImpact = biggestExpectedImpact(pendingRecommendations);
  const currency = selectedAccount?.currency_code;

  const requestedRange = resolveDateRange(params, '7d');
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
      effectiveRange = resolveDateRange(null, '7d');
      rangeLoadError =
        'تعذر تحميل الفترة المختارة مباشرة من Google Ads. عرضنا آخر 7 أيام المحفوظة مؤقتاً، ويمكنك إعادة المحاولة.';
      campaigns = await loadCampaignsForDateRange({
        supabase,
        userId: user.id,
        selectedAccount,
        campaigns: cachedCampaigns,
        range: effectiveRange,
      });
    }
  }

  // The comparison needs a live query for the previous period because the
  // cache only holds the latest 7 and 30 day windows. If it fails the headline
  // says so instead of guessing.
  let previousSpend: number | null = null;
  if (selectedAccount && campaigns.length > 0) {
    try {
      const previous = await loadCampaignsForDateRange({
        supabase,
        userId: user.id,
        selectedAccount,
        campaigns: cachedCampaigns,
        range: previousRange(effectiveRange),
      });
      previousSpend = sumCampaignTotals(previous).cost;
    } catch {
      previousSpend = null;
    }
  }

  const setupState: Record<string, boolean> = {
    accounts: accounts.length > 0,
    campaigns: cachedCampaigns.length > 0,
    audit: Boolean(latestAudit),
    subscription: subscription.active,
  };
  const completedCount = Object.values(setupState).filter(Boolean).length;
  const setupComplete = completedCount === setupSteps.length;

  const sortedCampaigns = [...campaigns].sort((a, b) => {
    const aEnabled = a.status === 'ENABLED' ? 1 : 0;
    const bEnabled = b.status === 'ENABLED' ? 1 : 0;
    if (aEnabled !== bEnabled) return bEnabled - aEnabled;
    return moneyMetric(b.range_metrics, 'cost') - moneyMetric(a.range_metrics, 'cost');
  });
  const activeCount = sortedCampaigns.filter((c) => c.status === 'ENABLED').length;
  // Every campaign with spend in the period counts, paused ones included.
  const totals = sumCampaignTotals(campaigns);
  const change = spendChange(totals.cost, previousSpend);
  const kpiKeys = kpiKeysForGoal(business?.primary_goal);
  const rowMetricKey = kpiKeys[1];

  const accountName = selectedAccount ? googleAdsAccountDisplayName(selectedAccount) : null;
  const syncNext = dateRangeHref('/dashboard', requestedRange);

  return (
    <>
      <PageHeader
        title={accountName ?? 'لوحة التحكم'}
        description={
          selectedAccount
            ? effectiveRange.label
            : revokedAccounts.length > 0
              ? 'انتهت صلاحية ربط Google Ads. جدّد الربط لاستعادة بيانات العمل.'
              : 'اربط حساباً إعلانياً حتى تظهر بيانات العمل.'
        }
        account={null}
        actions={
          selectedAccount ? (
            <>
              {!setupComplete && <SetupIndicator state={setupState} completed={completedCount} />}
              <PeriodSelector selection={effectiveRange} />
              <SyncButton
                active={subscription.active}
                customerId={selectedAccount.customer_id}
                next={syncNext}
              />
            </>
          ) : undefined
        }
      />

      <div className="space-y-5 p-4 sm:space-y-6 sm:p-6 lg:p-8">
        {params?.subscribed === '1' && (
          <>
            <Alert tone="success">
              تم تفعيل اشتراكك بنجاح. تجد تفاصيل الخطة والفواتير في صفحة الاشتراك.
            </Alert>
            {/* The one place the pixel loads inside the dashboard: the landing
                page of Stripe's success redirect. Requiring a live subscription
                as well keeps a hand-typed `?subscribed=1` from reporting a sale. */}
            {subscription.active && (
              <TikTokPixel conversion={{ event: 'Subscribe', userId: user.id }} />
            )}
          </>
        )}
        {params?.connected === '1' && (
          <Alert tone="success">
            {params.accounts && Number(params.accounts) > 0
              ? `تم ربط Google Ads: ${formatNumberAr(Number(params.accounts))} ${
                  Number(params.accounts) === 1 ? 'حساب إعلاني جاهز' : 'حسابات إعلانية جاهزة'
                } للعمل.`
              : 'تم ربط Google Ads.'}
          </Alert>
        )}
        {params?.synced && <Alert tone="success">تم تحديث بيانات الحساب المختار.</Alert>}
        {params?.sync_error && <Alert tone="danger">{syncErrorMessage(params.sync_error)}</Alert>}
        {rangeLoadError && <Alert tone="info">{rangeLoadError}</Alert>}

        {accounts.length === 0 ? (
          <EmptyState
            icon={revokedAccounts.length > 0 ? CircleDashed : Plus}
            tone="neutral"
            title={
              revokedAccounts.length > 0
                ? 'انتهت صلاحية ربط Google Ads'
                : 'اربط أول حساب إعلاني لتبدأ'
            }
            description={
              revokedAccounts.length > 0
                ? `جدّد الربط لاستعادة ${
                    revokedAccounts.length === 1
                      ? 'حسابك الإعلاني'
                      : `${formatNumberAr(revokedAccounts.length)} من حساباتك الإعلانية`
                  } وتحميل بياناتها من جديد.`
                : 'مُضاعِف يعمل على حساب إعلاني واحد في كل مرة. اربط Google Ads بموافقة واحدة، ثم اختر الحساب وشغّل أول فحص.'
            }
            action={
              <Link href="/onboarding/connect" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                {revokedAccounts.length > 0 ? 'تجديد الربط' : 'ربط Google Ads'}
              </Link>
            }
          />
        ) : (
          <>
            <SpendHeadline
              spend={totals.cost}
              currency={currency}
              change={change}
              rangeLabel={effectiveRange.label}
              lastSyncedAt={selectedAccount?.last_synced_at}
            />

            <section aria-label="المؤشرات الرئيسية" className="grid gap-3 sm:grid-cols-3 sm:gap-4">
              {kpiKeys.map((key) => (
                <KpiCard key={key} kpiKey={key} value={computeKpi(key, totals)} currency={currency} />
              ))}
            </section>

            <DecisionBlock
              pendingCount={pendingCount}
              biggestImpact={biggestImpact}
              currency={currency}
              hasAudit={Boolean(latestAudit)}
              subscriptionActive={subscription.active}
            />

            {latestAudit && (
              <p className="text-[12.5px] leading-6 text-muted-foreground">
                آخر فحص {timeAgoAr(latestAudit.ran_at)}. صحة الحساب{' '}
                <span className="font-mono numeric text-foreground">{formatNumberAr(latestAudit.health_score ?? 0)}</span>{' '}
                من 100.{' '}
                <Link href="/audit" className="font-medium text-foreground underline-offset-4 hover:underline">
                  عرض الفحص
                </Link>
              </p>
            )}

            {totals.cost > 0 && (
              <CampaignSpendChart
                currencyCode={currency}
                rangeLabel={effectiveRange.label}
                totalSpend={totals.cost}
                campaigns={campaigns.map((c) => ({
                  id: c.google_campaign_id ?? c.id,
                  name: c.name ?? 'حملة',
                  spend: moneyMetric(c.range_metrics, 'cost'),
                }))}
              />
            )}

            <section className="surface-card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
                <div>
                  <h2 className="text-[14px] font-semibold">حملات الحساب</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatNumberAr(activeCount)} مفعلة من أصل {formatNumberAr(campaigns.length)} خلال {effectiveRange.label}
                  </p>
                </div>
                <Link href="/campaigns" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                  كل الحملات
                </Link>
              </div>

              {campaigns.length === 0 ? (
                <EmptyState
                  bare
                  icon={Megaphone}
                  tone="neutral"
                  title="لا توجد حملات محفوظة بعد"
                  description="حدّث البيانات لجلب الحملات من Google Ads."
                  action={
                    selectedAccount ? (
                      <SyncButton
                        active={subscription.active}
                        customerId={selectedAccount.customer_id}
                        next={syncNext}
                        label="تحديث البيانات الآن"
                      />
                    ) : undefined
                  }
                />
              ) : (
                <>
                  {/* Cards on phones, table from md up. */}
                  <ul className="divide-y divide-border md:hidden">
                    {sortedCampaigns.map((campaign: any) => {
                      const t = totalsFromMetrics(campaign.range_metrics);
                      return (
                        <li key={campaign.id} className="space-y-3 px-4 py-4">
                          <div className="flex items-start justify-between gap-3">
                            <span className="min-w-0 text-[13.5px] font-semibold leading-6 text-foreground">
                              {campaign.name}
                            </span>
                            <StatusBadge tone={campaignStatusTone(campaign.status)}>
                              {campaignStatusLabel(campaign.status)}
                            </StatusBadge>
                          </div>
                          <dl className="grid grid-cols-3 gap-3 text-xs">
                            <MiniStat label="الإنفاق" value={formatCurrency(t.cost, currency)} />
                            <MiniStat label="التحويلات" value={formatNumberAr(roundOne(t.conversions))} />
                            <MiniStat
                              label={KPI_LABELS[rowMetricKey]}
                              value={formatKpi(computeKpi(rowMetricKey, t), currency)}
                            />
                          </dl>
                        </li>
                      );
                    })}
                  </ul>

                  <div className="hidden overflow-x-auto scrollbar-thin md:block">
                    <table className="w-full text-sm">
                      <thead className="border-b border-border bg-background-elevated text-[11px] text-muted-foreground">
                        <tr>
                          <th className="px-5 py-2.5 text-start font-medium">اسم الحملة</th>
                          <th className="px-3 py-2.5 text-start font-medium">الحالة</th>
                          <th className="px-3 py-2.5 text-start font-medium">الإنفاق</th>
                          <th className="px-3 py-2.5 text-start font-medium">التحويلات</th>
                          <th className="px-5 py-2.5 text-start font-medium">{KPI_LABELS[rowMetricKey]}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {sortedCampaigns.map((campaign: any) => {
                          const t = totalsFromMetrics(campaign.range_metrics);
                          return (
                            <tr key={campaign.id} className="transition-colors duration-150 hover:bg-muted/50">
                              <td className="px-5 py-3.5 font-medium text-foreground">{campaign.name}</td>
                              <td className="px-3 py-3.5">
                                <StatusBadge tone={campaignStatusTone(campaign.status)}>
                                  {campaignStatusLabel(campaign.status)}
                                </StatusBadge>
                              </td>
                              <td className="px-3 py-3.5 font-mono numeric">{formatCurrency(t.cost, currency)}</td>
                              <td className="px-3 py-3.5 font-mono numeric">{formatNumberAr(roundOne(t.conversions))}</td>
                              <td className="px-5 py-3.5 font-mono font-semibold numeric">
                                {formatKpi(computeKpi(rowMetricKey, t), currency)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>

            <ActionHistory actions={actionsResult.data ?? []} />
          </>
        )}
      </div>
    </>
  );
}

function roundOne(value: number) {
  return Math.round(value * 10) / 10;
}

function formatKpi(value: KpiValue, currency?: string | null) {
  switch (value.kind) {
    case 'count':
      return formatNumberAr(roundOne(value.value));
    case 'money':
      return formatCurrency(value.value, currency);
    case 'ratio':
      return `${value.value.toFixed(2)}×`;
    case 'percent':
      return `${value.value.toFixed(1)}%`;
    case 'empty':
      return 'غير متاح';
  }
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-mono font-semibold text-foreground numeric">{value}</dd>
    </div>
  );
}

/**
 * Sync button. Without an active trial or plan the endpoint refuses with
 * `subscription_required`, so the button says what is missing and goes to
 * the billing page instead of failing after the click.
 */
function SyncButton({
  active,
  customerId,
  next,
  label = 'تحديث البيانات',
}: {
  active: boolean;
  customerId: string;
  next: string;
  label?: string;
}) {
  if (!active) {
    return (
      <Link href="/billing" className={buttonClasses({ variant: 'outline' })}>
        <Lock className="h-4 w-4" aria-hidden />
        تحتاج التجربة
      </Link>
    );
  }
  return (
    <form action="/api/accounts/sync" method="post">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="next" value={next} />
      <PendingSubmitButton pendingLabel="جاري التحديث..." className={buttonClasses({ variant: 'outline' })}>
        {label}
      </PendingSubmitButton>
    </form>
  );
}

/** Setup progress, collapsed to one small control until every step is done. */
function SetupIndicator({ state, completed }: { state: Record<string, boolean>; completed: number }) {
  return (
    <details className="group relative">
      <summary className="flex h-10 cursor-pointer list-none items-center gap-2 border border-border bg-card px-3 text-xs font-semibold text-foreground marker:hidden hover:border-border-strong [&::-webkit-details-marker]:hidden">
        <span className="status-square bg-muted-foreground" aria-hidden />
        تجهيز الحساب
        <span className="font-mono numeric text-muted-foreground">
          {formatNumberAr(completed)}/{formatNumberAr(setupSteps.length)}
        </span>
      </summary>
      <div className="absolute end-0 top-full z-40 mt-1 w-64 max-w-[calc(100vw-2rem)] border border-border bg-card p-1">
        <ol>
          {setupSteps.map((step) => {
            const done = state[step.key];
            return (
              <li key={step.key}>
                <Link
                  href={step.href}
                  className="flex items-center gap-2.5 px-3 py-2.5 text-[13px] hover:bg-muted"
                >
                  {done ? (
                    <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-success" aria-hidden />
                  ) : (
                    <CircleDashed className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className={done ? 'text-muted-foreground' : 'font-medium text-foreground'}>
                    {step.title}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </div>
    </details>
  );
}

/** Period choice in the page header. Presets are plain links, custom opens the full picker. */
function PeriodSelector({ selection }: { selection: DateRangeSelection }) {
  return (
    <div className="flex items-center gap-2">
      <nav
        aria-label="فترة التقرير"
        className="inline-flex border border-border bg-muted/60 p-0.5"
      >
        {DATE_RANGE_PRESETS.map((preset) => {
          const selected = selection.key === preset.key;
          return (
            <Link
              key={preset.key}
              href={`/dashboard?range=${preset.key}`}
              aria-current={selected ? 'true' : undefined}
              className={`flex h-9 items-center px-3 text-xs font-semibold transition-colors ${
                selected ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="font-mono numeric">{preset.days}</span>
              <span className="ms-1">{preset.days === 7 ? 'أيام' : 'يوماً'}</span>
            </Link>
          );
        })}
      </nav>
      <details className="relative">
        <summary
          className={`flex h-10 cursor-pointer list-none items-center border px-3 text-xs font-semibold marker:hidden [&::-webkit-details-marker]:hidden ${
            selection.key === 'custom'
              ? 'border-border-strong bg-card text-foreground'
              : 'border-border bg-card text-muted-foreground hover:text-foreground'
          }`}
        >
          فترة مخصصة
        </summary>
        <div className="absolute end-0 top-full z-40 mt-1 w-[min(92vw,34rem)]">
          <DateRangePicker selection={selection} />
        </div>
      </details>
    </div>
  );
}

function SpendHeadline({
  spend,
  currency,
  change,
  rangeLabel,
  lastSyncedAt,
}: {
  spend: number;
  currency?: string | null;
  change: SpendChange;
  rangeLabel: string;
  lastSyncedAt?: string | null;
}) {
  return (
    <section className="surface-card p-5 sm:p-6" aria-label="الإنفاق في الفترة">
      <div className="text-[13px] font-medium text-muted-foreground">الإنفاق · {rangeLabel}</div>
      <div className="mt-3 break-words font-mono text-[2.5rem] font-bold leading-none text-foreground numeric sm:text-[3.25rem]">
        {formatCurrency(spend, currency)}
      </div>
      <p className="mt-3 text-[13px] leading-6 text-muted-foreground">
        <ChangeLine change={change} currency={currency} />
      </p>
      {lastSyncedAt && (
        <p className="mt-1 text-[12px] text-muted-foreground">آخر تحديث للبيانات {timeAgoAr(lastSyncedAt)}</p>
      )}
    </section>
  );
}

function ChangeLine({ change, currency }: { change: SpendChange; currency?: string | null }) {
  switch (change.kind) {
    case 'unavailable':
      return <>مقارنة الفترة السابقة غير متاحة الآن.</>;
    case 'none':
      return <>لا إنفاق في هذه الفترة ولا في الفترة السابقة.</>;
    case 'new':
      return <>لم يكن هناك إنفاق في الفترة السابقة.</>;
    case 'delta':
      if (change.direction === 'flat') {
        return (
          <>
            مطابق للفترة السابقة (<span className="font-mono numeric">{formatCurrency(change.previous, currency)}</span>).
          </>
        );
      }
      return (
        <>
          <span
            className={`font-mono font-semibold numeric ${
              change.direction === 'up' ? 'text-foreground' : 'text-success'
            }`}
          >
            {change.direction === 'up' ? 'أعلى' : 'أقل'} بنسبة {change.percent}%
          </span>{' '}
          من الفترة السابقة (<span className="font-mono numeric">{formatCurrency(change.previous, currency)}</span>).
        </>
      );
  }
}

function KpiCard({
  kpiKey,
  value,
  currency,
}: {
  kpiKey: KpiKey;
  value: KpiValue;
  currency?: string | null;
}) {
  return (
    <div className="surface-card p-4 sm:p-5">
      <div className="text-[13px] font-medium text-muted-foreground">{KPI_LABELS[kpiKey]}</div>
      <div className="mt-3 break-words font-mono text-[1.75rem] font-bold leading-none text-foreground numeric">
        {formatKpi(value, currency)}
      </div>
      <div className="mt-2 min-h-[1.25rem] text-xs leading-5 text-muted-foreground">
        {value.kind === 'empty' ? value.reason : null}
      </div>
    </div>
  );
}

/**
 * The one place on the page that uses the signal yellow. With nothing pending
 * it drops to a quiet bordered card, so yellow always means "act now".
 */
function DecisionBlock({
  pendingCount,
  biggestImpact,
  currency,
  hasAudit,
  subscriptionActive,
}: {
  pendingCount: number;
  biggestImpact: number | null;
  currency?: string | null;
  hasAudit: boolean;
  subscriptionActive: boolean;
}) {
  if (pendingCount > 0) {
    return (
      <section
        aria-labelledby="decision-title"
        className="flex flex-wrap items-center justify-between gap-4 bg-signal p-5 text-signal-foreground sm:p-6"
      >
        <div className="min-w-0">
          <h2 id="decision-title" className="text-[13px] font-semibold">
            يحتاج قرارك
          </h2>
          <p className="mt-1.5 text-[1.25rem] font-bold leading-8">
            {recommendationCountLabel(pendingCount, formatNumberAr)} بانتظار موافقتك
          </p>
          {biggestImpact !== null && (
            <p className="mt-1 text-[13px]">
              أكبر أثر متوقع{' '}
              <span className="font-mono font-semibold numeric">{formatCurrency(biggestImpact, currency)}</span> شهرياً
            </p>
          )}
        </div>
        <Link href="/optimizer" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
          افتح الموافقات
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Link>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="decision-title"
      className="flex flex-wrap items-center justify-between gap-4 border border-border bg-card p-5"
    >
      <div className="min-w-0">
        <h2 id="decision-title" className="text-[13px] font-semibold text-foreground">
          يحتاج قرارك
        </h2>
        <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
          {hasAudit
            ? 'لا توجد توصيات معلقة الآن. ولن تُنفذ المنصة شيئاً دون موافقتك.'
            : 'لا توجد توصيات بعد. تظهر هنا بعد أول فحص للحساب.'}
        </p>
      </div>
      {hasAudit ? (
        <Link href="/optimizer" className={buttonClasses({ variant: 'outline' })}>
          الموافقات
        </Link>
      ) : subscriptionActive ? (
        <Link href="/audit" className={buttonClasses({ variant: 'outline' })}>
          تشغيل الفحص
        </Link>
      ) : (
        <Link href="/billing" className={buttonClasses({ variant: 'outline' })}>
          <Lock className="h-4 w-4" aria-hidden />
          تحتاج التجربة
        </Link>
      )}
    </section>
  );
}

/** Quiet states only: the page's single yellow belongs to the decision block. */
function historyTone(tone: ReturnType<typeof actionHistoryTone>): StatusTone {
  return tone === 'warning' ? 'neutral' : tone;
}

function ActionHistory({ actions }: { actions: any[] }) {
  return (
    <section className="surface-card overflow-hidden" aria-labelledby="action-history-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div>
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h2 id="action-history-title" className="text-[14px] font-semibold text-foreground">
              آخر القرارات والنتائج
            </h2>
          </div>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">
            ما اعتمدته، وما نُفّذ فعلاً، وهل تحسن الأداء بعده.
          </p>
        </div>
        <Link href="/optimizer" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
          السجل الكامل
        </Link>
      </div>

      {actions.length === 0 ? (
        <div className="px-4 py-5 text-[12.5px] leading-6 text-muted-foreground sm:px-5">
          لا توجد قرارات بعد. ستظهر هنا كل موافقة أو تعديل مع نتيجته.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {actions.map((action) => {
            const state = actionHistoryState(action);
            return (
              <div key={action.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 sm:px-5">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold leading-6 text-foreground">
                    {action.description_ar}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                    {timeAgoAr(action.created_at)}
                  </div>
                </div>
                <StatusBadge tone={historyTone(actionHistoryTone(state))}>{actionHistoryLabel(state)}</StatusBadge>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

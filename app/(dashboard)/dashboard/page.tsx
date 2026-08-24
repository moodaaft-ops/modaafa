import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  History,
  ListChecks,
  Megaphone,
  MessageCircle,
  Plus,
  ShieldCheck,
  TrendingUp,
  Wallet,
  Zap,
} from 'lucide-react';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { formatCurrency, formatNumberAr, timeAgoAr } from '@/lib/utils';
import { moneyMetric } from '@/lib/google-ads/metrics';
import { campaignStatusLabel } from '@/lib/ui/labels';
import { PageHeader } from '@/lib/ui/page-header';
import { MetricCard } from '@/lib/ui/metric-card';
import { CampaignSpendChart } from './spend-chart';
import { EmptyState } from '@/lib/ui/empty-state';
import { StatusBadge, campaignStatusTone } from '@/lib/ui/status-badge';
import { buttonClasses } from '@/lib/ui/button';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { Alert } from '@/lib/ui/alert';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { syncErrorMessage } from '@/lib/ui/sync-errors';
import {
  dateRangeHref,
  resolveDateRange,
  type DateRangeSearchParams,
} from '@/lib/analytics/date-range';
import { loadCampaignsForDateRange } from '@/lib/analytics/campaign-performance';
import { DateRangePicker } from '@/lib/ui/date-range-picker';
import { buildDailyPlan, type DailyPlanTask } from '@/lib/guidance/daily-plan';
import {
  actionHistoryLabel,
  actionHistoryState,
  actionHistoryTone,
} from '@/lib/guidance/action-history';

const starterSteps = [
  {
    key: 'accounts',
    title: 'اربط حسابات Google Ads',
    description: 'موافقة واحدة تسحب كل حساب مباشر وكل حساب عميل تحت أي MCC.',
    href: '/onboarding/connect',
    cta: 'ربط حساب',
    icon: Plus,
  },
  {
    key: 'campaigns',
    title: 'حدّث بيانات الحساب',
    description: 'المزامنة تجلب الحملات والصرف والتحويلات من إعلانات Google.',
    href: '/campaigns',
    cta: 'عرض الحملات',
    icon: Megaphone,
  },
  {
    key: 'audit',
    title: 'شغّل أول فحص',
    description: 'الفحص يحوّل البيانات إلى توصيات مرتبة حسب الأولوية.',
    href: '/audit',
    cta: 'تشغيل الفحص',
    icon: ShieldCheck,
  },
  {
    key: 'subscription',
    title: 'اختر خطة أو ابدأ تجربة',
    description: 'فعّل التجربة لتشغيل الفحص الدوري والمساعد الذكي بالكامل.',
    href: '/billing',
    cta: 'عرض الخطط',
    icon: Zap,
  },
];

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
    business: workspaceBusiness,
    accounts,
    revokedAccounts,
    selectedAccount,
  } = await getAccountWorkspace(user.id);

  // Reuse the workspace lookup rather than issuing a second, unordered
  // `.maybeSingle()` query — that variant threw PGRST116 the moment a user had
  // more than one business row and silently degraded the greeting to a raw
  // email address.
  const business = workspaceBusiness;

  const [
    campaignsResult,
    auditResult,
    recommendationsResult,
    actionsResult,
    subscription,
  ] = await Promise.all([
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
    selectedAccount
      ? supabase
          .from('recommendations')
          .select('id,title,status,severity,expected_impact,created_at')
          .eq('account_id', selectedAccount.id)
          .in('status', ['pending', 'approved', 'executing', 'failed'])
          .order('created_at', { ascending: false })
          .limit(30)
      : Promise.resolve({ data: [], error: null }),
    selectedAccount
      ? supabase
          .from('ai_actions')
          .select('id,action_type,description_ar,created_at,result,observed_impact,reverted_at')
          .eq('account_id', selectedAccount.id)
          .order('created_at', { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [], error: null }),
    getSubscriptionAccess(supabase, user.id, user.email),
  ]);
  assertSupabaseRead(campaignsResult.error, 'load dashboard campaigns');
  assertSupabaseRead(auditResult.error, 'load dashboard audit');
  assertSupabaseRead(recommendationsResult.error, 'load dashboard recommendations');
  assertSupabaseRead(actionsResult.error, 'load dashboard actions');
  const cachedCampaigns = campaignsResult.data ?? [];
  const latestAudit = auditResult.data;
  const dailyPlan = buildDailyPlan({
    hasAccount: Boolean(selectedAccount),
    revokedAccounts: revokedAccounts.length,
    subscriptionActive: subscription.active,
    campaignCount: cachedCampaigns.length,
    lastSyncedAt: selectedAccount?.last_synced_at,
    latestAuditAt: latestAudit?.ran_at,
    recommendations: recommendationsResult.data ?? [],
    actions: actionsResult.data ?? [],
  });
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

  const setupState: Record<string, boolean> = {
    accounts: accounts.length > 0,
    campaigns: cachedCampaigns.length > 0,
    audit: Boolean(latestAudit),
    subscription: subscription.active,
  };
  const completedCount = Object.values(setupState).filter(Boolean).length;
  const setupComplete = completedCount === 4;

  const sortedCampaigns = [...campaigns].sort((a, b) => {
    const aEnabled = a.status === 'ENABLED' ? 1 : 0;
    const bEnabled = b.status === 'ENABLED' ? 1 : 0;
    if (aEnabled !== bEnabled) return bEnabled - aEnabled;
    return moneyMetric(b.range_metrics, 'cost') - moneyMetric(a.range_metrics, 'cost');
  });
  const activeCampaigns = sortedCampaigns.filter((c) => c.status === 'ENABLED');
  const totalSpend = activeCampaigns.reduce((sum, c) => sum + moneyMetric(c.range_metrics, 'cost'), 0);
  const totalConversions = activeCampaigns.reduce(
    (sum, c) => sum + (c.range_metrics?.conversions ?? 0),
    0
  );

  return (
    <>
      <PageHeader
        title={`أهلًا ${business?.name ?? user?.email ?? ''}`}
        description={
          selectedAccount
            ? `تعمل الآن على ${googleAdsAccountDisplayName(selectedAccount)}`
            : revokedAccounts.length > 0
              ? 'انتهت صلاحية ربط Google Ads. أعد الربط لاستعادة بيانات العمل.'
              : 'ابدأ بربط حساب إعلاني حتى تظهر بيانات العمل.'
        }
        account={
          selectedAccount
            ? { name: googleAdsAccountDisplayName(selectedAccount), customerId: selectedAccount.customer_id }
            : null
        }
        actions={
          <>
            {selectedAccount && (
              <form action="/api/accounts/sync" method="post">
                <input type="hidden" name="customerId" value={selectedAccount.customer_id} />
                <input type="hidden" name="next" value={dateRangeHref('/dashboard', requestedRange)} />
                <PendingSubmitButton pendingLabel="جاري التحديث..." className={buttonClasses({ variant: 'primary' })}>
                  تحديث البيانات
                </PendingSubmitButton>
              </form>
            )}
            <Link href="/onboarding/connect" className={buttonClasses({ variant: 'outline' })}>
              <Plus className="h-4 w-4" />
              إضافة حساب
            </Link>
          </>
        }
      />

      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        {/* Every success signal the API layer emits is rendered here. Paying
            for a subscription, finishing the Google OAuth dance and syncing all
            used to redirect back with a query param that no page ever read, so
            the user got no confirmation at the three moments that matter most. */}
        {params?.subscribed === '1' && (
          <Alert tone="success">
            تم تفعيل اشتراكك بنجاح. تجد تفاصيل الخطة والفواتير في صفحة الاشتراك.
          </Alert>
        )}
        {params?.connected === '1' && (
          <Alert tone="success">
            {params.accounts && Number(params.accounts) > 0
              ? `تم ربط إعلانات Google بنجاح — ${formatNumberAr(Number(params.accounts))} حساب إعلاني جاهز للعمل.`
              : 'تم ربط إعلانات Google بنجاح.'}
          </Alert>
        )}
        {params?.synced && <Alert tone="success">تم تحديث بيانات الحساب المختار.</Alert>}
        {params?.sync_error && (
          <Alert tone="danger">{syncErrorMessage(params.sync_error)}</Alert>
        )}
        {rangeLoadError && <Alert tone="warning">{rangeLoadError}</Alert>}
        {accounts.length === 0 ? (
          <EmptyState
            icon={revokedAccounts.length > 0 ? CircleDashed : Plus}
            tone={revokedAccounts.length > 0 ? 'warning' : 'neutral'}
            title={
              revokedAccounts.length > 0
                ? 'انتهت صلاحية ربط Google Ads'
                : 'اربط أول حساب إعلاني لتبدأ'
            }
            description={
              revokedAccounts.length > 0
                ? `أعد ربط Google Ads لاستعادة ${formatNumberAr(revokedAccounts.length)} حساب وحمل بياناته من جديد.`
                : 'مُضاعِف يعمل على حساب إعلاني واحد في كل مرة. اربط إعلانات Google بموافقة واحدة، ثم اختر الحساب وشغّل أول فحص.'
            }
            action={
              <Link href="/onboarding/connect" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                {revokedAccounts.length > 0 ? 'إعادة ربط Google Ads' : 'ربط إعلانات Google'}
              </Link>
            }
          />
        ) : (
          <>
            <DateRangePicker selection={effectiveRange} />

            {/* Setup progress.
                Was a bordered card containing four more bordered cards, pinned
                above the KPIs forever — the clearest "cards inside cards" case
                in the product, and it kept the most valuable screen real estate
                even after every step was done. Now: one quiet line when
                complete, a compact checklist strip while it isn't. */}
            {setupComplete ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-card/60 px-4 py-2.5 text-[12.5px]">
                <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden />
                <span className="font-medium text-foreground">مساحة العمل جاهزة</span>
                <span className="text-muted-foreground">
                  حدّث البيانات وقتما تريد ثم راجع التوصيات في مركز الموافقات.
                </span>
              </div>
            ) : (
              <section className="surface-card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
                  <div>
                    <h2 className="text-[13.5px] font-semibold">أكمل تجهيز مساحة العمل</h2>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      {`أكملت ${formatNumberAr(completedCount)} من 4 خطوات. تابع من حيث توقفت.`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-1 w-24 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-300"
                        style={{ width: `${(completedCount / 4) * 100}%` }}
                      />
                    </div>
                    <span className="text-[12px] font-semibold text-muted-foreground numeric">
                      {formatNumberAr(completedCount)}/4
                    </span>
                  </div>
                </div>

                <ol className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
                  {starterSteps.map((step) => {
                    const done = setupState[step.key];
                    const Icon = step.icon;
                    return (
                      <li key={step.key} className="bg-card">
                        <Link
                          href={step.href}
                          className="group flex h-full flex-col p-4 transition-colors duration-150 hover:bg-surface"
                        >
                          <div className="flex items-center gap-2">
                            {done ? (
                              <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
                            ) : (
                              <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
                            )}
                            <span
                              className={`text-[13px] font-medium ${
                                done ? 'text-muted-foreground line-through decoration-1' : 'text-foreground'
                              }`}
                            >
                              {step.title}
                            </span>
                          </div>
                          <p className="mt-1.5 flex-1 text-[11.5px] leading-6 text-muted-foreground">
                            {step.description}
                          </p>
                          {!done && (
                            <span className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-primary">
                              {step.cta}
                              <ArrowLeft className="h-3 w-3" aria-hidden />
                            </span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}

            <DailyActionPlan plan={dailyPlan} />

            {/* KPIs */}
            <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <MetricCard label={`الإنفاق — ${effectiveRange.label}`} value={formatCurrency(totalSpend, selectedAccount?.currency_code)} icon={Wallet} />
              <MetricCard label={`التحويلات — ${effectiveRange.label}`} value={formatNumberAr(totalConversions)} icon={TrendingUp} />
              <MetricCard
                label="صحة الحساب"
                value={`${latestAudit?.health_score ?? '—'}/100`}
                helper={latestAudit?.ran_at ? `آخر فحص ${timeAgoAr(latestAudit.ran_at)}` : 'لم يتم الفحص بعد'}
                icon={ShieldCheck}
                href="/audit"
              />
              <MetricCard
                label="تسريب الميزانية الشهري"
                value={formatCurrency(latestAudit?.estimated_monthly_waste ?? 0, selectedAccount?.currency_code)}
                helper={latestAudit ? 'تقدير محافظ قابل للتوفير' : 'يظهر بعد أول فحص'}
                tone="danger"
                icon={Wallet}
                href="/audit"
              />
            </section>

            {/* Spend distribution chart — only meaningful once there is spend. */}
            {activeCampaigns.length > 0 && totalSpend > 0 && (
              <CampaignSpendChart
                currencyCode={selectedAccount?.currency_code}
                rangeLabel={effectiveRange.label}
                campaigns={activeCampaigns.map((c) => ({
                  id: c.google_campaign_id ?? c.id,
                  name: c.name ?? 'حملة',
                  spend: moneyMetric(c.range_metrics, 'cost'),
                  roas: c.range_metrics?.roas ?? 0,
                }))}
              />
            )}

            {/* Campaigns */}
            <section className="surface-card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
                <div>
                  <h3 className="text-[14px] font-semibold">حملات الحساب المختار</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatNumberAr(activeCampaigns.length)} حملة مفعلة من أصل {formatNumberAr(campaigns.length)} خلال {effectiveRange.label}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Link href="/campaigns" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                    كل الحملات
                  </Link>
                  <Link href="/optimizer" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
                    مركز الموافقات
                  </Link>
                </div>
              </div>

              {campaigns.length === 0 ? (
                <EmptyState
                  bare
                  icon={Megaphone}
                  tone="neutral"
                  title="لا توجد حملات محفوظة بعد"
                  description="حدّث بيانات الحساب أو شغّل الفحص لجلب الحملات من إعلانات Google."
                  action={
                    <>
                      <form action="/api/accounts/sync" method="post">
                        <input type="hidden" name="customerId" value={selectedAccount?.customer_id ?? ''} />
                        <input type="hidden" name="next" value={dateRangeHref('/dashboard', requestedRange)} />
                        <PendingSubmitButton pendingLabel="جاري التحديث..." className={buttonClasses({ variant: 'primary' })}>
                          تحديث البيانات الآن
                        </PendingSubmitButton>
                      </form>
                      <Link href="/audit" className={buttonClasses({ variant: 'outline' })}>
                        تشغيل الفحص
                      </Link>
                    </>
                  }
                />
              ) : (
                <div className="overflow-x-auto scrollbar-thin">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="border-b border-border bg-background-elevated text-[11px] uppercase text-muted-foreground">
                      <tr>
                        <th className="px-5 py-2.5 text-start font-medium">اسم الحملة</th>
                        <th className="px-3 py-2.5 text-start font-medium">الحالة</th>
                        <th className="px-3 py-2.5 text-start font-medium">الإنفاق — {effectiveRange.label}</th>
                        <th className="px-3 py-2.5 text-start font-medium">التحويلات</th>
                        <th className="px-5 py-2.5 text-start font-medium">ROAS</th>
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
                          <td className="px-3 py-3.5 numeric">{formatCurrency(moneyMetric(campaign.range_metrics, 'cost'), selectedAccount?.currency_code)}</td>
                          <td className="px-3 py-3.5 numeric">{formatNumberAr(campaign.range_metrics?.conversions ?? 0)}</td>
                          <td className="px-5 py-3.5 font-bold numeric text-emerald-600 dark:text-emerald-400">
                            {(campaign.range_metrics?.roas ?? 0).toFixed(1)}×
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <ActionHistory actions={actionsResult.data ?? []} />

            {/* Quick help strip */}
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-primary/25 bg-primary/[0.06] p-5">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-card text-primary shadow-soft">
                  <MessageCircle className="h-5 w-5" />
                </span>
                <div>
                  <div className="font-semibold text-foreground">مو متأكد من أين تبدأ؟</div>
                  <p className="text-sm text-muted-foreground">اسأل المساعد عن أهم توصية أو حلل أداء {effectiveRange.label}.</p>
                </div>
              </div>
              <Link href="/assistant" className={buttonClasses({ variant: 'primary' })}>
                افتح المساعد
              </Link>
            </section>
          </>
        )}
      </div>
    </>
  );
}

function ActionHistory({ actions }: { actions: any[] }) {
  const recentActions = actions.slice(0, 4);

  return (
    <section className="surface-card overflow-hidden" aria-labelledby="action-history-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" aria-hidden />
            <h2 id="action-history-title" className="text-[14px] font-semibold text-foreground">
              آخر القرارات والنتائج
            </h2>
          </div>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">
            تعرف ماذا اعتمدت، وما نُفّذ فعلاً، وهل تحسن الأداء بعده.
          </p>
        </div>
        <Link href="/optimizer" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
          السجل الكامل
        </Link>
      </div>

      {recentActions.length === 0 ? (
        <div className="px-5 py-5 text-[12.5px] leading-6 text-muted-foreground">
          لا توجد قرارات بعد. ستظهر هنا كل موافقة أو تعديل مع نتيجته، ولن تُنفذ المنصة شيئاً دون إذنك.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {recentActions.map((action) => {
            const state = actionHistoryState(action);
            return (
              <div key={action.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold leading-6 text-foreground">
                    {action.description_ar}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                    {timeAgoAr(action.created_at)}
                  </div>
                </div>
                <StatusBadge tone={actionHistoryTone(state)}>{actionHistoryLabel(state)}</StatusBadge>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DailyActionPlan({ plan }: { plan: ReturnType<typeof buildDailyPlan> }) {
  const primary = plan.primary;
  const secondary = plan.tasks.slice(1);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-labelledby="daily-plan-title">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ListChecks className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="daily-plan-title" className="text-[15px] font-semibold text-foreground">
                خطتك اليوم
              </h2>
              {plan.pendingDecisions > 0 && (
                <StatusBadge tone="warning">{formatNumberAr(plan.pendingDecisions)} قرار</StatusBadge>
              )}
            </div>
            <p className="mt-1 text-[12.5px] leading-6 text-muted-foreground">{plan.summary}</p>
          </div>
        </div>
        <span className="text-[11.5px] text-muted-foreground">لا يُنفذ أي تعديل من دون موافقتك</span>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
        <div className={`border-b border-border p-5 lg:border-b-0 lg:border-e ${dailyPlanTone(primary.tone)}`}>
          <div className="text-[11.5px] font-semibold text-primary">ابدأ من هنا</div>
          <h3 className="mt-1.5 text-[18px] font-bold text-foreground">{primary.title}</h3>
          <p className="mt-2 max-w-3xl text-[13px] leading-7 text-muted-foreground">{primary.description}</p>
          <Link href={primary.href} className={`mt-4 ${buttonClasses({ variant: 'primary' })}`}>
            {primary.cta}
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Link>
        </div>

        <div className="divide-y divide-border">
          {secondary.length > 0 ? (
            secondary.map((task, index) => (
              <Link
                key={task.id}
                href={task.href}
                className="group flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-muted/50"
              >
                <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-bold text-muted-foreground">
                  {formatNumberAr(index + 2)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-foreground">{task.title}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-5 text-muted-foreground">{task.cta}</span>
                </span>
                <ArrowLeft className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform group-hover:-translate-x-0.5 group-hover:text-primary" aria-hidden />
              </Link>
            ))
          ) : (
            <div className="flex h-full min-h-32 items-center px-5 py-4 text-[12.5px] leading-6 text-muted-foreground">
              لا توجد خطوات متراكمة. سنضيف هنا أي قرار يحتاج انتباهك فور ظهوره.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function dailyPlanTone(tone: DailyPlanTask['tone']) {
  if (tone === 'danger') return 'bg-red-500/[0.045]';
  if (tone === 'warning') return 'bg-amber-500/[0.05]';
  if (tone === 'primary') return 'bg-primary/[0.045]';
  return 'bg-card';
}

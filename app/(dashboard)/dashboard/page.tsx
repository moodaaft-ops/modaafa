import Link from 'next/link';
import {
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
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
import { createServerClient } from '@/lib/supabase/server';
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
  }>;
}) {
  const params = await searchParams;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { business: workspaceBusiness, accounts, selectedAccount } = await getAccountWorkspace(supabase);

  // Reuse the workspace lookup rather than issuing a second, unordered
  // `.maybeSingle()` query — that variant threw PGRST116 the moment a user had
  // more than one business row and silently degraded the greeting to a raw
  // email address.
  const business = workspaceBusiness;

  const { data: campaigns } = selectedAccount
    ? await supabase
        .from('campaigns_cache')
        .select('*')
        .eq('account_id', selectedAccount.id)
        .order('last_synced_at', { ascending: false })
        .limit(500)
    : { data: [] };

  const { data: latestAudit } = selectedAccount
    ? await supabase
        .from('audits')
        .select('health_score, estimated_monthly_waste, ran_at')
        .eq('account_id', selectedAccount.id)
        .order('ran_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  const subscription = await getSubscriptionAccess(supabase, user?.id);

  const setupState: Record<string, boolean> = {
    accounts: accounts.length > 0,
    campaigns: (campaigns?.length ?? 0) > 0,
    audit: Boolean(latestAudit),
    subscription: subscription.active,
  };
  const completedCount = Object.values(setupState).filter(Boolean).length;
  const setupComplete = completedCount === 4;

  const sortedCampaigns = [...(campaigns ?? [])].sort((a, b) => {
    const aEnabled = a.status === 'ENABLED' ? 1 : 0;
    const bEnabled = b.status === 'ENABLED' ? 1 : 0;
    if (aEnabled !== bEnabled) return bEnabled - aEnabled;
    return moneyMetric(b.metrics_7d, 'cost') - moneyMetric(a.metrics_7d, 'cost');
  });
  const activeCampaigns = sortedCampaigns.filter((c) => c.status === 'ENABLED');
  const totalSpend = activeCampaigns.reduce((sum, c) => sum + moneyMetric(c.metrics_7d, 'cost'), 0);
  const totalConversions = activeCampaigns.reduce((sum, c) => sum + (c.metrics_7d?.conversions ?? 0), 0);

  return (
    <>
      <PageHeader
        title={`أهلًا ${business?.name ?? user?.email ?? ''}`}
        description={
          selectedAccount
            ? `تعمل الآن على ${googleAdsAccountDisplayName(selectedAccount)}`
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
                <input type="hidden" name="next" value="/dashboard" />
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
        {accounts.length === 0 ? (
          <EmptyState
            icon={Plus}
            title="اربط أول حساب إعلاني لتبدأ"
            description="مُضاعِف يعمل على حساب إعلاني واحد في كل مرة. اربط إعلانات Google بموافقة واحدة، ثم اختر الحساب وشغّل أول فحص."
            action={
              <Link href="/onboarding/connect" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                ربط إعلانات Google
              </Link>
            }
          />
        ) : (
          <>
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

            {/* KPIs */}
            <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <MetricCard label="الإنفاق آخر 7 أيام" value={formatCurrency(totalSpend, selectedAccount?.currency_code)} icon={Wallet} />
              <MetricCard label="التحويلات آخر 7 أيام" value={formatNumberAr(totalConversions)} icon={TrendingUp} />
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
                campaigns={activeCampaigns.map((c) => ({
                  name: c.name ?? 'حملة',
                  spend: moneyMetric(c.metrics_7d, 'cost'),
                  roas: c.metrics_30d?.roas ?? 0,
                }))}
              />
            )}

            {/* Campaigns */}
            <section className="surface-card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
                <div>
                  <h3 className="text-[14px] font-semibold">حملات الحساب المختار</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatNumberAr(activeCampaigns.length)} حملة مفعلة من أصل {formatNumberAr(campaigns?.length ?? 0)}
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

              {(campaigns?.length ?? 0) === 0 ? (
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
                        <input type="hidden" name="next" value="/dashboard" />
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
                        <th className="px-3 py-2.5 text-start font-medium">الإنفاق 7 أيام</th>
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
                          <td className="px-3 py-3.5 numeric">{formatCurrency(moneyMetric(campaign.metrics_7d, 'cost'), selectedAccount?.currency_code)}</td>
                          <td className="px-3 py-3.5 numeric">{formatNumberAr(campaign.metrics_7d?.conversions ?? 0)}</td>
                          <td className="px-5 py-3.5 font-bold numeric text-emerald-600 dark:text-emerald-400">
                            {(campaign.metrics_30d?.roas ?? 0).toFixed(1)}×
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Quick help strip */}
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-primary/25 bg-primary/[0.06] p-5">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-card text-primary shadow-soft">
                  <MessageCircle className="h-5 w-5" />
                </span>
                <div>
                  <div className="font-semibold text-foreground">مو متأكد من أين تبدأ؟</div>
                  <p className="text-sm text-muted-foreground">اسأل المساعد عن أهم توصية أو حلل الصرف آخر 7 أيام.</p>
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

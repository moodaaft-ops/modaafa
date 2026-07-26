import { ShieldCheck, Link2 } from 'lucide-react';
import { createServerClient } from '@/lib/supabase/server';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { formatCurrency, timeAgoAr } from '@/lib/utils';
import { severityLabel } from '@/lib/ui/labels';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { PageHeader } from '@/lib/ui/page-header';
import { EmptyState } from '@/lib/ui/empty-state';
import { Alert } from '@/lib/ui/alert';
import { StatusBadge, severityTone } from '@/lib/ui/status-badge';
import { buttonClasses } from '@/lib/ui/button';
import { cn } from '@/lib/utils';
import { getSubscriptionAccess, featureAccessMessage } from '@/lib/billing/entitlements';
import { SubscriptionGate } from '@/lib/ui/subscription-gate';

type AccountLite = { customer_id: string; customer_name: string | null };

export const metadata = {
  title: 'فحص الحساب',
};

export default async function AuditPage({
  searchParams,
}: {
  searchParams?: Promise<{ ran?: string; error?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createServerClient();
  const { accounts, selectedAccount, selectedCustomerId } = await getAccountWorkspace(supabase);
  const subscription = await getSubscriptionAccess(supabase);

  const { data: audit } = selectedAccount
    ? await supabase
        .from('audits')
        .select('*')
        .eq('account_id', selectedAccount.id)
        .order('ran_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  const accountName = selectedAccount ? googleAdsAccountDisplayName(selectedAccount) : 'إعلانات Google';

  if (!audit) {
    return (
      <>
        <PageHeader icon={ShieldCheck} title="فحص الحساب" description="تحليل صحة الحساب واكتشاف الفرص والتسريب." />
        <div className="p-4 sm:p-6 lg:p-8">
          {accounts.length === 0 ? (
            <EmptyState
              icon={Link2}
              title="اربط حساب إعلانات Google أولاً"
              description="بعد الربط تقدر تشغّل أول فحص للحساب المختار."
              action={
                <a href="/onboarding/connect" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                  ربط إعلانات Google
                </a>
              }
            />
          ) : (
            subscription.active ? (
              <EmptyState
                icon={ShieldCheck}
                title="ابدأ أول فحص ذكي للحساب"
                description="الفحص يقرأ الحملات المخزنة، يحدّثها من إعلانات Google عند توفر الصلاحية، ثم ينشئ توصيات قابلة للموافقة قبل أي تنفيذ."
                action={
                  <>
                    {params?.error && (
                      <div className="mb-1 w-full">
                        <Alert tone="danger">{auditErrorMessage(params.error)}</Alert>
                      </div>
                    )}
                    <RunAuditForm accounts={accounts} selectedCustomerId={selectedCustomerId} label="تشغيل الفحص الآن" />
                  </>
                }
              />
            ) : (
              <SubscriptionGate title="ابدأ التجربة لتشغيل أول فحص" />
            )
          )}
        </div>
      </>
    );
  }

  const { data: recommendations } = await supabase
    .from('recommendations')
    .select('*')
    .eq('audit_id', audit.id)
    .order('created_at', { ascending: false });

  const { data: latestReport } = await supabase
    .from('reports')
    .select('summary_ar, generated_at')
    .eq('account_id', audit.account_id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const recs = recommendations ?? [];

  return (
    <>
      <PageHeader
        icon={ShieldCheck}
        title="فحص الحساب"
        description={`آخر فحص ${timeAgoAr(audit.ran_at)}`}
        account={selectedAccount ? { name: accountName, customerId: selectedAccount.customer_id } : null}
        actions={
          subscription.active ? (
            <RunAuditForm accounts={accounts} selectedCustomerId={selectedCustomerId} label="إعادة الفحص" />
          ) : (
            <a href="/billing" className={buttonClasses({ variant: 'primary' })}>تفعيل الفحص</a>
          )
        }
      />

      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        {params?.ran && <Alert tone="success">تم تشغيل الفحص وتحديث التوصيات.</Alert>}
        {!subscription.active && <SubscriptionGate compact />}
        {params?.error && <Alert tone="danger">{auditErrorMessage(params.error)}</Alert>}

        <div className="grid gap-5 lg:grid-cols-3">
          <section className="rounded-lg border border-border bg-card p-6 lg:col-span-2">
            <div className="mb-6">
              <h3 className="text-lg font-bold">تقرير صحة الحساب</h3>
              <p className="mt-1 text-sm leading-7 text-muted-foreground">
                {latestReport?.summary_ar ?? 'ملخص الفحص الأخير وتوزيع المخاطر حسب بيانات الحساب.'}
              </p>
            </div>
            <div className="flex flex-col items-center gap-8 sm:flex-row">
              <HealthGauge score={audit.health_score ?? 0} />
              <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3">
                <CategoryScore label="الكلمات" value={audit.category_scores?.keywords ?? 0} />
                <CategoryScore label="الإعلانات" value={audit.category_scores?.ad_quality ?? 0} />
                <CategoryScore label="السلبيات" value={audit.category_scores?.negative_keywords ?? 0} />
                <CategoryScore label="المزايدة" value={audit.category_scores?.bidding ?? 0} />
                <CategoryScore label="الميزانية" value={audit.category_scores?.budget ?? 0} />
                <CategoryScore label="الاستهداف" value={audit.category_scores?.targeting ?? 0} />
              </div>
            </div>
          </section>

          <section className="relative flex flex-col overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-ink-900 to-ink-800 p-6 text-white shadow-card">
            <div className="pointer-events-none absolute -end-10 -top-10 h-32 w-32 rounded-full bg-red-500/20 blur-3xl" aria-hidden />
            <div className="relative text-sm text-white/70">تسريب الميزانية الشهري</div>
            <div className="relative mt-2 text-4xl font-bold tabular-nums">{formatCurrency(audit.estimated_monthly_waste ?? 0, selectedAccount?.currency_code)}</div>
            <p className="relative mt-3 flex-1 text-sm leading-7 text-white/70">
              تقدير محافظ لما يمكن توفيره أو إعادة توزيعه بناءً على آخر بيانات محفوظة من إعلانات Google.
            </p>
            <a
              href="#recommendations"
              className="relative mt-4 inline-flex h-11 items-center justify-center rounded-lg bg-white px-5 text-sm font-semibold text-ink-900 transition hover:bg-white/90"
            >
              مراجعة التوصيات
            </a>
          </section>
        </div>

        <section id="recommendations" className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border p-5">
            <div>
              <h3 className="font-bold">التوصيات</h3>
              <p className="mt-1 text-xs text-muted-foreground">مرتبة من الأحدث، وكل قرار يبقى تحت موافقتك.</p>
            </div>
            <span className="rounded-lg bg-muted px-3 py-1.5 text-sm font-semibold text-muted-foreground">{recs.length}</span>
          </div>

          {recs.length === 0 ? (
            <div className="p-8 text-sm text-muted-foreground">لا توجد توصيات محفوظة لهذا الفحص.</div>
          ) : (
            <div className="divide-y divide-border">
              {recs.map((r: any, idx: number) => (
                <div key={r.id} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-muted font-bold text-muted-foreground">
                    {idx + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{r.title}</span>
                      <StatusBadge tone={severityTone(r.severity)}>{severityLabel(r.severity)}</StatusBadge>
                    </div>
                    <p className="mt-1.5 text-sm leading-7 text-muted-foreground">{r.description}</p>
                    {r.expected_impact?.delta_sar_per_month && (
                      <p className="mt-2 inline-flex items-center gap-1 rounded-md bg-emerald-50 dark:bg-emerald-500/15 px-2 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                        تأثير متوقع: {formatCurrency(r.expected_impact.delta_sar_per_month, selectedAccount?.currency_code)}/شهر
                      </p>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 gap-2">
                    <RecommendationAction id={r.id} intent="approve" label="اعتماد" next="/audit" />
                    <RecommendationAction id={r.id} intent="dismiss" label="تجاهل" next="/audit" secondary />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function auditErrorMessage(code: string) {
  if (['subscription_required', 'quota_exceeded', 'usage_storage_unavailable'].includes(code)) {
    return featureAccessMessage(code);
  }
  if (code === 'account_not_found') return 'لم نجد الحساب الإعلاني المختار. اختر حساباً آخر أو أعد الربط.';
  return 'تعذر تشغيل الفحص الآن. لم ننفذ أي تعديل على حساب إعلانات Google.';
}

function scoreTone(value: number) {
  if (value >= 80) return { text: 'text-emerald-600 dark:text-emerald-400', stroke: '#059669', badge: 'success' as const };
  if (value >= 60) return { text: 'text-amber-600 dark:text-amber-400', stroke: '#D97706', badge: 'warning' as const };
  return { text: 'text-red-600 dark:text-red-400', stroke: '#DC2626', badge: 'danger' as const };
}

function HealthGauge({ score }: { score: number }) {
  const tone = scoreTone(score);
  const circumference = 264;
  return (
    <div className="relative h-44 w-44 flex-shrink-0">
      <svg className="h-full w-full -rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="42" fill="none" strokeWidth="10" className="stroke-muted" />
        <circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          stroke={tone.stroke}
          strokeWidth="10"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - (circumference * Math.max(0, Math.min(100, score))) / 100}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className={cn('text-5xl font-bold tabular-nums', tone.text)}>{score}</div>
        <div className="text-xs text-muted-foreground">من 100</div>
      </div>
    </div>
  );
}

function CategoryScore({ label, value }: { label: string; value: number }) {
  const tone =
    value >= 80
      ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : value >= 60
        ? 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300'
        : 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-300';
  return (
    <div className={cn('rounded-lg p-3', tone)}>
      <div className="text-xs">{label}</div>
      <div className="mt-0.5 text-xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function RunAuditForm({
  accounts,
  selectedCustomerId,
  label,
}: {
  accounts: AccountLite[];
  selectedCustomerId: string | null;
  label: string;
}) {
  if (accounts.length === 0) {
    return (
      <a href="/onboarding/connect" className={buttonClasses({ variant: 'primary' })}>
        ربط حساب
      </a>
    );
  }

  return (
    <form action="/api/audit/run" method="post" className="flex items-center gap-2">
      {accounts.length > 1 ? (
        <select
          name="customerId"
          defaultValue={selectedCustomerId ?? accounts[0].customer_id}
          className="h-10 max-w-[160px] rounded-lg border border-border bg-card px-2.5 text-sm outline-none focus:border-brand-500"
          aria-label="اختر الحساب للفحص"
        >
          {accounts.map((account) => (
            <option key={account.customer_id} value={account.customer_id}>
              {googleAdsAccountDisplayName(account)}
            </option>
          ))}
        </select>
      ) : (
        <input type="hidden" name="customerId" value={accounts[0].customer_id} />
      )}
      <PendingSubmitButton pendingLabel="جاري الفحص..." className={buttonClasses({ variant: 'primary' })}>
        {label}
      </PendingSubmitButton>
    </form>
  );
}

function RecommendationAction({
  id,
  intent,
  label,
  next,
  secondary,
}: {
  id: string;
  intent: 'approve' | 'dismiss';
  label: string;
  next: string;
  secondary?: boolean;
}) {
  return (
    <form action="/api/recommendations/action" method="post">
      <input type="hidden" name="recommendation_id" value={id} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="next" value={next} />
      <PendingSubmitButton
        pendingLabel={intent === 'approve' ? 'جاري الموافقة...' : 'جاري التجاهل...'}
        className={buttonClasses({ variant: secondary ? 'outline' : 'primary', size: 'sm' })}
      >
        {label}
      </PendingSubmitButton>
    </form>
  );
}

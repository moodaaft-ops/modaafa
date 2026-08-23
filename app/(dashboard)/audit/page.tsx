import { ClipboardCheck, ShieldCheck, Link2, Sparkles, DatabaseZap } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { formatCurrency, timeAgoAr } from '@/lib/utils';
import { recommendationStatusLabel, severityLabel } from '@/lib/ui/labels';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { PageHeader } from '@/lib/ui/page-header';
import { EmptyState } from '@/lib/ui/empty-state';
import { Alert } from '@/lib/ui/alert';
import { StatusBadge, recommendationStatusTone, severityTone } from '@/lib/ui/status-badge';
import { buttonClasses } from '@/lib/ui/button';
import { cn } from '@/lib/utils';
import { getSubscriptionAccess, featureAccessMessage } from '@/lib/billing/entitlements';
import { SubscriptionGate } from '@/lib/ui/subscription-gate';
import { isCurrentAuditEngine } from '@/lib/audit/version';
import { AuditRunner } from './audit-runner';

type AccountLite = { customer_id: string; customer_name: string | null };

export const metadata = {
  title: 'فحص الحساب',
};

export default async function AuditPage({
  searchParams,
}: {
  searchParams?: Promise<{ ran?: string; error?: string; approved?: string }>;
}) {
  const params = await searchParams;
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login');
  const [{ accounts, selectedAccount, selectedCustomerId }, subscription] = await Promise.all([
    getAccountWorkspace(user.id),
    getSubscriptionAccess(supabase, user.id, user.email),
  ]);

  const auditResult = selectedAccount
    ? await supabase
        .from('audits')
        .select('*')
        .eq('account_id', selectedAccount.id)
        .order('ran_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null, error: null };
  assertSupabaseRead(auditResult.error, 'load latest audit');
  const audit = auditResult.data;

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

  const metricsSnapshot = (audit.metrics_snapshot ?? {}) as any;
  const currentAuditEngine = isCurrentAuditEngine(metricsSnapshot);
  const liveCoverage = metricsSnapshot.live_coverage as
    | { coverage_pct?: number; confidence?: string; failed_checks?: string[] }
    | null;
  const aiNarrative = metricsSnapshot.ai_narrative as
    | {
        headline_ar?: string;
        executive_summary_ar?: string;
        priorities_ar?: string[];
        risks_ar?: string[];
        growth_ar?: string[];
      }
    | null;

  if (!currentAuditEngine) {
    return (
      <>
        <PageHeader
          icon={ShieldCheck}
          title="فحص الحساب"
          description={`آخر نتيجة محفوظة ${timeAgoAr(audit.ran_at)}، لكنها من محرك الفحص السابق`}
          account={selectedAccount ? { name: accountName, customerId: selectedAccount.customer_id } : null}
        />
        <div className="p-4 sm:p-6 lg:p-8">
          {params?.error && <Alert tone="danger">{auditErrorMessage(params.error)}</Alert>}
          <section className="surface-card mx-auto flex max-w-3xl flex-col items-center px-5 py-10 text-center sm:px-10">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-300">
              <DatabaseZap className="h-7 w-7" aria-hidden />
            </div>
            <h2 className="mt-5 text-xl font-bold text-foreground">هذه النتيجة قديمة ولا نعتمدها الآن</h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
              حُفظت قبل تشغيل محرك الفحص الذكي الذي يقرأ عبارات البحث وجودة الكلمات وفقد الميزانية والترتيب مباشرة من Google Ads. أخفينا الدرجة والتوصيات القديمة حتى لا تبدو نتيجة سطحية كأنها حكم حديث.
            </p>
            <div className="mt-6">
              {subscription.active ? (
                <RunAuditForm accounts={accounts} selectedCustomerId={selectedCustomerId} label="تشغيل الفحص الذكي الآن" />
              ) : (
                <a href="/billing" className={buttonClasses({ variant: 'primary', size: 'lg' })}>تفعيل الفحص</a>
              )}
            </div>
          </section>
        </div>
      </>
    );
  }

  const [recommendationsResult, latestReportResult] = await Promise.all([
    supabase
      .from('recommendations')
      .select('*')
      .eq('audit_id', audit.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('reports')
      .select('summary_ar, generated_at')
      .eq('account_id', audit.account_id)
      .contains('metrics', { kind: 'audit_summary', audit_id: audit.id })
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  assertSupabaseRead(recommendationsResult.error, 'load audit recommendations');
  assertSupabaseRead(latestReportResult.error, 'load audit report');
  const recommendations = recommendationsResult.data;
  const latestReport = latestReportResult.data;

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
        {params?.approved && (
          <Alert tone="success">تم اعتماد التوصية دون تنفيذ أي تعديل. راجع تفاصيلها في مركز الموافقات.</Alert>
        )}
        {!subscription.active && <SubscriptionGate compact />}
        {params?.error && <Alert tone="danger">{auditErrorMessage(params.error)}</Alert>}

        {liveCoverage && Number(liveCoverage.coverage_pct ?? 0) < 100 && (
          <Alert tone={liveCoverage.confidence === 'limited' ? 'danger' : 'warning'} title="تغطية الفحص غير مكتملة">
            اكتملت {Number(liveCoverage.coverage_pct ?? 0)}% من طبقات البيانات الحية. لم نعتبر البيانات المفقودة علامة سلامة.
            {Array.isArray(liveCoverage.failed_checks) && liveCoverage.failed_checks.length > 0
              ? ` تعذر فحص: ${liveCoverage.failed_checks.join('، ')}.`
              : null}
          </Alert>
        )}

        {aiNarrative?.headline_ar && (
          <section className="surface-card overflow-hidden border-primary/25">
            <div className="flex items-start gap-4 p-5 sm:p-6">
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <Sparkles className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold text-foreground">{aiNarrative.headline_ar}</h2>
                  <StatusBadge tone="brand">قراءة Claude للأدلة</StatusBadge>
                </div>
                {aiNarrative.executive_summary_ar && (
                  <p className="mt-2 max-w-4xl whitespace-pre-line text-sm leading-7 text-muted-foreground">
                    {aiNarrative.executive_summary_ar}
                  </p>
                )}
                <div className="mt-5 grid gap-4 md:grid-cols-3">
                  <NarrativeList title="الأولوية الآن" items={aiNarrative.priorities_ar} />
                  <NarrativeList title="المخاطر" items={aiNarrative.risks_ar} />
                  <NarrativeList title="فرص النمو" items={aiNarrative.growth_ar} />
                </div>
              </div>
            </div>
          </section>
        )}

        <div className="grid gap-5 lg:grid-cols-3">
          <section className="surface-card p-6 lg:col-span-2">
            <div className="mb-6">
              <h3 className="text-[15px] font-semibold">تقرير صحة الحساب</h3>
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
                <CategoryScore label="ثقة البيانات" value={audit.category_scores?.data_confidence ?? 0} />
              </div>
            </div>
          </section>

          <section className="surface-raised relative flex flex-col overflow-hidden p-6">
            <div className="pointer-events-none absolute -end-10 -top-10 h-32 w-32 rounded-full bg-red-500/20 blur-3xl" aria-hidden />
            <div className="relative text-[13px] text-muted-foreground">تسريب الميزانية الشهري</div>
            <div className="relative mt-2 text-[2.25rem] font-bold leading-none text-red-500 numeric dark:text-red-400">{formatCurrency(audit.estimated_monthly_waste ?? 0, selectedAccount?.currency_code)}</div>
            <p className="relative mt-3 flex-1 text-[13px] leading-7 text-muted-foreground">
              تقدير محافظ لما يمكن توفيره أو إعادة توزيعه بناءً على آخر بيانات محفوظة من إعلانات Google.
            </p>
            <a
              href="#recommendations"
              className="relative mt-4 inline-flex h-10 items-center justify-center rounded-lg border border-border bg-card px-4 text-[13px] font-semibold text-foreground shadow-soft transition-colors duration-150 hover:border-border-strong hover:bg-surface"
            >
              مراجعة التوصيات
            </a>
          </section>
        </div>

        <section id="recommendations" className="surface-card overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border p-5">
            <div>
              <h3 className="text-[14px] font-semibold">التوصيات</h3>
              <p className="mt-1 text-xs text-muted-foreground">مرتبة من الأحدث، وكل قرار يبقى تحت موافقتك.</p>
            </div>
            <span className="rounded-lg bg-muted px-3 py-1.5 text-sm font-semibold text-muted-foreground">{recs.length}</span>
          </div>

          {recs.length === 0 ? (
            <EmptyState
              bare
              tone={liveCoverage && Number(liveCoverage.coverage_pct ?? 0) < 100 ? 'warning' : 'neutral'}
              icon={liveCoverage && Number(liveCoverage.coverage_pct ?? 0) < 100 ? DatabaseZap : ClipboardCheck}
              title={liveCoverage && Number(liveCoverage.coverage_pct ?? 0) < 100 ? 'الفحص المتقدم لم يكتمل' : 'لا توجد توصيات مدعومة بالأدلة حالياً'}
              description={
                liveCoverage && Number(liveCoverage.coverage_pct ?? 0) < 100
                  ? 'تعذر جمع بعض طبقات Google Ads، لذلك لم نصدر حكماً أخضر وهمياً. أعد الفحص لاستكمال البيانات.'
                  : 'اكتملت طبقات الفحص ولم تظهر فرصة تتجاوز حدود الأدلة الحالية. أعد الفحص بعد تجميع بيانات أداء أحدث.'
              }
              action={
                <a href="/campaigns" className={buttonClasses({ variant: 'outline' })}>
                  استعراض الحملات
                </a>
              }
            />
          ) : (
            <div className="divide-y divide-border">
              {recs.map((r: any, idx: number) => {
                const evidence = Array.isArray(r.action_payload?.evidence_ar)
                  ? r.action_payload.evidence_ar.filter((item: unknown) => typeof item === 'string').slice(0, 5)
                  : [];
                const confidence = String(r.action_payload?.confidence ?? '');
                const source = String(r.action_payload?.source ?? '');
                return (
                <div key={r.id} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-muted font-bold text-muted-foreground">
                    {idx + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{r.title}</span>
                      <StatusBadge tone={severityTone(r.severity)}>{severityLabel(r.severity)}</StatusBadge>
                      <StatusBadge tone={recommendationStatusTone(r.status)}>
                        {recommendationStatusLabel(r.status)}
                      </StatusBadge>
                      {confidence && <StatusBadge tone={confidence === 'high' ? 'success' : confidence === 'medium' ? 'warning' : 'neutral'}>ثقة {confidenceLabelAr(confidence)}</StatusBadge>}
                      {source && <StatusBadge tone="info">{sourceLabelAr(source)}</StatusBadge>}
                    </div>
                    <p className="mt-1.5 text-sm leading-7 text-muted-foreground">{r.description}</p>
                    {evidence.length > 0 && (
                      <div className="mt-3 rounded-lg border border-border bg-muted/45 p-3">
                        <div className="text-xs font-semibold text-foreground">الدليل من الحساب</div>
                        <ul className="mt-2 space-y-1 text-xs leading-6 text-muted-foreground">
                          {evidence.map((item: string, evidenceIndex: number) => (
                            <li key={`${r.id}-evidence-${evidenceIndex}`} className="flex gap-2">
                              <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-hidden />
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {r.expected_impact?.delta_sar_per_month && (
                      <p className="mt-2 inline-flex items-center gap-1 rounded-md bg-emerald-50 dark:bg-emerald-500/15 px-2 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                        تأثير متوقع: {formatCurrency(r.expected_impact.delta_sar_per_month, selectedAccount?.currency_code)}/شهر
                      </p>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 gap-2">
                    {['pending', 'failed'].includes(r.status) && (
                      <>
                        <RecommendationAction id={r.id} intent="approve" label="اعتماد" next="/audit" />
                        <RecommendationAction id={r.id} intent="dismiss" label="تجاهل" next="/audit" secondary />
                      </>
                    )}
                    {r.status === 'approved' && (
                      <a href="/optimizer" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                        مراجعة التنفيذ
                      </a>
                    )}
                  </div>
                </div>
                );
              })}
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
  // Colour comes from `currentColor` (the text class, which HAS dark variants)
  // rather than a hardcoded hex, so the gauge tracks light/dark like the rest
  // of the product instead of staying a fixed emerald/amber/red.
  if (value >= 80) return { text: 'text-emerald-600 dark:text-emerald-400', badge: 'success' as const };
  if (value >= 60) return { text: 'text-amber-600 dark:text-amber-400', badge: 'warning' as const };
  return { text: 'text-red-600 dark:text-red-400', badge: 'danger' as const };
}

function HealthGauge({ score }: { score: number }) {
  const tone = scoreTone(score);
  const circumference = 264;
  return (
    <div className="relative h-44 w-44 flex-shrink-0">
      <svg className={cn('h-full w-full -rotate-90', tone.text)} viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="42" fill="none" strokeWidth="10" className="stroke-muted" />
        <circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - (circumference * Math.max(0, Math.min(100, score))) / 100}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 700ms cubic-bezier(0.16,1,0.3,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className={cn('text-5xl font-bold numeric', tone.text)}>{score}</div>
        <div className="text-xs text-muted-foreground">من 100</div>
      </div>
    </div>
  );
}

// A neutral instrument tile: hairline surface, a thin top accent + progress
// track coloured by score — instead of six pastel-filled "bag of sweets" tiles.
function CategoryScore({ label, value }: { label: string; value: number }) {
  const tone = scoreTone(value);
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="surface-card overflow-hidden p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={cn('text-lg font-bold numeric', tone.text)}>{value}</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className={cn('h-full rounded-full bg-current transition-[width] duration-700', tone.text)}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function NarrativeList({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/45 p-4">
      <div className="text-xs font-semibold text-foreground">{title}</div>
      <ul className="mt-2 space-y-2 text-xs leading-6 text-muted-foreground">
        {items.slice(0, 4).map((item, index) => (
          <li key={`${title}-${index}`} className="flex gap-2">
            <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function confidenceLabelAr(confidence: string) {
  if (confidence === 'high') return 'عالية';
  if (confidence === 'medium') return 'متوسطة';
  return 'محدودة';
}

function sourceLabelAr(source: string) {
  if (source === 'google_ads_live') return 'Google Ads مباشر';
  if (source === 'campaign_cache') return 'بيانات المزامنة';
  if (source === 'sector_benchmark') return 'مقارنة القطاع';
  if (source === 'data_coverage') return 'تغطية البيانات';
  return 'بيانات الحساب';
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

  return <AuditRunner accounts={accounts} selectedCustomerId={selectedCustomerId} label={label} />;
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

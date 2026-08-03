import { History, Link2, ShieldCheck, Zap } from 'lucide-react';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { createServerClient } from '@/lib/supabase/server';
import { formatCurrency, formatNumberAr, timeAgoAr } from '@/lib/utils';
import { recommendationStatusLabel, severityLabel } from '@/lib/ui/labels';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { PageHeader } from '@/lib/ui/page-header';
import { MetricCard } from '@/lib/ui/metric-card';
import { EmptyState } from '@/lib/ui/empty-state';
import { StatusBadge, severityTone, recommendationStatusTone } from '@/lib/ui/status-badge';
import { buttonClasses } from '@/lib/ui/button';
import { getSubscriptionAccess, featureAccessMessage } from '@/lib/billing/entitlements';
import { SubscriptionGate } from '@/lib/ui/subscription-gate';
import { Alert } from '@/lib/ui/alert';

export const metadata = {
  title: 'مركز الموافقات',
};

export default async function OptimizerPage({ searchParams }: { searchParams?: Promise<{ error?: string; executed?: string; approved?: string; reverted?: string; updated?: string }> }) {
  const params = await searchParams;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { accounts, selectedAccount } = await getAccountWorkspace(supabase);
  const subscription = await getSubscriptionAccess(supabase, user?.id);
  const { data: recommendations } = selectedAccount
    ? await supabase
        .from('recommendations')
        // action_payload is selected so the approval card can state EXACTLY
        // what will change. Without it the user was approving an LLM-written
        // sentence while a completely different object drove the mutation.
        .select('id, title, description, severity, status, expected_impact, action_payload, created_at')
        .eq('account_id', selectedAccount.id)
        .order('created_at', { ascending: false })
        .limit(20)
    : { data: [] };
  const { data: actions } = selectedAccount
    ? await supabase
        .from('ai_actions')
        .select('id, action_type, description_ar, expected_impact, observed_impact, result, rollback_payload, rollback_status, reverted_at, created_at')
        .eq('account_id', selectedAccount.id)
        .order('created_at', { ascending: false })
        .limit(20)
    : { data: [] };
  const recs = recommendations ?? [];
  const pending = recs.filter((item: any) => item.status === 'pending');
  const approved = recs.filter((item: any) => item.status === 'approved');
  const accountName = selectedAccount ? googleAdsAccountDisplayName(selectedAccount) : 'الحساب المختار';

  return (
    <>
      <PageHeader
        icon={Zap}
        title="مركز الموافقات"
        description="راجع التوصيات واعتمد ما تريد تنفيذه — لا تعديل قبل موافقتك."
        account={selectedAccount ? { name: accountName, customerId: selectedAccount.customer_id } : null}
      />
      <div className="p-4 sm:p-6 lg:p-8">
        {accounts.length === 0 ? (
          <EmptyState
            icon={Link2}
            title="اربط حساب إعلانات Google أولاً"
            description="بعد الربط يظهر مركز الموافقات لكل توصية على الحساب المختار."
            action={
              <a href="/onboarding/connect" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                ربط حساب
              </a>
            }
          />
        ) : (
          <div className="space-y-6">
            {!subscription.active && <SubscriptionGate compact description="يمكنك مراجعة التوصيات الآن، لكن تنفيذ أي تعديل على إعلانات Google يحتاج تجربة أو اشتراكاً نشطاً." />}
            {params?.error && (
              <Alert tone="danger">{optimizerErrorMessage(params.error)}</Alert>
            )}
            {params?.approved && (
              <Alert tone="success">
                تم اعتماد التوصية. راجع تفاصيل التعديل ثم اضغط «تنفيذ» لتطبيقه على Google Ads.
              </Alert>
            )}
            {params?.updated && <Alert tone="success">تم تحديث حالة التوصية.</Alert>}
            {params?.executed && <Alert tone="success">تم التحقق من العملية وتنفيذها وتسجيل نتيجتها.</Alert>}
            {params?.reverted && <Alert tone="success">تم التحقق من التراجع وإعادة الحالة السابقة في Google Ads.</Alert>}
            <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
              <MetricCard label="بانتظار الموافقة" value={formatNumberAr(pending.length)} tone={pending.length ? 'brand' : 'default'} />
              <MetricCard label="معتمدة للتنفيذ" value={formatNumberAr(approved.length)} />
              <MetricCard label="إجراءات مسجّلة" value={formatNumberAr((actions ?? []).length)} />
            </section>

            <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
              <section className="surface-card overflow-hidden">
                <div className="border-b border-border px-5 py-4">
                  <div className="text-[14px] font-semibold">التوصيات</div>
                  <p className="mt-1 text-xs leading-6 text-muted-foreground">
                    أي تعديل على إعلانات Google يبدأ هنا ولا يُنفّذ مباشرة بدون موافقة واضحة.
                  </p>
                </div>
                {recs.length === 0 ? (
                  <EmptyState
                    bare
                    icon={ShieldCheck}
                    title="لا توجد توصيات بعد"
                    description="التوصيات تُولَّد من فحص الحساب. شغّل الفحص مرة واحدة وسيمتلئ هذا المركز بقرارات جاهزة للاعتماد."
                    action={
                      <a href="/audit" className={buttonClasses({ variant: 'primary' })}>
                        تشغيل فحص الحساب
                      </a>
                    }
                  />
                ) : (
                  <div className="divide-y divide-border">
                    {recs.map((item: any) => (
                      <div key={item.id} className="p-5">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="font-semibold text-foreground">{item.title}</div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <StatusBadge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</StatusBadge>
                              <StatusBadge tone={recommendationStatusTone(item.status)}>
                                {recommendationStatusLabel(item.status)}
                              </StatusBadge>
                              {item.expected_impact?.delta_sar_per_month ? (
                                <span className="rounded-md bg-emerald-50 dark:bg-emerald-500/15 px-2 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                                  {formatCurrency(item.expected_impact.delta_sar_per_month, selectedAccount?.currency_code)}/شهر
                                </span>
                              ) : null}
                            </div>
                          </div>
                          {isCampaignOpportunity(item) ? (
                            // Growth opportunity: its CTA is the BUILDER, not a
                            // Google Ads mutation — the draft still goes through
                            // normal review inside the assistant.
                            ['pending', 'approved'].includes(item.status) && (
                              <div className="flex flex-shrink-0 gap-2">
                                <a
                                  href={`/assistant?brief=${encodeURIComponent(String(item.action_payload?.brief_ar ?? ''))}`}
                                  className={buttonClasses({ variant: 'primary', size: 'sm' })}
                                >
                                  ابنِ الحملة في المساعد
                                </a>
                                <RecommendationAction id={item.id} intent="dismiss" label="تجاهل" secondary />
                              </div>
                            )
                          ) : (
                            <>
                              {item.status === 'pending' && (
                                <div className="flex flex-shrink-0 gap-2">
                                  <RecommendationAction id={item.id} intent="approve" label="اعتماد" />
                                  <RecommendationAction id={item.id} intent="dismiss" label="تجاهل" secondary />
                                </div>
                              )}
                              {item.status === 'approved' && (
                                <div className="flex flex-shrink-0 gap-2">
                                  {subscription.active ? (
                                    <RecommendationAction id={item.id} intent="execute" label="تنفيذ" />
                                  ) : (
                                    <a href="/billing" className={buttonClasses({ variant: 'primary', size: 'sm' })}>تفعيل التنفيذ</a>
                                  )}
                                  <RecommendationAction id={item.id} intent="dismiss" label="إلغاء" secondary />
                                </div>
                              )}
                            </>
                          )}
                        </div>
                        {item.description && <p className="mt-2 text-sm leading-7 text-muted-foreground">{item.description}</p>}
                        <ChangePreview
                          payload={item.action_payload}
                          currencyCode={selectedAccount?.currency_code}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="surface-card overflow-hidden">
                <div className="border-b border-border px-5 py-4">
                  <div className="text-[14px] font-semibold">سجل التنفيذ</div>
                  <p className="mt-1 text-xs leading-6 text-muted-foreground">أثر واضح لكل قرار اعتمدته أو نفّذته المنصة لاحقاً.</p>
                </div>
                {(actions ?? []).length === 0 ? (
                  <EmptyState
                    bare
                    tone="neutral"
                    icon={History}
                    title="لا توجد إجراءات منفذة بعد"
                    description="كل تعديل تعتمده ثم تنفّذه يُسجَّل هنا مع تأثيره المتوقع وإمكانية التراجع خلال 30 يوماً."
                  />
                ) : (
                  <div className="divide-y divide-border">
                    {(actions ?? []).map((action: any) => (
                      <div key={action.id} className="p-5">
                        <div className="font-semibold text-foreground">{action.description_ar}</div>
                        <div className="mt-2 text-xs text-muted-foreground">
                          {actionTypeLabel(action.action_type)} · {timeAgoAr(action.created_at)}
                        </div>
                        {action.expected_impact?.delta_sar_per_month ? (
                          <div className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                            تأثير متوقع: {formatCurrency(action.expected_impact.delta_sar_per_month, selectedAccount?.currency_code)}/شهر
                          </div>
                        ) : null}
                        <ObservedImpact
                          impact={action.observed_impact}
                          actionType={action.action_type}
                          currencyCode={selectedAccount?.currency_code}
                        />
                        {canRollback(action) ? (
                          <form action="/api/actions/rollback" method="post" className="mt-3">
                            <input type="hidden" name="action_id" value={action.id} />
                            <input type="hidden" name="next" value="/optimizer" />
                            <PendingSubmitButton
                              pendingLabel="جاري التحقق والتراجع..."
                              className={buttonClasses({ variant: 'outline', size: 'sm' })}
                            >
                              التراجع عن التنفيذ
                            </PendingSubmitButton>
                          </form>
                        ) : action.reverted_at ? (
                          <div className="mt-3 text-xs font-medium text-muted-foreground">تم التراجع عن هذا الإجراء.</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function optimizerErrorMessage(code: string) {
  if (['subscription_required', 'quota_exceeded', 'usage_storage_unavailable'].includes(code)) {
    return featureAccessMessage(code);
  }
  const messages: Record<string, string> = {
    approve_before_execution: 'اعتمد التوصية أولاً قبل تنفيذها.',
    blocked_by_guardrails: 'أوقفت ضوابط الأمان هذه العملية قبل وصولها إلى إعلانات Google.',
    manual_review_required: 'هذه التوصية وصفية وتحتاج مراجعة يدوية، لذلك لم ننفذها تلقائياً.',
    execution_failed: 'اجتازت العملية المراجعة الأولية لكن تعذر تنفيذها في Google Ads. لم نعتبرها مطبقة.',
    execution_recording_failed: 'تم إرسال التعديل إلى Google Ads لكن تعذر تأكيد حفظ السجل. أوقفنا إعادة التنفيذ وأبلغنا فريق التشغيل للمطابقة اليدوية.',
    execution_unverified: 'انتهت مهلة إرسال التعديل وقد يكون طُبق فعلاً في Google Ads. أوقفنا إعادة التنفيذ وأبلغنا فريق التشغيل — راجع سجل التغييرات في Google Ads قبل أي محاولة جديدة.',
    already_executing: 'هذه التوصية قيد التنفيذ أو نُفذت بالفعل. حدّث الصفحة لرؤية حالتها الحالية.',
    recommendation_locked: 'لا يمكن تغيير هذه التوصية أثناء التنفيذ أو بعد تطبيقها.',
    invalid_rollback: 'طلب التراجع غير صالح.',
    action_not_found: 'لم نجد الإجراء المطلوب أو لا تملك صلاحية الوصول إليه.',
    rollback_unavailable: 'التراجع غير متاح لهذا الإجراء أو انتهت مهلة الثلاثين يوماً.',
    rollback_failed: 'تعذر تنفيذ التراجع في Google Ads. بقي سجل الإجراء محفوظاً للمراجعة.',
    rollback_recording_failed: 'تم إرسال التراجع إلى Google Ads لكن تعذر تأكيد حفظ السجل. أوقفنا تكراره وأبلغنا فريق التشغيل للمطابقة اليدوية.',
  };
  return messages[code] ?? 'تعذر إكمال العملية. لم يتم تنفيذ تعديل غير مؤكد على حسابك.';
}

function canRollback(action: any) {
  if (!action.rollback_payload?.reversible || action.reverted_at || action.rollback_status === 'executing') return false;
  return Date.now() - new Date(action.created_at).getTime() <= 30 * 24 * 60 * 60 * 1000;
}

function RecommendationAction({
  id,
  intent,
  label,
  secondary,
}: {
  id: string;
  intent: 'approve' | 'dismiss' | 'execute';
  label: string;
  secondary?: boolean;
}) {
  return (
    <form action="/api/recommendations/action" method="post">
      <input type="hidden" name="recommendation_id" value={id} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="next" value="/optimizer" />
      <PendingSubmitButton
        pendingLabel={intent === 'execute' ? 'جاري التنفيذ...' : intent === 'approve' ? 'جاري الموافقة...' : 'جاري التجاهل...'}
        className={buttonClasses({ variant: secondary ? 'outline' : 'primary', size: 'sm' })}
      >
        {label}
      </PendingSubmitButton>
    </form>
  );
}

/**
 * Machine-generated statement of what a recommendation will actually change.
 *
 * The approval card previously showed only `title` and `description` — free
 * text written by the model — while `action_payload` (the object that really
 * drives the mutation) was neither selected nor rendered. A benign-sounding
 * Arabic sentence could therefore sit above a −29% cut to the account's top
 * revenue campaign, and every guardrail would still pass. This block is
 * derived from the payload itself, so it cannot disagree with what runs.
 */
function ChangePreview({
  payload,
  currencyCode,
}: {
  payload: any;
  currencyCode?: string | null;
}) {
  if (!payload || typeof payload !== 'object') return null;

  const operation = String(payload.operation ?? '');
  const params = payload.params ?? {};
  const rows: Array<{ label: string; value: string; ltr?: boolean }> = [];

  const operationLabels: Record<string, string> = {
    adjust_budget: 'تعديل ميزانية حملة',
    adjust_bid: 'تعديل هدف المزايدة لمجموعة إعلانية',
    pause_keyword: 'إيقاف كلمة مفتاحية',
    pause_ad: 'إيقاف إعلان',
    add_negative_keyword: 'إضافة كلمة سلبية',
    add_keyword: 'إضافة كلمة رابحة من عبارات البحث',
    build_campaign_opportunity: 'اقتراح حملة جديدة (تُبنى في المساعد)',
    manual_campaign_draft: 'مسودة حملة جديدة (تحتاج مراجعة يدوية)',
  };

  if (operation === 'build_campaign_opportunity') {
    const terms: any[] = Array.isArray(payload.terms) ? payload.terms : [];
    for (const term of terms.slice(0, 5)) {
      rows.push({
        label: `«${term.term}»`,
        value: `${formatNumberAr(term.conversions ?? 0)} تحويل · ${formatCurrency(term.cost ?? 0, currencyCode)}`,
      });
    }
    if (payload.totals?.conversions) {
      rows.push({
        label: 'الإجمالي (30 يوم)',
        value: `${formatNumberAr(payload.totals.conversions)} تحويل · ${formatCurrency(payload.totals.cost ?? 0, currencyCode)}`,
      });
    }
  } else if (operation === 'add_keyword') {
    if (params.keyword_text) rows.push({ label: 'الكلمة الجديدة', value: String(params.keyword_text) });
    if (params.match_type) rows.push({ label: 'نوع المطابقة', value: String(params.match_type), ltr: true });
    if (params.ad_group_resource) {
      rows.push({ label: 'المجموعة الإعلانية', value: String(params.ad_group_resource), ltr: true });
    }
  } else if (operation === 'adjust_budget') {
    const next = Number(params.new_amount_micros ?? 0) / 1_000_000;
    const current = Number(params.current_amount_micros ?? 0) / 1_000_000;
    const deltaPct = Number(params.delta_pct ?? NaN);
    if (current > 0) rows.push({ label: 'الميزانية اليومية الحالية', value: formatCurrency(current, currencyCode) });
    if (next > 0) rows.push({ label: 'الميزانية اليومية الجديدة', value: formatCurrency(next, currencyCode) });
    // Delta-only payloads (queued before the absolute amount is known) must
    // still show a number — an approval card for a budget change with no
    // amount on it defeats the whole point of this block.
    if (!(next > 0) && Number.isFinite(deltaPct) && deltaPct !== 0) {
      rows.push({
        label: 'نسبة التغيير',
        value: `${deltaPct > 0 ? '+' : ''}${formatNumberAr(Number(deltaPct.toFixed(1)))}% من الميزانية الحالية (يُحسب المبلغ من القيمة الحية عند التنفيذ)`,
      });
    }
    if (params.budget_resource) {
      rows.push({ label: 'المورد المستهدف', value: String(params.budget_resource), ltr: true });
    }
  } else if (operation === 'adjust_bid') {
    if (params.target_cpa_micros !== undefined) {
      rows.push({
        label: 'تكلفة الاكتساب المستهدفة الجديدة',
        value: formatCurrency(Number(params.target_cpa_micros) / 1_000_000, currencyCode),
      });
    }
    if (params.target_roas !== undefined) {
      rows.push({ label: 'العائد المستهدف الجديد', value: String(params.target_roas), ltr: true });
    }
    if (params.ad_group_resource) {
      rows.push({ label: 'المجموعة الإعلانية', value: String(params.ad_group_resource), ltr: true });
    }
  } else if (operation === 'add_negative_keyword') {
    if (params.keyword_text) rows.push({ label: 'الكلمة السلبية', value: String(params.keyword_text) });
    if (params.match_type) rows.push({ label: 'نوع المطابقة', value: String(params.match_type), ltr: true });
  } else if (payload.target_id) {
    rows.push({ label: 'المورد المستهدف', value: String(payload.target_id), ltr: true });
  }

  if (!operation && rows.length === 0) return null;

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/50 p-3">
      <div className="text-xs font-semibold text-foreground">التعديل الفعلي عند التنفيذ</div>
      <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium">نوع العملية:</dt>
          <dd>{operationLabels[operation] ?? operation ?? 'غير محدد'}</dd>
        </div>
        {rows.map((row) => (
          <div key={row.label} className="flex flex-wrap gap-x-2">
            <dt className="font-medium">{row.label}:</dt>
            <dd className={row.ltr ? 'break-all' : undefined} dir={row.ltr ? 'ltr' : undefined}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        نتحقق من العملية على Google Ads (validateOnly) قبل تطبيقها فعلياً، ونسجّل نسخة للتراجع.
      </p>
    </div>
  );
}

function isCampaignOpportunity(item: any) {
  return String(item?.action_payload?.operation ?? '') === 'build_campaign_opportunity';
}

/**
 * The learning loop's payoff: what ACTUALLY happened in the 7 days after the
 * change, measured against the 7 days before it. Turns the log from "we
 * predicted X" into "this decision did X" — the sentence that builds trust.
 */
function ObservedImpact({
  impact,
  actionType,
  currencyCode,
}: {
  impact: any;
  actionType: string;
  currencyCode?: string | null;
}) {
  if (!impact || impact.status === 'unmeasurable' || !impact.after) return null;
  const before = impact.before ?? { cost: 0, conversions: 0 };
  const after = impact.after;
  const delta = impact.delta ?? {};

  const parts: string[] = [];
  if (actionType === 'pause_keyword' || actionType === 'pause_ad') {
    // Pauses are savings stories: the spend the entity used to burn weekly.
    if (before.cost > 0) {
      parts.push(`وفّرنا ~${formatCurrency(before.cost, currencyCode)} أسبوعياً كانت تُصرف بدون نتيجة`);
    }
  } else if (actionType === 'add_keyword') {
    // Promotions are growth stories: what the new keyword brought in.
    parts.push(`الكلمة الجديدة جابت ${formatNumberAr(after.clicks ?? 0)} نقرة و${formatNumberAr(after.conversions ?? 0)} تحويل في أسبوعها الأول`);
  } else {
    if (typeof delta.conversions === 'number' && delta.conversions !== 0) {
      parts.push(`${delta.conversions > 0 ? '+' : ''}${formatNumberAr(delta.conversions)} تحويل/أسبوع`);
    }
    if (typeof delta.cost === 'number' && delta.cost !== 0) {
      parts.push(`${delta.cost > 0 ? '+' : '−'}${formatCurrency(Math.abs(delta.cost), currencyCode)} إنفاق/أسبوع`);
    }
    if (parts.length === 0) parts.push('الأداء مستقر بعد التعديل');
  }
  if (parts.length === 0) return null;

  return (
    <div className="mt-2 inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-primary/[0.08] px-2.5 py-1.5 text-xs font-medium text-primary ring-1 ring-inset ring-primary/20">
      <span className="font-semibold">النتيجة المقاسة بعد التنفيذ:</span>
      <span className="text-foreground-subtle">{parts.join(' · ')}</span>
    </div>
  );
}

/** Raw enum values like PAUSE_KEYWORD were rendered verbatim in the Arabic log. */
function actionTypeLabel(value?: string | null) {
  if (!value) return 'إجراء';
  const labels: Record<string, string> = {
    adjust_budget: 'تعديل ميزانية',
    adjust_bid: 'تعديل مزايدة',
    pause_keyword: 'إيقاف كلمة مفتاحية',
    pause_ad: 'إيقاف إعلان',
    add_negative_keyword: 'إضافة كلمة سلبية',
    add_keyword: 'إضافة كلمة رابحة',
    approval_queued: 'اعتماد توصية',
    execution_blocked: 'محجوب — يحتاج مراجعة',
    blocked_by_guardrails: 'محجوب بحواجز الأمان',
    preflight_failed: 'فشل التحقق قبل التنفيذ',
    resource_account_mismatch: 'محجوب — مورد خارج الحساب',
    record_failed: 'نُفّذ ولم يُسجّل',
  };
  return labels[value] ?? value;
}

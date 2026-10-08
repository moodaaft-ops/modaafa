import { ChevronDown, History, Link2, ShieldCheck, Zap } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { formatCurrency, formatNumberAr, timeAgoAr } from '@/lib/utils';
import { severityLabel } from '@/lib/ui/labels';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { PageHeader } from '@/lib/ui/page-header';
import { MetricCard } from '@/lib/ui/metric-card';
import { EmptyState } from '@/lib/ui/empty-state';
import { StatusBadge, severityTone } from '@/lib/ui/status-badge';
import { buttonClasses } from '@/lib/ui/button';
import { getSubscriptionAccess, featureAccessMessage } from '@/lib/billing/entitlements';
import { SubscriptionGate } from '@/lib/ui/subscription-gate';
import { Alert } from '@/lib/ui/alert';
import { actionHistoryLabel, actionHistoryState, actionHistoryTone } from '@/lib/guidance/action-history';
import {
  approvalKind,
  buildCampaignNameIndex,
  buildChangePreview,
  canRollback,
  clicksPhrase,
  conversionsPhrase,
  executionConfirmationLines,
  expectedImpact,
  groupRecommendations,
  recommendationAttention,
  riskOf,
  rollbackAttention,
  rollbackDeadlineLabel,
  undoPolicy,
  type ApprovalKind,
  type Attention,
  type CampaignNameIndex,
  type ChangePreview,
} from '@/lib/guidance/approval-card';
import { ConfirmSubmit } from './confirm-submit';

export const metadata = {
  title: 'الموافقات',
};

type Rec = {
  id: string;
  title: string;
  description: string | null;
  severity: string | null;
  status: string | null;
  expected_impact: any;
  action_payload: any;
  applied_result: any;
  execution_started_at: string | null;
  created_at: string;
};

type CardContext = {
  campaigns: CampaignNameIndex;
  currencyCode?: string | null;
  executionEnabled: boolean;
};

export default async function OptimizerPage({ searchParams }: { searchParams?: Promise<{ error?: string; executed?: string; approved?: string; reverted?: string; updated?: string }> }) {
  const params = await searchParams;
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login');
  const [{ accounts, selectedAccount }, subscription] = await Promise.all([
    getAccountWorkspace(user.id),
    getSubscriptionAccess(supabase, user.id, user.email),
  ]);
  const [recommendationsResult, actionsResult, campaignsResult] = await Promise.all([
    selectedAccount
      ? supabase
          .from('recommendations')
          // action_payload is selected so the approval card can state EXACTLY
          // what will change. Without it the user was approving an LLM-written
          // sentence while a completely different object drove the mutation.
          .select('id, title, description, severity, status, expected_impact, action_payload, applied_result, execution_started_at, created_at')
          .eq('account_id', selectedAccount.id)
          .order('created_at', { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [], error: null }),
    selectedAccount
      ? supabase
          .from('ai_actions')
          .select('id, action_type, description_ar, expected_impact, observed_impact, result, rollback_payload, rollback_status, rollback_started_at, reverted_at, created_at')
          .eq('account_id', selectedAccount.id)
          .order('created_at', { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [], error: null }),
    // Read-only lookup so cards name campaigns instead of showing Google IDs.
    selectedAccount
      ? supabase.from('campaigns_cache').select('google_campaign_id, name').eq('account_id', selectedAccount.id).limit(500)
      : Promise.resolve({ data: [], error: null }),
  ]);
  assertSupabaseRead(recommendationsResult.error, 'load optimizer recommendations');
  assertSupabaseRead(actionsResult.error, 'load optimizer actions');
  // A missing name index only degrades a card to "الاسم غير متوفر".
  const campaigns = buildCampaignNameIndex(campaignsResult.error ? [] : ((campaignsResult.data ?? []) as any[]));
  const recs = (recommendationsResult.data ?? []) as Rec[];
  const actions = (actionsResult.data ?? []) as any[];
  const groups = groupRecommendations(recs);
  const now = Date.now();
  const rollbackIssues = actions
    .map((action) => ({ action, attention: rollbackAttention(action, now) }))
    .filter((item): item is { action: any; attention: Attention } => item.attention !== null);
  const accountName = selectedAccount ? googleAdsAccountDisplayName(selectedAccount) : 'الحساب المختار';
  const ctx: CardContext = {
    campaigns,
    currencyCode: selectedAccount?.currency_code,
    executionEnabled: subscription.active,
  };
  const attentionCount = groups.attention.length + rollbackIssues.length;

  return (
    <>
      <PageHeader
        icon={Zap}
        title="الموافقات"
        description="راجع كل توصية قبل أن تعتمدها. لا يتغير شيء في حسابك قبل موافقتك وتأكيدك."
        account={selectedAccount ? { name: accountName, customerId: selectedAccount.customer_id } : null}
      />
      <div className="p-4 sm:p-6 lg:p-8">
        {accounts.length === 0 ? (
          <EmptyState
            icon={Link2}
            title="اربط Google Ads أولاً"
            description="بعد الربط تظهر هنا توصيات الحساب المختار للاعتماد."
            action={
              <a href="/onboarding/connect" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                ربط Google Ads
              </a>
            }
          />
        ) : (
          <div className="mx-auto max-w-4xl space-y-6">
            {!subscription.active && <SubscriptionGate compact description="يمكنك مراجعة التوصيات الآن، لكن تنفيذ أي تعديل على إعلانات Google يحتاج تجربة أو اشتراكاً نشطاً." />}
            {params?.error && (
              <Alert tone="danger">{optimizerErrorMessage(params.error)}</Alert>
            )}
            {params?.approved && (
              <Alert tone="success">
                تم اعتماد التوصية. راجعها في قسم «معتمدة» ثم اضغط «تنفيذ» لتطبيقها على Google Ads.
              </Alert>
            )}
            {params?.updated && <Alert tone="success">تم تحديث حالة التوصية.</Alert>}
            {params?.executed && <Alert tone="success">تم التحقق من التعديل وتنفيذه وتسجيل نتيجته.</Alert>}
            {params?.reverted && <Alert tone="success">تم التحقق من التراجع وإعادة الحالة السابقة في Google Ads.</Alert>}

            {attentionCount > 0 && (
              // Persistent: stays on the page until the row leaves the stuck or
              // failed state, not only right after a redirect.
              <section aria-labelledby="attention-heading" className="border border-danger/40 bg-card">
                <div className="flex items-center gap-2 border-b border-danger/30 px-5 py-3">
                  <span className="status-square bg-danger" aria-hidden />
                  <h2 id="attention-heading" className="text-[14px] font-semibold text-foreground">تحتاج انتباهك</h2>
                  <span className="font-mono text-xs text-muted-foreground">{formatNumberAr(attentionCount)}</span>
                </div>
                <div className="divide-y divide-border">
                  {groups.attention.map((rec) => (
                    <RecommendationCard key={rec.id} rec={rec} ctx={ctx} attention={recommendationAttention(rec, now)} />
                  ))}
                  {rollbackIssues.map(({ action, attention }) => (
                    <div key={action.id} className="p-5">
                      <div className="font-semibold text-foreground">{action.description_ar}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {actionTypeLabel(action.action_type)} · {timeAgoAr(action.created_at)}
                      </div>
                      <AttentionBanner attention={attention} />
                      {canRollback(action, now) && <RollbackControl action={action} />}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
              <MetricCard label="بانتظار قرارك" value={formatNumberAr(groups.pending.length)} tone={groups.pending.length ? 'brand' : 'default'} />
              <MetricCard label="معتمدة للتنفيذ" value={formatNumberAr(groups.approved.length)} />
              <MetricCard label="تحتاج انتباهك" value={formatNumberAr(attentionCount)} tone={attentionCount ? 'danger' : 'default'} />
            </section>

            {recs.length === 0 ? (
              <section className="surface-card overflow-hidden">
                <EmptyState
                  bare
                  icon={ShieldCheck}
                  title="لا توجد توصيات بعد"
                  description="التوصيات تأتي من فحص الحساب. شغّل الفحص مرة واحدة لتظهر هنا قرارات جاهزة للاعتماد."
                  action={
                    <a href="/audit" className={buttonClasses({ variant: 'primary' })}>
                      تشغيل فحص الحساب
                    </a>
                  }
                />
              </section>
            ) : (
              <>
                <RecommendationList
                  id="pending"
                  title="بانتظار قرارك"
                  note="اقرأ كل توصية من الأعلى إلى الأسفل ثم اعتمدها أو تجاهلها."
                  empty="لا توجد توصيات بانتظار قرارك."
                  items={groups.pending}
                  ctx={ctx}
                />
                <RecommendationList
                  id="approved"
                  title="معتمدة"
                  note="لا يُرسل أي تعديل إلى Google Ads قبل أن تؤكد التنفيذ."
                  empty="لا توجد توصيات معتمدة تنتظر التنفيذ."
                  items={groups.approved}
                  ctx={ctx}
                />
              </>
            )}

            <details className="group surface-card overflow-hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-2">
                  <History className="h-4 w-4 text-muted-foreground" aria-hidden />
                  <span className="text-[14px] font-semibold">السجل</span>
                  <span className="font-mono text-xs text-muted-foreground">{formatNumberAr(actions.length + groups.dismissed.length)}</span>
                </span>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="border-t border-border">
                {actions.length === 0 && groups.dismissed.length === 0 ? (
                  <EmptyState
                    bare
                    tone="neutral"
                    icon={History}
                    title="لا توجد إجراءات مسجلة بعد"
                    description="كل اعتماد وتنفيذ وتراجع يُسجَّل هنا مع حالته."
                  />
                ) : (
                  <div className="divide-y divide-border">
                    {actions.map((action) => (
                      <HistoryRow key={action.id} action={action} currencyCode={ctx.currencyCode} now={now} />
                    ))}
                    {groups.dismissed.map((rec) => (
                      <div key={rec.id} className="p-5">
                        <div className="font-semibold text-foreground">{rec.title}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <StatusBadge tone="neutral">تم تجاهلها</StatusBadge>
                          <span>{timeAgoAr(rec.created_at)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </div>
        )}
      </div>
    </>
  );
}

function RecommendationList({
  id,
  title,
  note,
  empty,
  items,
  ctx,
}: {
  id: string;
  title: string;
  note: string;
  empty: string;
  items: Rec[];
  ctx: CardContext;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="surface-card overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <h2 id={`${id}-heading`} className="text-[14px] font-semibold">{title}</h2>
          <span className="font-mono text-xs text-muted-foreground">{formatNumberAr(items.length)}</span>
        </div>
        <p className="mt-1 text-xs leading-6 text-muted-foreground">{note}</p>
      </div>
      {items.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="divide-y divide-border">
          {items.map((rec) => (
            <RecommendationCard key={rec.id} rec={rec} ctx={ctx} attention={null} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One recommendation, read top to bottom: the problem, exactly what changes,
 * the expected impact, the risk, whether it can be undone, then the buttons.
 * Buttons are always last so on a phone the preview is read before any action.
 */
function RecommendationCard({ rec, ctx, attention }: { rec: Rec; ctx: CardContext; attention: Attention | null }) {
  const kind = approvalKind(rec);
  const preview = buildChangePreview(rec.action_payload, { campaigns: ctx.campaigns, currencyCode: ctx.currencyCode });
  const impact = expectedImpact(rec);
  const risk = riskOf(rec.action_payload, kind);

  return (
    <article className="p-5">
      <div className="flex flex-wrap items-center gap-2">
        {rec.severity && <StatusBadge tone={severityTone(rec.severity)}>{severityLabel(rec.severity)}</StatusBadge>}
        <span className="text-xs text-muted-foreground">{kindLabel(kind)}</span>
      </div>
      <h3 className="mt-2 font-semibold leading-7 text-foreground">{rec.title}</h3>
      {rec.description && <p className="mt-1 text-sm leading-7 text-muted-foreground">{rec.description}</p>}

      {preview && <ChangePreviewBlock preview={preview} kind={kind} />}

      <dl className="mt-3 grid gap-px border border-border bg-border text-xs sm:grid-cols-3">
        <Fact label={impact?.label ?? 'الأثر المتوقع شهرياً'}>
          {impact ? (
            <span className="font-mono text-sm font-semibold text-foreground">{formatCurrency(impact.amount, ctx.currencyCode)}</span>
          ) : (
            <span className="text-muted-foreground">لا يوجد تقدير بالريال لهذه التوصية</span>
          )}
        </Fact>
        <Fact label="مستوى المخاطرة">
          {risk ? (
            <>
              <span className="flex items-center gap-1.5 font-semibold text-foreground">
                <span
                  className={`status-square ${risk.level === 'high' ? 'bg-danger' : risk.level === 'medium' ? 'bg-signal' : 'bg-muted-foreground'}`}
                  aria-hidden
                />
                {risk.label}
              </span>
              <span className="mt-0.5 block leading-5 text-muted-foreground">{risk.reason}</span>
            </>
          ) : (
            <span className="text-muted-foreground">لا تنفيذ تلقائي</span>
          )}
        </Fact>
        <Fact label="التراجع">
          <span className="leading-5 text-foreground">{undoPolicy(kind)}</span>
        </Fact>
      </dl>

      {attention && <AttentionBanner attention={attention} />}

      <CardActions rec={rec} kind={kind} preview={preview} ctx={ctx} />
    </article>
  );
}

function kindLabel(kind: ApprovalKind) {
  if (kind === 'executable') return 'تعديل على Google Ads';
  if (kind === 'campaign_opportunity') return 'فرصة حملة جديدة';
  if (kind === 'campaign_draft') return 'مسودة من المساعد';
  return 'مراجعة يدوية';
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-card p-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

/**
 * Machine-generated statement of what a recommendation will actually change.
 *
 * Derived from `action_payload`, the object that really drives the mutation,
 * so it cannot disagree with what runs. Raw Google resource names stay in a
 * collapsed detail for support; the card itself shows names.
 */
function ChangePreviewBlock({ preview, kind }: { preview: ChangePreview; kind: ApprovalKind }) {
  return (
    <div className="mt-3 border border-border bg-muted/50 p-3">
      <div className="text-xs font-semibold text-muted-foreground">
        {kind === 'executable' ? 'ما سيتغير في Google Ads' : 'التفاصيل'}
        <span className="font-normal"> · {preview.operationLabel}</span>
      </div>
      <p className="mt-1 text-sm font-semibold leading-7 text-foreground">{preview.summary}</p>
      {preview.rows.length > 0 && (
        <dl className="mt-2 space-y-2 text-xs">
          {preview.rows.map((row, index) => (
            <div key={`${row.label}-${index}`} className="grid gap-1 sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-foreground">
                {row.current !== undefined || row.next !== undefined ? (
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-muted-foreground">الحالية</span>
                    <span className="font-mono">{row.current}</span>
                    <span className="text-muted-foreground" aria-hidden>
                      ←
                    </span>
                    <span className="text-muted-foreground">الجديدة</span>
                    <span className="font-mono font-semibold">{row.next}</span>
                  </span>
                ) : (
                  <span>{row.value}</span>
                )}
                {row.hint && <span className="mt-0.5 block leading-5 text-muted-foreground">{row.hint}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {kind === 'executable' && (
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
          نتحقق من التعديل مع Google Ads قبل تطبيقه فعلياً ونحفظ نسخة للتراجع.
        </p>
      )}
      {preview.target.technicalIds.length > 0 && (
        <details className="mt-2 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">المعرّف في Google Ads</summary>
          <ul className="mt-1 space-y-0.5" dir="ltr">
            {preview.target.technicalIds.map((id) => (
              <li key={id} className="break-all font-mono">
                {id}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function AttentionBanner({ attention }: { attention: Attention }) {
  const danger = attention.tone === 'danger';
  return (
    <div
      role={danger ? 'alert' : 'status'}
      className={`mt-3 border p-3 text-xs leading-6 ${danger ? 'border-danger/40 bg-danger-soft' : 'border-border-strong bg-card'}`}
    >
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <span className={`status-square ${danger ? 'bg-danger' : 'bg-signal'}`} aria-hidden />
        {attention.title}
      </div>
      <p className="mt-1 text-foreground">
        <span className="font-semibold">السبب: </span>
        {attention.reason}
      </p>
      <p className="text-foreground">
        <span className="font-semibold">الخطوة التالية: </span>
        {attention.nextStep}
      </p>
    </div>
  );
}

function CardActions({ rec, kind, preview, ctx }: { rec: Rec; kind: ApprovalKind; preview: ChangePreview | null; ctx: CardContext }) {
  const status = rec.status ?? '';
  const buttons: React.ReactNode[] = [];

  if (kind === 'campaign_opportunity') {
    if (status === 'pending' || status === 'approved') {
      // Growth opportunity: its CTA is the builder, not a Google Ads mutation.
      buttons.push(
        <a
          key="build"
          href={`/assistant?brief=${encodeURIComponent(String(rec.action_payload?.brief_ar ?? ''))}`}
          className={buttonClasses({ variant: 'primary', size: 'sm' })}
        >
          ابنِ الحملة في المساعد
        </a>
      );
    }
  } else if (kind === 'campaign_draft') {
    if (status === 'pending' || status === 'approved') {
      // Assistant drafts cannot execute from here. Route them to the builder
      // instead of offering a "تنفيذ" that can only dead-end.
      const name = String(rec.action_payload?.params?.name ?? '').trim();
      const brief = name ? `أكمل مسودة الحملة «${name}» وجهّزها للإطلاق` : 'أكمل مسودة الحملة وجهّزها للإطلاق';
      buttons.push(
        <a key="draft" href={`/assistant?brief=${encodeURIComponent(brief)}`} className={buttonClasses({ variant: 'primary', size: 'sm' })}>
          افتح المسودة في المساعد
        </a>
      );
    }
  } else if (kind === 'executable') {
    // The endpoint accepts approve from pending or failed; failed rows are
    // only demoted when the mutation is known not to have applied.
    if (status === 'pending' || status === 'failed') {
      buttons.push(<RecommendationAction key="approve" id={rec.id} intent="approve" label="اعتماد" />);
    }
    if (status === 'approved') {
      buttons.push(
        ctx.executionEnabled ? (
          <ConfirmSubmit
            key="execute"
            action="/api/recommendations/action"
            fields={{ recommendation_id: rec.id, intent: 'execute', next: '/optimizer' }}
            triggerLabel="تنفيذ"
            title="تأكيد التنفيذ على Google Ads"
            lines={executionConfirmationLines(preview, rec.title)}
            confirmLabel="تأكيد التنفيذ"
            pendingLabel="جاري التنفيذ..."
          />
        ) : (
          <a key="billing" href="/billing" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
            تفعيل التنفيذ
          </a>
        )
      );
    }
  }

  if (status === 'pending' || status === 'approved' || status === 'failed') {
    buttons.push(<RecommendationAction key="dismiss" id={rec.id} intent="dismiss" label="تجاهل" secondary />);
  }

  if (buttons.length === 0) return null;
  return <div className="mt-4 flex flex-wrap items-start gap-2">{buttons}</div>;
}

function RecommendationAction({
  id,
  intent,
  label,
  secondary,
}: {
  id: string;
  intent: 'approve' | 'dismiss';
  label: string;
  secondary?: boolean;
}) {
  return (
    <form action="/api/recommendations/action" method="post">
      <input type="hidden" name="recommendation_id" value={id} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="next" value="/optimizer" />
      <PendingSubmitButton
        pendingLabel={intent === 'approve' ? 'جاري الاعتماد...' : 'جاري التجاهل...'}
        className={buttonClasses({ variant: secondary ? 'outline' : 'primary', size: 'sm' })}
      >
        {label}
      </PendingSubmitButton>
    </form>
  );
}

function RollbackControl({ action }: { action: any }) {
  return (
    <div className="mt-3">
      <ConfirmSubmit
        action="/api/actions/rollback"
        fields={{ action_id: action.id, next: '/optimizer' }}
        triggerLabel="تراجع"
        triggerVariant="outline"
        title="تأكيد التراجع على Google Ads"
        lines={[`إعادة الحالة السابقة لهذا الإجراء: ${action.description_ar}`, 'يُطبَّق الآن على حسابك في Google Ads']}
        confirmLabel="تأكيد التراجع"
        pendingLabel="جاري التحقق والتراجع..."
      />
    </div>
  );
}

function HistoryRow({ action, currencyCode, now }: { action: any; currencyCode?: string | null; now: number }) {
  const state = actionHistoryState(action);
  const impact = expectedImpact({ expected_impact: action.expected_impact, action_payload: { operation: action.action_type } });
  const rollbackOk = canRollback(action, now);
  const deadline = rollbackOk ? rollbackDeadlineLabel(action.created_at) : null;
  const attention = rollbackAttention(action, now);
  return (
    <div className="p-5">
      <div className="font-semibold text-foreground">{action.description_ar}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge tone={actionHistoryTone(state)}>{actionHistoryLabel(state)}</StatusBadge>
        <span>
          {actionTypeLabel(action.action_type)} · {timeAgoAr(action.created_at)}
        </span>
      </div>
      {impact && state !== 'failed' && state !== 'reverted' && (
        <div className="mt-2 text-xs text-muted-foreground">
          {impact.label}: <span className="font-mono font-semibold text-foreground">{formatCurrency(impact.amount, currencyCode)}</span>
        </div>
      )}
      <ObservedImpact impact={action.observed_impact} actionType={action.action_type} currencyCode={currencyCode} />
      {attention && <AttentionBanner attention={attention} />}
      {rollbackOk ? (
        <>
          {deadline && <div className="mt-2 text-xs text-muted-foreground">{deadline}</div>}
          <RollbackControl action={action} />
        </>
      ) : action.reverted_at ? (
        <div className="mt-3 text-xs font-medium text-muted-foreground">تم التراجع عن هذا الإجراء.</div>
      ) : null}
    </div>
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
    execution_unverified: 'انتهت مهلة إرسال التعديل وقد يكون طُبق فعلاً في Google Ads. أوقفنا إعادة التنفيذ وأبلغنا فريق التشغيل. راجع سجل التغييرات في Google Ads قبل أي محاولة جديدة.',
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

/**
 * The learning loop's payoff: what ACTUALLY happened in the 7 days after the
 * change, measured against the 7 days before it. Turns the log from "we
 * predicted X" into "this decision did X", the sentence that builds trust.
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
      parts.push(`وفّرنا قرابة ${formatCurrency(before.cost, currencyCode)} أسبوعياً كانت تُصرف بدون نتيجة`);
    }
  } else if (actionType === 'add_keyword') {
    // Promotions are growth stories: what the new keyword brought in.
    parts.push(
      `الكلمة الجديدة جابت ${clicksPhrase(Number(after.clicks ?? 0))} و${conversionsPhrase(Number(after.conversions ?? 0))} في أسبوعها الأول`
    );
  } else {
    if (typeof delta.conversions === 'number' && delta.conversions !== 0) {
      parts.push(`${delta.conversions > 0 ? 'زيادة' : 'نقص'} ${conversionsPhrase(Math.abs(delta.conversions))} أسبوعياً`);
    }
    if (typeof delta.cost === 'number' && delta.cost !== 0) {
      parts.push(`${delta.cost > 0 ? 'زيادة' : 'نقص'} ${formatCurrency(Math.abs(delta.cost), currencyCode)} إنفاق أسبوعياً`);
    }
    if (parts.length === 0) parts.push('الأداء مستقر بعد التعديل');
  }
  if (parts.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border border-border bg-muted/50 px-2.5 py-1.5 text-xs">
      <span className="font-semibold text-foreground">النتيجة المقاسة بعد التنفيذ:</span>
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
    execution_blocked: 'محجوب ويحتاج مراجعة',
    blocked_by_guardrails: 'محجوب بضوابط الأمان',
    preflight_failed: 'فشل التحقق قبل التنفيذ',
    resource_account_mismatch: 'محجوب لأن العنصر خارج الحساب',
    record_failed: 'نُفّذ ولم يُسجّل',
    execution_failed: 'تعذر التنفيذ',
  };
  return labels[value] ?? 'إجراء';
}

import { redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { getAccountWorkspace, normalizeCustomerId } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { getRequestAuthContext, createAdminClient } from '@/lib/supabase/server';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { hasProductAccess } from '@/lib/billing/access-gate';
import { getBillingCheckoutContext } from '@/lib/billing/checkout-policy';
import { readFreeAuditView } from '@/lib/chat-first/free-audit-view';
import { toPlanRecommendations } from '@/lib/plan/load';
import { buildPlan, paywallCtaFromCheckout } from '@/lib/plan/plan';
import { buildExecutableAction } from '@/lib/ai/executable-action';
import { readVoiceConfig } from '@/lib/ai/voice-session';
import { TikTokPixel } from '@/lib/analytics/tiktok-pixel';
import { impactLabel, monthlyImpact } from '@/lib/onboarding/first-opportunities';
import { isSimpleExperience } from '@/lib/setup/mode';
import { isAdaptiveOnboarding } from '@/lib/setup/adaptive/flag';
import { adaptiveLockedPlan } from '@/lib/setup/adaptive/locked-plan';
import { readLedgerEntries } from '@/lib/setup/load';
import { economicsKindFromLedger } from '@/lib/setup/ledger';
import { homeMissingKeys, loadEconomicsNudgeInput } from '@/lib/setup/adaptive/economics-nudge';
import { adaptiveAnswered, answeredOnRecord } from '@/lib/setup/adaptive/view';
import { loadRecentChanges } from '@/lib/home/recent-changes';
import { keysAnsweredByProfile, missingCoreKeys, type SetupKey } from '@/lib/setup/questions';
import { firstNameFrom, healthWord } from '@/lib/setup/stage';
import {
  SEVERITY_WORD,
  greetingFor,
  lockedNoticeFrom,
  noticeFrom,
  orderDecisions,
  summaryLine,
  weekNumbers,
} from '@/lib/home/briefing';
import { cn, formatCurrency, timeAgoAr } from '@/lib/utils';
import { operationLabelAr } from '@/lib/ai/operation-labels';
import { AskAssistant } from './ask-assistant';
import { ApproveInline } from './approve-inline';
import { HomeThread } from './home-thread';
import { LockedHome } from './locked-home';
import { RecentChanges } from './recent-changes';
import type { ChatQuickAction } from '@/lib/chat-first/contracts';
import { dropStalePending } from '@/lib/recommendations/staleness';

export const metadata = { title: 'الرئيسية' };

type Decision = {
  id: string;
  title: string;
  description: string | null;
  severity: string | null;
  status: string;
  created_at: string | null;
  expected_impact: any;
  executable: boolean;
  change: string | null;
};

const VISIBLE_DECISIONS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/home');
  if (!isSimpleExperience(process.env, user.email)) redirect('/dashboard');

  const { business, accounts, selectedAccount } = await getAccountWorkspace(user.id);
  if (!business || accounts.length === 0) redirect('/onboarding');
  if (!selectedAccount) redirect('/onboarding');

  let admin: any = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }

  // The adaptive onboarding's plan rules (lib/setup/adaptive/locked-plan.ts) read each decision's audit category.
  const adaptiveOn = isAdaptiveOnboarding(process.env, user.email);

  const [campaignsRes, auditRes, recsRes, actionsRes, access, ledgerEntries, recentChanges] = await Promise.all([
    supabase.from('campaigns_cache').select('status, metrics_7d').eq('account_id', selectedAccount.id).limit(500),
    supabase
      .from('audits')
      .select('health_score, estimated_monthly_waste, ran_at')
      .eq('account_id', selectedAccount.id)
      .order('ran_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('recommendations')
      .select(
        adaptiveOn
          ? 'id, title, description, severity, status, category, expected_impact, action_payload, created_at'
          : 'id, title, description, severity, status, expected_impact, action_payload, created_at'
      )
      .eq('account_id', selectedAccount.id)
      .in('status', ['pending', 'approved'])
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('ai_actions')
      .select('id, action_type, description_ar, created_at, reverted_at')
      .eq('account_id', selectedAccount.id)
      .neq('action_type', 'approval_queued')
      .order('created_at', { ascending: false })
      .limit(3),
    getSubscriptionAccess(supabase, user.id, user.email),
    readLedgerEntries(admin, business.id),
    // The undo is never gated: it renders below for someone with a plan and for someone without.
    loadRecentChanges(supabase, { accountId: selectedAccount.id, customerId: selectedAccount.customer_id }),
  ]);

  // A pending optimizer card older than 14 days is not today's decision any more (lib/recommendations/staleness.ts).
  const currentRecs: any[] = dropStalePending<any>(recsRes.error ? [] : ((recsRes.data ?? []) as any[]));
  const ledger = ledgerEntries.choices;
  const currency = (selectedAccount.currency_code ?? 'SAR').toUpperCase();
  const hasRecentChanges = recentChanges.items.length > 0;
  const recentChangesSection = hasRecentChanges ? (
    <RecentChanges
      className="pt-1"
      items={recentChanges.items.map((item) => ({ id: item.id, text: item.text, when: timeAgoAr(item.createdAt) }))}
      more={recentChanges.more}
    />
  ) : null;

  // No subscription, no live trial, no operator free plan: «خطتك جاهزة» instead
  // of the conversation. This branch renders no chat client at all, so the page
  // cannot call /api/chat/start or a voice route; those answer 402 anyway.
  if (!hasProductAccess(access)) {
    const lockedAudit = auditRes.error ? null : auditRes.data;
    const [checkout, freeAudit] = await Promise.all([
      access.suspended
        ? Promise.resolve(null)
        : getBillingCheckoutContext(supabase, user.id, user.email).catch(() => null),
      lockedAudit
        ? Promise.resolve('unknown' as const)
        : readFreeAuditView(normalizeCustomerId(selectedAccount.customer_id), admin ?? undefined),
    ]);
    const basePlan = buildPlan({
      audit: lockedAudit,
      recommendations: toPlanRecommendations(currentRecs),
      currency,
      includeCategory: adaptiveOn,
    });
    // Adaptive onboarding on: the same plan the setup screen showed (a rules decision leads, no waste number
    // for an account without tracking), not the audit rebuilt raw. Without a usable read it comes back as it was.
    const adaptiveLock = adaptiveOn
      ? await adaptiveLockedPlan({ admin, accountId: selectedAccount.id, business, plan: basePlan, currency, ledger: ledgerEntries })
      : null;
    const plan = adaptiveLock ? adaptiveLock.plan : basePlan;
    const lockedName = googleAdsAccountDisplayName(selectedAccount);
    const lockedNotice = lockedNoticeFrom(params);
    const lockedFirstName = firstNameFrom(user.user_metadata ?? null);
    return (
      <div className="h-full">
        <LockedHome
          // A new token (sidebar's «محادثة جديدة») remounts a clean page.
          key={params.new ?? 'home'}
          plan={plan}
          lead={adaptiveLock?.lead ?? null}
          firstWhy={adaptiveLock?.firstWhy ?? null}
          trialEligible={Boolean(checkout?.trialEligible)}
          cta={paywallCtaFromCheckout(checkout)}
          suspended={Boolean(access.suspended)}
          greeting={`${greetingFor()}${lockedFirstName ? ` ${lockedFirstName}` : ''}`}
          voiceEnabled={readVoiceConfig().enabled}
          auditHref={!lockedAudit && freeAudit !== 'exhausted' ? '/onboarding' : null}
          accountLine={lockedName}
          notice={
            lockedNotice ? (
              <p
                role="status"
                className={cn(
                  'rounded-[14px] px-4 py-2.5 text-[14px] font-semibold leading-7',
                  lockedNotice.tone === 'ok' ? 'bg-success-soft text-foreground' : 'bg-danger-soft text-danger'
                )}
              >
                {lockedNotice.text}
              </p>
            ) : null
          }
          recentChanges={recentChangesSection}
        />
      </div>
    );
  }

  const money = (amount: number) => formatCurrency(Math.round(amount), currency);
  const week = weekNumbers(campaignsRes.error ? [] : campaignsRes.data ?? []);
  const audit = auditRes.error ? null : auditRes.data;
  const decisions: Decision[] = orderDecisions(
    currentRecs.map((row: any) => ({
      id: row.id,
      title: row.title,
      description: row.description ?? null,
      severity: row.severity ?? null,
      status: row.status,
      created_at: row.created_at ?? null,
      expected_impact: row.expected_impact ?? null,
      executable: Boolean(buildExecutableAction(row.action_payload, row)),
      change: operationLabelAr(row.action_payload?.operation ?? null),
    }))
  );
  const actions = actionsRes.error ? [] : actionsRes.data ?? [];
  const answered = new Set<SetupKey>([...keysAnsweredByProfile(business), ...ledger.keys()]);
  // Core answers plus, by the kind of business, the economics ones the optimizer needs before it may touch a
  // budget. Only the economics keys the edit questionnaire would actually ask this account (its real scenario:
  // a new, dormant or no-account customer, or an account the read could not place, is never asked a margin),
  // and only where the adaptive onboarding exists at all: a chip that leads nowhere would nag a customer who
  // cannot answer.
  const missing = adaptiveOn
    ? homeMissingKeys({
        answeredKeys: answered,
        kind: economicsKindFromLedger(ledgerEntries, business),
        answered: adaptiveAnswered({ answered: answeredOnRecord({ business, ledger }), ledger }),
        linkedAccounts: accounts.length,
        confirmed: ledgerEntries.confirmed ?? null,
        ...(await loadEconomicsNudgeInput({ admin, supabase, account: selectedAccount, weekSpend: week.spend })),
      })
    : missingCoreKeys(answered);
  const notice = noticeFrom(params);
  const firstName = firstNameFrom(user.user_metadata ?? null);
  const accountName = googleAdsAccountDisplayName(selectedAccount);

  const openChat = params.c && UUID.test(params.c) ? params.c : null;
  const quietWeek = week.spend <= 0 && week.results <= 0;
  const lastChange = actions[0] ?? null;

  // The chips under the opening message: the next useful step for this account.
  const introActions: ChatQuickAction[] = [
    ...(quietWeek
      ? [{ label: 'ليش حملاتي واقفة؟', action: { type: 'say' as const, text: 'ليش حملاتي واقفة وما تصرف؟' } }]
      : [{ label: 'وين تروح فلوسي؟', action: { type: 'say' as const, text: 'وين تروح فلوسي في الإعلانات؟' } }]),
    ...(!audit || quietWeek
      ? [{ label: audit ? 'افحص حسابي من جديد' : 'افحص حسابي', action: { type: 'run_audit' as const, customerId: selectedAccount.customer_id } }]
      : [{ label: 'ليش الطلبات قليلة؟', action: { type: 'say' as const, text: 'ليش الطلبات قليلة؟' } }]),
    ...(missing.length > 0
      ? [{ label: 'كمّل تعريف نشاطك، كم دقيقة', action: { type: 'open_dashboard' as const, href: '/onboarding?edit=1' } }]
      : [{ label: 'وش وضع حسابي؟', action: { type: 'say' as const, text: 'وش وضع حسابي' } }]),
  ];

  const intro = (
    <div className="space-y-4">
      {notice && (
        <p
          role="status"
          className={cn(
            'rounded-[14px] px-4 py-2.5 text-[14px] font-semibold leading-7',
            notice.tone === 'ok' ? 'bg-success-soft text-foreground' : 'bg-danger-soft text-danger'
          )}
        >
          {notice.text}
        </p>
      )}
      {/* Right after applying a change the undo is the first thing under the confirmation. */}
      {params.executed && recentChangesSection}
      <p className="text-[14px] text-muted-foreground">
        {greetingFor()}
        {firstName ? ` ${firstName}` : ''}
      </p>
      <p className="text-[19px] font-semibold leading-9 sm:text-[21px]">{summaryLine({ week, decisions: decisions.length, money })}</p>

      {!quietWeek && (
        <dl className="grid grid-cols-3 overflow-hidden rounded-[18px] border border-border/80 bg-card">
          <Stat label="الصرف، 7 أيام" value={money(week.spend)} />
          <Stat label="النتائج" value={week.results.toLocaleString('en-US', { maximumFractionDigits: 1 })} />
          <Stat label="تكلفة النتيجة" value={week.costPerResult === null ? 'ما فيه' : money(week.costPerResult)} />
        </dl>
      )}

      {decisions.length > 0 && (
        <section aria-labelledby="decisions-title" className="space-y-3 pt-1">
          <h2 id="decisions-title" className="text-[15px] font-bold">
            قرارات اليوم <span className="numeric font-normal text-muted-foreground">({decisions.length})</span>
          </h2>
          <ol className="space-y-3">
            {decisions.slice(0, VISIBLE_DECISIONS).map((decision) => (
              <DecisionCard key={decision.id} decision={decision} currency={currency} />
            ))}
          </ol>
          {decisions.length > VISIBLE_DECISIONS && (
            <details className="group">
              <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-full px-3 text-[14px] font-semibold hover:bg-muted [&::-webkit-details-marker]:hidden">
                <ChevronLeft className="h-4 w-4 transition-transform group-open:-rotate-90" />
                وريني الباقي ({decisions.length - VISIBLE_DECISIONS})
              </summary>
              <ol className="mt-3 space-y-3">
                {decisions.slice(VISIBLE_DECISIONS).map((decision) => (
                  <DecisionCard key={decision.id} decision={decision} currency={currency} />
                ))}
              </ol>
            </details>
          )}
        </section>
      )}

      {!params.executed && recentChangesSection}

      <p className="text-[14.5px] leading-8 text-muted-foreground">
        {audit
          ? `صحة حسابك ${audit.health_score ?? '؟'} من 100${healthWord(audit.health_score) ? `، ${healthWord(audit.health_score)}` : ''}، وآخر فحص ${timeAgoAr(audit.ran_at)}.`
          : 'ما فحصت حسابك للحين.'}
        {/* With undoable changes listed above, the list says it; the sentence stays for changes that can no longer be undone. */}
        {lastChange && !hasRecentChanges
          ? ` آخر شي غيّرته: ${String(lastChange.description_ar ?? '').slice(0, 90)}${lastChange.reverted_at ? ' (رجّعته)' : ` (${timeAgoAr(lastChange.created_at)})`}.`
          : ''}
      </p>
      <p className="text-[12.5px] text-muted-foreground">
        {accountName}
        {selectedAccount.last_synced_at ? `، آخر تحديث ${timeAgoAr(selectedAccount.last_synced_at)}` : ''}
      </p>
    </div>
  );

  return (
    <div className="h-full">
      {params.subscribed === '1' && access.active && access.status !== 'internal' && (
        <TikTokPixel conversion={{ event: 'Subscribe', userId: user.id }} />
      )}
      <HomeThread
        // A new token (sidebar's «محادثة جديدة») or another chat remounts a clean thread.
        key={openChat ?? params.new ?? 'home'}
        customerId={selectedAccount.customer_id}
        voiceEnabled={readVoiceConfig().enabled}
        restoreSessionId={openChat}
        intro={openChat ? null : intro}
        introActions={openChat ? undefined : introActions}
        currency={currency}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-s border-border/70 px-4 py-3 first:border-s-0">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="numeric mt-0.5 text-[17px] font-bold sm:text-[19px]">{value}</dd>
    </div>
  );
}

function DecisionCard({ decision, currency }: { decision: Decision; currency: string }) {
  const impact = monthlyImpact(decision);
  const label = impactLabel(decision);
  const tone =
    decision.severity === 'critical' ? 'bg-danger' : decision.severity === 'medium' ? 'bg-signal' : 'bg-muted-foreground';
  const approved = decision.status === 'approved';
  return (
    <li className="rounded-[18px] border border-border/80 bg-card">
      <div className="px-4 pb-2 pt-4">
        <p className="flex items-center gap-2 text-[12.5px] font-semibold text-muted-foreground">
          <span className={cn('h-2 w-2 rounded-full', tone)} aria-hidden />
          {approved ? 'وافقت عليه، باقي التنفيذ' : SEVERITY_WORD[decision.severity ?? ''] ?? 'قرار'}
        </p>
        <p className="mt-1.5 text-[15.5px] font-semibold leading-7">{decision.title}</p>
        {decision.description && (
          <p className="mt-1 line-clamp-2 text-[13.5px] leading-6 text-muted-foreground">{decision.description}</p>
        )}
        {label && impact > 0 && (
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            {label}: <span className="numeric font-semibold text-foreground">{formatCurrency(impact, currency)}</span>
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-1">
        {/* This page only renders for an account with access; without it /home is the locked plan. */}
        {decision.executable ? (
          <ApproveInline
            id={decision.id}
            intent={approved ? 'execute' : 'approve_execute'}
            label={approved ? 'نفّذ الحين' : 'اعتمد'}
            change={decision.change}
          />
        ) : null}
        {!approved && (
          <DecisionForm id={decision.id} intent="dismiss">
            مو الحين
          </DecisionForm>
        )}
        <AskAssistant
          text={decision.executable ? `اشرح لي: ${decision.title}` : `كيف أسوي هذا: ${decision.title}`}
          label={decision.executable ? 'اشرح لي هذا القرار' : 'كيف أسويه؟'}
          recommendationId={decision.id}
          className="ms-auto"
        />
      </div>
    </li>
  );
}

/** Plain form posts to the guarded recommendation route; it redirects back to /home. */
function DecisionForm({
  id,
  intent,
  primary = false,
  children,
}: {
  id: string;
  intent: 'dismiss';
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <form method="post" action="/api/recommendations/action">
      <input type="hidden" name="recommendation_id" value={id} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="next" value="/home" />
      <button
        type="submit"
        className={cn(
          'inline-flex h-9 items-center rounded-full px-4 text-[13.5px] font-bold',
          primary ? 'bg-primary text-primary-foreground' : 'border border-border bg-background text-foreground hover:bg-muted'
        )}
      >
        {children}
      </button>
    </form>
  );
}

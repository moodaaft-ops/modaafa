import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Check, ChevronLeft, RotateCcw } from 'lucide-react';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { getRequestAuthContext, createAdminClient } from '@/lib/supabase/server';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { buildExecutableAction } from '@/lib/ai/executable-action';
import { readVoiceConfig } from '@/lib/ai/voice-session';
import { TikTokPixel } from '@/lib/analytics/tiktok-pixel';
import { ASSISTANT } from '@/lib/assistant/persona';
import { AssistantAvatar } from '@/lib/ui/assistant-avatar';
import { impactLabel, monthlyImpact } from '@/lib/onboarding/first-opportunities';
import { isSimpleExperience } from '@/lib/setup/mode';
import { readLedger } from '@/lib/setup/load';
import { keysAnsweredByProfile, missingCoreKeys, type SetupKey } from '@/lib/setup/questions';
import { firstNameFrom, healthWord } from '@/lib/setup/stage';
import {
  SEVERITY_WORD,
  greetingFor,
  noticeFrom,
  orderDecisions,
  summaryLine,
  weekNumbers,
} from '@/lib/home/briefing';
import { cn, formatCurrency, timeAgoAr } from '@/lib/utils';
import { operationLabelAr } from '@/lib/ai/operation-labels';
import { AskAssistant } from './ask-assistant';
import { ApproveInline } from './approve-inline';
import { HomeChat } from './home-chat';

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

  const [campaignsRes, auditRes, recsRes, actionsRes, access, ledger] = await Promise.all([
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
      .select('id, title, description, severity, status, expected_impact, action_payload, created_at')
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
    readLedger(admin, business.id),
  ]);

  const currency = (selectedAccount.currency_code ?? 'SAR').toUpperCase();
  const money = (amount: number) => formatCurrency(Math.round(amount), currency);
  const week = weekNumbers(campaignsRes.error ? [] : campaignsRes.data ?? []);
  const audit = auditRes.error ? null : auditRes.data;
  const decisions: Decision[] = orderDecisions(
    (recsRes.error ? [] : recsRes.data ?? []).map((row: any) => ({
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
  const missing = missingCoreKeys(answered);
  const notice = noticeFrom(params);
  const firstName = firstNameFrom(user.user_metadata ?? null);
  const accountName = googleAdsAccountDisplayName(selectedAccount);

  return (
    <div className="lg:grid lg:h-full lg:grid-cols-[minmax(360px,430px)_minmax(0,1fr)]">
      {params.subscribed === '1' && access.active && access.status !== 'internal' && (
        <TikTokPixel conversion={{ event: 'Subscribe', userId: user.id }} />
      )}

      {/* RTL: the chat takes the first (right) column, the day's content the left one. */}
      <div className="lg:col-start-2 lg:row-start-1 lg:h-full lg:overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-[760px] space-y-7 px-4 pb-28 pt-5 sm:px-6 lg:pb-10 lg:pt-8">
          {notice && (
            <p
              role="status"
              className={cn(
                'border px-4 py-3 text-[14px] font-semibold leading-7',
                notice.tone === 'ok' ? 'border-foreground/20 bg-card text-foreground' : 'border-danger/40 bg-danger-soft text-danger'
              )}
            >
              {notice.text}
            </p>
          )}

          {/* the assistant's read of the account: the one thing this screen leads with. */}
          <section className="bg-foreground px-5 py-6 text-background sm:px-7 sm:py-7">
            <div className="flex items-center gap-2.5">
              <AssistantAvatar size={34} className="border-background/25 bg-background text-foreground" />
              <p className="text-[13.5px] text-background/75">
                {greetingFor()}
                {firstName ? ` ${firstName}` : ''}، معك {ASSISTANT.name}
              </p>
            </div>
            <p className="mt-4 text-[20px] font-semibold leading-[1.75] sm:text-[23px]">
              {summaryLine({ week, decisions: decisions.length, money })}
            </p>
            <dl className="mt-6 grid grid-cols-3 border-t border-background/15 pt-4">
              <div>
                <dt className="text-[12px] text-background/65">الصرف، 7 أيام</dt>
                <dd className="numeric mt-1 text-[17px] font-bold sm:text-[20px]">{money(week.spend)}</dd>
              </div>
              <div className="border-s border-background/15 ps-3 sm:ps-5">
                <dt className="text-[12px] text-background/65">النتائج</dt>
                <dd className="numeric mt-1 text-[17px] font-bold sm:text-[20px]">
                  {week.results.toLocaleString('en-US', { maximumFractionDigits: 1 })}
                </dd>
              </div>
              <div className="border-s border-background/15 ps-3 sm:ps-5">
                <dt className="text-[12px] text-background/65">تكلفة النتيجة</dt>
                <dd className="numeric mt-1 text-[17px] font-bold sm:text-[20px]">
                  {week.costPerResult === null ? <span className="text-[14px] font-semibold text-background/70">ما فيه</span> : money(week.costPerResult)}
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-[12px] text-background/60">
              {accountName}
              {selectedAccount.last_synced_at ? `، آخر تحديث ${timeAgoAr(selectedAccount.last_synced_at)}` : ''}
            </p>
          </section>

          {/* Today's decisions */}
          <section aria-labelledby="decisions-title">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="decisions-title" className="text-[19px] font-bold">
                قرارات اليوم
              </h2>
              {decisions.length > 0 && (
                <span className="numeric text-[13px] text-muted-foreground">{decisions.length}</span>
              )}
            </div>
            {decisions.length === 0 ? (
              <div className="mt-3 flex items-start gap-3 border border-border bg-card px-4 py-4">
                <Check className="mt-1 h-5 w-5 flex-shrink-0 text-success" />
                <div>
                  <p className="text-[15px] font-semibold">ما فيه شي يحتاجك الحين.</p>
                  <p className="mt-0.5 text-[13.5px] leading-6 text-muted-foreground">
                    أقرأ حسابك كل يوم، وأول ما يطلع شي يستاهل يطلع لك هنا.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <ol className="mt-3 space-y-3">
                  {decisions.slice(0, VISIBLE_DECISIONS).map((decision) => (
                    <DecisionCard key={decision.id} decision={decision} currency={currency} subscribed={access.active} />
                  ))}
                </ol>
                {decisions.length > VISIBLE_DECISIONS && (
                  <details className="group mt-3">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-[14px] font-semibold text-foreground">
                      <ChevronLeft className="h-4 w-4 transition-transform group-open:-rotate-90" />
                      وريني الباقي ({decisions.length - VISIBLE_DECISIONS})
                    </summary>
                    <ol className="mt-2 space-y-3">
                      {decisions.slice(VISIBLE_DECISIONS).map((decision) => (
                        <DecisionCard key={decision.id} decision={decision} currency={currency} subscribed={access.active} />
                      ))}
                    </ol>
                  </details>
                )}
              </>
            )}
          </section>

          {missing.length > 0 && (
            <section className="flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-4">
              <div className="min-w-0">
                <p className="text-[15px] font-semibold">خلني أعرف نشاطك أكثر</p>
                <p className="mt-0.5 text-[13.5px] leading-6 text-muted-foreground">
                  أسئلة سريعة بضغطة، وتخلي قراراتي على مقاس نشاطك.
                </p>
              </div>
              <Link
                href="/onboarding?edit=1"
                className="inline-flex h-11 items-center bg-primary px-5 text-[14.5px] font-bold text-primary-foreground"
              >
                دقيقة وحدة
              </Link>
            </section>
          )}

          {/* Account health */}
          <section className="grid gap-3 sm:grid-cols-2">
            <div className="border border-border bg-card px-4 py-4">
              <p className="text-[13px] text-muted-foreground">صحة الحساب</p>
              {audit ? (
                <>
                  <p className="mt-1 flex items-baseline gap-2">
                    <span className="numeric text-[28px] font-bold leading-none">{audit.health_score ?? '؟'}</span>
                    <span className="text-[13px] text-muted-foreground">من 100، {healthWord(audit.health_score) ?? ''}</span>
                  </p>
                  <p className="mt-2 text-[12.5px] text-muted-foreground">آخر فحص {timeAgoAr(audit.ran_at)}</p>
                </>
              ) : (
                <p className="mt-1 text-[14px]">ما انفحص الحساب للحين.</p>
              )}
              <AskAssistant text="افحص حسابي" label="افحص حسابي من جديد" className="mt-1 -ms-1">
                <RotateCcw className="h-4 w-4" />
                افحصه من جديد
              </AskAssistant>
            </div>
            <div className="border border-border bg-card px-4 py-4">
              <p className="text-[13px] text-muted-foreground">آخر شي تغيّر في حسابك</p>
              {actions.length === 0 ? (
                <p className="mt-1 text-[14px] leading-7">ما نفّذت شي للحين. أول ما تعتمد قرار يطلع هنا.</p>
              ) : (
                <ul className="mt-1.5 space-y-2">
                  {actions.map((action: any) => (
                    <li key={action.id} className="text-[13.5px] leading-6">
                      <span className={cn(action.reverted_at && 'text-muted-foreground line-through')}>
                        {String(action.description_ar ?? '').slice(0, 110)}
                      </span>
                      <span className="block text-[12px] text-muted-foreground">
                        {action.reverted_at ? 'رجعته' : timeAgoAr(action.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>

      <HomeChat customerId={selectedAccount.customer_id} voiceEnabled={readVoiceConfig().enabled} />
    </div>
  );
}

function DecisionCard({
  decision,
  currency,
  subscribed,
}: {
  decision: Decision;
  currency: string;
  subscribed: boolean;
}) {
  const impact = monthlyImpact(decision);
  const label = impactLabel(decision);
  const tone =
    decision.severity === 'critical' ? 'bg-danger' : decision.severity === 'medium' ? 'bg-signal' : 'bg-muted-foreground';
  const approved = decision.status === 'approved';
  return (
    <li className="border border-border bg-card">
      <div className="px-4 pb-3 pt-4">
        <p className="flex items-center gap-2 text-[12.5px] font-semibold text-muted-foreground">
          <span className={cn('h-2 w-2', tone)} aria-hidden />
          {approved ? 'وافقت عليه، باقي التنفيذ' : SEVERITY_WORD[decision.severity ?? ''] ?? 'قرار'}
        </p>
        <p className="mt-1.5 text-[16px] font-semibold leading-7">{decision.title}</p>
        {decision.description && (
          <p className="mt-1 line-clamp-2 text-[13.5px] leading-6 text-muted-foreground">{decision.description}</p>
        )}
        {label && impact > 0 && (
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            {label}: <span className="numeric font-semibold text-foreground">{formatCurrency(impact, currency)}</span>
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
        {decision.executable ? (
          subscribed ? (
            <ApproveInline
              id={decision.id}
              intent={approved ? 'execute' : 'approve_execute'}
              label={approved ? 'نفّذ الحين' : 'اعتمد'}
              change={decision.change}
            />
          ) : (
            <Link
              href="/onboarding/trial"
              className="inline-flex h-10 items-center bg-primary px-4 text-[14px] font-bold text-primary-foreground"
            >
              فعّل اشتراكك وأنفذها
            </Link>
          )
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
          'inline-flex h-10 items-center px-4 text-[14px] font-bold',
          primary ? 'bg-primary text-primary-foreground' : 'border border-border bg-background text-foreground'
        )}
      >
        {children}
      </button>
    </form>
  );
}

import Link from 'next/link';
import { Bot, CircleDotDashed, History, ShieldCheck } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { autopilotDecisionDisplayDetails } from '@/lib/autopilot/display';
import { normalizeAutopilotSettings } from '@/lib/autopilot/settings';
import { autopilotExecutionGloballyEnabled, type AutopilotDecision } from '@/lib/autopilot/types';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { Alert } from '@/lib/ui/alert';
import { buttonClasses } from '@/lib/ui/button';
import { EmptyState } from '@/lib/ui/empty-state';
import { PageHeader } from '@/lib/ui/page-header';
import { StatusBadge, type StatusTone } from '@/lib/ui/status-badge';
import { timeAgoAr } from '@/lib/utils';
import { AutopilotSettingsForm } from './autopilot-settings-form';

export const metadata = { title: 'الطيار الآلي' };

type DecisionRow = {
  id: string;
  decision: AutopilotDecision;
  mode: string;
  action_type: string | null;
  confidence: number | null;
  reason_ar: string | null;
  action_snapshot: Record<string, unknown> | null;
  created_at: string;
};

export default async function AutopilotPage() {
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/autopilot');

  const workspace = await getAccountWorkspace(user.id);
  const account = workspace.selectedAccount;
  if (!account) {
    return (
      <>
        <PageHeader icon={Bot} title="الطيار الآلي" description="يراقب الحساب ويقترح أو ينفذ التحسينات ضمن حدودك." />
        <div className="p-4 sm:p-6 lg:p-8">
          <EmptyState
            icon={CircleDotDashed}
            title="اختر حساباً إعلانياً أولاً"
            description="اربط حساب Google Ads أو اختر حساباً فعالاً من القائمة الجانبية، ثم اضبط وضع الطيار الآلي له."
            action={<Link href="/onboarding/connect" className={buttonClasses()}>ربط Google Ads</Link>}
          />
        </div>
      </>
    );
  }

  const [settingsResult, decisionsResult, subscription] = await Promise.all([
    supabase.from('autopilot_settings').select('*').eq('account_id', account.id).maybeSingle(),
    supabase
      .from('autopilot_decisions')
      .select('id, decision, mode, action_type, confidence, reason_ar, action_snapshot, created_at')
      .eq('account_id', account.id)
      .order('created_at', { ascending: false })
      .limit(100),
    getSubscriptionAccess(supabase, user.id, user.email),
  ]);
  assertSupabaseRead(settingsResult.error, 'load autopilot settings');
  assertSupabaseRead(decisionsResult.error, 'load autopilot decision ledger');

  const settings = normalizeAutopilotSettings(account.id, settingsResult.data);
  const accountName = googleAdsAccountDisplayName(account);
  const decisions = (decisionsResult.data ?? []) as DecisionRow[];
  const globalExecutionEnabled = autopilotExecutionGloballyEnabled();

  return (
    <>
      <PageHeader
        icon={Bot}
        title="الطيار الآلي"
        description={`مراقبة وتحسين ${accountName} بقواعد أمان لا يستطيع الذكاء الاصطناعي تجاوزها.`}
      />

      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <Alert tone="info" title="أنت صاحب القرار">
          الوضع الافتراضي متوقف. يمكنك تشغيل المراقبة بلا تغييرات، أو السماح بالتنفيذ المحافظ. الميزانيات والمزايدات
          وإيقاف الحملات تبقى في مركز الموافقات ولا ينفذها الطيار تلقائياً في هذا الإصدار.
        </Alert>

        <section className="surface-card p-5 sm:p-6">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
            <div>
              <h2 className="text-[15px] font-semibold text-foreground">سياسة هذا الحساب</h2>
              <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                {accountName} · {account.customer_id}
              </p>
            </div>
            <StatusBadge tone={modeTone(settings.mode)}>{modeLabel(settings.mode)}</StatusBadge>
          </div>
          <AutopilotSettingsForm
            account={{ customerId: account.customer_id, name: accountName }}
            initialSettings={settings}
            subscriptionActive={subscription.active}
            globalExecutionEnabled={globalExecutionEnabled}
          />
        </section>

        <section className="surface-card overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5 sm:p-6">
            <div>
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
                <History className="h-4 w-4" />
                سجل القرارات
              </h2>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">
                سجل ثابت لقرارات مُضاعِف: ماذا لاحظ، ولماذا منع أو جهّز أو نفّذ. تغييرات Google Ads الخارجية ستضاف
                في مرحلة لاحقة.
              </p>
            </div>
            <StatusBadge tone="neutral">آخر {decisions.length} قرار</StatusBadge>
          </div>

          {decisions.length === 0 ? (
            <EmptyState
              bare
              icon={ShieldCheck}
              title="لا توجد قرارات بعد"
              description="فعّل وضع المراقبة، وسيبدأ السجل بعد دورة التحسين المجدولة التالية."
              className="py-14"
            />
          ) : (
            <div className="divide-y divide-border">
              {decisions.map((item) => {
                const { keyword, campaign, matchType } = autopilotDecisionDisplayDetails(
                  item.action_snapshot
                );
                return (
                  <article key={item.id} className="grid gap-3 p-5 sm:grid-cols-[1fr_auto] sm:p-6">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge tone={decisionTone(item.decision)}>{decisionLabel(item.decision)}</StatusBadge>
                        {item.action_type && <span className="text-xs font-semibold text-foreground">{actionLabel(item.action_type)}</span>}
                        {typeof item.confidence === 'number' && (
                          <span className="text-xs text-muted-foreground">ثقة {Math.round(item.confidence * 100)}%</span>
                        )}
                      </div>
                      <p className="mt-2 text-sm leading-7 text-foreground">
                        {item.reason_ar || 'سُجّل القرار دون وصف إضافي.'}
                      </p>
                      {(keyword || campaign || matchType) && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {keyword ? `الكلمة: ${keyword}` : ''}
                          {keyword && campaign ? ' · ' : ''}
                          {campaign ? `الحملة: ${campaign}` : ''}
                          {(keyword || campaign) && matchType ? ' · ' : ''}
                          {matchType ? `المطابقة: ${matchType}` : ''}
                        </p>
                      )}
                    </div>
                    <time className="text-xs text-muted-foreground" dateTime={item.created_at}>
                      {timeAgoAr(item.created_at)}
                    </time>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function modeLabel(mode: string) {
  if (mode === 'conservative') return 'تنفيذ محافظ';
  if (mode === 'observe') return 'مراقبة فقط';
  return 'متوقف';
}

function modeTone(mode: string): StatusTone {
  if (mode === 'conservative') return 'success';
  if (mode === 'observe') return 'info';
  return 'neutral';
}

function decisionLabel(decision: AutopilotDecision) {
  return {
    settings_changed: 'تغيير إعدادات',
    observed: 'تمت المراقبة',
    queued: 'أُرسل للموافقة',
    executed: 'تم التنفيذ',
    unverified: 'بانتظار المطابقة',
    blocked: 'منعته الحماية',
    failed: 'فشل التنفيذ',
    no_action: 'لا إجراء',
  }[decision];
}

function decisionTone(decision: AutopilotDecision): StatusTone {
  if (decision === 'executed') return 'success';
  if (decision === 'unverified') return 'warning';
  if (decision === 'failed' || decision === 'blocked') return decision === 'failed' ? 'danger' : 'warning';
  if (decision === 'queued' || decision === 'observed') return 'info';
  return 'neutral';
}

function actionLabel(actionType: string) {
  if (actionType === 'add_negative_keyword') return 'إضافة كلمة سلبية مطابقة تامة';
  if (actionType === 'budget') return 'تعديل ميزانية';
  if (actionType === 'status') return 'تغيير حالة';
  if (actionType === 'bidding') return 'تعديل مزايدة';
  return actionType;
}

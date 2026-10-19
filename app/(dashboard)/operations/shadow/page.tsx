import { notFound } from 'next/navigation';
import { requireOperatorPage } from '@/lib/platform/operator-page';
import { createAdminClient } from '@/lib/supabase/server';
import { shadowModeEnabled } from '@/lib/shadow/flag';
import {
  SHADOW_CATEGORY_LABELS_AR,
  normalizeShadowCategory,
  weekStartUtc,
  weeklyAgreement,
  type ShadowDecisionRow,
  type ShadowReviewRow,
} from '@/lib/shadow/summary';
import { cn } from '@/lib/utils';
import { OpsTabs, SectionHead } from '../ops-ui';
import { riyadhTime, shortDate } from '../format';
import { MarkShadowForm, MissedForm, ReviewButtons } from './shadow-controls';

export const metadata = { title: 'وضع الظل · مركز التشغيل' };
export const dynamic = 'force-dynamic';

const DECISIONS_SHOWN = 60;

export default async function ShadowPage() {
  await requireOperatorPage('/operations/shadow');
  if (!shadowModeEnabled()) notFound();
  const now = Date.now();
  const admin = createAdminClient();
  const weekStart = weekStartUtc(new Date(now));
  const since = new Date(weekStart.getTime() - 7 * 86_400_000).toISOString();

  const [accountsResult, decisionsResult, reviewsResult] = await Promise.all([
    admin.from('shadow_accounts').select('account_id, marked_at, note').order('marked_at', { ascending: false }),
    admin
      .from('shadow_decisions')
      .select('id, account_id, action_type, category, target_id, reason_ar, confidence, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500),
    admin
      .from('shadow_reviews')
      .select('id, account_id, decision_id, verdict, category, note, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1000),
  ]);

  const readError = accountsResult.error || decisionsResult.error || reviewsResult.error;
  const shadowAccounts = (accountsResult.data ?? []) as Array<{ account_id: string; marked_at: string; note: string | null }>;
  const decisions = (decisionsResult.data ?? []) as Array<ShadowDecisionRow & { action_type: string; target_id: string | null; reason_ar: string | null; confidence: number | null }>;
  const reviews = (reviewsResult.data ?? []) as Array<ShadowReviewRow & { note: string | null }>;

  const ids = shadowAccounts.map((row) => row.account_id);
  const { data: accountRows } = ids.length
    ? await admin.from('google_ads_accounts').select('id, customer_id, customer_name').in('id', ids)
    : { data: [] as Array<{ id: string; customer_id: string; customer_name: string | null }> };
  const accountName = new Map((accountRows ?? []).map((row) => [row.id, `${row.customer_name ?? 'حساب'} · ${row.customer_id}`]));

  const verdictByDecision = new Map<string, 'right' | 'wrong'>();
  for (const review of reviews) {
    if (review.decision_id && (review.verdict === 'right' || review.verdict === 'wrong') && !verdictByDecision.has(review.decision_id)) {
      verdictByDecision.set(review.decision_id, review.verdict);
    }
  }

  const thisWeek = weeklyAgreement(decisions, reviews, weekStart);
  const lastWeek = weeklyAgreement(decisions, reviews, new Date(weekStart.getTime() - 7 * 86_400_000));
  const shown = decisions.slice(0, DECISIONS_SHOWN);

  return (
    <div className="pb-16">
      <header className="px-4 pb-2 pt-5 sm:px-6 lg:px-8">
        <h1 className="text-lg font-bold text-foreground">وضع الظل</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          حسابات الوكالة اللي المُحسِّن يقرأها ويقترح عليها، بدون ما ينفذ شي أبداً. قيّم كل قرار، وسجّل اللي فاته.
        </p>
      </header>
      <OpsTabs active="shadow" updatedAt={riyadhTime(now)} />

      <div className="space-y-8 px-4 pt-6 sm:px-6 lg:px-8">
        {readError && (
          <p role="alert" className="border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            ما قدرنا نقرأ جداول الظل. غالباً الميقريشن 20261020_trust_shadow_mode ما انشغل بعد.
          </p>
        )}

        <section aria-labelledby="mark-title" className="space-y-3">
          <SectionHead id="mark-title" title="الحسابات في الظل" note="الحساب هنا ما يتنفذ عليه شي، لا من الطيار ولا من الموافقات." />
          <MarkShadowForm />
          {shadowAccounts.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">ما فيه حسابات في الظل.</p>
          ) : (
            <ul className="divide-y divide-border border border-border">
              {shadowAccounts.map((row) => (
                <li key={row.account_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span>{accountName.get(row.account_id) ?? row.account_id}</span>
                  <span className="text-xs text-muted-foreground">من {shortDate(row.marked_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="agree-title" className="space-y-3">
          <SectionHead id="agree-title" title="الاتفاق هذا الأسبوع" note="النسبة من القرارات اللي قيّمتها بس: صح مقسوم على صح وغلط." />
          <AgreementCard title="هذا الأسبوع" summary={thisWeek} />
          <AgreementCard title="الأسبوع اللي قبل" summary={lastWeek} />
        </section>

        <section aria-labelledby="missed-title" className="space-y-3">
          <SectionHead id="missed-title" title="فاتك شي" note="شي كان لازم يسويه المُحسِّن وما سواه." />
          {shadowAccounts.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">أضف حساب للظل أول.</p>
          ) : (
            shadowAccounts.map((row) => (
              <div key={row.account_id} className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">{accountName.get(row.account_id) ?? row.account_id}</p>
                <MissedForm accountId={row.account_id} />
              </div>
            ))
          )}
        </section>

        <section aria-labelledby="decisions-title" className="space-y-3">
          <SectionHead id="decisions-title" title="القرارات" note={`آخر ${shown.length} قرار. ما فيه زر تنفيذ لأن ما أحد ينفذها.`} />
          {shown.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">لسه ما جاء قرار. المُحسِّن يمر على الحسابات كل ساعة تقريباً.</p>
          ) : (
            <ul className="space-y-3">
              {shown.map((decision) => {
                const current = verdictByDecision.get(decision.id) ?? null;
                return (
                  <li key={decision.id} className={cn('border border-border p-3', current === 'wrong' && 'border-danger/40')}>
                    <p className="text-xs text-muted-foreground">
                      {accountName.get(decision.account_id) ?? decision.account_id} · {SHADOW_CATEGORY_LABELS_AR[normalizeShadowCategory(decision.category)]} · {shortDate(decision.created_at)}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-foreground">{decision.reason_ar ?? decision.action_type}</p>
                    <ReviewButtons accountId={decision.account_id} decisionId={decision.id} current={current} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function AgreementCard({ title, summary }: { title: string; summary: ReturnType<typeof weeklyAgreement> }) {
  return (
    <div className="border border-border p-3">
      <p className="text-sm font-semibold">{title}</p>
      <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        <Item label="قرارات" value={String(summary.decisions)} />
        <Item label="قيّمتها" value={summary.coveragePct === null ? 'لا يوجد' : `${summary.reviewed} (${summary.coveragePct}%)`} />
        <Item label="الاتفاق" value={summary.agreePct === null ? 'ما فيه تقييم' : `${summary.agreePct}%`} />
        <Item label="غلط" value={String(summary.wrong)} />
        <Item label="فاتك" value={String(summary.missed)} />
      </dl>
      {summary.missesBy.length > 0 && (
        <p className="mt-2 text-[13px] text-muted-foreground">
          اللي فات حسب النوع: {summary.missesBy.map((item) => `${SHADOW_CATEGORY_LABELS_AR[item.category]} ${item.count}`).join('، ')}
        </p>
      )}
      {summary.wrongBy.length > 0 && (
        <p className="mt-1 text-[13px] text-muted-foreground">
          الغلط حسب النوع: {summary.wrongBy.map((item) => `${SHADOW_CATEGORY_LABELS_AR[item.category]} ${item.count}`).join('، ')}
        </p>
      )}
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="numeric text-base font-bold">{value}</dd>
    </div>
  );
}

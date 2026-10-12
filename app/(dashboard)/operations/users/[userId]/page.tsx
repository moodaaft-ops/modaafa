import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { requireOperatorPage } from '@/lib/platform/operator-page';
import { loadCustomerDetail } from '@/lib/platform/operator-data';
import {
  ACCESS_LABELS,
  STAGES,
  STAGE_LABELS,
  buildAttentionQueue,
  buildCustomerProfiles,
  isGoogleDisabled,
} from '@/lib/platform/operator-insights';
import { isModaafaOperator } from '@/lib/platform/operators';
import { formatGoogleAdsCustomerId } from '@/lib/accounts/display';
import { planLabel, recommendationStatusLabel, subscriptionStatusLabel } from '@/lib/ui/labels';
import { summarizeUsageEvents } from '@/lib/platform/operator-metrics';
import { cn, formatNumberAr, timeAgoAr } from '@/lib/utils';
import { AccessChip, ContactButton, MigrationNotice, SectionHead } from '../../ops-ui';
import { OPERATOR_ACTION_LABELS, sar, shortDate } from '../../format';
import { OperatorActions } from './operator-actions';

export const metadata = { title: 'ملف عميل · مركز التشغيل' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACCOUNT_STATUS: Record<string, string> = {
  active: 'شغال',
  paused: 'موقف',
  revoked: 'فصل الربط',
  invitation_pending: 'بانتظار قبول الدعوة',
};

const minIso = (values: Array<string | null | undefined>) =>
  values.filter(Boolean).sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())[0] ?? null;

export default async function OperationsCustomerPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  await requireOperatorPage(`/operations/users/${userId}`);
  if (!UUID.test(userId)) notFound();

  const now = Date.now();
  const detail = await loadCustomerDetail(userId, now);
  if (!detail) notFound();

  const [profile] = buildCustomerProfiles(detail.dataset, now);
  const attention = buildAttentionQueue([profile], now)[0] ?? null;
  const usage = summarizeUsageEvents(
    Object.entries(detail.usageByFeature).flatMap(([feature, count]) => Array.from({ length: count }, () => ({ feature })))
  );
  const migrationMissing = detail.dataset.unavailable.includes('account_access_overrides') || detail.dataset.unavailable.includes('operator_audit_log');
  const trialing = detail.subscriptions.find((row) => row.status === 'trialing' && row.stripe_subscription_id);

  const journey: Array<{ stage: (typeof STAGES)[number]; at: string | null }> = [
    { stage: 'signed_up', at: profile.createdAt },
    { stage: 'confirmed', at: profile.confirmedAt },
    { stage: 'business', at: profile.businessCreatedAt },
    { stage: 'connected', at: profile.firstLinkedAt },
    { stage: 'audited', at: minIso(detail.dataset.audits.map((row) => row.ran_at)) },
    { stage: 'trial', at: minIso(detail.subscriptions.map((row) => row.created_at)) },
    { stage: 'paying', at: minIso(detail.invoices.filter((row) => row.status === 'paid').map((row) => row.paid_at ?? row.created_at)) },
  ];

  const business = detail.dataset.businesses[0] ?? null;

  return (
    <div className="pb-16">
      <div className="px-4 pt-5 sm:px-6 lg:px-8">
        <Link href="/operations/users" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowRight className="h-4 w-4" aria-hidden />
          العملاء
        </Link>
      </div>

      {/* Identity */}
      <header className="border-b border-border px-4 pb-5 pt-3 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="break-all text-xl font-bold text-foreground sm:text-2xl" dir="ltr">
              {profile.email}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {[profile.name, profile.businessName, profile.sector].filter(Boolean).join(' · ') || 'ما عبّى بيانات النشاط'}
              {profile.website && (
                <>
                  {' · '}
                  <a href={profile.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4" dir="ltr">
                    {profile.website.replace(/^https?:\/\//, '')}
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                </>
              )}
              {profile.phone && (
                <span className="numeric" dir="ltr">
                  {' · '}
                  {profile.phone}
                </span>
              )}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <AccessChip access={profile.access} label={ACCESS_LABELS[profile.access]} />
              {(profile.overrides.grant?.plan || profile.subscription?.plan) && (
                <span className="text-xs font-semibold text-foreground">
                  خطة {planLabel(profile.overrides.grant?.plan ?? profile.subscription?.plan ?? null)}
                </span>
              )}
              {profile.mrr > 0 && <span className="text-xs text-muted-foreground">{sar(profile.mrr)} شهرياً</span>}
              {profile.trialValue > 0 && <span className="text-xs text-muted-foreground">{sar(profile.trialValue)} شهرياً لو تحولت</span>}
            </div>
          </div>
          <ContactButton profile={profile} text={attention?.whatsappText ?? 'هلا معك ايمن من مضاعف حبيت اتطمن عليك وش وضع حسابك'} />
        </div>

        {attention && (
          <div
            className={cn(
              'mt-4 border-s-4 px-4 py-2.5 text-sm',
              attention.severity === 'critical' ? 'border-danger bg-danger/10' : 'border-signal bg-signal/10'
            )}
          >
            <span className="font-semibold text-foreground">{attention.title}.</span>{' '}
            <span className="text-muted-foreground">{attention.detail}</span>
            {attention.more.length > 0 && <span className="text-muted-foreground"> وكمان: {attention.more.join('، ')}.</span>}
          </div>
        )}
      </header>

      {/* Journey */}
      <section className="border-b border-border px-4 py-5 sm:px-6 lg:px-8" aria-label="رحلة العميل">
        <ol className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-7">
          {journey.map((step) => {
            const reached = profile.milestones[step.stage];
            return (
              <li key={step.stage} className="flex items-start gap-2">
                <span
                  className={cn(
                    'mt-1 h-2.5 w-2.5 flex-shrink-0',
                    reached ? (step.stage === profile.stage ? 'bg-signal ring-1 ring-foreground/50' : 'bg-foreground') : 'border border-border-strong'
                  )}
                  aria-hidden
                />
                <span>
                  <span className={cn('block text-[13px] font-semibold', reached ? 'text-foreground' : 'text-muted-foreground')}>
                    {STAGE_LABELS[step.stage]}
                  </span>
                  <span className="block text-xs text-muted-foreground numeric">{reached ? shortDate(step.at) : 'لسا'}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="grid gap-10 px-4 pt-6 sm:px-6 lg:grid-cols-3 lg:px-8">
        <div className="space-y-10 lg:col-span-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <Fact label="آخر نشاط" value={profile.lastSeenAt ? timeAgoAr(profile.lastSeenAt) : 'ما دخل'} />
            <Fact label="استخدام 30 يوم" value={formatNumberAr(profile.usage30d)} />
            <Fact label="توصيات انتفذت" value={formatNumberAr(profile.recsApplied30d)} note="30 يوم" />
            <Fact label="محادثات المساعد" value={formatNumberAr(detail.chatSessions)} />
          </dl>

          <section aria-labelledby="accounts-title">
            <SectionHead id="accounts-title" title="حسابات الإعلانات" />
            {detail.accounts.filter((row) => !row.is_manager).length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">ما ربط أي حساب إعلانات.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border border-y border-border">
                {detail.accounts
                  .filter((row) => !row.is_manager)
                  .map((account) => {
                    const disabled = isGoogleDisabled(account);
                    return (
                      <li key={account.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 text-sm">
                        <span className="min-w-0">
                          <span className="block font-semibold text-foreground">{account.customer_name || 'بدون اسم'}</span>
                          <span className="block text-xs text-muted-foreground numeric" dir="ltr">
                            {formatGoogleAdsCustomerId(account.customer_id)}
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          <span className={cn('font-semibold', disabled || account.status !== 'active' ? 'text-danger' : 'text-success')}>
                            {disabled && account.status === 'active' ? 'قوقل موقفه' : ACCOUNT_STATUS[account.status] ?? account.status}
                          </span>
                          {account.google_status && account.google_status !== 'ENABLED' && (
                            <span className="font-mono" dir="ltr">
                              {' '}
                              ({account.google_status})
                            </span>
                          )}
                          {' · '}
                          {account.last_synced_at ? `آخر تحديث ${timeAgoAr(account.last_synced_at)}` : 'ما تحدث'}
                          {account.last_optimized_at && ` · آخر تحسين ${timeAgoAr(account.last_optimized_at)}`}
                        </span>
                      </li>
                    );
                  })}
              </ul>
            )}
          </section>

          <section aria-labelledby="billing-title">
            <SectionHead id="billing-title" title="الاشتراك والفواتير" />
            {detail.subscriptions.length === 0 && !profile.overrides.grant ? (
              <p className="mt-3 text-sm text-muted-foreground">ما بدأ تجربة ولا اشترك.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border border-y border-border text-sm">
                {profile.overrides.grant && (
                  <li className="flex flex-wrap justify-between gap-2 py-2.5">
                    <span className="font-semibold text-foreground">خطة {planLabel(profile.overrides.grant.plan)} مجانية من الإدارة</span>
                    <span className="text-xs text-muted-foreground">
                      من {shortDate(profile.overrides.grant.grantedAt)} ·{' '}
                      {profile.overrides.grant.expiresAt ? `لين ${shortDate(profile.overrides.grant.expiresAt)}` : 'بدون نهاية'}
                    </span>
                  </li>
                )}
                {detail.subscriptions.map((row) => (
                  <li key={row.id} className="flex flex-wrap justify-between gap-2 py-2.5">
                    <span className="text-foreground">
                      <span className="font-semibold">{planLabel(row.plan)}</span>
                      {row.billing_period === 'yearly' ? ' سنوي' : ' شهري'} · {subscriptionStatusLabel(row.status)}
                      {!row.stripe_subscription_id && <span className="text-xs text-muted-foreground"> (بدون Stripe)</span>}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      بدأ {shortDate(row.created_at)}
                      {row.status === 'trialing' && row.trial_ends_at && ` · التجربة تنتهي ${shortDate(row.trial_ends_at)}`}
                      {row.status !== 'trialing' && row.current_period_end && ` · الفترة لين ${shortDate(row.current_period_end)}`}
                      {row.canceled_at && ` · ألغى ${shortDate(row.canceled_at)}`}
                    </span>
                  </li>
                ))}
                {detail.invoices.map((row, index) => (
                  <li key={`${row.invoice_number ?? index}`} className="flex flex-wrap justify-between gap-2 py-2.5">
                    <span className="text-foreground">
                      فاتورة {row.invoice_number ? <span className="numeric" dir="ltr">{row.invoice_number}</span> : ''} ·{' '}
                      {subscriptionStatusLabel(row.status)}
                    </span>
                    <span className="text-xs text-muted-foreground numeric">
                      {sar(Number(row.amount_sar ?? 0))} · {shortDate(row.paid_at ?? row.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="recs-title">
            <SectionHead
              id="recs-title"
              title="التوصيات والتنفيذ"
              note={detail.recommendations.length > 10 ? `${formatNumberAr(detail.recommendations.length)} توصية مسجلة، نعرض آخر 10.` : undefined}
            />
            {detail.recommendations.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">ما طلعت له توصيات لين الحين.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border border-y border-border text-sm">
                {detail.recommendations.slice(0, 10).map((rec) => (
                  <li key={rec.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
                    <span className="min-w-0 flex-1 text-foreground">{rec.title}</span>
                    <span className="text-xs text-muted-foreground">
                      <span
                        className={cn(
                          'font-semibold',
                          rec.status === 'failed' ? 'text-danger' : rec.status === 'applied' ? 'text-success' : 'text-foreground'
                        )}
                      >
                        {recommendationStatusLabel(rec.status)}
                      </span>{' '}
                      · {shortDate(rec.applied_at ?? rec.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {detail.actions.length > 0 && (
              <ul className="mt-4 space-y-1.5 text-[13px]">
                {detail.actions.slice(0, 6).map((action) => (
                  <li key={action.id} className="flex flex-wrap justify-between gap-2">
                    <span className="text-foreground">{action.description_ar}</span>
                    <span className="text-xs text-muted-foreground">
                      {timeAgoAr(action.created_at)}
                      {action.rollback_status === 'reverted' && <span className="text-danger"> · تراجع عنه</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="usage-title">
            <SectionHead id="usage-title" title="وش استخدم خلال 30 يوم" />
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
              {usage.map((item) => (
                <Fact key={item.feature} label={item.label} value={formatNumberAr(item.count)} />
              ))}
            </dl>
          </section>
        </div>

        <aside className="space-y-8 lg:border-s lg:border-border lg:ps-8">
          <section aria-labelledby="tools-title">
            <SectionHead id="tools-title" title="أدواتك على هذا العميل" />
            <div className="mt-3">
              <MigrationNotice missing={migrationMissing ? ['account_access_overrides'] : []} />
              <div className="mt-3">
                <OperatorActions
                  userId={profile.id}
                  trialEndsAt={trialing?.trial_ends_at ?? null}
                  hasStripeTrial={Boolean(trialing)}
                  grant={profile.overrides.grant ? { plan: profile.overrides.grant.plan, expiresAt: profile.overrides.grant.expiresAt } : null}
                  suspended={profile.overrides.suspended}
                  targetIsOperator={isModaafaOperator(profile.email)}
                  migrationMissing={migrationMissing}
                  hasPaidPlan={profile.stripeStatus === 'active' || profile.stripeStatus === 'past_due'}
                />
              </div>
            </div>
          </section>

          <section aria-labelledby="customer-log-title">
            <SectionHead id="customer-log-title" title="سجل الإجراءات عليه" />
            {detail.auditLog.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">ما فيه إجراءات على هذا العميل.</p>
            ) : (
              <ul className="mt-3 space-y-3 text-[13px]">
                {detail.auditLog.map((row) => (
                  <li key={row.id} className="border-s-2 border-border ps-3">
                    <div className={cn('font-semibold', row.status === 'failed' ? 'text-danger' : 'text-foreground')}>
                      {OPERATOR_ACTION_LABELS[row.action] ?? row.action}
                      {row.status === 'failed' && ' (فشل)'}
                      {row.status === 'started' && ' (ما اكتمل)'}
                    </div>
                    <div className="text-muted-foreground">{row.reason}</div>
                    {row.error_message && (
                      <div className="mt-0.5 break-all font-mono text-[11px] text-danger" dir="ltr">
                        {row.error_message}
                      </div>
                    )}
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      <span dir="ltr">{row.operator_email}</span> · {timeAgoAr(row.created_at)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {business?.monthly_budget ? (
            <p className="text-xs text-muted-foreground">
              الميزانية الشهرية اللي كتبها: <span className="numeric">{sar(Number(business.monthly_budget))}</span>
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-bold text-foreground numeric">{value}</dd>
      {note && <dd className="text-[11px] text-muted-foreground">{note}</dd>}
    </div>
  );
}

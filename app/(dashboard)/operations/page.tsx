import Link from 'next/link';
import { ArrowUpLeft } from 'lucide-react';
import { requireOperatorPage } from '@/lib/platform/operator-page';
import { loadOperatorDataset } from '@/lib/platform/operator-data';
import {
  ACCESS_LABELS,
  FUNNEL_RANGES,
  STAGES,
  STAGE_LABELS,
  STAGE_NEXT_STEP,
  biggestLeak,
  buildAttentionQueue,
  buildCustomerProfiles,
  computeEngineHealth,
  computeFunnel,
  computePulse,
  computeRevenue,
  headline,
  parseFunnelRange,
  type FunnelRange,
} from '@/lib/platform/operator-insights';
import { cn, formatNumberAr, timeAgoAr } from '@/lib/utils';
import { AccessChip, ContactButton, MigrationNotice, OpsTabs, TruncatedNotice, SectionHead } from './ops-ui';
import { OPERATOR_ACTION_LABELS, percent, riyadhDayLabel, riyadhTime, sar } from './format';

export const metadata = { title: 'مركز التشغيل' };
export const dynamic = 'force-dynamic';

const ATTENTION_VISIBLE = 10;

export default async function OperationsOverviewPage({
  searchParams,
}: {
  searchParams?: Promise<{ range?: string }>;
}) {
  await requireOperatorPage('/operations');
  const params = await searchParams;
  const range = parseFunnelRange(params?.range);
  const now = Date.now();

  const data = await loadOperatorDataset(now);
  const profiles = buildCustomerProfiles(data, now);
  const attention = buildAttentionQueue(profiles, now);
  const revenue = computeRevenue(profiles, now);
  const health = computeEngineHealth(data, now);
  const pulse = computePulse(profiles, data, now);
  const funnel = computeFunnel(profiles, range, now);
  const leak = biggestLeak(funnel);
  const top = headline({ attention, health, revenue });
  const emailById = new Map(profiles.map((profile) => [profile.id, profile.email]));
  const customerCount = profiles.filter((profile) => !profile.isOperator).length;

  return (
    <div className="pb-16">
      <header className="px-4 pb-2 pt-5 sm:px-6 lg:px-8">
        <h1 className="text-lg font-bold text-foreground">مركز التشغيل</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {formatNumberAr(customerCount)} عميل مسجّل · للمالك فقط
        </p>
      </header>
      <OpsTabs active="overview" updatedAt={riyadhTime(now)} />

      {/* Command strip: the one sentence, then this week in four numbers. */}
      <section className="bg-foreground px-4 py-6 text-background sm:px-6 lg:px-8" aria-label="الحالة الآن">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'mt-2.5 h-3 w-3 flex-shrink-0',
              top.tone === 'danger' ? 'bg-danger' : top.tone === 'warning' ? 'bg-signal' : 'bg-success'
            )}
            aria-hidden
          />
          <p className="text-xl font-bold leading-snug sm:text-2xl">{top.text}</p>
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-px bg-background/20 lg:grid-cols-4">
          {pulse.map((metric) => {
            const diff = metric.current - metric.previous;
            return (
              <div key={metric.key} className="bg-foreground py-3 pe-3 sm:pe-5">
                <dt className="text-xs text-background/70">{metric.label}</dt>
                <dd className="mt-1 flex items-baseline gap-2">
                  <span className="text-3xl font-bold leading-none numeric">{formatNumberAr(metric.current)}</span>
                  <span className="text-xs text-background/80 numeric">
                    {diff === 0 ? (
                      'نفس الأسبوع اللي قبل'
                    ) : (
                      <bdi dir="ltr">{`${diff > 0 ? '▲ +' : '▼ −'}${formatNumberAr(Math.abs(diff))}`}</bdi>
                    )}
                  </span>
                </dd>
                <dd className="mt-1 text-[11px] text-background/60">
                  <span className="hidden sm:inline">{metric.hint} · </span>الأسبوع اللي قبل {formatNumberAr(metric.previous)}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      <div className="space-y-10 px-4 pt-6 sm:px-6 lg:px-8">
        <MigrationNotice missing={data.unavailable} />
        <TruncatedNotice tables={data.truncated} />

        <div className="grid gap-8 lg:grid-cols-3">
          {/* Who needs you */}
          <section className="lg:col-span-2" aria-labelledby="attention-title">
            <SectionHead
              id="attention-title"
              title="يحتاجونك اليوم"
              note="عميل واحد في كل سطر بأهم سبب عنده. الأحمر قبل الأصفر، وفي نفس اللون اللي عليه فلوس أول."
              aside={
                <span className="text-sm font-semibold numeric text-foreground">{formatNumberAr(attention.length)}</span>
              }
            />
            {attention.length === 0 ? (
              <p className="mt-4 border border-border px-4 py-6 text-sm text-muted-foreground">
                ما فيه أحد عالق اليوم. القائمة تتعبى لما أحد يسجّل وما يكمل، أو تقرب نهاية تجربته بدون قيمة، أو يفشل دفعه.
              </p>
            ) : (
              <ol className="mt-4 divide-y divide-border border-y border-border">
                {attention.slice(0, ATTENTION_VISIBLE).map((item) => (
                  <AttentionRow key={item.profile.id} item={item} />
                ))}
              </ol>
            )}
            {attention.length > ATTENTION_VISIBLE && (
              <details className="group">
                <summary className="cursor-pointer list-none py-3 text-sm font-semibold text-foreground underline-offset-4 hover:underline">
                  باقي القائمة ({formatNumberAr(attention.length - ATTENTION_VISIBLE)})
                </summary>
                <ol className="divide-y divide-border border-b border-border">
                  {attention.slice(ATTENTION_VISIBLE).map((item) => (
                    <AttentionRow key={item.profile.id} item={item} />
                  ))}
                </ol>
              </details>
            )}
          </section>

          {/* Money */}
          <section aria-labelledby="money-title" className="lg:sticky lg:top-6 lg:self-start lg:border-s lg:border-border lg:ps-8">
            <SectionHead id="money-title" title="الفلوس" note="شهرياً، بأسعار الخطط الحالية في Stripe." />
            <div className="mt-4">
              <div className="text-xs text-muted-foreground">الإيراد الشهري المتكرر</div>
              <div className="mt-1 text-4xl font-bold leading-none text-foreground numeric">{sar(revenue.mrr)}</div>
              <div className="mt-2 text-[13px] text-muted-foreground">
                من {formatNumberAr(revenue.payingCustomers)} عميل دافع
                {revenue.collectedTotal > 0 && <> · انحصّل لين الحين {sar(revenue.collectedTotal)}</>}
              </div>
            </div>

            <dl className="mt-6 space-y-3 border-t border-border pt-4 text-sm">
              <MoneyLine
                label="تجارب شغالة"
                value={formatNumberAr(revenue.trialing)}
                note={revenue.trialPipeline > 0 ? `${sar(revenue.trialPipeline)} شهرياً لو كلها تحولت` : undefined}
              />
              <MoneyLine
                label="دفعات فشلت"
                value={formatNumberAr(revenue.pastDueCustomers)}
                note={revenue.pastDueValue > 0 ? `${sar(revenue.pastDueValue)} شهرياً معلّقة` : undefined}
                danger={revenue.pastDueCustomers > 0}
              />
              <MoneyLine label="خطط مجانية من عندك" value={formatNumberAr(revenue.compCustomers)} />
            </dl>

            <ChargeCalendar upcoming={revenue.upcoming} />
          </section>
        </div>

        {/* Funnel */}
        <section aria-labelledby="funnel-title">
          <SectionHead
            id="funnel-title"
            title="وين يطيحون الناس"
            note="اللي سجلوا خلال الفترة، وكم واحد منهم وصل كل خطوة."
            aside={<RangeTabs range={range} />}
          />
          {leak && (
            <p className="mt-4 border-s-4 border-signal bg-signal/10 px-4 py-3 text-sm leading-6 text-foreground">
              أكبر تسرب: بين «{STAGE_LABELS[STAGES[STAGES.indexOf(leak.stage) - 1]]}» و«{leak.label}» راح{' '}
              <strong className="numeric">{formatNumberAr(leak.dropped)}</strong> شخص.{' '}
              <Link
                href={`/operations/users?stage=${STAGES[STAGES.indexOf(leak.stage) - 1]}`}
                className="font-semibold underline underline-offset-4"
              >
                شوف أسماءهم
              </Link>
            </p>
          )}
          <FunnelBars steps={funnel} />
        </section>

        {/* Engine */}
        <section aria-labelledby="engine-title">
          <SectionHead
            id="engine-title"
            title="صحة المحرك"
            note="هل المنصة تشتغل لعملائك فعلاً: التحديث والمحسّن والربط، وش طلع منها هالأسبوع."
          />
          <div className="mt-4 grid gap-8 lg:grid-cols-5">
            <ul className="divide-y divide-border border-y border-border lg:col-span-3">
              {health.jobs.map((job) => (
                <li key={job.key} className="flex gap-3 py-3.5">
                  <span
                    className={cn(
                      'mt-1.5 h-2.5 w-2.5 flex-shrink-0',
                      job.state === 'ok'
                        ? 'bg-success'
                        : job.state === 'warning'
                          ? 'bg-signal'
                          : job.state === 'failing'
                            ? 'bg-danger'
                            : 'bg-border-strong'
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-sm font-semibold text-foreground">{job.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {job.lastSuccessAt ? `آخر نجاح ${timeAgoAr(job.lastSuccessAt)}` : 'ما فيه نجاح مسجل'}
                      </span>
                    </div>
                    <div
                      className={cn(
                        'mt-0.5 text-[13px]',
                        job.state === 'failing' ? 'font-semibold text-danger' : 'text-muted-foreground'
                      )}
                    >
                      {job.stateNote}
                      {job.runs24h > 0 && (
                        <span className="text-muted-foreground font-normal">
                          {' '}
                          · {formatNumberAr(job.runs24h)} تشغيل خلال 24 ساعة، {formatNumberAr(job.processed24h)} حساب
                          {job.errors24h > 0 && `، ${formatNumberAr(job.errors24h)} خطأ`}
                        </span>
                      )}
                    </div>
                    {job.lastError && job.state !== 'ok' && (
                      <p className="mt-1.5 break-all bg-muted px-2 py-1 font-mono text-[11px] leading-5 text-foreground" dir="ltr">
                        {job.lastError}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <dl className="grid grid-cols-2 content-start gap-x-6 gap-y-4 text-sm lg:col-span-2">
              <EngineStat label="توصيات طلعت" value={health.recommendations.created7d} note="آخر 7 أيام" />
              <EngineStat label="انتفذت" value={health.recommendations.applied7d} note="آخر 7 أيام" />
              <EngineStat label="فشل تنفيذها" value={health.recommendations.failed7d} danger={health.recommendations.failed7d > 0} />
              <EngineStat
                label="عالقة على قيد التنفيذ"
                value={health.recommendations.stuck}
                danger={health.recommendations.stuck > 0}
                note="أكثر من 30 دقيقة"
              />
              <EngineStat label="بانتظار موافقة العميل" value={health.recommendations.pending} />
              <EngineStat label="تراجع عنها العميل" value={health.actions.rolledBack7d} note={`من ${formatNumberAr(health.actions.executed7d)} تنفيذ`} />
              <EngineStat label="حسابات إعلانية شغالة" value={health.accounts.active} />
              <EngineStat
                label="ما تحدثت من يوم"
                value={health.accounts.staleSync}
                danger={health.accounts.staleSync > 0}
                note="من الحسابات الشغالة"
              />
              <EngineStat label="موقفة من قوقل" value={health.accounts.googleDisabled} />
              <EngineStat
                label="ويبهوك Stripe فشل"
                value={health.webhooksFailed}
                danger={health.webhooksFailed > 0}
                note={health.webhookTypes.length ? health.webhookTypes.join('، ') : 'آخر 7 أيام'}
              />
            </dl>
          </div>
        </section>

        {/* Operator log */}
        {!data.unavailable.includes('operator_audit_log') && (
          <section aria-labelledby="log-title">
            <SectionHead id="log-title" title="آخر إجراءاتك" note="كل تمديد وخطة مجانية وإيقاف، مين سواه ومتى وليش." />
            {data.auditLog.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">ما فيه إجراءات لين الحين. تلقاها في صفحة كل عميل.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border border-y border-border text-sm">
                {data.auditLog.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                    <span className={cn('font-semibold', row.status === 'failed' ? 'text-danger' : 'text-foreground')}>
                      {OPERATOR_ACTION_LABELS[row.action] ?? row.action}
                      {row.status === 'failed' && ' (فشل)'}
                    </span>
                    {row.target_user_id && (
                      <Link href={`/operations/users/${row.target_user_id}`} className="underline-offset-4 hover:underline" dir="ltr">
                        {emailById.get(row.target_user_id) ?? 'عميل محذوف'}
                      </Link>
                    )}
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.reason}</span>
                    <span className="text-xs text-muted-foreground">{timeAgoAr(row.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function AttentionRow({ item }: { item: ReturnType<typeof buildAttentionQueue>[number] }) {
  const { profile } = item;
  return (
    <li className="flex gap-3 py-3.5">
      <span
        className={cn(
          'mt-1.5 h-2.5 w-2.5 flex-shrink-0',
          item.severity === 'critical' ? 'bg-danger' : item.severity === 'high' ? 'bg-signal' : 'bg-border-strong'
        )}
        aria-label={item.severity === 'critical' ? 'عاجل' : item.severity === 'high' ? 'مهم' : 'متابعة'}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-6 text-foreground">{item.title}</p>
        <p className="text-[13px] leading-5 text-muted-foreground">{item.detail}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <Link href={`/operations/users/${profile.id}`} className="font-medium text-foreground underline-offset-4 hover:underline" dir="ltr">
            {profile.email}
          </Link>
          {profile.businessName && <span className="text-muted-foreground">{profile.businessName}</span>}
          <AccessChip access={profile.access} label={ACCESS_LABELS[profile.access]} />
          {item.more.length > 0 && <span className="text-muted-foreground">وكمان: {item.more.join('، ')}</span>}
        </div>
      </div>
      <div className="flex flex-shrink-0 items-start gap-1.5">
        <ContactButton profile={profile} text={item.whatsappText} compact />
        <Link
          href={`/operations/users/${profile.id}`}
          className="inline-flex h-8 w-8 items-center justify-center border border-border-strong text-foreground hover:border-foreground hover:bg-surface"
          aria-label={`ملف ${profile.email}`}
        >
          <ArrowUpLeft className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </li>
  );
}

function MoneyLine({ label, value, note, danger }: { label: string; value: string; note?: string; danger?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-end">
        <span className={cn('font-bold numeric', danger ? 'text-danger' : 'text-foreground')}>{value}</span>
        {note && <span className="block text-[11px] text-muted-foreground">{note}</span>}
      </dd>
    </div>
  );
}

function ChargeCalendar({ upcoming }: { upcoming: ReturnType<typeof computeRevenue>['upcoming'] }) {
  const max = Math.max(1, ...upcoming.map((day) => day.count));
  const busy = upcoming.filter((day) => day.count > 0);
  return (
    <div className="mt-6 border-t border-border pt-4">
      <div className="text-xs text-muted-foreground">تجارب تتحول لدفع خلال 14 يوم</div>
      <div className="mt-3 flex h-24 items-end gap-[3px]" role="img" aria-label="عدد التجارب اللي تنتهي كل يوم">
        {upcoming.map((day, index) => {
          const total = (day.count / max) * 100;
          return (
            <div
              key={day.date}
              className="flex h-full flex-1 flex-col justify-end"
              title={`${riyadhDayLabel(day.date)}: ${day.count} تجربة${day.atRisk ? `، ${day.atRisk} ما شافوا قيمة` : ''}`}
            >
              {day.count > 0 && (
                <span className="mb-0.5 text-center text-[10px] font-semibold leading-none numeric text-foreground">
                  {day.count}
                </span>
              )}
              <div className="flex w-full flex-col justify-end" style={{ height: `${Math.max(day.count ? 6 : 2, total)}%` }}>
                <div className="bg-danger" style={{ height: `${day.count ? (day.atRisk / day.count) * 100 : 0}%` }} />
                <div className={cn('flex-1', day.count ? 'bg-foreground' : 'bg-border')} />
              </div>
              <span className={cn('mt-1 text-center text-[10px] numeric', index === 0 ? 'font-bold text-foreground' : 'text-muted-foreground')}>
                {index === 0 ? 'اليوم' : day.date.slice(8)}
              </span>
            </div>
          );
        })}
      </div>
      {busy.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted-foreground">ما فيه تجربة تنتهي خلال الأسبوعين الجايين.</p>
      ) : (
        <ul className="mt-3 space-y-1.5 text-[13px]">
          {busy.slice(0, 5).map((day) => (
            <li key={day.date} className="flex items-baseline justify-between gap-3">
              <span className="text-foreground">{riyadhDayLabel(day.date)}</span>
              <span className="text-end text-muted-foreground">
                <span className="font-semibold text-foreground numeric">{formatNumberAr(day.count)}</span> تجربة ·{' '}
                {sar(day.value)}
                {day.atRisk > 0 && <span className="block text-danger">{formatNumberAr(day.atRisk)} منها ما شافوا قيمة</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="h-2 w-2 bg-danger" aria-hidden /> ما عنده حساب شغال أو ما سوّى فحص، يعني يدفع بدون ما شاف شي
      </p>
    </div>
  );
}

function RangeTabs({ range }: { range: FunnelRange }) {
  return (
    <nav className="flex border border-border text-xs" aria-label="فترة القمع">
      {(Object.keys(FUNNEL_RANGES) as FunnelRange[]).map((key) => (
        <Link
          key={key}
          href={key === '30d' ? '/operations#funnel-title' : `/operations?range=${key}#funnel-title`}
          aria-current={range === key ? 'true' : undefined}
          className={cn(
            'px-3 py-1.5 font-semibold',
            range === key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {FUNNEL_RANGES[key].label}
        </Link>
      ))}
    </nav>
  );
}

function FunnelBars({ steps }: { steps: ReturnType<typeof computeFunnel> }) {
  const top = Math.max(1, steps[0]?.reached ?? 0);
  return (
    <ol className="mt-5 space-y-2.5">
      {steps.map((step, index) => (
        <li key={step.stage} className="grid grid-cols-[7.5rem_1fr] items-center gap-x-3 gap-y-1 sm:grid-cols-[9rem_1fr_11rem]">
          <span className="text-sm text-foreground">{step.label}</span>
          <div className="flex items-center gap-2">
            <div className="h-6 flex-1 bg-muted">
              <div
                className={cn('h-full', index === steps.length - 1 ? 'bg-signal' : 'bg-foreground')}
                style={{ width: `${(step.reached / top) * 100}%`, minWidth: step.reached ? '2px' : 0 }}
              />
            </div>
            <span className="w-12 text-end text-sm font-bold numeric text-foreground">{formatNumberAr(step.reached)}</span>
          </div>
          <div className="col-start-2 flex items-baseline gap-2 text-xs text-muted-foreground sm:col-start-auto">
            {step.fromPrevious !== null && (
              <span className={cn('numeric', step.fromPrevious < 0.5 && step.dropped > 0 && 'font-semibold text-danger')}>
                {percent(step.fromPrevious)} من اللي قبل
              </span>
            )}
            {step.stuckHere > 0 && index < steps.length - 1 && (
              <Link href={`/operations/users?stage=${step.stage}`} className="underline underline-offset-4 hover:text-foreground">
                {formatNumberAr(step.stuckHere)} واقف هنا
              </Link>
            )}
          </div>
          {step.stuckHere > 0 && index < steps.length - 1 && (
            <span className="sr-only">{STAGE_NEXT_STEP[step.stage]}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function EngineStat({ label, value, note, danger }: { label: string; value: number; note?: string; danger?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('text-xl font-bold numeric', danger ? 'text-danger' : 'text-foreground')}>{formatNumberAr(value)}</dd>
      {note && <dd className="text-[11px] text-muted-foreground">{note}</dd>}
    </div>
  );
}

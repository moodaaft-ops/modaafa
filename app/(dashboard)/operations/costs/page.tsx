import Link from 'next/link';
import { requireOperatorPage } from '@/lib/platform/operator-page';
import { loadCostDataset, loadEmails } from '@/lib/platform/cost-data';
import {
  buildCostReport,
  optimizerMonthlyCeilingUsd,
  type CostAlert,
  type CostReport,
  type DailySpend,
  type SpendShare,
} from '@/lib/platform/cost-insights';
import { ANTHROPIC_CREDIT, CREDIT_READING_STALE_DAYS, DAILY_SPEND_ALERT_USD, RUNWAY_DANGER_DAYS, RUNWAY_WARNING_DAYS } from '@/lib/platform/cost-config';
import { OPTIMIZE_ACCOUNT_COOLDOWN_HOURS } from '@/lib/platform/job-capacity';
import { SAR_PER_USD } from '@/lib/ai/usage';
import { cn, formatNumberAr } from '@/lib/utils';
import { OpsTabs, SectionHead } from '../ops-ui';
import { percent, riyadhDayLabel, riyadhTime, shortDate, usd } from '../format';

export const metadata = { title: 'التكلفة · مركز التشغيل' };
export const dynamic = 'force-dynamic';

const FEATURE_LABELS: Record<string, string> = {
  optimizer: 'المحسّن (الجدولة)',
  audit: 'الفحص المجاني',
  assistant: 'المساعد',
  campaign_builder: 'منشئ الحملات',
  builder: 'منشئ الحملات',
  jarvis: 'جارفس',
  jarvis_fast: 'جارفس السريع',
  jarvis_deep: 'جارفس العميق',
  jarvis_memory: 'ذاكرة جارفس',
  chat_start_language: 'فهم طلب الدخول',
  reporter: 'التقرير الأسبوعي',
  support: 'خدمة العملاء',
  support_bot: 'خدمة العملاء',
};

const MODEL_LABELS: Array<[RegExp, string]> = [
  [/opus-5-5/, 'Opus 5.5'],
  [/sonnet-5-5/, 'Sonnet 5.5'],
  [/haiku-5-5/, 'Haiku 5.5'],
  [/opus/, 'Opus'],
  [/sonnet/, 'Sonnet'],
  [/haiku/, 'Haiku'],
];

const modelLabel = (model: string) => MODEL_LABELS.find(([pattern]) => pattern.test(model))?.[1] ?? model;
const featureLabel = (feature: string) => FEATURE_LABELS[feature] ?? feature;

/** Dollars with a fixed number of decimals, kept left-to-right inside Arabic text. */
function Usd({ value, digits = 2, className }: { value: number; digits?: number; className?: string }) {
  return (
    <bdi dir="ltr" className={cn('numeric', className)}>
      {usd(value, digits)}
    </bdi>
  );
}

/** Arabic count agreement: 1 يوم، 2 يومين، 3 إلى 10 أيام، 11 فما فوق يوم. */
function countAr(n: number, forms: { one: string; two: string; few: string; many: string }) {
  const value = Math.round(n);
  const abs = Math.abs(value);
  if (abs === 1) return forms.one;
  if (abs === 2) return forms.two;
  const label = abs >= 3 && abs <= 10 ? forms.few : forms.many;
  return `${formatNumberAr(value)} ${label}`;
}
const daysAr = (n: number) => countAr(n, { one: 'يوم', two: 'يومين', few: 'أيام', many: 'يوم' });
const timesAr = (n: number) => countAr(n, { one: 'مرة', two: 'مرتين', few: 'مرات', many: 'مرة' });
const callsAr = (n: number) => countAr(n, { one: 'نداء', two: 'نداءان', few: 'نداءات', many: 'نداء' });

const sarText = (valueUsd: number) => `${formatNumberAr(Math.round(valueUsd * SAR_PER_USD))} ريال تقريباً`;

function alertText(alert: CostAlert): string {
  const v = alert.values;
  switch (alert.code) {
    case 'daily_spike':
      return `${v.when === 'today' ? 'صرف اليوم' : 'صرف أمس'} وصل ${usd(Number(v.costUsd))} وهو فوق حد التنبيه ${usd(Number(v.limitUsd))}. شوف «وين يروح الصرف» تحت وحدد وش رفعه`;
    case 'week_rise':
      return `صرف آخر 7 أيام ${usd(Number(v.last7Usd))} مقابل ${usd(Number(v.prev7Usd))} للأسبوع اللي قبله، أعلى بنسبة ${formatNumberAr(Number(v.risePct))}%`;
    case 'unpriced_calls':
      return `${callsAr(Number(v.calls))} استخدم نموذجاً ما هو في جدول الأسعار، فتكلفته مقدّرة بأغلى سعر معروف وقد تكون أعلى من الحقيقة. قل لكلود يضيف سعر النموذج الجديد`;
    case 'metering_gap':
      return `المحسّن اشتغل في آخر يومين (${callsAr(Number(v.modelCalls))} للنموذج) ولا نزل أي سجل تكلفة. غالباً جدول llm_usage ناقص أو التسجيل فاشل، فكل أرقام هالصفحة أقل من الحقيقة`;
    case 'runway_critical':
      return `الرصيد التقديري ${usd(Number(v.balanceUsd))} ويكفي ${daysAr(Number(v.days))} فقط بالصرف الحالي. اشحن قبل ما يقف المحسّن`;
    case 'runway_low':
      return `الرصيد التقديري ${usd(Number(v.balanceUsd))} ويكفي ${daysAr(Number(v.days))} بالصرف الحالي`;
    case 'promo_expired':
      return `الرصيد الترويجي (قرابة ${usd(Number(v.promoUsd))}) انتهى وانطرح من التقدير. المتبقي من المدفوع قرابة ${usd(Number(v.balanceUsd))}. قارنه بالكونسول وحدّث القراءة`;
    case 'promo_expiring': {
      const runway = Number(v.paidRunwayDays);
      const tail = runway >= 0 ? ` ويكفي ${daysAr(runway)}` : '';
      return `الرصيد الترويجي (قرابة ${usd(Number(v.promoUsd))}) ينتهي بعد ${daysAr(Number(v.days))}. بعدها يبقى المدفوع فقط: ${usd(Number(v.paidAtExpiryUsd))}${tail}`;
    }
    case 'auto_reload_off':
      return 'الشحن التلقائي مطفي في كونسول أنثروبك. إذا خلص الرصيد يتوقف المحسّن وكل نداء للنموذج لين تشحن يدوياً';
    case 'reading_stale':
      return `قراءة الرصيد عمرها ${daysAr(Number(v.days))}، فالرقم التقديري قد يبعد عن الكونسول. قل لكلود يحدّثها`;
  }
}

const TONE_STYLE: Record<CostAlert['tone'], string> = {
  danger: 'border-danger/40 bg-danger/10',
  warning: 'border-warning/40 bg-warning/10',
  info: 'border-border bg-muted/40',
};
const TONE_DOT: Record<CostAlert['tone'], string> = {
  danger: 'bg-danger',
  warning: 'bg-signal',
  info: 'bg-border-strong',
};

function headline(report: CostReport): { tone: 'danger' | 'warning' | 'ok'; text: string } {
  const danger = report.alerts.find((alert) => alert.tone === 'danger');
  if (danger) return { tone: 'danger', text: alertText(danger) };
  if (report.last30.calls === 0) {
    return { tone: 'warning', text: 'ما فيه أي سجل تكلفة بعد. السجل يبدأ يتعبى مع أول نداء للنموذج بعد تشغيل ميقريشن llm_usage' };
  }
  const open = report.alerts.filter((alert) => alert.tone === 'warning').length;
  const base = `صرف اليوم ${usd(report.todaySpend.costUsd)}، وتوقع الشهر ${usd(report.monthProjectionUsd)}`;
  return open > 0
    ? { tone: 'warning', text: `${base}. وفيه ${open === 1 ? 'تنبيه واحد' : `${formatNumberAr(open)} تنبيهات`} تحت يستاهل نظرتك` }
    : { tone: 'ok', text: base };
}

export default async function OperationsCostsPage() {
  await requireOperatorPage('/operations/costs');
  const now = Date.now();

  const data = await loadCostDataset(now);
  const report = buildCostReport(data.rows, data.runs, {
    now,
    dailyAlertUsd: DAILY_SPEND_ALERT_USD,
    credit: ANTHROPIC_CREDIT,
    staleCreditDays: CREDIT_READING_STALE_DAYS,
    runwayWarningDays: RUNWAY_WARNING_DAYS,
    runwayDangerDays: RUNWAY_DANGER_DAYS,
  });
  const emails = await loadEmails(report.topUsers.map((user) => user.userId ?? ''));
  const top = headline(report);
  const credit = report.credit;
  const ceiling =
    data.activeAccounts === null
      ? null
      : optimizerMonthlyCeilingUsd(data.activeAccounts, OPTIMIZE_ACCOUNT_COOLDOWN_HOURS, report.optimizer.costPerCall7);

  return (
    <div className="pb-16">
      <header className="px-4 pb-2 pt-5 sm:px-6 lg:px-8">
        <h1 className="text-lg font-bold text-foreground">تكلفة الذكاء الاصطناعي</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          صرف نداءات Anthropic من سجل المنصة · بالدولار · للمالك فقط
        </p>
      </header>
      <OpsTabs active="costs" updatedAt={riyadhTime(now)} />

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
          <Strip
            label="صرف اليوم"
            value={<Usd value={report.todaySpend.costUsd} />}
            hint={
              <>
                أمس <Usd value={report.yesterday.costUsd} /> · {callsAr(report.todaySpend.calls)} اليوم
              </>
            }
          />
          <Strip
            label="المتوسط اليومي"
            value={<Usd value={report.last7.avgDailyUsd} />}
            hint={
              report.avgDailyDays === 0
                ? 'لا يوم كامل في السجل بعد، فهذا رقم اليوم الجزئي'
                : report.avgDailyDays < 7
                  ? `من ${daysAr(report.avgDailyDays)} كاملة فقط، فالمتوسط تقريبي`
                  : 'آخر 7 أيام كاملة بدون اليوم'
            }
          />
          <Strip
            label="توقع نهاية الشهر"
            value={<Usd value={report.monthProjectionUsd} />}
            hint={`${sarText(report.monthProjectionUsd)} · لحد الآن ${usd(report.monthToDate.costUsd)}`}
          />
          <Strip
            label="الرصيد التقديري"
            value={credit ? <Usd value={credit.estimatedBalanceUsd} /> : 'غير مضبوط'}
            hint={
              credit
                ? credit.runwayDays === null
                  ? 'ما فيه صرف كافي لحساب المدة'
                  : credit.daysToPromoExpiry !== null
                    ? `يكفي ${daysAr(credit.runwayDays)} بالصرف الحالي، والترويجي ينتهي بعد ${daysAr(credit.daysToPromoExpiry)}`
                    : `يكفي ${daysAr(credit.runwayDays)} بالصرف الحالي`
                : 'أضف قراءة الرصيد في cost-config'
            }
          />
        </dl>
      </section>

      <div className="space-y-10 px-4 pt-6 sm:px-6 lg:px-8">
        {data.ledgerMissing && (
          <div className="border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] leading-6 text-foreground">
            <span className="font-semibold">جدول سجل التكلفة ما انشغل بعد.</span> شغّل{' '}
            <code className="break-all font-mono text-xs" dir="ltr">
              db/migrations/20261012_llm_usage.sql
            </code>{' '}
            على Supabase، وبعدها تبدأ الأرقام تتجمع.
          </div>
        )}
        {data.ledgerTruncated && (
          <p className="border border-border-strong px-4 py-2.5 text-[13px] text-muted-foreground">
            سجل التكلفة أكبر من حد القراءة، فالأرقام أقل من الحقيقة. وقتها ننقل التجميع لقاعدة البيانات.
          </p>
        )}

        {report.alerts.length > 0 && (
          <section aria-labelledby="alerts-title">
            <SectionHead id="alerts-title" title="تنبيهات" note="الأحمر أولاً. كل سطر يقول وش صار وش تسوي." />
            <ul className="mt-4 space-y-2">
              {report.alerts.map((alert) => (
                <li key={alert.code} className={cn('flex items-start gap-3 border px-4 py-3 text-sm leading-6', TONE_STYLE[alert.tone])}>
                  <span className={cn('mt-2 h-2 w-2 flex-shrink-0', TONE_DOT[alert.tone])} aria-hidden />
                  <span>{alertText(alert)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="grid gap-10 lg:grid-cols-5">
          <section className="lg:col-span-3" aria-labelledby="daily-title">
            <SectionHead
              id="daily-title"
              title="الصرف يوم بيوم"
              note={
                report.firstRowDay
                  ? `الأسود للمحسّن والأصفر لكل الباقي. السجل يبدأ من ${riyadhDayLabel(report.firstRowDay)}، وأي يوم قبله فاضي لأنه ما كان مسجّل، مو لأنه ما فيه صرف.`
                  : 'الأسود للمحسّن والأصفر لكل الباقي.'
              }
              aside={
                <span className="text-sm font-semibold text-foreground">
                  <Usd value={report.last30.costUsd} /> <span className="font-normal text-muted-foreground">آخر 30 يوم</span>
                </span>
              }
            />
            <DailyChart days={report.daily} />
            <details className="group mt-3">
              <summary className="cursor-pointer list-none text-sm font-semibold text-foreground underline-offset-4 hover:underline">
                جدول الأيام
              </summary>
              <table className="mt-2 w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1.5 text-start font-medium">اليوم</th>
                    <th className="py-1.5 text-start font-medium">الصرف</th>
                    <th className="py-1.5 text-start font-medium">منه المحسّن</th>
                    <th className="py-1.5 text-start font-medium">النداءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border border-y border-border">
                  {[...report.daily].reverse().map((day) => (
                    <tr key={day.day}>
                      <td className="py-1.5">{riyadhDayLabel(day.day)}</td>
                      <td className="py-1.5">
                        <Usd value={day.costUsd} />
                      </td>
                      <td className="py-1.5">
                        <Usd value={day.optimizerUsd} />
                      </td>
                      <td className="py-1.5 numeric">{formatNumberAr(day.calls)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </section>

          <section className="lg:col-span-2" aria-labelledby="credit-title">
            <SectionHead
              id="credit-title"
              title="الرصيد عند أنثروبك"
              note="القراءة يدوية من الكونسول. المنصة ما تقدر تقرأ الرصيد بنفسها، فنطرح منه الصرف المسجّل بعد القراءة."
            />
            {credit ? (
              <dl className="mt-4 divide-y divide-border border-y border-border text-sm">
                <Line label="آخر قراءة من الكونسول" value={<><Usd value={credit.balanceAtReadUsd} /> · {shortDate(credit.readAt)}</>} />
                <Line label="صُرف بعدها (حسب السجل)" value={<Usd value={credit.spentSinceReadUsd} />} />
                <Line label="التقديري الآن" value={<Usd value={credit.estimatedBalanceUsd} className="font-bold" />} />
                <Line
                  label="يكفي بمعدل آخر 7 أيام"
                  value={credit.runwayDays === null ? 'ما فيه صرف كافي للحساب' : daysAr(credit.runwayDays)}
                />
                <Line
                  label="الرصيد الترويجي"
                  value={
                    credit.promoExpiresOn ? (
                      <>
                        <Usd value={credit.promoUsd} /> · ينتهي {shortDate(`${credit.promoExpiresOn}T12:00:00+03:00`)}
                        {credit.daysToPromoExpiry !== null && ` (بعد ${daysAr(credit.daysToPromoExpiry)})`}
                      </>
                    ) : (
                      <Usd value={credit.promoUsd} />
                    )
                  }
                />
                <Line
                  label="المدفوع الحقيقي"
                  value={
                    <>
                      <Usd value={credit.purchasedUsd} />
                      {credit.paidAtExpiryUsd !== null && (
                        <>
                          {' '}
                          · يبقى عند انتهاء الترويجي <Usd value={credit.paidAtExpiryUsd} />
                          {credit.paidRunwayDays !== null && ` ويكفي ${daysAr(credit.paidRunwayDays)}`}
                        </>
                      )}
                    </>
                  }
                />
                <Line
                  label="الشحن التلقائي"
                  value={<span className={credit.autoReload ? 'text-success' : 'font-semibold text-danger'}>{credit.autoReload ? 'شغال' : 'مطفي'}</span>}
                />
              </dl>
            ) : (
              <p className="mt-4 border border-border px-4 py-6 text-sm text-muted-foreground">
                قراءة الرصيد غير مضبوطة. تنكتب في lib/platform/cost-config.ts.
              </p>
            )}
            <p className="mt-3 text-[13px] leading-6 text-muted-foreground">
              ما يدخل في الحساب: صرف مفتاح ثاني على نفس الرصيد (مفتاح قربانم)، وصوت ElevenLabs، وأي نداء قبل بداية السجل.
              فالرصيد الحقيقي ينزل أسرع من التقديري هنا. بعد كل شحن قل لكلود يحدّث القراءة.
            </p>
          </section>
        </div>

        <div className="grid gap-10 lg:grid-cols-2">
          <section aria-labelledby="features-title">
            <SectionHead id="features-title" title="وين يروح الصرف" note="آخر 30 يوم، الأغلى أول." />
            <ShareList items={report.byFeature} label={featureLabel} empty="ما فيه نداءات مسجّلة بعد." />
          </section>
          <section aria-labelledby="models-title">
            <SectionHead id="models-title" title="حسب النموذج" note="Opus أغلى من Sonnet بضعفين تقريباً، وHaiku أرخص بعشرين ضعفاً." />
            <ShareList items={report.byModel} label={modelLabel} empty="ما فيه نداءات مسجّلة بعد." />
          </section>
        </div>

        <section aria-labelledby="optimizer-title">
          <SectionHead
            id="optimizer-title"
            title="المحسّن"
            note="أكبر بند في الفاتورة. كل جولة تنادي النموذج مرة لكل حساب مستحق للمراجعة."
          />
          <dl className="mt-4 grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
            <Cell
              label="جولات آخر 7 أيام"
              value={formatNumberAr(report.optimizer.runs7)}
              hint={
                report.optimizer.failedRuns7 > 0
                  ? `${formatNumberAr(report.optimizer.failedRuns7)} منها فشلت`
                  : `${(report.optimizer.runs7 / 7).toFixed(1)} باليوم تقريباً`
              }
            />
            <Cell
              label="تكلفة النداء الواحد"
              value={report.optimizer.costPerCall7 === null ? 'لا بيانات' : usd(report.optimizer.costPerCall7, 4)}
              hint={`${callsAr(report.optimizer.ledgerCalls7)} في 7 أيام`}
            />
            <Cell
              label="تكلفة الجولة الواحدة"
              value={report.optimizer.costPerRun7 === null ? 'لا بيانات' : usd(report.optimizer.costPerRun7, 3)}
              hint="كل حسابات الجولة"
            />
            <Cell
              label="أقصى صرف شهري للمحسّن"
              value={ceiling === null ? 'بلا سقف' : usd(ceiling, 0)}
              hint={
                OPTIMIZE_ACCOUNT_COOLDOWN_HOURS > 0
                  ? `${formatNumberAr(data.activeAccounts ?? 0)} حساب، كل حساب مرة كل ${formatNumberAr(OPTIMIZE_ACCOUNT_COOLDOWN_HOURS)} ساعة كحد أعلى`
                  : 'الراحة مطفية، فالصرف يتبع عدد الجولات'
              }
            />
          </dl>
          <div className="mt-4 border border-border px-4 py-3 text-sm leading-6">
            <p className="font-semibold text-foreground">وش وفّرت الحراس</p>
            {report.optimizer.guardRuns7 === 0 ? (
              <p className="mt-1 text-muted-foreground">
                الحراس (راحة {formatNumberAr(OPTIMIZE_ACCOUNT_COOLDOWN_HOURS)} ساعة لكل حساب، وتخطي الحساب الخامل) ما سجّلوا جولة بعد. تظهر الأرقام بعد أول جولة من النسخة المنشورة.
              </p>
            ) : (
              <p className="mt-1 text-muted-foreground">
                في آخر 7 أيام مرّت الجولات {timesAr(report.optimizer.cooledDown7)} على حساب في راحته، و{timesAr(report.optimizer.skippedIdle7)} على حساب خامل بلا إنفاق، وما كلّفتنا أي منها نداء.
                {report.optimizer.avoidedUsd7 !== null && (
                  <>
                    {' '}بسعر النداء المتوسط هذا يعادل قرابة <Usd value={report.optimizer.avoidedUsd7} /> (تقدير، مو رقم مقاس).
                  </>
                )}
              </p>
            )}
          </div>
        </section>

        <section aria-labelledby="cache-title">
          <SectionHead
            id="cache-title"
            title="الكاش"
            note="التعليمات الثابتة اللي تنقرأ من الكاش تكلّف خمسة بالمئة من سعر الإدخال العادي. آخر 7 أيام."
          />
          {report.cache.readTokens + report.cache.writeTokens === 0 ? (
            <p className="mt-4 border border-border px-4 py-5 text-sm leading-6 text-muted-foreground">
              ما سجّلنا أي قراءة كاش بعد. يظهر الرقم بعد نشر النسخة الجديدة بيوم. لو بقي صفر بعدها، يعني الكاش ما اشتغل ونراجعه.
            </p>
          ) : (
            <dl className="mt-4 grid gap-px border border-border bg-border sm:grid-cols-3">
              <Cell label="نسبة القراءة من الكاش" value={percent(report.cache.hitRatio)} hint="من كل توكنات الإدخال" />
              <Cell label="الصافي الموفّر" value={usd(report.cache.netSavingUsd, 3)} hint="بعد خصم رسوم الكتابة في الكاش" />
              <Cell
                label="توكنات من الكاش"
                value={formatNumberAr(report.cache.readTokens)}
                hint={`مقابل ${formatNumberAr(report.cache.freshInputTokens)} توكن إدخال عادي`}
              />
            </dl>
          )}
        </section>

        <section aria-labelledby="users-title">
          <SectionHead id="users-title" title="أكثر العملاء صرفاً" note="آخر 30 يوم. الصف بلا عميل هو صرف المنصة نفسها." />
          {report.topUsers.length === 0 ? (
            <p className="mt-4 border border-border px-4 py-5 text-sm text-muted-foreground">ما فيه صرف مسجّل بعد.</p>
          ) : (
            <ol className="mt-4 divide-y divide-border border-y border-border">
              {report.topUsers.map((user) => {
                const label = user.userId ? emails.get(user.userId) ?? 'عميل (البريد غير متاح)' : 'المنصة (بلا عميل)';
                return (
                  <li key={user.userId ?? 'platform'} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 text-sm">
                    <span className="min-w-0">
                      {user.userId ? (
                        <Link href={`/operations/users/${user.userId}`} className="font-semibold text-foreground underline-offset-4 hover:underline">
                          <bdi dir="ltr">{label}</bdi>
                        </Link>
                      ) : (
                        <span className="font-semibold text-foreground">{label}</span>
                      )}
                      {user.topFeature && <span className="ms-2 text-xs text-muted-foreground">أغلى بند: {featureLabel(user.topFeature)}</span>}
                    </span>
                    <span className="numeric text-muted-foreground">
                      {callsAr(user.calls)} · <Usd value={user.costUsd} className="font-semibold text-foreground" />
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

function Strip({ label, value, hint }: { label: string; value: React.ReactNode; hint: React.ReactNode }) {
  return (
    <div className="bg-foreground py-3 pe-3 sm:pe-5">
      <dt className="text-xs text-background/70">{label}</dt>
      <dd className="mt-1 text-3xl font-bold leading-none numeric">{value}</dd>
      <dd className="mt-1 text-[11px] text-background/60">{hint}</dd>
    </div>
  );
}

function Cell({ label, value, hint }: { label: string; value: React.ReactNode; hint: React.ReactNode }) {
  return (
    <div className="bg-background px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-bold leading-none numeric text-foreground">
        <bdi dir="ltr">{value}</bdi>
      </dd>
      <dd className="mt-1.5 text-[12px] leading-5 text-muted-foreground">{hint}</dd>
    </div>
  );
}

function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

function ShareList({
  items,
  label,
  empty,
}: {
  items: SpendShare[];
  label: (key: string) => string;
  empty: string;
}) {
  if (items.length === 0) {
    return <p className="mt-4 border border-border px-4 py-5 text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ol className="mt-4 divide-y divide-border border-y border-border">
      {items.map((item) => (
        <li key={item.key} className="py-2.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 font-semibold text-foreground">{label(item.key)}</span>
            <span className="numeric text-muted-foreground">
              {callsAr(item.calls)} · <Usd value={item.costUsd} className="font-semibold text-foreground" /> · <bdi dir="ltr">{percent(item.share)}</bdi>
            </span>
          </div>
          <div className="mt-1.5 h-1.5 bg-border" aria-hidden>
            <div className="h-full bg-foreground" style={{ width: `${Math.max(1, Math.round(item.share * 100))}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function DailyChart({ days }: { days: DailySpend[] }) {
  const max = Math.max(...days.map((day) => day.costUsd), 0.000001);
  const total = days.reduce((sum, day) => sum + day.costUsd, 0);
  return (
    <figure className="mt-4">
      <div
        className="flex h-36 items-end gap-[3px] border-b border-border"
        role="img"
        aria-label={`الصرف اليومي لآخر 30 يوم، المجموع ${usd(total)}`}
      >
        {days.map((day) => {
          const heightPct = (day.costUsd / max) * 100;
          const optimizerPct = day.costUsd > 0 ? (day.optimizerUsd / day.costUsd) * 100 : 0;
          return (
            <div
              key={day.day}
              className="flex h-full flex-1 flex-col justify-end"
              title={`${riyadhDayLabel(day.day)} · ${usd(day.costUsd)} · ${callsAr(day.calls)}`}
            >
              {day.costUsd > 0 && (
                <div className="flex w-full flex-col justify-end" style={{ height: `${Math.max(2, heightPct)}%` }}>
                  <div className="w-full bg-signal" style={{ height: `${100 - optimizerPct}%` }} />
                  <div className="w-full bg-foreground" style={{ height: `${optimizerPct}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <figcaption className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
        <span>{riyadhDayLabel(days[0].day).split(' ').slice(-2).join(' ')}</span>
        <span>اليوم</span>
      </figcaption>
    </figure>
  );
}

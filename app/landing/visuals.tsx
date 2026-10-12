'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import Image from 'next/image';
import { Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
 * Drawn explainers for the landing page. Every figure here is illustrative
 * (a representative perfume-store account) and the page labels it as such;
 * the rules they draw (7 days, 20 clicks, 25% / 30%, 20%, 50%, 30 days) are
 * the real ones from lib/ai/optimizer-agent.ts and checkGuardrails.
 *
 * Motion rules: each figure plays once when it scrolls into view. Text is
 * never hidden behind an animation (only bars, lines and squares move), so
 * the page reads the same with JavaScript off or reduced motion on.
 */

const PAPER = '#F4F2EC';
const NAVY = '#0E1426';
const SIGNAL = '#FBBC04';

const hatch = (color: string): CSSProperties => ({
  backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 1.5px, transparent 1.5px 6px)`,
});
const delay = (ms: number): CSSProperties => ({ transitionDelay: `${ms}ms` });

function useInView<T extends Element>(threshold = 0.35) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold, rootMargin: '0px 0px -8% 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);

  return [ref, inView] as const;
}

/** Flips to true `ms` after `on` does, for second beats (a toggle switching off after the bars grow). */
function useLater(on: boolean, ms: number) {
  const [later, setLater] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = window.setTimeout(() => setLater(true), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return later;
}

const ease = 'motion-safe:transition-all motion-safe:duration-700 motion-safe:ease-snap';

/* ------------------------------------------------------------------------ */
/* A normal day: cumulative spend through one day, with the four leaks.     */
/* ------------------------------------------------------------------------ */

type DayEvent = {
  at: number;
  time: string;
  period: 'ص' | 'م';
  title: string;
  text: string;
  kind: 'clicks' | 'budget' | 'twoweeks' | 'rotation';
};

const DAY_EVENTS: DayEvent[] = [
  { at: 9 + 10 / 60, time: '9:10', period: 'ص', title: 'عبارة «عود مجاني»', text: 'أخذت 14 ضغطة من الصبح. ولا طلب.', kind: 'clicks' },
  {
    at: 13 + 40 / 60,
    time: '1:40',
    period: 'م',
    title: 'حملة الطلبات',
    text: 'خلّصت ميزانيتها قبل الظهر، وسكتت وقت الذروة.',
    kind: 'budget',
  },
  { at: 18.25, time: '6:15', period: 'م', title: 'كلمة «عطورات»', text: 'تصرف من أسبوعين، وما جابت تحويل واحد.', kind: 'twoweeks' },
  {
    at: 23.5,
    time: '11:30',
    period: 'م',
    title: 'إعلان ضعيف',
    text: 'قوقل يقيّمه ضعيف، وللحين يتناوب مع إعلانك الأقوى.',
    kind: 'rotation',
  },
];

const DAY_START = 6;
const DAY_END = 24;
const DRAW_MS = 2600;
const dayPos = (h: number) => ((h - DAY_START) / (DAY_END - DAY_START)) * 100;

// Spend per hour on a representative day: busy morning until the main
// campaign runs dry at 11:45, a quiet early afternoon, then the evening.
const RATE: Array<[number, number]> = [
  [8, 2],
  [11.75, 9],
  [14, 2.5],
  [18, 5],
  [22, 6.5],
  [24, 3],
];
function spendAt(h: number) {
  let total = 0;
  let from = DAY_START;
  for (const [until, rate] of RATE) {
    const to = Math.min(h, until);
    if (to > from) total += (to - from) * rate;
    from = until;
    if (h <= until) break;
  }
  return total;
}
const SPEND_TOTAL = spendAt(DAY_END);
const chartY = (h: number) => 150 - (spendAt(h) / SPEND_TOTAL) * 130; // viewBox 0..160
const chartX = (h: number) => 1000 - dayPos(h) * 10; // RTL: morning on the right

const SPEND_PATH = (() => {
  const pts: string[] = [];
  for (let h = DAY_START; h <= DAY_END + 0.001; h += 0.25) pts.push(`${chartX(h).toFixed(1)},${chartY(h).toFixed(1)}`);
  return `M${pts.join(' L')}`;
})();

const TICKS: Array<[number, string, string]> = [
  [6, '6', 'ص'],
  [9, '9', 'ص'],
  [12, '12', 'م'],
  [15, '3', 'م'],
  [18, '6', 'م'],
  [21, '9', 'م'],
  [24, '12', 'ص'],
];

export function DayLeaks() {
  const [ref, inView] = useInView<HTMLDivElement>(0.25);
  const reach = (h: number) => Math.round((dayPos(h) / 100) * DRAW_MS);

  return (
    <div ref={ref}>
      <div className="flex items-center justify-between text-[12.5px] text-brand-paper/55">
        <span>الصرف من الصبح، يوم تمثيلي</span>
        <span className="flex items-center gap-2">
          <span className="h-2 w-2 bg-brand-signal" aria-hidden />
          صرف ما جاب شي
        </span>
      </div>

      {/* Chart */}
      <div className="relative mt-4 h-40 sm:h-52" aria-hidden>
        <svg viewBox="0 0 1000 160" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
          {TICKS.map(([h]) => (
            <line key={h} x1={chartX(h)} x2={chartX(h)} y1={6} y2={150} stroke={PAPER} strokeOpacity={0.08} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={`${SPEND_PATH} L${chartX(DAY_END)},150 L${chartX(DAY_START)},150 Z`} fill={PAPER} fillOpacity={0.05} />
          <path d={SPEND_PATH} fill="none" stroke={PAPER} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
        {/* The line draws from morning (right) to night (left): a navy cover slides off it. */}
        <div
          className="absolute inset-y-0 left-0 bg-brand-navy motion-safe:transition-[width] motion-safe:ease-[cubic-bezier(0.65,0,0.35,1)]"
          style={{ width: inView ? '0%' : '100%', transitionDuration: `${DRAW_MS}ms` }}
        />
        {DAY_EVENTS.map((event) => (
          <div
            key={event.time}
            className="absolute"
            style={{ right: `${Math.min(dayPos(event.at), 98.5)}%`, top: `${(chartY(event.at) / 160) * 100}%`, bottom: 0 }}
          >
            <span
              className={cn('absolute bottom-0 top-0 w-px translate-x-1/2 border-s border-dashed border-brand-signal/60', ease)}
              style={{ ...delay(reach(event.at)), opacity: inView ? 1 : 0 }}
            />
            <span
              className={cn('absolute -top-[7px] h-[14px] w-[14px] translate-x-1/2 bg-brand-signal outline outline-4 outline-brand-navy', ease)}
              style={{ ...delay(reach(event.at)), transform: `translateX(50%) scale(${inView ? 1 : 0})` }}
            />
          </div>
        ))}
      </div>

      {/* Day ruler */}
      <div className="relative h-8 border-t border-brand-paper/30 text-[11.5px] text-brand-paper/55" aria-hidden>
        {TICKS.map(([h, num, period], i) => (
          <span
            key={h}
            className="absolute top-2 whitespace-nowrap"
            style={{
              right: `${dayPos(h)}%`,
              transform: i === 0 ? 'none' : i === TICKS.length - 1 ? 'translateX(100%)' : 'translateX(50%)',
            }}
          >
            <span className="font-numeric">{num}</span> {period}
          </span>
        ))}
      </div>

      <ol className="mt-8 grid gap-px bg-brand-paper/15 sm:grid-cols-2 lg:grid-cols-4">
        {DAY_EVENTS.map((event) => (
          <li key={event.time} className="flex flex-col bg-brand-navy p-6 lg:pe-8">
            <div className="flex items-center gap-2.5">
              <span
                className={cn('h-2 w-2 motion-safe:transition-colors motion-safe:duration-300', inView ? 'bg-brand-signal' : 'bg-brand-paper/25')}
                style={delay(reach(event.at))}
                aria-hidden
              />
              <span className="text-[14px] text-brand-paper/60">
                <span dir="ltr" className="font-numeric text-[22px] font-medium text-brand-paper">
                  {event.time}
                </span>{' '}
                {event.period}
              </span>
            </div>
            <div className="mt-5 h-[76px]" aria-hidden>
              <DayVisual kind={event.kind} on={inView} start={reach(event.at)} />
            </div>
            <p className="mt-5 text-[15.5px] font-bold">{event.title}</p>
            <p className="mt-1 text-[15px] leading-7 text-brand-paper/75">{event.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function DayVisual({ kind, on, start }: { kind: DayEvent['kind']; on: boolean; start: number }) {
  if (kind === 'clicks') {
    return (
      <div className="space-y-2.5 text-[11.5px] text-brand-paper/60">
        <div className="flex items-center gap-3">
          <span className="w-11 flex-shrink-0">ضغطات</span>
          <span className="grid grid-cols-7 gap-[3px]">
            {Array.from({ length: 14 }, (_, i) => (
              <span
                key={i}
                className={cn('h-2.5 w-2.5 border border-brand-paper/40 motion-safe:transition-colors motion-safe:duration-200', on && 'bg-brand-paper')}
                style={delay(start + i * 70)}
              />
            ))}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-11 flex-shrink-0">طلبات</span>
          <span className="h-2.5 w-2.5 border border-dashed border-brand-signal" />
          <span className="font-numeric text-[13px] font-semibold text-brand-signal">0</span>
        </div>
      </div>
    );
  }

  if (kind === 'budget') {
    return (
      <div className="text-[11.5px] text-brand-paper/60">
        <div className="mb-1.5 flex justify-end">
          <span className="border-b border-brand-signal pb-0.5 text-brand-signal" style={{ width: '46%' }}>
            وقت الذروة
          </span>
        </div>
        <div className="relative h-4 border border-brand-paper/40">
          <span
            className={cn('absolute inset-y-0 right-0 bg-brand-paper', ease)}
            style={{ ...delay(start), width: on ? '26%' : '0%' }}
          />
          <span
            className={cn('absolute inset-y-0 left-0 motion-safe:transition-opacity motion-safe:duration-500')}
            style={{ ...hatch('rgba(251,188,4,0.7)'), ...delay(start + 600), width: '74%', opacity: on ? 1 : 0 }}
          />
        </div>
        <div className="relative mt-1.5 h-4">
          <span className="absolute right-0">8ص</span>
          <span className="absolute text-brand-paper" style={{ right: '26%', transform: 'translateX(50%)' }}>
            نفدت
          </span>
          <span className="absolute left-0">11م</span>
        </div>
      </div>
    );
  }

  if (kind === 'twoweeks') {
    const spend = [5, 7, 6, 8, 5, 9, 7, 6, 8, 7, 9, 6, 8, 7];
    return (
      <div className="flex h-full flex-col text-[11.5px] text-brand-paper/60">
        <div className="flex flex-1 items-end gap-[3px]">
          {spend.map((v, i) => (
            <span
              key={i}
              className={cn('flex-1 bg-brand-paper/70', ease)}
              style={{ ...delay(start + i * 45), height: on ? `${v * 10}%` : '0%' }}
            />
          ))}
        </div>
        <div className="h-[2px] bg-brand-signal" />
        <div className="mt-1.5 flex justify-between">
          <span>14 يوم صرف</span>
          <span className="text-brand-signal">
            تحويلات <span className="font-numeric font-semibold">0</span>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 text-[11.5px] text-brand-paper/60">
      {[
        { label: 'إعلانك الأقوى', share: 52, weak: false },
        { label: 'الإعلان الضعيف', share: 48, weak: true },
      ].map((ad, i) => (
        <div key={ad.label}>
          <div className="flex justify-between">
            <span className={ad.weak ? 'text-brand-signal' : undefined}>{ad.label}</span>
            <span dir="ltr" className="font-numeric">
              {ad.share}%
            </span>
          </div>
          <div className="mt-1 h-2.5 border border-brand-paper/25">
            <span
              className={cn('block h-full', ease, ad.weak ? '' : 'bg-brand-paper')}
              style={{
                ...delay(start + i * 200),
                width: on ? `${ad.share}%` : '0%',
                ...(ad.weak ? hatch(SIGNAL) : {}),
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* How it works: five stops with a status square travelling between them.   */
/* ------------------------------------------------------------------------ */

type FlowKind = 'account' | 'read' | 'plan' | 'approve' | 'apply';
const FLOW: Array<{ kind: FlowKind; title: string; body: string }> = [
  { kind: 'account', title: 'تربط حسابك', body: 'من شاشة قوقل الرسمية. ما نطلب كلمة مرورك، والصلاحية لإعلانات قوقل بس.' },
  { kind: 'read', title: 'يقرا آخر 30 يوم', body: 'الفحص الأول مجاني: وين تروح الفلوس، وهل تتبع التحويلات سليم أصلاً.' },
  { kind: 'plan', title: 'خطة اليوم', body: 'قرارات مرتبة حسب أثرها، وكل قرار معه سببه من أرقام حسابك.' },
  { kind: 'approve', title: 'أنت تعتمد', body: 'ضغطة اعتمد أو تجاهل. ما يتحرك شي في الحساب قبلها.' },
  { kind: 'apply', title: 'يتطبق في قوقل', body: 'مُضاعِف ينفّذه في حسابك بنفسه، وتقدر تتراجع عنه خلال 30 يوم.' },
];

function Pictogram({ kind }: { kind: FlowKind }) {
  const common = { fill: 'none', stroke: NAVY, strokeWidth: 1.6, strokeLinecap: 'square' as const };
  switch (kind) {
    case 'account':
      return (
        <svg viewBox="0 0 40 40" className="h-10 w-10" aria-hidden>
          <rect x="5" y="7" width="30" height="26" {...common} />
          <path d="M12 27v-5M19 27v-9M26 27v-13" {...common} strokeWidth={3} />
        </svg>
      );
    case 'read':
      return (
        <span className="relative block h-10 w-10 overflow-hidden" aria-hidden>
          <svg viewBox="0 0 40 40" className="h-10 w-10">
            <rect x="5" y="5" width="30" height="30" {...common} />
            <path d="M11 13h18M11 19h14M11 25h18M11 31h10" {...common} strokeOpacity={0.45} />
          </svg>
          <span className="absolute inset-x-[6px] top-[7px] h-[2px] bg-brand-signal motion-safe:animate-scan" />
        </span>
      );
    case 'plan':
      return (
        <svg viewBox="0 0 40 40" className="h-10 w-10" aria-hidden>
          <rect x="5" y="5" width="30" height="30" {...common} />
          <rect x="10" y="11" width="5" height="5" fill={SIGNAL} className="motion-safe:animate-lamp" />
          <rect x="10" y="19" width="5" height="5" fill={NAVY} fillOpacity={0.35} />
          <rect x="10" y="27" width="5" height="5" fill={NAVY} fillOpacity={0.35} />
          <path d="M19 13.5h11M19 21.5h9M19 29.5h11" {...common} />
        </svg>
      );
    case 'approve':
      return (
        <svg viewBox="0 0 40 40" className="h-10 w-10" aria-hidden>
          <rect x="4" y="12" width="32" height="16" fill={NAVY} />
          <path d="M14 20.5l4 4 8-9" fill="none" stroke={PAPER} strokeWidth={2} strokeLinecap="square" />
        </svg>
      );
    case 'apply':
      return (
        <svg viewBox="0 0 40 40" className="h-10 w-10" aria-hidden>
          <rect x="4" y="9" width="27" height="24" {...common} />
          <path d="M10 27v-4M16 27v-7M22 27v-11" {...common} strokeWidth={3} />
          <rect x="25" y="4" width="12" height="12" fill={NAVY} />
          <path d="M28 10l2.2 2.2 4-4.4" fill="none" stroke={PAPER} strokeWidth={1.6} strokeLinecap="square" />
        </svg>
      );
  }
}

export function FlowDiagram() {
  return (
    <>
      {/* Desktop: five stops in a row */}
      <div className="relative hidden pt-14 lg:block">
        {/* Undo loop from the last stop back to approval */}
        <div className="absolute top-0 h-14" style={{ left: '10%', width: '20%' }} aria-hidden>
          <svg viewBox="0 0 100 56" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
            <path d="M2 56 V22 H98 V50" fill="none" stroke={NAVY} strokeOpacity={0.45} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          </svg>
          <span className="absolute -right-[5px] bottom-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-brand-navy/60" />
          <span className="absolute inset-x-0 -top-1 flex items-center justify-center gap-1.5 text-[12.5px] font-semibold text-brand-navy">
            <Undo2 className="h-3.5 w-3.5" />
            تراجع خلال 30 يوم
          </span>
        </div>

        <ol className="relative grid grid-cols-5">
          <div className="absolute top-10 h-px bg-brand-navy/30" style={{ left: '10%', right: '10%' }} aria-hidden>
            <div dir="ltr" className="absolute inset-0">
              <span className="absolute -top-[5px] h-[11px] w-[11px] -translate-x-1/2 bg-brand-signal motion-safe:animate-flow-x motion-reduce:left-0" />
            </div>
          </div>
          {FLOW.map((step, i) => (
            <li key={step.kind} className="relative flex flex-col items-center px-4 text-center">
              <span className="relative z-10 flex h-20 w-20 items-center justify-center border border-brand-navy bg-brand-paper">
                <Pictogram kind={step.kind} />
              </span>
              <span dir="ltr" className="mt-5 font-numeric text-[12px] text-brand-slate">
                0{i + 1}
              </span>
              <h3 className="mt-1 text-[17px] font-bold leading-7">{step.title}</h3>
              <p className="mt-2 max-w-[13rem] text-[14.5px] leading-7 text-brand-slate">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>

      {/* Phones and tablets: the same stops, stacked */}
      <ol className="relative lg:hidden">
        <span className="absolute bottom-10 top-10 w-px bg-brand-navy/30" style={{ insetInlineStart: '31.5px' }} aria-hidden />
        {FLOW.map((step, i) => (
          <li key={step.kind} className="relative grid grid-cols-[64px_minmax(0,1fr)] gap-5 pb-8 last:pb-0">
            <span className="relative z-10 flex h-16 w-16 items-center justify-center border border-brand-navy bg-brand-paper">
              <Pictogram kind={step.kind} />
            </span>
            <div className="pt-1">
              <span dir="ltr" className="block font-numeric text-[12px] text-brand-slate">
                0{i + 1}
              </span>
              <h3 className="text-[17px] font-bold leading-7">{step.title}</h3>
              <p className="mt-1 text-[15px] leading-7 text-brand-slate">{step.body}</p>
              {step.kind === 'apply' && (
                <p className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-semibold">
                  <Undo2 className="h-3.5 w-3.5" aria-hidden />
                  تراجع خلال 30 يوم
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* The product screen: today's plan inside the dashboard.                   */
/* ------------------------------------------------------------------------ */

const PLAN_ROWS = [
  {
    tone: 'danger' as const,
    title: 'تحويل «شراء» ما سجّل شي من 3 أيام',
    meta: 'التتبع أول: قرارات الميزانية واقفة لين ينحل',
    impact: 'يحتاج تدخلك',
    cta: 'شوف السبب',
  },
  {
    tone: 'signal' as const,
    title: 'أوقف الكلمة «عطورات»',
    meta: 'حملة البحث · 14 يوم، 46 ضغطة، بدون تحويل',
    impact: 'توفير متوقع شهرياً 610 ريال',
    cta: 'اعتمد',
  },
  {
    tone: 'signal' as const,
    title: 'أضف «دهن عود كمبودي» ككلمة مطابقة',
    meta: 'حملة البحث · 31 ضغطة، 4 طلبات في 30 يوم',
    impact: 'زيادة متوقعة في الطلبات',
    cta: 'اعتمد',
  },
];

export function PlanScreen() {
  const [ref, inView] = useInView<HTMLElement>(0.25);

  return (
    <figure ref={ref} className="border border-brand-navy bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-brand-navy/15 px-4 py-2.5" aria-hidden>
        <span className="flex gap-1.5">
          <span className="h-2.5 w-2.5 bg-brand-navy/15" />
          <span className="h-2.5 w-2.5 bg-brand-navy/15" />
          <span className="h-2.5 w-2.5 bg-brand-navy/15" />
        </span>
        <span dir="ltr" className="font-numeric text-[12px] text-brand-slate">
          ai.modaafa.com/dashboard
        </span>
        <span className="w-10" />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[12rem_minmax(0,1fr)]">
        <aside className="hidden bg-brand-navy px-4 py-5 text-[13.5px] text-brand-paper/70 sm:block" aria-hidden>
          <Image src="/brand/modaafa-lockup-reversed.svg" alt="" width={120} height={28} className="h-6 w-auto" />
          <ul className="mt-7 space-y-1">
            {[
              ['لوحة التحكم', true, null],
              ['الموافقات', false, 3],
              ['الحملات', false, null],
              ['التقارير', false, null],
              ['المساعد', false, null],
            ].map(([label, active, count]) => (
              <li
                key={label as string}
                className={cn(
                  'flex items-center justify-between border-s-2 px-3 py-2',
                  active ? 'border-brand-signal bg-brand-paper/10 text-brand-paper' : 'border-transparent'
                )}
              >
                {label}
                {count ? <span className="font-numeric text-[12px] text-brand-signal">{count as number}</span> : null}
              </li>
            ))}
          </ul>
        </aside>

        <div className="p-5 sm:p-7">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-[19px] font-bold">خطة اليوم</p>
            <p className="text-[12.5px] text-brand-slate">
              الأحد، آخر قراءة{' '}
              <span dir="ltr" className="font-numeric">
                8:02
              </span>{' '}
              ص
            </p>
          </div>
          <p className="mt-1 text-[14px] text-brand-slate">3 قرارات تنتظرك، مرتبة حسب أثرها.</p>

          <ul className="mt-5 border-t border-brand-navy/15">
            {PLAN_ROWS.map((row, i) => (
              <li
                key={row.title}
                className={cn('grid grid-cols-[minmax(0,1fr)] gap-3 border-b border-brand-navy/15 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center', ease)}
                style={{ ...delay(150 + i * 180), opacity: inView ? 1 : 0.35 }}
              >
                <div className="flex gap-3">
                  <span
                    className={cn('mt-2 h-2.5 w-2.5 flex-shrink-0', row.tone === 'danger' ? 'bg-danger' : 'bg-brand-signal motion-safe:animate-lamp')}
                    aria-hidden
                  />
                  <div>
                    <p className="text-[15px] font-bold leading-7">{row.title}</p>
                    <p className="text-[13px] leading-6 text-brand-slate">{row.meta}</p>
                    <p className={cn('mt-1 text-[13px] font-semibold', row.tone === 'danger' ? 'text-danger' : 'text-brand-navy')}>
                      {row.impact}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 ps-5 sm:ps-0" aria-hidden>
                  <span
                    className={cn(
                      'inline-flex h-9 items-center px-4 text-[13px] font-bold',
                      row.tone === 'danger' ? 'border border-brand-navy/30' : 'bg-brand-navy text-brand-paper'
                    )}
                  >
                    {row.cta}
                  </span>
                  {row.tone !== 'danger' && (
                    <span className="inline-flex h-9 items-center border border-brand-navy/30 px-3 text-[13px] font-semibold">تجاهل</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <figcaption className="border-t border-brand-navy/15 px-4 py-2.5 text-[12px] text-brand-slate">
        شكل مبسّط لخطة اليوم، بأرقام تمثيلية من حساب متجر عطور.
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------------ */
/* The six moves, each drawn with its own condition.                        */
/* ------------------------------------------------------------------------ */

export type MoveKind = 'pause_keyword' | 'add_keyword' | 'add_negative' | 'adjust_budget' | 'adjust_bid' | 'pause_ad';

export function MoveVisual({ kind }: { kind: MoveKind }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.5);
  const done = useLater(inView, 1100);

  return (
    <div ref={ref} className="h-full text-[11.5px] text-brand-slate" aria-hidden>
      {kind === 'pause_keyword' && (
        <div className="flex h-full flex-col justify-between">
          <div className="flex justify-between">
            <span>«عطورات» · آخر 7 أيام</span>
            <span>
              <span className="font-numeric">23</span> ضغطة · <span className="font-numeric">0</span> تحويل
            </span>
          </div>
          <div className="flex h-12 items-end gap-1.5">
            {[3, 4, 2, 5, 3, 2, 4].map((v, i) => (
              <span key={i} className={cn('flex-1 bg-brand-navy/75', ease)} style={{ ...delay(i * 70), height: inView ? `${v * 20}%` : '6%' }} />
            ))}
          </div>
          <div className="flex items-center justify-between">
            <span>حالة الكلمة</span>
            <span className="flex items-center gap-2">
              <span className={cn('font-semibold', done ? 'text-brand-navy' : 'text-brand-slate')}>{done ? 'موقفة' : 'شغالة'}</span>
              <span className="relative h-5 w-9 border border-brand-navy">
                <span
                  className={cn('absolute top-[2px] h-[14px] w-[14px] motion-safe:transition-all motion-safe:duration-300', done ? 'bg-brand-slate/50' : 'bg-brand-navy')}
                  style={{ insetInlineStart: done ? '2px' : 'calc(100% - 16px)' }}
                />
              </span>
            </span>
          </div>
        </div>
      )}

      {kind === 'add_keyword' && (
        <div className="grid h-full grid-cols-2 gap-4">
          <div>
            <p>عبارات البحث</p>
            <div className="mt-2 space-y-1.5">
              <Chip className={cn('border-brand-signal', ease, done && 'opacity-30')}>
                دهن عود كمبودي <span className="ms-1 text-brand-navy">· <span className="font-numeric">4</span> طلبات</span>
              </Chip>
              <Chip>عود</Chip>
              <Chip>عطر عود رجالي</Chip>
            </div>
          </div>
          <div className="border-s border-brand-navy/15 ps-4">
            <p>كلماتك</p>
            <div className="mt-2 space-y-1.5">
              <Chip>[دهن عود]</Chip>
              <Chip>[عود كمبودي]</Chip>
              <span
                className={cn('flex h-[26px] items-center border px-2', ease, done ? 'border-brand-navy bg-brand-navy text-brand-paper' : 'border-dashed border-brand-navy/30 text-transparent')}
              >
                + [دهن عود كمبودي]
              </span>
            </div>
          </div>
        </div>
      )}

      {kind === 'add_negative' && (
        <div className="flex h-full flex-col justify-center gap-3">
          <div className="relative w-fit border border-brand-navy/40 bg-white px-3 py-2 text-[13px] text-brand-navy">
            «عود مجاني»
            <span
              className={cn('absolute right-2 top-1/2 h-[2px] bg-brand-navy', ease)}
              style={{ width: done ? 'calc(100% - 16px)' : '0%' }}
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="flex gap-[3px]">
              {Array.from({ length: 5 }, (_, i) => (
                <span key={i} className={cn('h-2.5 w-2.5 border border-brand-navy/50', ease, inView && 'bg-brand-navy/70')} style={delay(i * 90)} />
              ))}
            </span>
            <span>
              <span className="font-numeric">5</span> ضغطات · <span className="font-numeric">0</span> تحويل
            </span>
          </div>
          <span className={cn('flex w-fit items-center gap-1.5 font-semibold text-brand-navy', ease)} style={{ opacity: done ? 1 : 0 }}>
            <span className="flex h-3.5 w-3.5 items-center justify-center bg-brand-navy text-[11px] leading-none text-brand-paper">−</span>
            انضافت عبارة سلبية
          </span>
        </div>
      )}

      {kind === 'adjust_budget' && (
        <Scale
          inView={inView}
          min={-40}
          max={40}
          band={[-30, 25]}
          to={25}
          labels={[
            [-30, '−30%'],
            [0, 'اليوم'],
            [25, '+25%'],
          ]}
          caption="الميزانية اليومية، المرة الوحدة"
        />
      )}

      {kind === 'adjust_bid' && <Dial inView={inView} />}

      {kind === 'pause_ad' && (
        <div className="flex h-full flex-col justify-between">
          <div className="flex justify-between">
            <span>نسبة الضغط في المجموعة</span>
            <span>
              نص المتوسط{' '}
              <span dir="ltr" className="font-numeric">
                1.4%
              </span>
            </span>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1 space-y-2.5">
              <span className="absolute -bottom-1 -top-1 z-10 border-s border-dashed border-brand-navy" style={{ right: '28%' }} />
              {[4.2, 1.3].map((ctr, i) => (
                <div key={ctr} className="h-3 bg-white">
                  <span
                    className={cn('block h-full', ease, i === 0 && 'bg-brand-navy/75')}
                    style={{ ...delay(i * 150), width: inView ? `${ctr * 20}%` : '0%', ...(i === 1 ? hatch(NAVY) : {}) }}
                  />
                </div>
              ))}
            </div>
            <div className="w-9 space-y-2.5">
              {[4.2, 1.3].map((ctr) => (
                <span key={ctr} dir="ltr" className="block h-3 font-numeric leading-3">
                  {ctr}%
                </span>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span>تقييم قوقل للإعلان 2: ضعيف</span>
            <span className={cn('font-semibold text-brand-navy', ease)} style={{ opacity: done ? 1 : 0 }}>
              يتوقف
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('flex h-[26px] items-center border border-brand-navy/25 bg-white px-2 text-brand-navy', className)}>{children}</span>;
}

/** A numeric scale (always left to right, like any number line) with an allowed band and a marker that moves inside it. */
function Scale({
  inView,
  min,
  max,
  band,
  to,
  labels,
  caption,
  dark = false,
}: {
  inView: boolean;
  min: number;
  max: number;
  band: [number, number];
  to: number;
  labels: Array<[number, string]>;
  caption?: string;
  dark?: boolean;
}) {
  const x = (v: number) => ((v - min) / (max - min)) * 100;
  const line = dark ? 'bg-brand-paper/35' : 'bg-brand-navy/30';
  return (
    <div className="flex h-full flex-col justify-between">
      {caption && <p>{caption}</p>}
      <div dir="ltr" className="relative h-10">
        <span className={cn('absolute inset-x-0 top-1/2 h-px', line)} />
        <span
          className="absolute top-1/2 h-3 -translate-y-1/2"
          style={{ left: `${x(band[0])}%`, width: `${x(band[1]) - x(band[0])}%`, background: dark ? 'rgba(244,242,236,0.16)' : 'rgba(14,20,38,0.10)' }}
        />
        <span className="absolute inset-y-0 left-0" style={{ width: `${x(band[0])}%`, ...hatch(dark ? 'rgba(244,242,236,0.18)' : 'rgba(14,20,38,0.14)') }} />
        <span className="absolute inset-y-0 right-0" style={{ width: `${100 - x(band[1])}%`, ...hatch(dark ? 'rgba(244,242,236,0.18)' : 'rgba(14,20,38,0.14)') }} />
        {band.map((b) => (
          <span key={b} className="absolute inset-y-0 w-[2px] -translate-x-1/2 bg-brand-signal" style={{ left: `${x(b)}%` }} />
        ))}
        <span
          className={cn('absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 motion-safe:transition-[left] motion-safe:duration-1000 motion-safe:ease-snap', dark ? 'bg-brand-paper' : 'bg-brand-navy')}
          style={{ left: `${x(inView ? to : 0)}%`, transitionDelay: '250ms' }}
        />
      </div>
      <div dir="ltr" className="relative h-4">
        {labels.map(([v, label]) => (
          <span key={v} className="absolute -translate-x-1/2 whitespace-nowrap font-numeric" style={{ left: `${x(v)}%` }}>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Bid target dial: the needle can move only inside ±20%. */
function Dial({ inView }: { inView: boolean }) {
  // −30%..+30% maps to −90°..+90°; the allowed band ±20% is ±60°.
  const angle = inView ? 54 : 0; // +18%
  const arc = (from: number, to: number, r: number) => {
    const p = (deg: number) => {
      const rad = ((deg - 90) * Math.PI) / 180;
      return `${(70 + r * Math.cos(rad)).toFixed(2)} ${(62 + r * Math.sin(rad)).toFixed(2)}`;
    };
    return `M${p(from)} A${r} ${r} 0 0 1 ${p(to)}`;
  };
  return (
    <div className="flex h-full items-center gap-5">
      <svg viewBox="0 0 140 70" className="h-[84px] w-[168px] flex-shrink-0">
        <path d={arc(-90, 90, 50)} fill="none" stroke={NAVY} strokeOpacity={0.15} strokeWidth={10} />
        <path d={arc(-60, 60, 50)} fill="none" stroke={NAVY} strokeOpacity={0.55} strokeWidth={10} />
        {[-60, 60].map((a) => (
          <path key={a} d={arc(a - 0.6, a + 0.6, 50)} fill="none" stroke={SIGNAL} strokeWidth={16} />
        ))}
        <g
          style={{ transform: `rotate(${angle}deg)`, transformOrigin: '70px 62px', transitionDelay: '250ms' }}
          className="motion-safe:transition-transform motion-safe:duration-1000 motion-safe:ease-snap"
        >
          <path d="M70 62 L70 20" stroke={NAVY} strokeWidth={2.5} />
        </g>
        <rect x="66" y="58" width="8" height="8" fill={NAVY} />
      </svg>
      <div className="space-y-1.5">
        <p className="text-[12.5px] font-semibold text-brand-navy">
          هدف المزايدة، والخطين الأصفرين حدّه
        </p>
        <p>يتحرك داخل ±20% من الهدف الحالي، وما يطلع عنها حتى لو الأرقام تغري.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Guardrails, drawn.                                                       */
/* ------------------------------------------------------------------------ */

export type LimitKind = 'gate' | 'cap' | 'window' | 'range';

export function LimitVisual({ kind }: { kind: LimitKind }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.5);

  return (
    <div ref={ref} className="text-[11.5px] text-brand-paper/60" aria-hidden>
      {kind === 'gate' && (
        <div className="relative flex h-12 items-center justify-between">
          <span className="absolute inset-x-0 top-1/2 h-px bg-brand-paper/35" />
          <span className="absolute left-0 top-1/2 h-px w-[42%] border-t border-dashed border-brand-paper/50 bg-brand-navy" />
          <span className="relative z-10 border border-brand-paper/40 bg-brand-navy px-2.5 py-1.5 text-brand-paper">توصية</span>
          <span className="relative z-10">
            <span className="flex h-8 items-center border-2 border-brand-signal bg-brand-navy px-3 font-semibold text-brand-paper">اعتمد</span>
            {/* The change waits at the gate until someone presses it. */}
            <span
              className="absolute left-full top-1/2 ms-0 h-2.5 w-2.5 bg-brand-signal motion-safe:transition-all motion-safe:duration-1000 motion-safe:ease-snap"
              style={{ marginLeft: 6, transform: `translate(${inView ? 0 : 36}px, -50%)`, opacity: inView ? 1 : 0 }}
            />
          </span>
          <span className="relative z-10 border border-brand-paper/40 bg-brand-navy px-2.5 py-1.5 text-brand-paper">حسابك في قوقل</span>
        </div>
      )}

      {kind === 'cap' && (
        <div>
          <div dir="ltr" className="relative h-5">
            <span className="absolute inset-y-0 left-0 bg-brand-paper/30" style={{ width: '50%' }} />
            <span
              className="absolute inset-y-0 bg-brand-paper motion-safe:transition-[width] motion-safe:duration-1000 motion-safe:ease-snap"
              style={{ left: '50%', width: inView ? '25%' : '0%', transitionDelay: '200ms' }}
            />
            <span className="absolute inset-y-0 border border-dashed border-brand-paper/40" style={{ left: '75%', width: '17%' }} />
            <span className="absolute -bottom-1.5 -top-1.5 w-[2px] bg-brand-signal" style={{ left: '75%' }} />
          </div>
          <div dir="ltr" className="relative mt-2 h-4">
            <span className="absolute left-0">الميزانية الحالية</span>
            <span className="absolute -translate-x-1/2 font-numeric text-brand-signal" style={{ left: '75%' }}>
              +50%
            </span>
            <span className="absolute right-0">ما يعدّي</span>
          </div>
        </div>
      )}

      {kind === 'window' && (
        <div>
          <div className="grid grid-cols-[repeat(15,minmax(0,1fr))] gap-1">
            {Array.from({ length: 30 }, (_, i) => (
              <span
                key={i}
                className={cn('aspect-square border border-brand-paper/30 motion-safe:transition-colors motion-safe:duration-200', inView && (i === 0 ? 'bg-brand-signal' : 'bg-brand-paper/70'))}
                style={delay(i * 35)}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between">
            <span>يوم الاعتماد</span>
            <span>
              اليوم <span className="font-numeric">30</span>
            </span>
          </div>
        </div>
      )}

      {kind === 'range' && (
        <Scale
          dark
          inView={inView}
          min={-30}
          max={30}
          band={[-20, 20]}
          to={20}
          labels={[
            [-20, '−20%'],
            [0, 'الحالي'],
            [20, '+20%'],
          ]}
        />
      )}
    </div>
  );
}

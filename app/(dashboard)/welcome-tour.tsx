'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Check, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { trapTabKey } from '@/lib/ui/focus-trap';

/**
 * First-run product tour.
 *
 * The handoff's #1 complaint was that a new user lands on /dashboard with no
 * idea where to start — what the account switcher is, that every page follows
 * the SELECTED account, what فحص does, or what مركز الموافقات is for. This is a
 * dismissible spotlight walkthrough that anchors to `[data-tour]` elements in
 * the shell and is persisted per-browser so it never re-nags.
 *
 * Persistence is a first-party cookie (survives sessions, unlike sessionStorage)
 * and it can be replayed any time from the "شرح المنصة" button, which dispatches
 * a `modaafa:start-tour` event.
 */

const TOUR_COOKIE = 'modaafa_tour_seen';

type Step = {
  selector: string | null;
  title: string;
  body: string;
};

const STEPS: Step[] = [
  {
    selector: null,
    title: 'أهلاً بك في مُضاعِف 👋',
    body: 'مساعدك الذكي لإدارة إعلانات Google. خلال ثلاثين ثانية نوريك أهم أربع نقاط في المنصة حتى تبدأ بثقة. تقدر تتخطى الجولة في أي وقت.',
  },
  {
    selector: '[data-tour="account-switcher"]',
    title: 'الحساب الإعلاني المُحدَّد',
    body: 'هذا هو الحساب الذي تعمل عليه الآن. كل الصفحات — الحملات، الفحص، التقارير — تتبع هذا الاختيار. بدّل الحساب من هنا في أي لحظة.',
  },
  {
    selector: '[data-tour="nav-audit"]',
    title: 'فحص الحساب',
    body: 'يفحص حسابك بالكامل ويعطيك درجة صحة، ويكشف الهدر والفرص الضائعة، مع توصيات عملية مرتّبة حسب الأثر.',
  },
  {
    selector: '[data-tour="nav-optimizer"]',
    title: 'مركز الموافقات',
    body: 'قلب المنصة: لا يتم أي تعديل على حسابك قبل موافقتك. تراجع كل توصية هنا، وتعتمدها أو ترفضها، وتقدر تتراجع عن أي إجراء لاحقاً.',
  },
  {
    selector: '[data-tour="nav-assistant"]',
    title: 'المساعد الذكي',
    body: 'اسأله عن أداء حسابك بالعربي، أو اطلب منه بناء حملة جديدة. يفهم بياناتك ويردّ باقتراحات جاهزة للتنفيذ.',
  },
];

type Rect = { top: number; left: number; width: number; height: number };

function readCookie(name: string) {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function WelcomeTour() {
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const step = STEPS[index];

  const markSeen = useCallback(() => {
    try {
      document.cookie = `${TOUR_COOKIE}=1; max-age=${60 * 60 * 24 * 365}; path=/; samesite=lax`;
    } catch {
      /* cookies disabled — the tour simply shows again next time */
    }
  }, []);

  const finish = useCallback(() => {
    setActive(false);
    setIndex(0);
    markSeen();
  }, [markSeen]);

  const start = useCallback(() => {
    setIndex(0);
    setActive(true);
  }, []);

  // Auto-start on the very first visit; always listen for a manual replay.
  useEffect(() => {
    setMounted(true);
    if (!readCookie(TOUR_COOKIE)) {
      // Let the shell paint first so anchors exist to measure.
      const timer = window.setTimeout(() => setActive(true), 550);
      const onReplay = () => start();
      window.addEventListener('modaafa:start-tour', onReplay);
      return () => {
        window.clearTimeout(timer);
        window.removeEventListener('modaafa:start-tour', onReplay);
      };
    }
    const onReplay = () => start();
    window.addEventListener('modaafa:start-tour', onReplay);
    return () => window.removeEventListener('modaafa:start-tour', onReplay);
  }, [start]);

  // Measure the anchored element for the current step (null → centered card).
  useEffect(() => {
    if (!active) return;

    function measure() {
      if (!step?.selector) {
        setRect(null);
        return;
      }
      const el = document.querySelector(step.selector) as HTMLElement | null;
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      // An off-screen anchor (e.g. the sidebar on mobile) → fall back to center.
      if (r.width === 0 || r.height === 0 || r.left < -40 || r.right > window.innerWidth + 40) {
        setRect(null);
        return;
      }
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    }

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [active, index, step]);

  // Treat the walkthrough as a real modal: focus enters the card, the app
  // behind it becomes inert, and focus returns to the original trigger.
  useEffect(() => {
    if (!active) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;

    const root = rootRef.current;
    const inertSiblings = root
      ? Array.from(document.body.children).filter((element) => element !== root)
      : [];
    const previousInert = inertSiblings.map((element) => ({
      element: element as HTMLElement & { inert: boolean },
      inert: Boolean((element as HTMLElement & { inert: boolean }).inert),
    }));
    for (const entry of previousInert) entry.element.inert = true;

    const frame = window.requestAnimationFrame(() => cardRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      for (const entry of previousInert) entry.element.inert = entry.inert;
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [active]);

  // Escape closes; arrows navigate.
  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') finish();
      if (event.key === 'ArrowLeft') setIndex((i) => Math.min(STEPS.length - 1, i + 1));
      if (event.key === 'ArrowRight') setIndex((i) => Math.max(0, i - 1));
      if (cardRef.current) trapTabKey(event, cardRef.current);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, finish]);

  if (!mounted || !active) return null;

  const isLast = index === STEPS.length - 1;
  const isFirst = index === 0;
  const pad = 8;

  // Card placement: below the anchor when there is room, otherwise centered.
  const cardStyle: React.CSSProperties = (() => {
    if (!rect) {
      return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    }
    const below = rect.top + rect.height + 12;
    const spaceBelow = window.innerHeight - (rect.top + rect.height);
    if (spaceBelow > 240) {
      // Anchor the card's right edge near the target (RTL reading order).
      const right = Math.max(16, window.innerWidth - (rect.left + rect.width));
      return { top: below, right };
    }
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  })();

  return createPortal(
    <div ref={rootRef} className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="جولة تعريفية">
      {/* Dimmed backdrop with a spotlight hole punched around the anchor. */}
      {rect ? (
        <div
          className="pointer-events-none absolute rounded-xl ring-2 ring-primary/70 transition-all duration-300"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: '0 0 0 9999px hsl(222 40% 3% / 0.72)',
          }}
          aria-hidden
        />
      ) : (
        <div className="absolute inset-0 bg-[hsl(222_40%_3%/0.72)]" aria-hidden onClick={finish} />
      )}

      {/* Step card */}
      <div
        ref={cardRef}
        tabIndex={-1}
        className="absolute w-[min(92vw,360px)] surface-raised p-5 shadow-pop animate-fade-in-fast"
        style={cardStyle}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-inset ring-primary/25">
            <Sparkles className="h-4 w-4" />
          </span>
          <button
            type="button"
            onClick={finish}
            aria-label="إغلاق الجولة"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <h2 className="text-[17px] font-semibold text-foreground">{step.title}</h2>
        <p className="mt-2 text-[13.5px] leading-7 text-foreground-subtle">{step.body}</p>

        <div className="mt-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5" aria-hidden>
            {STEPS.map((_, dot) => (
              <span
                key={dot}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-200',
                  dot === index ? 'w-5 bg-primary' : 'w-1.5 bg-border-strong'
                )}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {!isFirst && (
              <button
                type="button"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-surface"
              >
                <ArrowRight className="h-3.5 w-3.5" />
                السابق
              </button>
            )}
            {isLast ? (
              <button
                type="button"
                onClick={finish}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-gradient px-4 text-[13px] font-semibold text-primary-foreground shadow-soft transition-transform hover:brightness-105 active:scale-[0.98]"
              >
                <Check className="h-4 w-4" />
                يلا نبدأ
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIndex((i) => Math.min(STEPS.length - 1, i + 1))}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-gradient px-4 text-[13px] font-semibold text-primary-foreground shadow-soft transition-transform hover:brightness-105 active:scale-[0.98]"
              >
                التالي
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {isFirst && (
          <button
            type="button"
            onClick={finish}
            className="mt-3 w-full text-center text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            تخطّي الجولة
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}

/** Small trigger used in the shell to replay the tour. */
export function startWelcomeTour() {
  window.dispatchEvent(new Event('modaafa:start-tour'));
}

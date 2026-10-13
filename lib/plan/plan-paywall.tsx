'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, Lock, ShieldCheck, X } from 'lucide-react';
import { SEVERITY_WORD } from '@/lib/home/briefing';
import { trapTabKey } from '@/lib/ui/focus-trap';
import { cn, formatCurrency } from '@/lib/utils';
import {
  PLAN_COPY,
  cancelLine,
  paywallCta,
  planSubtitle,
  planTitle,
  sheetLine,
  type PaywallCta,
  type Plan,
  type PlanSheetReason,
} from './plan';

/**
 * «خطتك جاهزة», shared by the end of onboarding and the locked /home.
 *
 * The plan card is the hero: the title, the audit's own sentence, the
 * health score and the estimated waste, then the first decision in full and the
 * other decisions as muted, locked rows. The reassurance (the free days, the
 * one-tap cancel, nothing changes without approval) is smaller and quieter
 * than the card, on purpose: it supports the plan, it is not a second pitch.
 *
 * Nothing here talks to the server. The CTA is a plain link to the existing
 * trial checkout entry, so the paywall can render without any request to the
 * chat or voice APIs.
 */

const SEVERITY_DOT: Record<string, string> = { critical: 'bg-danger', medium: 'bg-signal' };
const MAX_LOCKED_ROWS = 6;

// ------------------------------------------------------------------ the card

export function PlanCard({
  plan,
  trialEligible,
  id,
  onApprove,
  onAsk,
  children,
}: {
  plan: Plan;
  trialEligible: boolean;
  id?: string;
  /** Present on /home: «اعتمد» on the open decision, which opens the paywall. */
  onApprove?: () => void;
  /** Present on /home: «اشرح لي هذا القرار», which opens the paywall. */
  onAsk?: () => void;
  children?: React.ReactNode;
}) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const shownLocked = plan.locked.slice(0, MAX_LOCKED_ROWS);
  const hiddenLocked = plan.locked.length - shownLocked.length;

  return (
    <section id={id} aria-labelledby={titleId} className="scroll-mt-4 overflow-hidden rounded-[18px] border border-border/80 bg-card">
      <div className="flex items-start gap-4 px-4 pb-4 pt-5 sm:px-6">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-[24px] font-bold leading-10 sm:text-[27px]">
            {planTitle(plan.kind)}
          </h2>
          <p className="mt-1 text-[14.5px] leading-7 text-muted-foreground">{planSubtitle(plan, trialEligible)}</p>
        </div>
        {plan.healthScore !== null && <ScoreRing score={plan.healthScore} word={plan.healthWord} />}
      </div>

      {plan.waste !== null && (
        <div className="mx-4 mb-4 rounded-[14px] bg-muted/60 px-4 py-3 sm:mx-6">
          <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            تروح بدون فايدة كل شهر
            <span className="rounded-full border border-border-strong/60 px-2 py-px text-[11px] font-semibold text-foreground">
              {PLAN_COPY.estimateTag}
            </span>
          </p>
          <p className="numeric mt-0.5 text-[28px] font-bold leading-tight">
            {formatCurrency(Math.round(plan.waste), plan.currency)}
          </p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{PLAN_COPY.wasteBasis}</p>
        </div>
      )}

      {plan.first && (
        <div className="border-t border-border/70 px-4 py-4 sm:px-6">
          <p className="text-[12px] font-semibold text-muted-foreground">{PLAN_COPY.firstLabel}</p>
          <p className="mt-2 flex items-center gap-2 text-[12.5px] font-semibold text-muted-foreground">
            <span
              className={cn('h-2 w-2 rounded-full', SEVERITY_DOT[plan.first.severity ?? ''] ?? 'bg-muted-foreground')}
              aria-hidden
            />
            {SEVERITY_WORD[plan.first.severity ?? ''] ?? 'قرار'}
          </p>
          <p className="mt-1 text-[16px] font-semibold leading-8">{plan.first.title}</p>
          {plan.first.reason && <p className="mt-1 text-[14px] leading-7 text-muted-foreground">{plan.first.reason}</p>}
          {plan.first.impactLabel && plan.first.impactAmount > 0 && (
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              {plan.first.impactLabel}:{' '}
              <span className="numeric font-semibold text-foreground">
                {formatCurrency(plan.first.impactAmount, plan.currency)}
              </span>
            </p>
          )}
          {(onApprove || onAsk) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onApprove && plan.first.executable && (
                <button
                  type="button"
                  onClick={onApprove}
                  className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-[13.5px] font-bold text-primary-foreground"
                >
                  اعتمد
                </button>
              )}
              {onAsk && (
                <button
                  type="button"
                  onClick={onAsk}
                  className="inline-flex min-h-9 items-center rounded-full px-3 text-[13.5px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {plan.first.executable ? 'اشرح لي هذا القرار' : 'كيف أسويه؟'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {shownLocked.length > 0 && (
        <div className="border-t border-border/70 bg-muted/35 px-4 py-4 sm:px-6">
          <p className="text-[12px] font-semibold text-muted-foreground">
            {PLAN_COPY.lockedLabel} <span className="numeric font-normal">({plan.locked.length})</span>
          </p>
          <ul className="mt-2 space-y-1">
            {shownLocked.map((item) => (
              <li
                key={item.id}
                className="flex cursor-default select-none items-start gap-2.5 rounded-[14px] px-3 py-2 text-[13.5px] leading-6 text-muted-foreground"
              >
                <Lock className="mt-1 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                <span className="min-w-0">
                  <span className="sr-only">{PLAN_COPY.lockedSr}: </span>
                  {item.title}
                </span>
              </li>
            ))}
            {hiddenLocked > 0 && (
              <li className="flex items-center gap-2.5 px-3 py-1 text-[13px] text-muted-foreground">
                <Lock className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                <span>
                  وغيرها <span className="numeric">{hiddenLocked}</span>
                </span>
              </li>
            )}
          </ul>
        </div>
      )}

      {children}
    </section>
  );
}

function ScoreRing({ score, word }: { score: number; word: string | null }) {
  const value = Math.max(0, Math.min(100, score));
  return (
    <div className="flex flex-shrink-0 flex-col items-center gap-1" role="img" aria-label={`صحة حسابك ${Math.round(value)} من 100${word ? `، ${word}` : ''}`}>
      <div className="relative h-[76px] w-[76px]" aria-hidden>
        <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90">
          <circle cx="18" cy="18" r="15.5" fill="none" className="stroke-muted" strokeWidth="3.5" />
          <circle
            cx="18"
            cy="18"
            r="15.5"
            fill="none"
            className={value >= 70 ? 'stroke-foreground' : 'stroke-signal'}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={`${(value / 100) * 97.4} 97.4`}
          />
        </svg>
        <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
          <span className="numeric text-[22px] font-bold">{Math.round(value)}</span>
          <span dir="ltr" className="numeric mt-0.5 text-[10.5px] text-muted-foreground">/100</span>
        </span>
      </div>
      {word && (
        <span className="max-w-[88px] text-center text-[11.5px] leading-4 text-muted-foreground" aria-hidden>
          {word}
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the CTA

/**
 * The one way forward. By default the existing trial checkout entry; when a
 * subscription already exists but gives no access, `cta` points to /billing
 * (the checkout entry would refuse it with «already_subscribed»).
 */
export function PlanCtaButton({
  trialEligible,
  cta,
  className,
  onNavigate,
}: {
  trialEligible: boolean;
  cta?: PaywallCta;
  className?: string;
  onNavigate?: () => void;
}) {
  const target = cta ?? paywallCta({ trialEligible });
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    // Coming back with the browser's back button must not leave the button spinning.
    const reset = () => setLoading(false);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);
  return (
    <Link
      href={target.href}
      prefetch={false}
      aria-busy={loading}
      onClick={() => {
        setLoading(true);
        onNavigate?.();
      }}
      className={cn(
        'flex h-14 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 text-[16px] font-bold text-primary-foreground transition-colors hover:bg-primary/90',
        className
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
      {target.label}
    </Link>
  );
}

export function PlanCancelLine({ trialEligible, className }: { trialEligible: boolean; className?: string }) {
  return <p className={cn('text-center text-[12.5px] leading-5 text-muted-foreground', className)}>{cancelLine(trialEligible)}</p>;
}

export function PlanTrust({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-start justify-center gap-1.5 text-center text-[12.5px] leading-5 text-muted-foreground', className)}>
      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
      <span>{PLAN_COPY.trust}</span>
    </p>
  );
}

/** The line saying why the plan is stopped, above the button of someone who already has a subscription. */
export function PlanCtaReason({ cta, className }: { cta: PaywallCta | undefined; className?: string }) {
  if (!cta?.reason) return null;
  return <p className={cn('text-center text-[14px] font-semibold leading-6', className)}>{cta.reason}</p>;
}

/**
 * The reason (only for a stopped subscription), the button, the one-line
 * cancel promise and the trust line, in that order. A stopped subscription has
 * nothing to cancel, so it gets no cancel promise.
 */
export function PlanCta({ trialEligible, cta, className }: { trialEligible: boolean; cta?: PaywallCta; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      <PlanCtaReason cta={cta} />
      <PlanCtaButton trialEligible={trialEligible} cta={cta} />
      {cta?.kind !== 'billing' && <PlanCancelLine trialEligible={trialEligible} />}
      <PlanTrust />
    </div>
  );
}

// ------------------------------------------------------------------ the sheet

/**
 * What the voice button, the chat bar and «اعتمد» open on /home. A dialog that
 * says in one line what is behind the lock and offers the same CTA. Escape,
 * the backdrop and «مو الحين» close it; focus returns to whatever opened it.
 */
export function PlanSheet({
  open,
  reason,
  trialEligible,
  cta,
  suspended = false,
  onClose,
}: {
  open: boolean;
  reason: PlanSheetReason;
  trialEligible: boolean;
  cta?: PaywallCta;
  suspended?: boolean;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      } else if (panelRef.current) {
        trapTabKey(event, panelRef.current);
      }
    };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4" dir="rtl">
      <div className="absolute inset-0 bg-foreground/30" aria-hidden onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-[460px] rounded-t-[22px] bg-background px-5 pb-6 pt-5 shadow-[0_-12px_40px_rgba(14,20,38,0.22)] motion-safe:animate-fade-up sm:rounded-[22px]"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 24px)' }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[21px] font-bold leading-9">
              {suspended ? 'حسابك موقوف مؤقتاً' : PLAN_COPY.title}
            </h2>
            <p className="mt-1 text-[14.5px] leading-7 text-muted-foreground">
              {suspended
                ? 'المحادثة والتنفيذ واقفين لين نرجّع التفعيل. كلمنا على الواتساب ونرتبه معك.'
                : cta?.kind === 'billing' && cta.reason
                  ? cta.reason
                  : sheetLine(reason, trialEligible)}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="سكّر"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full hover:bg-muted"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        {!suspended && (
          <div className="mt-5 space-y-3">
            {/* The sheet's own line above already says why; the CTA adds only the button. */}
            <PlanCta trialEligible={trialEligible} cta={cta && { ...cta, reason: null }} />
            <button
              type="button"
              onClick={onClose}
              className="flex h-12 w-full items-center justify-center rounded-full text-[15px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              مو الحين
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

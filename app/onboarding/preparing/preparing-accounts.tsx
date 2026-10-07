'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { buttonClasses } from '@/lib/ui/button';
import { cn } from '@/lib/utils';
import {
  CONNECT_ERROR_MESSAGES,
  CONNECT_STAGES,
  connectErrorRecoveryHref,
  connectPollDelayMs,
  type ConnectProgressView,
  type ConnectStageState,
} from '@/lib/onboarding/connect-progress';

type StatusPayload = ConnectProgressView & { linkedAccounts?: number };

/** Consecutive failed polls before we tell the user something is wrong. */
const MAX_POLL_FAILURES = 6;
/** No job row at all after this long means nothing was started. */
const NO_JOB_GRACE_MS = 8_000;

const initialView: StatusPayload = {
  phase: 'running',
  stages: CONNECT_STAGES.map((stage, index) => ({ ...stage, state: index === 0 ? 'active' : 'pending' })),
  error: null,
  next: null,
  linkedAccounts: 0,
};

export function PreparingAccounts() {
  const router = useRouter();
  const [view, setView] = useState<StatusPayload>(initialView);
  const [problem, setProblem] = useState<'network' | 'no_job' | null>(null);
  const startedAt = useRef(Date.now());
  const failures = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      let payload: StatusPayload | null = null;
      try {
        const res = await fetch('/api/onboarding/connect-status', { cache: 'no-store' });
        if (res.status === 401) {
          router.replace('/login?next=/onboarding/preparing');
          return;
        }
        if (res.ok) payload = (await res.json()) as StatusPayload;
      } catch {
        payload = null;
      }
      if (cancelled) return;

      const elapsed = Date.now() - startedAt.current;
      if (!payload) {
        failures.current += 1;
        if (failures.current >= MAX_POLL_FAILURES) setProblem('network');
      } else {
        failures.current = 0;
        setProblem(null);

        if (payload.phase === 'done') {
          setView(payload);
          router.replace(payload.next ?? '/onboarding/choose');
          return;
        }
        const recovery = connectErrorRecoveryHref(payload.error);
        if (recovery) {
          router.replace(recovery);
          return;
        }
        if (payload.phase === 'failed' || payload.phase === 'timed_out') {
          setView(payload);
          return;
        }
        if (payload.phase === 'none') {
          if (elapsed > NO_JOB_GRACE_MS) {
            setProblem('no_job');
            return;
          }
        } else {
          setView(payload);
        }
      }

      timer = setTimeout(poll, connectPollDelayMs(elapsed));
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [router]);

  const stopped = view.phase === 'failed' || view.phase === 'timed_out';

  return (
    <section className="surface-card p-5 sm:p-6" aria-live="polite">
      <ol className="space-y-4">
        {view.stages.map((stage, index) => (
          <li key={stage.id} className="flex items-start gap-3">
            <StageMarker state={stage.state} index={index} />
            <div className="min-w-0">
              <div
                className={cn(
                  'text-[14px] font-semibold',
                  stage.state === 'pending' ? 'text-muted-foreground' : 'text-foreground'
                )}
              >
                {stage.label}
              </div>
              <p className="mt-0.5 text-[12.5px] leading-6 text-muted-foreground">{stage.hint}</p>
            </div>
          </li>
        ))}
      </ol>

      {stopped && (
        <div className="mt-6 border-t border-border pt-5">
          <p className="text-[13px] font-semibold text-danger">ما اكتمل التجهيز</p>
          <p className="mt-1 text-[13px] leading-7 text-foreground">
            {CONNECT_ERROR_MESSAGES[view.error ?? ''] ?? CONNECT_ERROR_MESSAGES.connect_failed}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <a href="/api/auth/google-ads/connect" className={buttonClasses({ variant: 'primary' })}>
              تجديد الربط
            </a>
            {(view.linkedAccounts ?? 0) > 0 && (
              <Link href="/onboarding/choose" className={buttonClasses({ variant: 'outline' })}>
                أكمل بالحسابات التي وصلت
              </Link>
            )}
          </div>
        </div>
      )}

      {problem === 'network' && !stopped && (
        <p className="mt-6 border-t border-border pt-5 text-[13px] leading-7 text-muted-foreground" role="status">
          الاتصال بالمنصة متقطع. التجهيز مستمر عندنا، وهذي الصفحة تحاول من جديد تلقائياً.
        </p>
      )}

      {problem === 'no_job' && (
        <div className="mt-6 border-t border-border pt-5">
          <p className="text-[13px] leading-7 text-foreground">ما لقينا ربطاً جارياً على حسابك. ابدأ الربط من جديد.</p>
          <Link href="/onboarding/connect" className={`${buttonClasses({ variant: 'primary' })} mt-4`}>
            ربط Google Ads
          </Link>
        </div>
      )}
    </section>
  );
}

function StageMarker({ state, index }: { state: ConnectStageState; index: number }) {
  return (
    <span
      className={cn(
        'mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center border text-[11px] font-bold',
        state === 'done' && 'border-foreground bg-foreground text-background',
        state === 'active' && 'border-signal bg-signal text-signal-foreground motion-safe:animate-pulse',
        state === 'pending' && 'border-border bg-background-elevated text-foreground-subtle',
        state === 'failed' && 'border-danger bg-danger text-background'
      )}
      aria-label={
        state === 'done' ? 'اكتملت' : state === 'active' ? 'جارية' : state === 'failed' ? 'توقفت' : 'لم تبدأ'
      }
    >
      {state === 'done' ? (
        <Check className="h-3.5 w-3.5" />
      ) : state === 'failed' ? (
        <X className="h-3.5 w-3.5" />
      ) : (
        <span className="numeric">{index + 1}</span>
      )}
    </span>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { buttonClasses } from '@/lib/ui/button';
import type { AuditStreamEvent } from '@/lib/audit/progress';
import { firstAuditGuardKey, isFirstAuditGuardActive } from '@/lib/onboarding/first-opportunities';

type RunState =
  | { kind: 'running'; percent: number; message: string }
  | { kind: 'waiting' }
  | { kind: 'error'; message: string };

const WAIT_REFRESH_MS = 10_000;

function readGuard(key: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function writeGuard(key: string, value: number | null) {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, String(value));
  } catch {
    // Private mode: the ref guard below still stops a double start.
  }
}

/**
 * Starts the first audit as soon as the page opens, using the same endpoint
 * and progress stream as the audit page. A refresh while it runs waits for
 * the result instead of starting (and billing) a second audit.
 */
export function FirstAuditRunner({ customerId }: { customerId: string }) {
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<RunState>({ kind: 'running', percent: 0, message: 'نجهز الفحص' });
  const guardKey = firstAuditGuardKey(customerId);

  const run = useCallback(async () => {
    writeGuard(guardKey, Date.now());
    setState({ kind: 'running', percent: 0, message: 'نجهز الفحص' });
    try {
      const res = await fetch('/api/audit/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ customerId }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        writeGuard(guardKey, null);
        setState({ kind: 'error', message: body.message ?? 'ما قدرنا نبدأ الفحص الحين. جرّب بعد دقيقة.' });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: AuditStreamEvent;
          try {
            event = JSON.parse(line) as AuditStreamEvent;
          } catch {
            continue;
          }
          if (event.type === 'progress') {
            setState({ kind: 'running', percent: event.percent, message: event.message });
          } else if (event.type === 'complete') {
            writeGuard(guardKey, null);
            router.refresh();
            return;
          } else if (event.type === 'error') {
            writeGuard(guardKey, null);
            setState({ kind: 'error', message: event.message });
            return;
          }
        }
      }
      // The stream closed without a final event; the audit may still have saved.
      writeGuard(guardKey, null);
      router.refresh();
    } catch {
      setState({ kind: 'waiting' });
    }
  }, [customerId, guardKey, router]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (isFirstAuditGuardActive(readGuard(guardKey))) {
      setState({ kind: 'waiting' });
      return;
    }
    void run();
  }, [guardKey, run]);

  // A run from before a refresh (or a dropped connection) finishes on the
  // server; re-read the page until its audit shows up or the guard expires.
  useEffect(() => {
    if (state.kind !== 'waiting') return;
    const timer = setInterval(() => {
      if (!isFirstAuditGuardActive(readGuard(guardKey))) {
        clearInterval(timer);
        setState({ kind: 'error', message: 'الفحص أخذ وقتاً أطول من المتوقع. جرّب تشغيله من جديد.' });
        return;
      }
      router.refresh();
    }, WAIT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [state.kind, guardKey, router]);

  if (state.kind === 'error') {
    return (
      <section className="surface-card p-5 sm:p-6">
        <p className="text-[13px] font-semibold text-danger">ما اكتمل الفحص</p>
        <p className="mt-1 text-[13px] leading-7 text-foreground">{state.message}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" onClick={() => void run()} className={buttonClasses({ variant: 'primary' })}>
            شغّل الفحص من جديد
          </button>
          <Link href="/dashboard" className={buttonClasses({ variant: 'ghost' })}>
            لوحة التحكم
          </Link>
        </div>
      </section>
    );
  }

  const percent = state.kind === 'running' ? Math.max(4, Math.min(100, state.percent)) : null;
  return (
    <section className="surface-card p-5 sm:p-6" aria-live="polite">
      <p className="text-[14px] font-semibold text-foreground">نفحص حسابك الحين</p>
      <p className="mt-1 text-[13px] leading-7 text-muted-foreground">
        {state.kind === 'running' ? state.message : 'الفحص شغال عندنا، ننتظر النتيجة'}
      </p>
      <div
        className="mt-4 h-1.5 w-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div
          className="h-full bg-foreground transition-[width] duration-500"
          style={{ width: percent === null ? '30%' : `${percent}%` }}
        />
      </div>
      <p className="mt-3 text-[12px] text-muted-foreground">اترك الصفحة مفتوحة، والنتيجة تطلع هنا أول ما تجهز.</p>
    </section>
  );
}

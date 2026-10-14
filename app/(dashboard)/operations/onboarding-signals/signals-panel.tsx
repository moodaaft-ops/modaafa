'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { SIGNAL_KEYS } from '@/lib/setup/adaptive/signals-store';
import type { AccountSignals, Scenario } from '@/lib/setup/adaptive/types';
import { SIGNAL_LABELS, describeScenario, describeSignal, readSummary } from './describe';

export type SignalsView = {
  signals: AccountSignals;
  scenario: Scenario | null;
  saved: boolean;
};

const timeFormat = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  timeZone: 'Asia/Riyadh',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

function readTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date);
}

function errorText(status: number, code: string | undefined) {
  if (status === 429) return 'كثرت المحاولات، انتظر شوي وعيدها.';
  if (status === 404) return 'هذا الحساب مو من حساباتك.';
  if (code === 'client_unavailable') return 'ما قدرت أفتح الحساب في قوقل، يمكن يحتاج ربط من جديد.';
  return 'صار خطأ وما انقرأ الحساب.';
}

/**
 * One linked account: the «اقرأ الحساب» button and what came back. Posts to
 * /api/operations/onboarding-signals, which reads fresh and stores the result.
 */
export function SignalsPanel({
  accountId,
  name,
  customerId,
  initial,
}: {
  accountId: string;
  name: string;
  customerId: string;
  initial: SignalsView | null;
}) {
  const [view, setView] = useState<SignalsView | null>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/operations/onboarding-signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.signals) {
        setMessage(errorText(res.status, json?.error));
        return;
      }
      setView({ signals: json.signals, scenario: json.scenario ?? null, saved: json.saved !== false });
    } catch {
      setMessage('صار خطأ وما انقرأ الحساب.');
    } finally {
      setBusy(false);
    }
  }

  const summary = view ? readSummary(view.signals, SIGNAL_KEYS) : null;

  return (
    <section className="border border-border" aria-label={name}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <h2 className="break-words text-sm font-bold text-foreground">{name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground numeric" dir="ltr">
            {customerId}
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="h-10 w-full bg-foreground px-4 text-sm font-semibold text-background disabled:opacity-40 sm:w-auto"
        >
          {busy ? 'يقرأ الحساب...' : 'اقرأ الحساب'}
        </button>
      </div>

      {message && (
        <p role="status" className="bg-danger/10 px-3 py-2 text-[13px] leading-6 text-danger sm:px-4">
          {message}
        </p>
      )}

      {!view && !message && (
        <p className="border-t border-border px-3 py-4 text-[13px] leading-6 text-muted-foreground sm:px-4">
          ما فيه قراءة محفوظة لهذا الحساب. اضغط «اقرأ الحساب» وتطلع الإشارات هنا.
        </p>
      )}

      {view && summary && (
        <div className="border-t border-border">
          <p className="px-3 py-2.5 text-xs leading-5 text-muted-foreground sm:px-4">
            قراءة <span className="numeric">{readTime(view.signals.readAt)}</span>
            {' '}· انقرا {summary.ok} من {SIGNAL_KEYS.length}
            {summary.failed > 0 && <span className="font-semibold text-danger">، وفشل {summary.failed}</span>}
            {!view.saved && <span className="font-semibold text-danger">، وما انحفظت</span>}
          </p>

          <ul className="divide-y divide-border border-t border-border">
            {SIGNAL_KEYS.map((key) => {
              const read = view.signals[key];
              const text = describeSignal(key, view.signals);
              return (
                <li key={key} className="px-3 py-2.5 sm:px-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[13px] font-semibold text-foreground">{SIGNAL_LABELS[key]}</span>
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center px-2 py-0.5 text-[11px] font-semibold leading-5 ring-1 ring-inset',
                        read.ok ? 'bg-success/10 text-success ring-success/30' : 'bg-danger/10 text-danger ring-danger/30'
                      )}
                    >
                      {read.ok ? 'انقرت' : 'فشلت'}
                    </span>
                  </div>
                  {read.ok ? (
                    <p className="mt-1 break-words text-[13px] leading-6 text-muted-foreground">{text}</p>
                  ) : (
                    <p className="mt-1 break-all text-xs leading-5 text-danger" dir="ltr">
                      {read.error ?? 'unknown'}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="border-t border-border bg-surface px-3 py-3 sm:px-4">
            <h3 className="text-[13px] font-bold text-foreground">وش يفهم منها المسار</h3>
            {view.scenario ? (
              <dl className="mt-2 space-y-1.5">
                {describeScenario(view.scenario).map((row) => (
                  <div key={row.label} className="flex flex-wrap gap-x-2 text-[13px] leading-6">
                    <dt className="text-muted-foreground">{row.label}</dt>
                    <dd className="break-words font-semibold text-foreground">{row.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-1 text-[13px] leading-6 text-muted-foreground">ما قدر المصنّف يطلع حالة من هالقراءة.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

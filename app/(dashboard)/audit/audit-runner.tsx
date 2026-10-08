'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Circle, Loader2, ScanSearch, TriangleAlert, X } from 'lucide-react';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import {
  AUDIT_PROGRESS_STEPS,
  type AuditProgressEvent,
  type AuditStreamEvent,
} from '@/lib/audit/progress';
import { auditErrorInfo, type AuditErrorInfo } from '@/lib/audit/error-messages';
import { buttonClasses } from '@/lib/ui/button';
import { selectClasses } from '@/lib/ui/field';
import { cn } from '@/lib/utils';

type AccountLite = { customer_id: string; customer_name: string | null };

type StepState = {
  phase: AuditProgressEvent['phase'];
  detail?: string;
  warning?: boolean;
};

export function AuditRunner({
  accounts,
  selectedCustomerId,
  label,
}: {
  accounts: AccountLite[];
  selectedCustomerId: string | null;
  label: string;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState(selectedCustomerId ?? accounts[0]?.customer_id ?? '');
  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState('جاري إرسال طلب الفحص إلى الخادم');
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [error, setError] = useState<AuditErrorInfo | null>(null);
  const finishedRef = useRef(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const accountName = useMemo(() => {
    const account = accounts.find((item) => item.customer_id === customerId);
    return account ? googleAdsAccountDisplayName(account) : 'الحساب المختار';
  }, [accounts, customerId]);

  async function startAudit() {
    if (!customerId || running) return;

    setRunning(true);
    setPercent(0);
    setMessage('جاري إرسال طلب الفحص إلى الخادم');
    setSteps({});
    setError(null);
    finishedRef.current = false;

    try {
      const response = await fetch('/api/audit/run', {
        method: 'POST',
        headers: {
          Accept: 'application/x-ndjson',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ customerId }),
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        finishedRef.current = true;
        setError(auditErrorInfo(String(payload.error ?? 'audit_failed'), { resetsAt: payload.resets_at }));
        setRunning(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          handleEvent(JSON.parse(line) as AuditStreamEvent);
        }

        if (done) break;
      }

      if (buffer.trim()) handleEvent(JSON.parse(buffer) as AuditStreamEvent);

      // The stream closed without a result or an error: the connection dropped.
      // Without this the dialog would keep spinning with no way out.
      if (!finishedRef.current) {
        finishedRef.current = true;
        setError(auditErrorInfo('audit_failed'));
        setRunning(false);
      }
    } catch {
      if (!finishedRef.current) {
        finishedRef.current = true;
        setError(auditErrorInfo('audit_failed'));
      }
      setRunning(false);
    }
  }

  function closeError() {
    setError(null);
    setRunning(false);
  }

  function handleEvent(event: AuditStreamEvent) {
    if (event.type === 'progress') {
      setPercent((current) => Math.max(current, event.percent));
      setMessage(event.message);
      setSteps((current) => ({
        ...current,
        [event.step]: {
          phase: event.phase,
          detail: event.detail,
          warning: event.warning,
        },
      }));
      return;
    }

    if (event.type === 'error') {
      finishedRef.current = true;
      setError(auditErrorInfo(event.code));
      setRunning(false);
      return;
    }

    finishedRef.current = true;
    setPercent(100);
    setMessage(event.message);
    window.setTimeout(() => {
      setRunning(false);
      router.push(event.redirect);
      router.refresh();
    }, 700);
  }

  // The error dialog can always be dismissed: Escape closes it and focus moves
  // to the close button so keyboard users are never stuck behind it.
  useEffect(() => {
    if (!error) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeError();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [error]);

  if (accounts.length === 0) return null;

  return (
    <>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void startAudit();
        }}
      >
        {accounts.length > 1 ? (
          <select
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
            className={cn(selectClasses, 'h-10 max-w-[180px]')}
            aria-label="اختر الحساب للفحص"
            disabled={running}
          >
            {accounts.map((account) => (
              <option key={account.customer_id} value={account.customer_id}>
                {googleAdsAccountDisplayName(account)}
              </option>
            ))}
          </select>
        ) : null}
        <button type="submit" disabled={running} className={buttonClasses({ variant: 'primary' })}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ScanSearch className="h-4 w-4" aria-hidden />}
          {running ? 'الفحص يعمل الآن' : label}
        </button>
      </form>

      {(running || error) && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-foreground/60 p-4"
          role="presentation"
          onClick={(event) => {
            if (error && event.target === event.currentTarget) closeError();
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-progress-title"
            className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card"
          >
            <div className="border-b border-border px-5 py-5 sm:px-7">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-primary">فحص مباشر من Google Ads</div>
                  <h2 id="audit-progress-title" className="mt-1 text-xl font-bold text-foreground">
                    {error ? error.title : `نفحص ${accountName}`}
                  </h2>
                  {error ? (
                    <div className="mt-2 space-y-1.5 text-sm leading-7" aria-live="assertive">
                      <p className="text-foreground">{error.message}</p>
                      <p className="text-muted-foreground">
                        <span className="font-semibold text-foreground">الخطوة الجاية: </span>
                        {error.nextStep}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground" aria-live="polite">{message}</p>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-start gap-2">
                  <div className={cn(
                    'flex h-14 w-14 items-center justify-center rounded-xl text-lg font-bold numeric',
                    error ? 'bg-danger/12 text-danger dark:text-danger' : 'bg-primary/12 text-primary'
                  )}>
                    {error ? <TriangleAlert className="h-6 w-6" aria-hidden /> : `${percent}%`}
                  </div>
                  {error && (
                    <button
                      type="button"
                      onClick={closeError}
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:text-foreground"
                      aria-label="إغلاق"
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  )}
                </div>
              </div>

              <div
                className="mt-5 h-2 overflow-hidden rounded-sm bg-muted"
                role="progressbar"
                aria-label="تقدم فحص الحساب"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div
                  className={cn('h-full rounded-sm transition-[width] duration-500', error ? 'bg-danger' : 'bg-primary')}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>

            <ol className="max-h-[45vh] divide-y divide-border overflow-y-auto px-5 sm:px-7">
              {AUDIT_PROGRESS_STEPS.map((definition) => {
                const state = steps[definition.id];
                const completed = state?.phase === 'completed';
                const active = state?.phase === 'started' && !error;
                return (
                  <li key={definition.id} className="flex gap-3 py-3.5">
                    <div className="mt-0.5 flex-shrink-0">
                      {completed ? (
                        <CheckCircle2 className={cn('h-5 w-5', state.warning ? 'text-warning' : 'text-success')} aria-hidden />
                      ) : active ? (
                        <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden />
                      ) : (
                        <Circle className="h-5 w-5 text-muted-foreground/45" aria-hidden />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={cn('text-sm font-semibold', state ? 'text-foreground' : 'text-muted-foreground/65')}>
                        {definition.title}
                      </div>
                      <p className="mt-0.5 text-xs leading-6 text-muted-foreground">
                        {active
                          ? definition.runningLabel
                          : completed
                            ? definition.completedLabel
                            : error
                              ? 'لم تبدأ هذه الخطوة'
                              : 'بانتظار اكتمال الخطوة السابقة'}
                      </p>
                      {state?.detail && (
                        <p className={cn('mt-1 text-xs leading-5', state.warning ? 'text-warning dark:text-warning' : 'text-muted-foreground')}>
                          {state.detail}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/35 px-5 py-4 sm:px-7">
              <p className="text-xs leading-5 text-muted-foreground">
                {error ? 'لم يُنفذ الفحص أي تعديل على حسابك.' : 'أبقِ هذه الصفحة مفتوحة حتى نحفظ النتيجة.'}
              </p>
              {error && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    ref={closeRef}
                    className={buttonClasses({ variant: 'outline', size: 'sm' })}
                    onClick={closeError}
                  >
                    إغلاق
                  </button>
                  {error.actions.includes('billing') && (
                    <a href="/billing" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
                      فتح الفوترة
                    </a>
                  )}
                  {error.actions.includes('connect') && (
                    <a href="/onboarding/connect" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
                      تجديد الربط
                    </a>
                  )}
                  {error.actions.includes('retry') && (
                    <button
                      type="button"
                      className={buttonClasses({ variant: 'primary', size: 'sm' })}
                      onClick={() => void startAudit()}
                    >
                      إعادة المحاولة
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

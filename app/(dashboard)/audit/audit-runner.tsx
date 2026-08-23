'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Circle, Loader2, ScanSearch, TriangleAlert } from 'lucide-react';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import {
  AUDIT_PROGRESS_STEPS,
  type AuditProgressEvent,
  type AuditStreamEvent,
} from '@/lib/audit/progress';
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
  const [error, setError] = useState<string | null>(null);

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
        throw new Error(auditErrorMessage(String(payload.error ?? 'audit_failed')));
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر إكمال الفحص الآن.');
      setRunning(false);
    }
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
      setError(event.message);
      setRunning(false);
      return;
    }

    setPercent(100);
    setMessage(event.message);
    window.setTimeout(() => {
      router.push(event.redirect);
      router.refresh();
    }, 700);
  }

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
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm" role="presentation">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-progress-title"
            className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
          >
            <div className="border-b border-border px-5 py-5 sm:px-7">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-medium text-primary">فحص مباشر من Google Ads</div>
                  <h2 id="audit-progress-title" className="mt-1 text-xl font-bold text-foreground">
                    نفحص {accountName}
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground" aria-live="polite">{error ?? message}</p>
                </div>
                <div className={cn(
                  'flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl text-lg font-bold numeric',
                  error ? 'bg-red-500/12 text-red-600 dark:text-red-300' : 'bg-primary/12 text-primary'
                )}>
                  {error ? <TriangleAlert className="h-6 w-6" aria-hidden /> : `${percent}%`}
                </div>
              </div>

              <div
                className="mt-5 h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="تقدم فحص الحساب"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div
                  className={cn('h-full rounded-full transition-[width] duration-500', error ? 'bg-red-500' : 'bg-primary')}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>

            <ol className="max-h-[55vh] divide-y divide-border overflow-y-auto px-5 sm:px-7">
              {AUDIT_PROGRESS_STEPS.map((definition) => {
                const state = steps[definition.id];
                const completed = state?.phase === 'completed';
                const active = state?.phase === 'started';
                return (
                  <li key={definition.id} className="flex gap-3 py-3.5">
                    <div className="mt-0.5 flex-shrink-0">
                      {completed ? (
                        <CheckCircle2 className={cn('h-5 w-5', state.warning ? 'text-amber-500' : 'text-emerald-500')} aria-hidden />
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
                            : 'بانتظار اكتمال الخطوة السابقة'}
                      </p>
                      {state?.detail && (
                        <p className={cn('mt-1 text-xs leading-5', state.warning ? 'text-amber-600 dark:text-amber-300' : 'text-muted-foreground')}>
                          {state.detail}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="flex items-center justify-between gap-4 border-t border-border bg-muted/35 px-5 py-4 sm:px-7">
              <p className="text-xs leading-5 text-muted-foreground">
                {error ? 'لم يُنفذ الفحص أي تعديل على حسابك.' : 'أبقِ هذه الصفحة مفتوحة حتى نحفظ النتيجة.'}
              </p>
              {error && (
                <button
                  type="button"
                  className={buttonClasses({ variant: 'primary', size: 'sm' })}
                  onClick={() => void startAudit()}
                >
                  إعادة المحاولة
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function auditErrorMessage(code: string) {
  if (code === 'subscription_required') return 'تحتاج إلى اشتراك نشط لتشغيل الفحص.';
  if (code === 'quota_exceeded') return 'وصلت إلى حد الفحوصات في خطتك الحالية.';
  if (code === 'account_not_found') return 'لم نجد الحساب الإعلاني المختار. اختر حساباً آخر أو أعد الربط.';
  if (code === 'too_many_requests') return 'تم إرسال عدة طلبات فحص خلال وقت قصير. انتظر قليلاً ثم أعد المحاولة.';
  if (code === 'security_service_unavailable') return 'تعذر التحقق من أمان الطلب الآن. أعد المحاولة بعد لحظات.';
  return 'تعذر إكمال الفحص الآن. لم ننفذ أي تعديل على حساب إعلانات Google.';
}

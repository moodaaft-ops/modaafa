'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** «افحص الحين»: the hourly sweep, by hand. Posts to /api/operations/provisioning/check, then reloads the page data. */
export function CheckNowButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/operations/provisioning/check', { method: 'POST' });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; checked?: number; accepted?: number; expired?: number; unlinked?: number; errors?: number; staleFailed?: number }
        | null;
      if (!res.ok || !body?.ok) {
        setMessage(
          res.status === 409
            ? 'المدير مو مربوط، ما فيه شي أفحصه.'
            : res.status === 429
              ? 'كثرت المحاولات، انتظر شوي.'
              : 'ما تم الفحص، جرّب بعد شوي.'
        );
      } else {
        setMessage(
          `انفحص ${body.checked ?? 0}، قُبل ${body.accepted ?? 0}، انتهى ${body.expired ?? 0}، انفك ${body.unlinked ?? 0}` +
            (body.errors ? `، أخطاء ${body.errors}` : '')
        );
        router.refresh();
      }
    } catch {
      setMessage('ما تم الفحص، تأكد من الاتصال وجرّب.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="h-10 bg-foreground px-4 text-sm font-semibold text-background disabled:opacity-60"
      >
        {busy ? 'أفحص…' : 'افحص الحين'}
      </button>
      {message && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}

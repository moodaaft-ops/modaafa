'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SHADOW_CATEGORIES, SHADOW_CATEGORY_LABELS_AR } from '@/lib/shadow/summary';

async function post(body: Record<string, unknown>) {
  const res = await fetch('/api/operations/shadow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return { ok: res.ok, error: data?.error };
}

const ERROR_AR: Record<string, string> = {
  customer_id_invalid: 'رقم الحساب لازم 10 أرقام.',
  account_not_found: 'ما لقينا الحساب بين الحسابات المربوطة.',
  account_ambiguous: 'الرقم مربوط بأكثر من حساب، افصلها أول.',
  too_many_requests: 'كثرت المحاولات، انتظر شوي.',
};

export function MarkShadowForm() {
  const router = useRouter();
  const [customerId, setCustomerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: 'mark' | 'unmark') {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const result = await post({ action, customer_id: customerId }).catch(() => ({ ok: false, error: 'network' }));
    setBusy(false);
    if (result.ok) {
      setMessage(action === 'mark' ? 'انحط الحساب في وضع الظل.' : 'انشال الحساب من وضع الظل.');
      setCustomerId('');
      router.refresh();
    } else {
      setMessage(ERROR_AR[result.error ?? ''] ?? 'ما تم، جرّب بعد شوي.');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        dir="ltr"
        inputMode="numeric"
        value={customerId}
        onChange={(event) => setCustomerId(event.target.value)}
        placeholder="رقم الحساب 123-456-7890"
        className="h-10 w-56 border border-border bg-background px-3 text-sm"
        aria-label="رقم حساب Google Ads"
      />
      <button type="button" disabled={busy} onClick={() => run('mark')} className="h-10 bg-foreground px-4 text-sm font-semibold text-background disabled:opacity-60">
        حطه في الظل
      </button>
      <button type="button" disabled={busy} onClick={() => run('unmark')} className="h-10 border border-border px-4 text-sm font-semibold disabled:opacity-60">
        شيله من الظل
      </button>
      {message && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}

export function ReviewButtons({ accountId, decisionId, current }: { accountId: string; decisionId: string; current: 'right' | 'wrong' | null }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function send(verdict: 'right' | 'wrong') {
    if (busy) return;
    setBusy(true);
    setError(false);
    const result = await post({ action: 'review', account_id: accountId, decision_id: decisionId, verdict, note }).catch(() => ({ ok: false }));
    setBusy(false);
    if (result.ok) router.refresh();
    else setError(true);
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy} onClick={() => send('right')} aria-pressed={current === 'right'} className={`h-8 px-3 text-xs font-semibold ring-1 ring-border ${current === 'right' ? 'bg-success/15 text-success' : ''}`}>
        صح
      </button>
      <button type="button" disabled={busy} onClick={() => send('wrong')} aria-pressed={current === 'wrong'} className={`h-8 px-3 text-xs font-semibold ring-1 ring-border ${current === 'wrong' ? 'bg-danger/10 text-danger' : ''}`}>
        غلط
      </button>
      <input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="ملاحظة (اختياري)"
        maxLength={600}
        className="h-8 min-w-40 flex-1 border border-border bg-background px-2 text-xs"
        aria-label="ملاحظة"
      />
      {error && <span className="text-xs text-danger">ما انحفظ</span>}
    </div>
  );
}

export function MissedForm({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [category, setCategory] = useState<string>('other');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const result = await post({ action: 'review', account_id: accountId, verdict: 'missed', category, note }).catch(() => ({ ok: false }));
    setBusy(false);
    if (result.ok) {
      setNote('');
      setMessage('انسجل.');
      router.refresh();
    } else setMessage('ما انحفظ، جرّب بعد شوي.');
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={category} onChange={(event) => setCategory(event.target.value)} className="h-9 border border-border bg-background px-2 text-xs" aria-label="نوع اللي فاته">
        {SHADOW_CATEGORIES.map((item) => (
          <option key={item} value={item}>
            {SHADOW_CATEGORY_LABELS_AR[item]}
          </option>
        ))}
      </select>
      <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="وش اللي فاته؟" maxLength={600} className="h-9 min-w-48 flex-1 border border-border bg-background px-2 text-xs" aria-label="وش اللي فاته" />
      <button type="button" disabled={busy || note.trim().length === 0} onClick={send} className="h-9 border border-border px-3 text-xs font-semibold disabled:opacity-60">
        فاتك شي
      </button>
      {message && <span className="text-xs text-muted-foreground">{message}</span>}
    </div>
  );
}

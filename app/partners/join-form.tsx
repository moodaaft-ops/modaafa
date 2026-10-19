'use client';

import { useState } from 'react';

export function JoinForm({ defaultName }: { defaultName: string }) {
  const [name, setName] = useState(defaultName);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/partners/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display_name: name, phone, code, accept_terms: accepted }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (res.ok && json.ok) {
        window.location.assign('/partners');
        return;
      }
      setError(json.message ?? (res.status === 429 ? 'محاولات كثيرة. جرّب بعد شوي.' : 'ما انحفظ طلبك. أعد المحاولة.'));
    } catch {
      setError('انقطع الاتصال. أعد المحاولة.');
    } finally {
      setBusy(false);
    }
  }

  const field = 'h-11 w-full border border-border bg-background px-3 text-sm text-foreground';
  return (
    <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
      <label className="block text-[13px] font-semibold text-foreground">
        الاسم اللي يظهر لك في الصفحة
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoComplete="name" className={`${field} mt-1.5`} />
      </label>
      <label className="block text-[13px] font-semibold text-foreground">
        جوالك (عشان نتواصل معك وقت الصرف)
        <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" dir="ltr" placeholder="9665XXXXXXXX" required autoComplete="tel" className={`${field} mt-1.5 text-start`} />
      </label>
      <label className="block text-[13px] font-semibold text-foreground">
        كودك (اختياري)
        <input value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" maxLength={32} placeholder="ahmed" autoCapitalize="none" className={`${field} mt-1.5 text-start font-mono`} />
        <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">إنجليزي صغير وأرقام. لو تركته فاضي نختار لك واحد.</span>
      </label>
      <label className="flex items-start gap-2.5 text-[13px] leading-6 text-foreground">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-1.5 h-4 w-4" />
        <span>قرأت الشروط اللي فوق وأوافق عليها.</span>
      </label>
      {error && (
        <p role="alert" className="border border-danger/40 bg-danger/10 px-4 py-3 text-sm leading-6">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || !accepted} className="h-11 bg-foreground px-6 text-sm font-semibold text-background disabled:opacity-50">
        {busy ? 'لحظة...' : 'انضم للبرنامج'}
      </button>
    </form>
  );
}

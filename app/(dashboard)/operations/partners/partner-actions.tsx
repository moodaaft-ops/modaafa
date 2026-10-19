'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const ERRORS: Record<string, string> = {
  bad_code: 'الكود لازم 3 إلى 32 حرف إنجليزي صغير أو رقم أو - أو _.',
  bad_email: 'الإيميل مو صحيح.',
  bad_name: 'الاسم قصير أو طويل.',
  bad_rate: 'النسبة بين 0 و0.5 (مثلاً 0.25).',
  duplicate: 'الكود أو الإيميل مستخدم عند شريك ثاني.',
  reference_required: 'اكتب رقم الحوالة (3 أحرف على الأقل).',
  too_many_requests: 'كثرت المحاولات، انتظر شوي.',
  bad_input: 'في بيانات ناقصة.',
};

async function send(body: Record<string, unknown>) {
  try {
    const res = await fetch('/api/operations/partners', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<string, any> | null;
    return { ok: res.ok && json?.ok === true, json, status: res.status };
  } catch {
    return { ok: false, json: null, status: 0 };
  }
}

const field = 'h-10 min-w-0 border border-border bg-background px-3 text-sm text-foreground';
const primary = 'h-10 bg-foreground px-4 text-sm font-semibold text-background disabled:opacity-60';
const quiet = 'h-9 border border-border-strong px-3 text-[13px] font-semibold text-foreground hover:border-foreground disabled:opacity-60';

export function CreatePartnerForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    setBusy(true);
    setMessage(null);
    const result = await send({ action: 'create', ...data });
    setBusy(false);
    if (result.ok) {
      form.reset();
      setMessage(`انضاف الشريك. رابطه: /r/${result.json?.code}`);
      router.refresh();
    } else {
      setMessage(ERRORS[result.json?.error] ?? 'ما انضاف، جرّب بعد شوي.');
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 border border-border p-4 sm:grid-cols-2">
      <input name="display_name" required placeholder="الاسم" aria-label="الاسم" className={field} />
      <input name="email" type="email" required dir="ltr" placeholder="الإيميل (نفسه اللي يسجّل فيه)" aria-label="الإيميل" className={field} />
      <input name="code" required dir="ltr" placeholder="الكود، مثلاً sara" aria-label="الكود" className={field} />
      <input name="phone" dir="ltr" placeholder="الجوال (اختياري)" aria-label="الجوال" className={field} />
      <input name="commission_rate" dir="ltr" inputMode="decimal" placeholder="نسبة خاصة، مثلاً 0.35 (اختياري)" aria-label="نسبة خاصة" className={field} />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className={primary}>
          أضف شريك
        </button>
        {message && <p role="status" className="text-[13px] text-muted-foreground">{message}</p>}
      </div>
    </form>
  );
}

export function PartnerRowActions({ partnerId, status, payableCurrencies }: { partnerId: string; status: string; payableCurrencies: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  async function setStatus(next: 'active' | 'paused' | 'banned') {
    if (busy) return;
    if (next === 'banned' && !window.confirm('تأكد: الحظر يوقف الإحالات الجديدة والعمولات القادمة لهذا الشريك.')) return;
    setBusy(true);
    const result = await send({ action: 'status', partner_id: partnerId, status: next });
    setBusy(false);
    setMessage(result.ok ? null : 'ما تغيّرت الحالة.');
    if (result.ok) router.refresh();
  }

  async function payOut(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    setBusy(true);
    setMessage(null);
    const result = await send({ action: 'pay_out', partner_id: partnerId, ...data });
    setBusy(false);
    const s = result.json?.status as string | undefined;
    if (result.ok && s === 'paid') {
      setMessage(`سُجّل الصرف: ${result.json?.amount}`);
      setPaying(false);
      router.refresh();
    } else if (result.ok) {
      setMessage(
        s === 'below_minimum' ? 'الصافي أقل من الحد الأدنى للصرف.'
        : s === 'covered_by_clawback' ? 'الاسترجاعات تغطي الجاهز، ما فيه شي يُصرف.'
        : 'ما فيه شي جاهز للصرف.'
      );
    } else {
      setMessage(ERRORS[result.json?.error] ?? 'ما تم تسجيل الصرف.');
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {status !== 'active' && <button type="button" disabled={busy} onClick={() => setStatus('active')} className={quiet}>فعّل</button>}
        {status === 'active' && <button type="button" disabled={busy} onClick={() => setStatus('paused')} className={quiet}>أوقف</button>}
        {status !== 'banned' && <button type="button" disabled={busy} onClick={() => setStatus('banned')} className={quiet}>احظر</button>}
        {payableCurrencies.length > 0 && <button type="button" onClick={() => setPaying((v) => !v)} className={quiet}>سجّل صرف</button>}
      </div>
      {paying && (
        <form onSubmit={payOut} className="grid gap-2 border border-border p-3 sm:grid-cols-2">
          <select name="currency" aria-label="العملة" className={field} defaultValue={payableCurrencies[0]}>
            {payableCurrencies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select name="method" aria-label="طريقة التحويل" className={field} defaultValue="bank_transfer">
            <option value="bank_transfer">تحويل بنكي</option>
            <option value="wise">Wise</option>
            <option value="other">غير ذلك</option>
          </select>
          <input name="reference" required dir="ltr" placeholder="رقم الحوالة" aria-label="رقم الحوالة" className={field} />
          <input name="note" placeholder="ملاحظة (اختياري)" aria-label="ملاحظة" className={field} />
          <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
            حوّل المبلغ أول من البنك، وبعدين سجّله هنا. التسجيل يقفل العمولات الجاهزة ويخصم الاسترجاعات تلقائياً.
          </p>
          <button type="submit" disabled={busy} className={primary}>سجّل الصرف</button>
        </form>
      )}
      {message && <p role="status" className="text-[13px] text-muted-foreground">{message}</p>}
    </div>
  );
}

export function HeldActions({ commissionId }: { commissionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function resolve(release: boolean) {
    if (busy) return;
    setBusy(true);
    const result = await send({ action: 'resolve_held', commission_id: commissionId, release });
    setBusy(false);
    if (result.ok) router.refresh();
  }
  return (
    <div className="flex gap-2">
      <button type="button" disabled={busy} onClick={() => resolve(true)} className={quiet}>اعتمد</button>
      <button type="button" disabled={busy} onClick={() => resolve(false)} className={quiet}>ألغِ</button>
    </div>
  );
}

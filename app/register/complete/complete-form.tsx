'use client';

import { useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Alert } from '@/lib/ui/alert';
import { ThemeToggle } from '@/lib/ui/theme-toggle';
import { LogoLockup } from '@/lib/ui/logo';

type FieldErrors = Partial<Record<'name' | 'phone', string>>;

const inputClass =
  'h-12 w-full rounded-lg border border-input bg-card px-4 text-sm outline-none transition focus:border-primary/60';

const PHONE_TAKEN = 'هذا الرقم مسجل بحساب ثاني. استخدم رقماً آخر.';

export function CompleteForm({
  email,
  initialName,
  initialError,
  consentText,
}: {
  email: string;
  initialName: string;
  initialError: string;
  consentText: string;
}) {
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(initialError === 'failed' ? 'صار خلل من عندنا. أعد المحاولة.' : '');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(
    initialError === 'phone_taken' ? { phone: PHONE_TAKEN } : {},
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError('');
    setFieldErrors({});
    try {
      const res = await fetch('/api/register/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        errors?: FieldErrors;
        redirect?: string;
      };
      if (res.ok && body.ok) {
        window.location.assign(body.redirect ?? '/welcome');
        return;
      }
      if (body.error === 'validation' && body.errors) setFieldErrors(body.errors);
      else if (body.error === 'phone_taken') setFieldErrors({ phone: PHONE_TAKEN });
      else if (body.error === 'too_many_requests') setError('حاولت عدة مرات. انتظر دقيقة ثم أعد المحاولة.');
      else if (body.error === 'unauthenticated') window.location.assign('/login?next=/register/finish');
      else setError('صار خلل من عندنا. أعد المحاولة بعد قليل.');
    } catch {
      setError('تعذر الاتصال. تأكد من الإنترنت ثم أعد المحاولة.');
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="min-h-screen bg-background p-4 lg:p-6">
      <div className="mx-auto flex min-h-[calc(100dvh-2rem)] max-w-md items-center">
        <div className="relative w-full surface-card p-6 sm:p-10">
          <div className="absolute end-4 top-4">
            <ThemeToggle />
          </div>
          <div className="mb-8">
            <LogoLockup />
          </div>
          <div className="mb-7">
            <h1 className="text-2xl font-bold">باقي خطوة وحدة</h1>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">
              أكمل اسمك ورقم جوالك لحساب <span dir="ltr">{email}</span> وندخلك المنصة.
            </p>
          </div>

          {error && (
            <div className="mb-4">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-foreground">الاسم</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
                className={inputClass}
              />
              {fieldErrors.name && <span className="mt-1 block text-xs text-danger">{fieldErrors.name}</span>}
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-foreground">رقم الجوال</span>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                autoComplete="tel"
                inputMode="tel"
                dir="ltr"
                placeholder="05xxxxxxxx"
                className={inputClass}
              />
              {fieldErrors.phone && <span className="mt-1 block text-xs text-danger">{fieldErrors.phone}</span>}
            </label>
            <button
              type="submit"
              disabled={sending}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary text-[0.9375rem] font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-50"
            >
              {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowLeft className="h-4 w-4" />}
              أكمل التسجيل
            </button>
            {consentText && <p className="text-xs leading-6 text-muted-foreground">{consentText}</p>}
          </form>
        </div>
      </div>
    </main>
  );
}

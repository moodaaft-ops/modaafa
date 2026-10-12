'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Alert } from '@/lib/ui/alert';
import { ThemeToggle } from '@/lib/ui/theme-toggle';
import { LogoLockup } from '@/lib/ui/logo';

type FieldErrors = Partial<Record<'name' | 'email' | 'phone', string>>;

const inputClass =
  'h-12 w-full rounded-lg border border-input bg-card px-4 text-sm outline-none transition focus:border-primary/60';

export function RegisterForm({ consentText }: { consentText: string }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError('');
    setFieldErrors({});
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; errors?: FieldErrors };
      if (res.ok && body.ok) {
        setSent(true);
        return;
      }
      if (body.error === 'validation' && body.errors) setFieldErrors(body.errors);
      else if (body.error === 'phone_taken') {
        setFieldErrors({ phone: 'هذا الرقم مسجل بحساب ثاني. استخدم رقماً آخر أو سجّل دخولك بالحساب الأول.' });
      } else if (body.error === 'too_many_requests') {
        setError('حاولت عدة مرات خلال وقت قصير. انتظر دقيقة ثم أعد المحاولة.');
      } else if (body.error === 'email_failed') {
        setError('تعذر إرسال الرسالة الآن. تأكد من البريد ثم أعد المحاولة بعد دقيقة.');
      } else {
        setError('صار خلل من عندنا. أعد المحاولة بعد قليل.');
      }
    } catch {
      setError('تعذر الاتصال. تأكد من الإنترنت ثم أعد المحاولة.');
    } finally {
      setSending(false);
    }
  }

  function handleGoogle() {
    setGoogleLoading(true);
    window.location.assign(`/api/auth/google/login?next=${encodeURIComponent('/register/finish')}`);
  }

  return (
    <main className="min-h-screen bg-background p-4 lg:p-6">
      <div className="mx-auto flex min-h-[calc(100dvh-2rem)] max-w-md items-center">
        <div className="relative w-full surface-card p-6 sm:p-10">
          <div className="absolute end-4 top-4">
            <ThemeToggle />
          </div>
          <Link href="/" className="mb-8 flex items-center gap-3">
            <LogoLockup />
          </Link>

          {sent ? (
            <Alert tone="success" title={`وصلتك رسالة على ${email}`} icon>
              افتحها واضغط الزر داخلها مرة واحدة. بعدها يكتمل تسجيلك وندخلك المنصة. لو ما لقيتها، شوف مجلد الرسائل غير المرغوبة.
            </Alert>
          ) : (
            <>
              <div className="mb-7">
                <h1 className="text-2xl font-bold">أنشئ حسابك</h1>
                <p className="mt-2 text-sm leading-7 text-muted-foreground">
                  اسمك وبريدك وجوالك، وتدخل المنصة. بدون بطاقة بنكية.
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
                  <span className="mb-2 block text-sm font-medium text-foreground">البريد الإلكتروني</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    dir="ltr"
                    placeholder="name@example.com"
                    className={inputClass}
                  />
                  {fieldErrors.email && <span className="mt-1 block text-xs text-danger">{fieldErrors.email}</span>}
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
                  أرسل لي رابط التفعيل
                </button>

                {consentText && <p className="text-xs leading-6 text-muted-foreground">{consentText}</p>}
              </form>

              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-card px-3 text-muted-foreground">أو</span>
                </div>
              </div>

              <button
                type="button"
                onClick={handleGoogle}
                disabled={googleLoading}
                className="flex h-12 w-full items-center justify-center gap-3 surface-card text-sm font-semibold transition hover:bg-muted disabled:cursor-wait disabled:opacity-70"
              >
                {googleLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                المتابعة بحساب Google
              </button>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                مع Google نطلب منك رقم الجوال في الخطوة التالية.
              </p>

              <p className="mt-6 text-center text-xs text-muted-foreground">
                عندك حساب؟{' '}
                <Link href="/login" className="font-semibold text-foreground underline underline-offset-4">
                  سجّل دخولك
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

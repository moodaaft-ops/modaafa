'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, Loader2, MailCheck, ShieldCheck } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Alert } from '@/lib/ui/alert';
import { ThemeToggle } from '@/lib/ui/theme-toggle';
import { safeLocalPath } from '@/lib/security/redirect';

const authErrors: Record<string, string> = {
  auth_callback_failed: 'تعذر إكمال تسجيل الدخول. أعد المحاولة، وإذا تكرر جرّب رابط بريد جديد.',
  google_state_failed: 'انتهت جلسة الدخول عبر Google قبل إكمالها. أعد المحاولة من زر «الدخول بـ Google».',
  google_login_failed: 'لم يكتمل الدخول عبر Google. تأكد من السماح بالوصول ثم أعد المحاولة.',
  too_many_requests: 'حاولت الدخول عدة مرات خلال فترة قصيرة. انتظر دقيقة ثم أعد المحاولة.',
  security_service_unavailable: 'تعذر التحقق الآمن من طلب الدخول الآن. أعد المحاولة بعد قليل.',
  missing_config: 'إعدادات المنصة غير مكتملة في هذه البيئة. تواصل معنا حتى نعالجها.',
};

/**
 * Supabase surfaces its own errors in English (e.g. "For security purposes,
 * you can only request this after 60 seconds"). Showing them raw inside an
 * otherwise fully-Arabic form reads as a broken page, so the ones users
 * actually hit are mapped.
 */
function arabicSupabaseError(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes('only request this after') || normalized.includes('rate limit')) {
    return 'أرسلنا رابطاً قبل قليل. انتظر دقيقة ثم أعد المحاولة.';
  }
  if (normalized.includes('invalid') && normalized.includes('email')) {
    return 'صيغة البريد غير صحيحة. تأكد منها ثم أعد المحاولة.';
  }
  if (normalized.includes('signups not allowed') || normalized.includes('not allowed')) {
    return 'هذا البريد غير مسموح له بالدخول حالياً. تواصل معنا.';
  }
  return 'تعذر إرسال رابط الدخول الآن. أعد المحاولة بعد قليل.';
}

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [authError, setAuthError] = useState('');

  const [notice, setNotice] = useState('');

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const code = query.get('error');
    if (code) setAuthError(authErrors[code] ?? 'تعذر تسجيل الدخول. أعد المحاولة.');
    if (query.get('account_deleted') === '1') {
      setNotice('تم حذف حسابك وبياناته نهائياً. شكراً لتجربتك مُضاعِف.');
    }
  }, []);

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError('');
    const supabase = createClient();
    const next = getSafeNextPath();
    const callbackUrl = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: callbackUrl },
    });
    setSending(false);
    if (error) setError(arabicSupabaseError(error.message));
    else setSent(true);
  }

  function handleGoogleLogin() {
    setGoogleLoading(true);
    const next = getSafeNextPath();
    window.location.assign(`/api/auth/google/login?next=${encodeURIComponent(next)}`);
  }

  return (
    <main className="min-h-screen bg-background p-4 lg:p-6">
      <div className="mx-auto grid min-h-[calc(100dvh-3rem)] max-w-6xl overflow-hidden rounded-lg border border-border bg-card shadow-card lg:grid-cols-[1.05fr_460px]">
        {/* Brand panel */}
        <section className="hidden flex-col justify-between overflow-hidden bg-ink-900 p-10 text-white lg:flex">
          <div>
            <Link href="/" className="flex items-center gap-3">
              <Image src="/logo-mark.svg" alt="مُضاعِف" width={44} height={44} className="h-11 w-11 rounded-xl shadow-soft" />
              <span>
                <span className="block text-xl font-bold">مُضاعِف</span>
                <span className="block text-xs text-white/60" dir="ltr">
                  Modaafa Ads AI
                </span>
              </span>
            </Link>
            <h1 className="mt-16 max-w-xl text-4xl font-bold leading-tight">
              اربط حساب إعلانات Google، وخلّي المنصة تطلع لك الفحص والتوصيات ومركز الموافقات.
            </h1>
            <p className="mt-4 max-w-md text-sm leading-7 text-white/70">
              كل تعديل يبقى تحت موافقتك. لا ينفّذ المساعد أي تغيير على حسابك قبل أن تعتمده.
            </p>
          </div>
          <ul className="grid gap-1 divide-y divide-white/10 border-y border-white/10">
            {['سجّل دخولك بحساب Google', 'اربط كل حساباتك بموافقة واحدة', 'راجع التوصيات واعتمدها'].map((s, i) => (
              <li key={s} className="flex items-center gap-3 px-1 py-3 text-sm">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-bold">
                  {i + 1}
                </span>
                {s}
              </li>
            ))}
          </ul>
        </section>

        {/* Form panel */}
        <section className="relative flex items-center p-6 sm:p-10">
          <div className="absolute end-4 top-4">
            <ThemeToggle />
          </div>
          <div className="w-full">
            <Link href="/" className="mb-8 flex items-center gap-3 lg:hidden">
              <Image src="/logo-mark.svg" alt="مُضاعِف" width={40} height={40} className="h-10 w-10 rounded-xl" />
              <span className="text-lg font-bold">مُضاعِف</span>
            </Link>

            <div className="mb-7">
              <h2 className="text-2xl font-bold">تسجيل الدخول</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                ادخل بنفس حساب Google الذي يملك أو يدير حساباتك الإعلانية للرجوع لمساحتك.
              </p>
            </div>

            {notice && (
              <div className="mb-4">
                <Alert tone="success">{notice}</Alert>
              </div>
            )}

            {authError && (
              <div className="mb-4">
                <Alert tone="danger">{authError}</Alert>
              </div>
            )}

            <button
              onClick={handleGoogleLogin}
              disabled={googleLoading}
              aria-busy={googleLoading}
              className="mb-4 flex h-12 w-full items-center justify-center gap-3 rounded-lg border border-border bg-card text-sm font-semibold transition hover:bg-muted disabled:cursor-wait disabled:opacity-70"
            >
              {googleLoading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <svg className="h-5 w-5" viewBox="0 0 48 48" aria-hidden>
                  <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
                  <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
                  <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
                  <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
                </svg>
              )}
              {googleLoading ? 'جاري فتح Google...' : 'الدخول بـ Google'}
            </button>

            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-card px-3 text-muted-foreground">أو عبر البريد</span>
              </div>
            </div>

            {sent ? (
              <Alert tone="success" icon={false}>
                <div className="flex items-center gap-2 font-semibold">
                  <MailCheck className="h-5 w-5" />
                  أرسلنا رابط الدخول إلى بريدك
                </div>
                <p className="mt-1">افتح الرابط من نفس هذا الجهاز لإكمال الدخول.</p>
              </Alert>
            ) : (
              <form onSubmit={handleEmailLogin} className="space-y-4">
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-foreground">البريد الإلكتروني</span>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    dir="ltr"
                    className="h-12 w-full rounded-lg border border-input bg-card px-4 text-sm outline-none transition focus:border-brand-500"
                  />
                </label>
                <button
                  type="submit"
                  disabled={sending}
                  aria-busy={sending}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand-gradient font-semibold text-white shadow-soft transition hover:brightness-105 hover:shadow-glow-brand disabled:opacity-60"
                >
                  {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowLeft className="h-4 w-4" />}
                  {sending ? 'جاري الإرسال...' : 'إرسال رابط الدخول'}
                </button>
                {error && <Alert tone="danger">{error}</Alert>}
              </form>
            )}

            <div className="mt-6 flex items-center gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 flex-shrink-0 text-emerald-500" />
              دخولك آمن، ولا ننفّذ أي تعديل على إعلاناتك بدون موافقتك.
            </div>

            <p className="mt-6 text-center text-xs text-muted-foreground">
              بدخولك توافق على{' '}
              <a href="/terms" className="font-medium text-brand-700 hover:underline dark:text-brand-400">
                شروط الاستخدام
              </a>{' '}
              و{' '}
              <a href="/privacy" className="font-medium text-brand-700 hover:underline dark:text-brand-400">
                سياسة الخصوصية
              </a>
              . ويمكنك مراجعة{' '}
              <a href="/data-deletion" className="font-medium text-brand-700 hover:underline dark:text-brand-400">
                حذف البيانات
              </a>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}

function getSafeNextPath() {
  if (typeof window === 'undefined') return '/dashboard';
  const next = new URLSearchParams(window.location.search).get('next');
  return safeLocalPath(next);
}

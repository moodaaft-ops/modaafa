'use client';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError('');
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard` },    });
    setSending(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  async function handleGoogleLogin() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback?next=/dashboard` },    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-ink-50 to-brand-50 p-4">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl p-8">
        <div className="text-center mb-8">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-cyan-500 items-center justify-center text-white text-3xl font-bold mb-4">
            ×
          </div>
          <h1 className="text-2xl font-bold mb-1">مُضاعِف</h1>
          <p className="text-ink-500 text-sm">سجّل دخول لإدارة حملاتك</p>
        </div>

        <button
          onClick={handleGoogleLogin}
          className="w-full mb-4 px-4 py-3 rounded-xl border border-ink-200 hover:bg-ink-50 flex items-center justify-center gap-3 font-medium text-sm"
        >
          <svg className="w-5 h-5" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"/><path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"/><path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"/><path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"/></svg>
          الدخول بـ Google
        </button>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-ink-100"></div></div>
          <div className="relative flex justify-center text-xs"><span className="px-2 bg-white text-ink-400">أو</span></div>
        </div>

        {sent ? (
          <div className="text-center text-emerald-600 text-sm">
            ✓ تم إرسال رابط الدخول لبريدك. افحص inbox.
          </div>
        ) : (
          <form onSubmit={handleEmailLogin} className="space-y-4">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="بريدك الإلكتروني"
              className="w-full px-4 py-3 rounded-xl border border-ink-200 focus:border-brand-500 outline-none"
            />
            <button
              type="submit"
              disabled={sending}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 text-white font-semibold disabled:opacity-50"
            >
              {sending ? 'جاري الإرسال...' : 'إرسال رابط الدخول'}
            </button>
            {error && <div className="text-red-500 text-sm text-center">{error}</div>}
          </form>
        )}

        <p className="text-center text-xs text-ink-400 mt-6">
          بدخولك توافق على{' '}
          <a href="/terms" className="text-brand-600 hover:underline">شروط الاستخدام</a> و{' '}
          <a href="/privacy" className="text-brand-600 hover:underline">سياسة الخصوصية</a>
        </p>
      </div>
    </div>
  );
}

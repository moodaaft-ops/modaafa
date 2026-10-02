import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { ThemeToggle } from '@/lib/ui/theme-toggle';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { TikTokPixel } from '@/lib/analytics/tiktok-pixel';
import { isRecentRegistration } from '@/lib/analytics/tiktok';

export const metadata: Metadata = {
  title: 'الإعداد الأول',
};

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  // Onboarding is where a brand-new account lands, so it is the one place the
  // registration is reported. The pixel only loads while the account is under
  // 30 minutes old: anyone returning later (e.g. via "إضافة حساب") gets no
  // pixel at all, rather than one that loads and then sends nothing.
  const { user } = await getRequestAuthContext();
  const justRegistered = user && isRecentRegistration(user.created_at) ? user : null;

  return (
    // A faint radial wash behind the setup flow so the panels read as floating
    // on a canvas rather than sitting on flat paint — same treatment as the
    // landing hero, at lower intensity.
    <div className="relative min-h-screen bg-background">
      {justRegistered && (
        <TikTokPixel conversion={{ event: 'CompleteRegistration', userId: justRegistered.id }} />
      )}
      <div className="canvas-glow pointer-events-none absolute inset-x-0 top-0 h-[420px] opacity-70" aria-hidden />

      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Image src="/logo-mark.svg" alt="" width={32} height={32} className="h-8 w-8 rounded-lg" aria-hidden />
            <span className="text-[15px] font-bold text-foreground">مُضاعِف</span>
          </Link>
          {/* The "لوحة التحكم" link used to live here unconditionally, which
              sent brand-new users into a dashboard with nothing in it. The
              escape hatch now lives in the progress bar and only appears once
              the user actually has an account to go back to. */}
          <ThemeToggle />
        </div>
      </header>

      <div className="relative">{children}</div>
    </div>
  );
}

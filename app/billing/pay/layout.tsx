import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ThemeToggle } from '@/lib/ui/theme-toggle';
import { createAdminClient, getRequestAuthContext } from '@/lib/supabase/server';
import { isRegistrationComplete, REGISTRATION_COMPLETE_PATH } from '@/lib/registration/gate';
import { Lock } from 'lucide-react';
import { LogoMark } from '@/lib/ui/logo';

export const metadata: Metadata = {
  title: 'الدفع',
  robots: { index: false, follow: false },
};

/**
 * The payment page stands on its own, outside the dashboard chrome, so the same
 * screen serves a customer coming from /billing and one coming from the first-run
 * onboarding. Sign-in and the registration step are enforced here as well as in
 * the middleware.
 */
export default async function PayLayout({ children }: { children: React.ReactNode }) {
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/billing');
  if (!(await isRegistrationComplete(createAdminClient(), user.id))) redirect(REGISTRATION_COMPLETE_PATH);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <LogoMark size={32} alt="" />
            <span className="text-[15px] font-bold text-foreground">مُضاعِف</span>
          </Link>
          <div className="flex items-center gap-4">
            <span className="hidden items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground sm:flex">
              <Lock aria-hidden className="h-3.5 w-3.5" />
              صفحة دفع آمنة
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

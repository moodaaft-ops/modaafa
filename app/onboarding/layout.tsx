import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { redirect } from 'next/navigation';
import { ThemeToggle } from '@/lib/ui/theme-toggle';
import { createAdminClient, getRequestAuthContext } from '@/lib/supabase/server';
import { isRegistrationComplete, REGISTRATION_COMPLETE_PATH } from '@/lib/registration/gate';
import { LogoMark } from '@/lib/ui/logo';

export const metadata: Metadata = {
  title: 'الإعداد الأول',
};

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  // Registration (name, email, phone) comes first. The CompleteRegistration
  // conversion is reported from /welcome now, with the same event id the
  // server event uses, so this layout no longer reports it.
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/onboarding');
  if (!(await isRegistrationComplete(createAdminClient(), user.id))) redirect(REGISTRATION_COMPLETE_PATH);

  return (
    // A faint radial wash behind the setup flow so the panels read as floating
    // on a canvas rather than sitting on flat paint — same treatment as the
    // landing hero, at lower intensity.
    <div className="relative min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <LogoMark size={32} alt="" />
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

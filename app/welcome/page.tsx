import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getRequestAuthContext, createAdminClient } from '@/lib/supabase/server';
import { isRegistrationComplete, REGISTRATION_COMPLETE_PATH } from '@/lib/registration/gate';
import { RegistrationPixel } from '@/lib/analytics/registration-pixel';
import { LogoLockup } from '@/lib/ui/logo';

export const metadata: Metadata = {
  title: 'أهلاً بك',
};

/**
 * First page after registration. Placeholder content: the real welcome page is
 * built separately, this one exists so the redirect target and the pixel are
 * in place and testable.
 */
export default async function WelcomePage() {
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/welcome');
  if (!(await isRegistrationComplete(createAdminClient(), user.id))) redirect(REGISTRATION_COMPLETE_PATH);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <RegistrationPixel userId={user.id} />
      <div className="w-full max-w-md surface-card p-8 text-center">
        <div className="mb-6 flex justify-center">
          <LogoLockup />
        </div>
        <h1 className="text-2xl font-bold">تم تسجيلك</h1>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">حسابك جاهز. ندخلك المنصة الحين.</p>
        <Link
          href="/dashboard"
          className="mt-6 flex h-12 w-full items-center justify-center rounded-lg bg-primary text-[0.9375rem] font-semibold text-primary-foreground hover:bg-primary/90"
        >
          ادخل المنصة
        </Link>
      </div>
    </main>
  );
}

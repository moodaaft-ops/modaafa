import { redirect } from 'next/navigation';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { OnboardingProgress } from '../onboarding-progress';
import { PreparingAccounts } from './preparing-accounts';

export const metadata = {
  title: 'نجهز حساباتك',
};

export default async function PreparingPage() {
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/onboarding/preparing');

  return (
    <main className="px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <OnboardingProgress active="connect" />
        <div className="mb-6 mt-8">
          <h2 className="text-[26px] font-bold leading-tight sm:text-3xl">نجهز حساباتك</h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
            وصلتنا موافقة Google. نقرأ حساباتك الحين وننقلك للخطوة الجاية أول ما نخلص، وتقدر تترك الصفحة مفتوحة.
          </p>
        </div>
        <PreparingAccounts />
      </div>
    </main>
  );
}

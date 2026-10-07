import { redirect } from 'next/navigation';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { createAdminClient, getRequestAuthContext } from '@/lib/supabase/server';
import { connectJobName, type ConnectJobDetails } from '@/lib/onboarding/connect-progress';
import { accountsCountLabel, sortAccountsBySpend } from '@/lib/onboarding/account-choice';
import { OnboardingProgress } from '../onboarding-progress';
import { ChooseAccountForm } from './choose-account-form';

export const metadata = {
  title: 'اختر الحساب',
};

export default async function ChooseAccountPage() {
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/onboarding/choose');

  const { accounts, business } = await getAccountWorkspace(user.id);
  if (!business) redirect('/onboarding/business');
  if (accounts.length === 0) redirect('/onboarding/connect');

  const spend = await loadLatestSpend(user.id);
  const ranked = sortAccountsBySpend(
    accounts.map((account) => ({
      customer_id: account.customer_id,
      customer_name: account.customer_name,
      google_status: account.google_status ?? null,
      currency_code: account.currency_code ?? null,
    })),
    spend
  );
  const hasSpend = ranked.some((account) => account.spend !== null);

  return (
    <main className="px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <OnboardingProgress active="choose" />
        <div className="mb-6 mt-8">
          <h2 className="text-[26px] font-bold leading-tight sm:text-3xl">اختر الحساب الذي نبدأ به</h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
            وصلنا {accountsCountLabel(ranked.length)}.
            {hasSpend
              ? ' رتبناها حسب الصرف في آخر 30 يوم.'
              : ' ما قدرنا نقرأ الصرف لهالحسابات، فرتبناها حسب الحالة.'}{' '}
            تقدر تبدّل الحساب بعدين من لوحة التحكم.
          </p>
        </div>
        <ChooseAccountForm
          accounts={ranked}
          initialCustomerId={business.selected_google_ads_customer_id ?? null}
        />
      </div>
    </main>
  );
}

/**
 * The connect job stores each account's 30-day spend next to its stages.
 * Missing or unreadable means "unknown", which the chooser shows as such.
 */
async function loadLatestSpend(userId: string): Promise<Record<string, number | null>> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from('job_runs')
      .select('details')
      .eq('job_name', connectJobName(userId))
      .in('status', ['success', 'partial', 'failed'])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const details = (data?.details ?? null) as ConnectJobDetails | null;
    return details?.spend ?? {};
  } catch {
    return {};
  }
}

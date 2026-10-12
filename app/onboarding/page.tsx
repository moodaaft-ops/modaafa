import { redirect } from 'next/navigation';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { getRequestAuthContext } from '@/lib/supabase/server';

export const metadata = {
  title: 'الإعداد الأول',
};

export default async function OnboardingPage() {
  const { user } = await getRequestAuthContext();

  if (!user) redirect('/login?next=/onboarding');

  const { accounts, revokedAccounts, pausedAccounts, business } = await getAccountWorkspace(user.id);
  if (accounts.length > 0) redirect('/dashboard');

  // Linked before but expired or paused: that is a renewal, not a first visit,
  // so it keeps the old path to the connect page.
  if (revokedAccounts.length + pausedAccounts.length > 0) {
    redirect(business ? '/onboarding/connect' : '/onboarding/business');
  }

  // Nobody has connected yet: the first thing they see is /welcome, which
  // explains what linking does before Google's consent screen appears.
  redirect('/welcome');
}

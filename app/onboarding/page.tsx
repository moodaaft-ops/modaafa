import { redirect } from 'next/navigation';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { getRequestAuthContext } from '@/lib/supabase/server';

export const metadata = {
  title: 'الإعداد الأول',
};

export default async function OnboardingPage() {
  const { user } = await getRequestAuthContext();

  if (!user) redirect('/login?next=/onboarding');

  const { accounts, business } = await getAccountWorkspace(user.id);
  if (accounts.length > 0) redirect('/dashboard');

  if (business) redirect('/onboarding/connect');

  redirect('/onboarding/business');
}

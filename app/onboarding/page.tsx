import { redirect } from 'next/navigation';
import { getAccountWorkspace, getUserBusiness } from '@/lib/accounts/selection';
import { createServerClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'الإعداد الأول',
};

export default async function OnboardingPage() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login?next=/onboarding');

  const { accounts } = await getAccountWorkspace(supabase, user.id);
  if (accounts.length > 0) redirect('/dashboard');

  const business = await getUserBusiness(supabase, user.id);
  if (business) redirect('/onboarding/connect');

  redirect('/onboarding/business');
}

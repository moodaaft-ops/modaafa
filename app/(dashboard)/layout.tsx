import { redirect } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { DashboardChrome } from './dashboard-chrome';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: business } = await supabase
    .from('businesses')
    .select('name')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const workspace = await getAccountWorkspace(supabase);
  const { accounts, selectedCustomerId } = workspace;

  // Send a first-time user through onboarding.
  //
  // Nothing linked to /onboarding: the login page defaults `next` to
  // /dashboard, middleware redirects an authenticated /login to /dashboard,
  // and the magic-link callback does the same — so a brand-new user landed on
  // an empty dashboard and never filled in business name, sector, budget or
  // goal, which is exactly the data the audit engine tunes recommendations
  // with. The Google Ads callback then quietly fabricated a placeholder
  // business for them.
  if (!business) redirect('/onboarding');

  return (
    <DashboardChrome
      brandName={business?.name ?? user.email ?? 'مساحة العمل'}
      userEmail={user.email ?? ''}
      accounts={accounts}
      selectedCustomerId={selectedCustomerId}
    >
      {children}
    </DashboardChrome>
  );
}

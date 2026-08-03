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

  // One workspace load, and pass the known user id so getUserBusiness does not
  // re-call auth.getUser() internally. This layout previously ran its own
  // `businesses` select AND getAccountWorkspace (which loads the business
  // again) AND let that reload auth — three redundant round trips on every hard
  // navigation and every router.refresh() (account switch, sync). The business
  // the workspace already resolved is reused for the brand name below.
  const workspace = await getAccountWorkspace(supabase, user.id);
  const { business, accounts, revokedAccounts, selectedCustomerId } = workspace;

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
      revokedAccounts={revokedAccounts}
      selectedCustomerId={selectedCustomerId}
    >
      {children}
    </DashboardChrome>
  );
}

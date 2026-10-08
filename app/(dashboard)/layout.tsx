import { redirect } from 'next/navigation';
import { getRequestAuthContext, getRequestServerClient } from '@/lib/supabase/server';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { DashboardChrome } from './dashboard-chrome';
import { isModaafaOperator } from '@/lib/platform/operators';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { daysUntil } from '@/lib/ui/plural-ar';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login');

  // One workspace load, and pass the known user id so getUserBusiness does not
  // re-call auth.getUser() internally. This layout previously ran its own
  // `businesses` select AND getAccountWorkspace (which loads the business
  // again) AND let that reload auth — three redundant round trips on every hard
  // navigation and every router.refresh() (account switch, sync). The business
  // the workspace already resolved is reused for the brand name below.
  const workspace = await getAccountWorkspace(user.id);
  const { business, accounts, revokedAccounts, pausedAccounts, selectedCustomerId } = workspace;

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

  // Trial badge for the sidebar. A failed read must never break the shell, so
  // it simply shows no badge.
  let trialDaysLeft: number | null = null;
  try {
    const supabase = await getRequestServerClient();
    const access = await getSubscriptionAccess(supabase, user.id, user.email);
    if (access.status === 'trialing') trialDaysLeft = daysUntil(access.trialEndsAt);
  } catch {
    trialDaysLeft = null;
  }

  return (
    <DashboardChrome
      brandName={business?.name ?? user.email ?? 'مساحة العمل'}
      userEmail={user.email ?? ''}
      accounts={accounts}
      revokedAccounts={revokedAccounts}
      pausedAccounts={pausedAccounts}
      selectedCustomerId={selectedCustomerId}
      isOperator={isModaafaOperator(user.email)}
      trialDaysLeft={trialDaysLeft}
    >
      {children}
    </DashboardChrome>
  );
}

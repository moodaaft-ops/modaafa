import { redirect } from 'next/navigation';
import { createAdminClient, getRequestAuthContext } from '@/lib/supabase/server';
import { isRegistrationComplete, REGISTRATION_COMPLETE_PATH } from '@/lib/registration/gate';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { DashboardChrome } from './dashboard-chrome';
import { isModaafaOperator } from '@/lib/platform/operators';
import { isChatFirstEnabled } from '@/lib/chat-first/flag';
import { partnersEnabled } from '@/lib/partners/config';
import { readAccessOverrides } from '@/lib/billing/access-overrides';
import { SuspendedBanner } from './suspended-banner';
import { InstallPrompt } from './install-prompt';
import { SimpleChrome } from './simple-chrome';
import { isSimpleExperience } from '@/lib/setup/mode';
import { listRecentChats } from '@/lib/chat-first/sessions';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login');

  // Nobody reaches the platform before leaving name, email and phone.
  if (!(await isRegistrationComplete(createAdminClient(), user.id))) redirect(REGISTRATION_COMPLETE_PATH);

  // One workspace load, and pass the known user id so getUserBusiness does not
  // re-call auth.getUser() internally. This layout previously ran its own
  // `businesses` select AND getAccountWorkspace (which loads the business
  // again) AND let that reload auth — three redundant round trips on every hard
  // navigation and every router.refresh() (account switch, sync). The business
  // the workspace already resolved is reused for the brand name below.
  const [workspace, overrides] = await Promise.all([
    getAccountWorkspace(user.id),
    readAccessOverrides(supabase, user.id),
  ]);
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

  // The simple experience: a ChatGPT-style sidebar and «مُضاعِف» as the home screen.
  if (isSimpleExperience(process.env, user.email)) {
    const selectedAccount = accounts.find((account) => account.customer_id === selectedCustomerId) ?? null;
    const recentChats = await listRecentChats({ supabase, userId: user.id, accountId: selectedAccount?.id ?? null });
    return (
      <SimpleChrome
        brandName={business?.name ?? user.email ?? 'مساحة العمل'}
        userEmail={user.email ?? ''}
        accounts={accounts}
        revokedAccounts={revokedAccounts}
        pausedAccounts={pausedAccounts}
        selectedCustomerId={selectedCustomerId}
        isOperator={isModaafaOperator(user.email)}
        partnersOn={partnersEnabled()}
        recentChats={recentChats}
      >
        {overrides.suspended && <SuspendedBanner />}
        <InstallPrompt />
        {children}
      </SimpleChrome>
    );
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
      partnersOn={partnersEnabled()}
      chatFirst={isChatFirstEnabled(process.env, user.email)}
    >
      {overrides.suspended && <SuspendedBanner />}
      <InstallPrompt />
      {children}
    </DashboardChrome>
  );
}

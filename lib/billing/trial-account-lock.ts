import { normalizeCustomerId } from '@/lib/accounts/selection';
import { findTrialCustomerIdsOwnedByOthers } from '@/lib/billing/checkout-policy';
import { getSubscriptionAccessDetailed } from '@/lib/billing/entitlements';

/**
 * Link-after-trial gap.
 *
 * The checkout policy refuses a trial when a linked Google Ads account already
 * had a trial under another user. That is checked when the trial STARTS. A user
 * who is already trialing can still connect more accounts afterwards, including
 * one whose trial another user burned. So after every successful link, an account
 * that belongs to someone else's trial is parked (`status = 'paused'`, which every
 * sync, audit and optimizer query already treats as "not selectable").
 *
 * It only applies to a user who is on a Stripe trial right now with no operator
 * free-plan grant. A paying user, a granted user and a user with no subscription
 * are not touched here (a user with no subscription cannot start a trial on such
 * an account: the checkout policy refuses it).
 *
 * This lock only PARKS accounts that already belong to someone else's trial. It
 * never claims anything in `trial_customer_ledger`: linking an account is not
 * using it for a trial. An account is claimed when the trial starts on it or the
 * optimizer/audit runs on it (lib/billing/trial-account-claim.ts). The write is
 * best-effort: a failure is logged and never blocks the connect flow.
 *
 * `linked` are the rows `connect_job_link` just saved.
 */
export async function enforceTrialAccountLock({
  admin,
  userId,
  linked,
}: {
  admin: any;
  userId: string;
  linked: Array<{ id: string; customer_id: string }>;
}): Promise<{ pausedAccountIds: string[] }> {
  const none = { pausedAccountIds: [] as string[] };
  if (linked.length === 0) return none;

  try {
    // getSubscriptionAccessDetailed logs and degrades to "no access" on a read
    // error, which lands here as "not trialing": the lock is skipped, not applied.
    const { billing, overrides } = await getSubscriptionAccessDetailed(admin, userId, null);
    if (!(billing.active && billing.status === 'trialing') || overrides.grant) return none;

    const byCustomerId = new Map<string, string[]>();
    for (const account of linked) {
      const customerId = normalizeCustomerId(account.customer_id ?? '');
      if (!/^[0-9]{3,20}$/.test(customerId)) continue;
      byCustomerId.set(customerId, [...(byCustomerId.get(customerId) ?? []), account.id]);
    }
    const customerIds = Array.from(byCustomerId.keys());
    if (customerIds.length === 0) return none;

    const ownedByOthers = new Set(await findTrialCustomerIdsOwnedByOthers(admin, userId, customerIds));

    const pausedAccountIds = Array.from(ownedByOthers).flatMap((id) => byCustomerId.get(id) ?? []);
    if (pausedAccountIds.length > 0) {
      const { error } = await admin
        .from('google_ads_accounts')
        .update({ status: 'paused' })
        .in('id', pausedAccountIds);
      if (error) throw error;
      console.warn('Paused linked Google Ads accounts: a trial was already taken on them by another user', {
        userId,
        customerIds: Array.from(ownedByOthers),
      });
    }

    return { pausedAccountIds };
  } catch (error) {
    // Fail open: refusing to finish a legitimate connect over a ledger hiccup is
    // worse than the one account that slips through, and the optimizer cap and
    // the checkout lock still bound the cost.
    console.error('Trial account lock check failed after linking; accounts left as linked', error);
    return none;
  }
}

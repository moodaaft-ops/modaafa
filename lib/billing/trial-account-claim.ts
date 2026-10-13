import { normalizeCustomerId } from '@/lib/accounts/selection';
import {
  findTrialCustomerIdsOwnedByOthers,
  isMissingRelationError,
} from '@/lib/billing/checkout-policy';
import { getSubscriptionAccessDetailed } from '@/lib/billing/entitlements';

/**
 * Claiming a Google Ads account in `trial_customer_ledger`.
 *
 * The ledger answers one question: "which user's free trial ran on this Google
 * customer id?". Only an account the trial ACTUALLY USED may be claimed, because
 * a claim blocks every other user from trialing on that account. Claiming every
 * linked account (the first version did, on every subscription update) turned an
 * unused account into a false positive.
 *
 * An account is claimed in exactly three places, all through this module:
 *   1. When the trial starts (trial-start-account-lock.ts): the selected account.
 *   2. When the optimizer processes an account of a TRIALING user.
 *   3. When a TRIALING user runs an audit on an account.
 *
 * First writer wins: insert-on-conflict-do-nothing, then read the owners back, so
 * two users racing on a fresh account are settled by the ledger itself.
 */

const CUSTOMER_ID_PATTERN = /^[0-9]{3,20}$/;
const WRITE_CHUNK = 100;

export type TrialClaim = { userId: string; customerId: string };

/**
 * Claim `customerIds` for `userId` and report which ones another user owns.
 * Throws on a database error: callers decide between fail-open and fail-closed.
 */
export async function claimTrialCustomerIds({
  admin,
  userId,
  customerIds,
  source,
}: {
  admin: any;
  userId: string;
  customerIds: string[];
  source: string;
}): Promise<{ ownedByOthers: string[] }> {
  const ids = Array.from(
    new Set(customerIds.map((id) => normalizeCustomerId(id)).filter((id) => CUSTOMER_ID_PATTERN.test(id)))
  );
  if (ids.length === 0) return { ownedByOthers: [] };

  for (let index = 0; index < ids.length; index += WRITE_CHUNK) {
    const rows = ids.slice(index, index + WRITE_CHUNK).map((customerId) => ({
      customer_id: customerId,
      first_user_id: userId,
      source,
    }));
    const { error } = await admin
      .from('trial_customer_ledger')
      .upsert(rows, { onConflict: 'customer_id', ignoreDuplicates: true });
    if (error) throw error;
  }

  return { ownedByOthers: await findTrialCustomerIdsOwnedByOthers(admin, userId, ids) };
}

/**
 * Claim the accounts a trialing user is using right now (optimizer pass, audit).
 * Best effort and never throws: a ledger hiccup must not fail a nightly job or an
 * audit. A missing table (code deployed before the migration) is logged loudly.
 * An account another user already owns is returned (and logged) but never
 * blocked here: the trial-start and link locks are what park such accounts.
 */
export async function claimTrialAccountsInUse({
  admin,
  claims,
  source,
}: {
  admin: any;
  claims: TrialClaim[];
  source: string;
}): Promise<{ ownedByOthers: TrialClaim[] }> {
  const byUser = new Map<string, string[]>();
  for (const claim of claims) {
    if (!claim.userId) continue;
    byUser.set(claim.userId, [...(byUser.get(claim.userId) ?? []), claim.customerId]);
  }

  const ownedByOthers: TrialClaim[] = [];
  for (const [userId, customerIds] of byUser) {
    try {
      const result = await claimTrialCustomerIds({ admin, userId, customerIds, source });
      for (const customerId of result.ownedByOthers) ownedByOthers.push({ userId, customerId });
    } catch (error) {
      if (isMissingRelationError(error)) {
        console.error(
          'DEPLOY ORDER: trial_customer_ledger does not exist, so the account was not recorded as used for a trial. ' +
            'Run db/migrations/20261013_trial_abuse_guards.sql.',
          error
        );
      } else {
        console.error('Failed to record the Google Ads account a trial is using', { userId, source, error });
      }
    }
  }
  if (ownedByOthers.length > 0) {
    console.warn('A trialing user is using a Google Ads account whose trial belongs to another user', {
      accounts: ownedByOthers,
      source,
    });
  }
  return { ownedByOthers };
}

/**
 * True when this user is on a Stripe trial right now with no operator free-plan
 * grant: the only state in which a claim means "the trial used this account".
 * A paying user, a granted user and a user with no subscription are not trialing.
 * A read error degrades to "not trialing" (getSubscriptionAccessDetailed logs it).
 */
export async function isTrialingWithoutGrant(admin: any, userId: string) {
  try {
    const { billing, overrides } = await getSubscriptionAccessDetailed(admin, userId, null);
    return billing.active && billing.status === 'trialing' && !overrides.grant;
  } catch (error) {
    console.error('Could not tell whether the user is trialing; not claiming', error);
    return false;
  }
}

/**
 * The audit-route flavour of the use-time claim: claims the account only when the
 * user is trialing. Never throws.
 */
export async function claimTrialAccountIfTrialing({
  admin,
  userId,
  customerId,
  source,
}: {
  admin: any;
  userId: string;
  customerId: string;
  source: string;
}) {
  if (!(await isTrialingWithoutGrant(admin, userId))) return { claimed: false as const };
  await claimTrialAccountsInUse({ admin, claims: [{ userId, customerId }], source });
  return { claimed: true as const };
}

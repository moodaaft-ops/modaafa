import { partitionGoogleAdsAccounts, normalizeCustomerId, type AdsAccountSummary } from '@/lib/accounts/selection';
import {
  findTrialCustomerIdsOwnedByOthers,
  isMissingRelationError,
} from '@/lib/billing/checkout-policy';
import { trialCardStripe } from '@/lib/billing/stripe';
import { claimTrialCustomerIds } from '@/lib/billing/trial-account-claim';
import {
  cancelImmediately,
  isLiveTrial,
  type TrialCardStripe,
  type TrialCardSubscription,
} from '@/lib/billing/trial-card-guard';

/**
 * The Google Ads account lock, applied when the trial actually STARTS.
 *
 * The checkout policy checks the user's accounts when the Checkout session is
 * created, and the link lock checks accounts linked while a trial is running.
 * Between the two there was a hole: open Checkout with a throwaway account, link a
 * burned account before paying, and the trial starts on the burned one. So the
 * same check runs again when the subscription becomes a live trial
 * (checkout.session.completed, customer.subscription.created and
 * /api/billing/checkout/complete), over ALL the user's client accounts:
 *
 *   1. An account whose `trial_customer_ledger` owner is another user is parked
 *      (`status = 'paused'`).
 *   2. The account the trial will use is claimed in the ledger: the selected one if
 *      it is still active, else the first remaining active account by link date.
 *      The claim is insert-on-conflict-do-nothing followed by a read of the owner,
 *      so two users racing on a fresh account are settled by the ledger. A claim
 *      that loses the race parks that account too and the next one is tried.
 *   3. If other users' trials took accounts and NO active account is left, the
 *      subscription is cancelled on the spot, the same way the card guard does it.
 *      A user with no accounts at all is not an abuse signal and is left alone.
 *
 * Idempotent: parked accounts stay owned by their other user in the ledger, so a
 * replay (the same event, or the second of the two events that start a trial)
 * reaches the same decision, and a repeated cancel is accepted.
 *
 * Fail-open on a lookup problem and when the ledger table does not exist yet
 * (deploy order), like the card guard: cancelling a real customer over a transient
 * error is worse than letting one trial through, and the checkout-time check
 * already ran. A failed CANCEL is thrown, so the webhook retries.
 */

export type TrialStartLockOutcome =
  | 'not_trialing'
  | 'no_accounts'
  | 'claimed'
  | 'paused_others'
  | 'blocked'
  | 'lookup_failed'
  | 'table_missing';

export type TrialStartLockResult = {
  blocked: boolean;
  outcome: TrialStartLockOutcome;
  /** Account row ids parked by this call. */
  pausedAccountIds: string[];
  /** The customer id the trial was recorded against, when one was claimed. */
  claimedCustomerId: string | null;
};

/** What callers (webhook handler, checkout/complete) depend on. */
export type EnforceTrialStartAccountLock = (params: {
  admin: any;
  userId: string;
  subscription: TrialCardSubscription;
}) => Promise<TrialStartLockResult>;

type LockAccount = {
  id: string;
  business_id: string;
  customer_id: string;
  status: string;
  linked_at: string | null;
};

const ID_CHUNK = 60;

export async function enforceTrialStartAccountLock({
  stripe,
  admin,
  userId,
  subscription,
  now = Date.now(),
}: {
  stripe: TrialCardStripe;
  admin: any;
  userId: string;
  subscription: TrialCardSubscription;
  now?: number;
}): Promise<TrialStartLockResult> {
  const result = (outcome: TrialStartLockOutcome, extra: Partial<TrialStartLockResult> = {}): TrialStartLockResult => ({
    blocked: false,
    outcome,
    pausedAccountIds: [],
    claimedCustomerId: null,
    ...extra,
  });
  if (!isLiveTrial(subscription, now)) return result('not_trialing');

  let decision: Awaited<ReturnType<typeof decide>>;
  try {
    decision = await decide(admin, userId);
  } catch (error) {
    if (isMissingRelationError(error)) {
      console.error(
        'DEPLOY ORDER: trial_customer_ledger does not exist, so the trial-start account lock is OFF. ' +
          'Run db/migrations/20261013_trial_abuse_guards.sql. Allowing the trial.',
        error
      );
      return result('table_missing');
    }
    console.error('Trial-start account lock lookup failed; allowing the trial', {
      subscriptionId: subscription.id,
      error,
    });
    return result('lookup_failed');
  }

  // Park first, cancel second. A failed park is logged and never stops a cancel.
  let pausedAccountIds: string[] = [];
  if (decision.toPause.length > 0) {
    try {
      await pauseAccounts(admin, decision.toPause);
      pausedAccountIds = decision.toPause;
      console.warn('Paused Google Ads accounts at trial start: a trial was already taken on them by another user', {
        userId,
        subscriptionId: subscription.id,
      });
    } catch (error) {
      console.error('Failed to pause Google Ads accounts owned by another trial', { userId, error });
    }
  }

  if (decision.blocked) {
    await cancelImmediately(stripe, subscription.id);
    console.warn('Trial cancelled: every linked Google Ads account already had a trial under another user', {
      subscriptionId: subscription.id,
      userId,
    });
    return result('blocked', { blocked: true, pausedAccountIds });
  }

  if (!decision.claimedCustomerId) return result('no_accounts', { pausedAccountIds });
  return result(decision.toPause.length > 0 ? 'paused_others' : 'claimed', {
    pausedAccountIds,
    claimedCustomerId: decision.claimedCustomerId,
  });
}

/**
 * Production wiring: the real Stripe client. Used by the Stripe webhook handler
 * (through its dependency object) and by checkout/complete.
 */
export const enforceTrialStartAccountLockLive: EnforceTrialStartAccountLock = (params) =>
  enforceTrialStartAccountLock({ ...params, stripe: trialCardStripe });

async function decide(admin: any, userId: string) {
  const { data: businesses, error: businessError } = await admin
    .from('businesses')
    .select('id, selected_google_ads_customer_id')
    .eq('user_id', userId);
  if (businessError) throw businessError;
  const businessRows = (businesses ?? []) as Array<{ id: string; selected_google_ads_customer_id?: string | null }>;
  if (businessRows.length === 0) return noDecision();

  const selectedIds = new Set(
    businessRows.map((row) => normalizeCustomerId(row.selected_google_ads_customer_id ?? '')).filter(Boolean)
  );

  // Paused accounts are read too, so a replay still sees the accounts this lock
  // parked earlier as taken by another user.
  const { data: accountRows, error: accountError } = await admin
    .from('google_ads_accounts')
    .select('id, business_id, customer_id, status, is_manager, linked_at')
    .in('business_id', businessRows.map((row) => row.id))
    .in('status', ['active', 'paused'])
    .not('is_manager', 'is', true)
    .limit(1000);
  if (accountError) throw accountError;

  const rows = (accountRows ?? []) as Array<LockAccount & { is_manager?: boolean | null }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  // partitionGoogleAdsAccounts drops the configured MCC ids and manager accounts
  // and normalises the stored id to digits, so this is the same set of "client
  // accounts" the rest of the app uses.
  const partitioned = partitionGoogleAdsAccounts(rows as unknown as AdsAccountSummary[]);
  const candidates: LockAccount[] = [...partitioned.accounts, ...partitioned.pausedAccounts]
    .map((account) => ({ ...(byId.get(account.id) as LockAccount), customer_id: account.customer_id }))
    .filter((account) => /^[0-9]{3,20}$/.test(account.customer_id));
  if (candidates.length === 0) return noDecision();

  const ownedByOthers = new Set(
    await findTrialCustomerIdsOwnedByOthers(admin, userId, Array.from(new Set(candidates.map((a) => a.customer_id))))
  );

  const toPause = new Set(
    candidates.filter((a) => a.status === 'active' && ownedByOthers.has(a.customer_id)).map((a) => a.id)
  );
  let sawOthers = candidates.some((a) => ownedByOthers.has(a.customer_id));

  // Preference: the selected account, then the oldest link, then the id.
  const remaining = candidates
    .filter((a) => a.status === 'active' && !ownedByOthers.has(a.customer_id))
    .sort((a, b) => {
      const selectedA = selectedIds.has(a.customer_id);
      const selectedB = selectedIds.has(b.customer_id);
      if (selectedA !== selectedB) return selectedA ? -1 : 1;
      const linkedA = linkedAtMs(a.linked_at);
      const linkedB = linkedAtMs(b.linked_at);
      if (linkedA !== linkedB) return linkedA < linkedB ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  let claimedCustomerId: string | null = null;
  const tried = new Set<string>();
  for (const account of remaining) {
    if (tried.has(account.customer_id)) continue;
    tried.add(account.customer_id);
    const claim = await claimTrialCustomerIds({
      admin,
      userId,
      customerIds: [account.customer_id],
      source: 'trial_start',
    });
    if (claim.ownedByOthers.includes(account.customer_id)) {
      // Lost the race: another user's claim landed first. Park every row of it.
      sawOthers = true;
      for (const row of remaining) if (row.customer_id === account.customer_id) toPause.add(row.id);
      continue;
    }
    claimedCustomerId = account.customer_id;
    break;
  }

  return {
    toPause: Array.from(toPause),
    claimedCustomerId,
    blocked: sawOthers && claimedCustomerId === null,
  };
}

function noDecision() {
  return { toPause: [] as string[], claimedCustomerId: null as string | null, blocked: false };
}

async function pauseAccounts(admin: any, ids: string[]) {
  for (let index = 0; index < ids.length; index += ID_CHUNK) {
    const { error } = await admin
      .from('google_ads_accounts')
      .update({ status: 'paused' })
      .in('id', ids.slice(index, index + ID_CHUNK));
    if (error) throw error;
  }
}

function linkedAtMs(value: string | null | undefined) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

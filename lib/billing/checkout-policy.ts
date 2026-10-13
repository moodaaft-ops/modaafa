import { createAdminClient } from '@/lib/supabase/server';
import { partitionGoogleAdsAccounts, type AdsAccountSummary } from '@/lib/accounts/selection';
import {
  isDisposableEmailDomain,
  legacyTrialEmailKey,
  trialEmailKeys,
} from '@/lib/billing/trial-identity';

/**
 * Why a user is not offered the free trial (null = eligible).
 *  - already_used: this user, or this inbox (incl. +tag / Gmail-dot variants),
 *    already had the trial.
 *  - ads_account_used: a Google Ads account this user has linked already had a
 *    trial under a different user.
 *  - disposable_email: a well-known throwaway inbox provider.
 */
/**
 * Why a trial is not offered. `check_failed` is different in kind from the others:
 * nothing is known to be wrong, a ledger lookup just could not be completed. The
 * semantics stay fail-closed (no trial), but callers must NOT turn it into a paid
 * checkout: see `checkoutTrialDecision`.
 */
export type TrialIneligibleReason =
  | 'already_used'
  | 'ads_account_used'
  | 'disposable_email'
  | 'check_failed';

export type BillingCheckoutContext = {
  activeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  /** Always `trialIneligibleReason === null`. */
  trialEligible: boolean;
  trialIneligibleReason: TrialIneligibleReason | null;
};

/** The service-role client, or a test double with the same `from()` surface. */
type AdminClientLike = { from: (table: string) => any; auth?: any };

type CheckoutPolicyOptions = {
  /** Injected in tests; production resolves it through `createAdminClient()`. */
  admin?: AdminClientLike;
};

// PostgREST puts IN lists in the URL; 100 ids of at most 20 digits stay far
// below the usual proxy limits.
const CUSTOMER_ID_CHUNK = 100;
const CUSTOMER_ID_PATTERN = /^[0-9]{3,20}$/;

const LIVE_STATUSES = ['trialing', 'active', 'past_due', 'paused'];

/** Length of the one free trial, passed to Stripe as trial_period_days. */
export const TRIAL_DAYS = 14;

/**
 * Where a checkout started from inside onboarding comes back to. A fixed
 * literal, never a caller-supplied URL, so it cannot become an open redirect.
 */
export const ONBOARDING_CHECKOUT_RETURN = 'onboarding';
export const ONBOARDING_CHECKOUT_SUCCESS_PATH = '/onboarding/first-audit?subscribed=1';

/**
 * Stable, non-reversible key for the durable trial ledger.
 *
 * `billing_trial_grants` is keyed on `users.id` and cascades away when the
 * account is deleted, so deleting and re-registering with the same Google
 * account produced an unlimited supply of free 14-day trials. The ledger keyed
 * on this hash is never deleted, and stores no plaintext address.
 *
 * This is the EXACT-address (legacy) key. Lookups and new writes go through
 * `trialEmailKeys`, which adds the +tag / Gmail-dot normalised key.
 */
export function trialLedgerKey(email: string) {
  return legacyTrialEmailKey(email);
}

export async function getBillingCheckoutContext(
  supabase: any,
  userId: string,
  email?: string | null,
  options: CheckoutPolicyOptions = {}
): Promise<BillingCheckoutContext> {
  const [liveResult, customerResult, grantResult, priorTrialResult] = await Promise.all([
    supabase
      .from('subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .in('status', LIVE_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .not('stripe_customer_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('billing_trial_grants')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('subscriptions')
      .select('id')
      .eq('user_id', userId)
      .not('trial_ends_at', 'is', null)
      .limit(1)
      .maybeSingle(),
  ]);

  const error =
    liveResult.error ??
    customerResult.error ??
    grantResult.error ??
    priorTrialResult.error;
  if (error) throw error;

  const usedByUser = Boolean(grantResult.data) || Boolean(priorTrialResult.data);

  // The two durable ledgers are independent lookups. Both fail CLOSED (an
  // unanswered lookup never grants a trial), and both are skipped when the user's
  // own rows already settle the answer. 'error' is kept apart from 'used' so a
  // storage hiccup is reported as `check_failed`, not as "you already had a trial".
  const [emailLedger, adsAccount] = usedByUser
    ? (['used', 'not_used'] as const)
    : await Promise.all([
        email ? hasLedgerTrialGrant(email, options.admin) : ('not_used' as const),
        hasAdsAccountTrial(supabase, userId, options.admin),
      ]);

  // Definite reasons first (they are true whatever the failed lookup would have
  // said), then the failed check.
  let trialIneligibleReason: TrialIneligibleReason | null = null;
  if (usedByUser || emailLedger === 'used') trialIneligibleReason = 'already_used';
  else if (adsAccount === 'used') trialIneligibleReason = 'ads_account_used';
  else if (isDisposableEmailDomain(email)) trialIneligibleReason = 'disposable_email';
  else if (emailLedger === 'error' || adsAccount === 'error') trialIneligibleReason = 'check_failed';

  return {
    activeSubscriptionId: liveResult.data?.stripe_subscription_id ?? null,
    stripeCustomerId: customerResult.data?.stripe_customer_id ?? null,
    trialEligible: trialIneligibleReason === null,
    trialIneligibleReason,
  };
}

/**
 * What a checkout entry point does with the policy. A trial is offered only when
 * the user is eligible. `check_failed` BLOCKS: creating a session anyway would
 * silently turn a first-time trial into an immediate charge, which is the worst
 * way to fail. Every other ineligible reason is a known fact about the user and
 * starts a paid subscription as before.
 */
export function checkoutTrialDecision(
  context: Pick<BillingCheckoutContext, 'trialEligible' | 'trialIneligibleReason'>
): { action: 'proceed'; trialDays: number } | { action: 'blocked'; error: 'trial_check_failed' } {
  if (context.trialIneligibleReason === 'check_failed') {
    return { action: 'blocked', error: 'trial_check_failed' };
  }
  return { action: 'proceed', trialDays: context.trialEligible ? TRIAL_DAYS : 0 };
}

type LedgerLookup = 'used' | 'not_used' | 'error';

async function hasLedgerTrialGrant(email: string, injectedAdmin?: AdminClientLike): Promise<LedgerLookup> {
  try {
    const admin = injectedAdmin ?? createAdminClient();
    // Every key the address is known under: the exact-address hash older rows
    // were written with, and the +tag / Gmail-dot normalised one.
    const keys = trialEmailKeys(email);
    const { data, error } = await admin
      .from('billing_trial_ledger')
      .select('email_hash')
      .in('email_hash', keys)
      .limit(1);

    if (error) throw error;
    return data && data.length > 0 ? 'used' : 'not_used';
  } catch (error) {
    // Fail CLOSED on a storage problem: the cost of wrongly denying a trial is
    // a support message; the cost of wrongly granting one is unbounded. It is
    // reported as `check_failed`, not as a used trial, so the customer is told to
    // retry instead of being quietly moved to a paid start.
    console.error('Trial ledger lookup failed; no trial is offered (check_failed)', error);
    return 'error';
  }
}

/**
 * The user's own active, non-manager Google Ads customer ids, resolved through
 * businesses.user_id. Works with the user-scoped client (RLS) and the admin
 * client alike. Throws on a read error; callers choose fail-open or fail-closed.
 */
export async function loadActiveClientCustomerIds(supabase: any, userId: string) {
  const { data: businesses, error: businessError } = await supabase
    .from('businesses')
    .select('id')
    .eq('user_id', userId);
  if (businessError) throw businessError;

  const businessIds = ((businesses ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (businessIds.length === 0) return [];

  const { data: accounts, error: accountError } = await supabase
    .from('google_ads_accounts')
    .select('customer_id, status, is_manager')
    .in('business_id', businessIds)
    .eq('status', 'active')
    .not('is_manager', 'is', true)
    .limit(1000);
  if (accountError) throw accountError;

  // partitionGoogleAdsAccounts also drops the configured MCC ids and normalises
  // the stored id to digits, so this matches what the rest of the app treats as
  // the user's client accounts.
  const { accounts: clientAccounts } = partitionGoogleAdsAccounts(
    (accounts ?? []) as AdsAccountSummary[]
  );
  return Array.from(
    new Set(
      clientAccounts
        .map((account) => account.customer_id)
        .filter((customerId) => CUSTOMER_ID_PATTERN.test(customerId))
    )
  );
}

/**
 * The subset of `customerIds` whose trial was taken by a DIFFERENT user, per
 * `trial_customer_ledger`. Throws on a read error.
 */
export async function findTrialCustomerIdsOwnedByOthers(
  admin: AdminClientLike,
  userId: string,
  customerIds: string[]
) {
  const owned: string[] = [];
  for (let index = 0; index < customerIds.length; index += CUSTOMER_ID_CHUNK) {
    const chunk = customerIds.slice(index, index + CUSTOMER_ID_CHUNK);
    const { data, error } = await admin
      .from('trial_customer_ledger')
      .select('customer_id, first_user_id')
      .in('customer_id', chunk);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ customer_id: string; first_user_id: string }>) {
      if (row.first_user_id !== userId) owned.push(row.customer_id);
    }
  }
  return owned;
}

/**
 * True when a read failed because the table (or view) is not there: Postgres
 * 42P01 (undefined_table), PostgREST PGRST205 (table not in the schema cache,
 * which is also what a freshly created table looks like until the cache
 * reloads), or the same text without a code. Column and function errors do not
 * match, and neither does anything else.
 */
export function isMissingRelationError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === '42P01' || code === 'PGRST205') return true;
  return (
    typeof message === 'string' &&
    /could not find the table|relation "[^"]*" does not exist/i.test(message)
  );
}

/**
 * Ads-account lock: true when any Google Ads account the user has linked already
 * had a free trial under another user. Fail CLOSED on any lookup problem, for the
 * same reason as the email ledger, with ONE exception: the trial_customer_ledger
 * table not existing. That only happens when this code is deployed before
 * db/migrations/20261013_trial_abuse_guards.sql has run, and blocking every trial
 * for everyone until then is worse than running without the new lock for a while.
 * It is treated as "not used" and logged loudly. A missing table in any OTHER read
 * (businesses, google_ads_accounts, billing_trial_ledger) still fails closed.
 */
async function hasAdsAccountTrial(
  supabase: any,
  userId: string,
  injectedAdmin?: AdminClientLike
): Promise<LedgerLookup> {
  try {
    const customerIds = await loadActiveClientCustomerIds(supabase, userId);
    if (customerIds.length === 0) return 'not_used';
    const admin = injectedAdmin ?? createAdminClient();
    let owned: string[];
    try {
      owned = await findTrialCustomerIdsOwnedByOthers(admin, userId, customerIds);
    } catch (error) {
      if (!isMissingRelationError(error)) throw error;
      console.error(
        'DEPLOY ORDER: trial_customer_ledger does not exist, so the ads-account trial lock is OFF. ' +
          'Run db/migrations/20261013_trial_abuse_guards.sql. Treating the trial as available.',
        error
      );
      return 'not_used';
    }
    return owned.length > 0 ? 'used' : 'not_used';
  } catch (error) {
    console.error('Trial ads-account lookup failed; no trial is offered (check_failed)', error);
    return 'error';
  }
}

/**
 * Record that this user took their one free trial: the per-user grant and the
 * durable email ledger (so delete-and-re-register cannot repeat it).
 *
 * It deliberately does NOT touch `trial_customer_ledger`. This runs on every
 * subscription update that still carries `trial_end` (Stripe keeps it after the
 * trial converts to paid), so claiming the user's accounts here marked accounts
 * that never had a trial as used. Accounts are claimed only where the trial
 * actually used one: see lib/billing/trial-account-claim.ts.
 */
export async function recordTrialGrant({
  supabase,
  userId,
  email,
  stripeSubscriptionId,
  source,
  admin: injectedAdmin,
}: {
  supabase: any;
  userId: string;
  email?: string | null;
  stripeSubscriptionId?: string | null;
  source: 'checkout_complete' | 'stripe_webhook';
  /** Injected in tests; production resolves it through `createAdminClient()`. */
  admin?: AdminClientLike;
}) {
  const { error } = await supabase.from('billing_trial_grants').upsert(
    {
      user_id: userId,
      stripe_subscription_id: stripeSubscriptionId ?? null,
      source,
    },
    { onConflict: 'user_id', ignoreDuplicates: true }
  );
  if (error) throw error;

  const resolvedEmail = email ?? (await lookupUserEmail(supabase, userId));
  if (resolvedEmail) {
    try {
      const admin = injectedAdmin ?? createAdminClient();
      // Both the exact-address key and the normalised key, so old and new
      // lookups find the row and a +tag / dotted variant of this inbox is caught.
      const { error: ledgerError } = await admin.from('billing_trial_ledger').upsert(
        trialEmailKeys(resolvedEmail).map((emailHash) => ({ email_hash: emailHash, source })),
        { onConflict: 'email_hash', ignoreDuplicates: true }
      );
      if (ledgerError) throw ledgerError;
    } catch (ledgerError) {
      // Non-fatal: the per-user grant above is already recorded, so the only
      // thing lost is protection against delete-and-re-register.
      console.error('Failed to record durable trial ledger entry', ledgerError);
    }
  }
}

async function lookupUserEmail(_supabase: any, userId: string) {
  // Resolve from the AUTHORITATIVE Supabase Auth identity, never from
  // public.users.email. That column is client-writable (RLS `FOR ALL`), so
  // recording the durable trial ledger under a user-chosen address — while the
  // eligibility check reads the real Google identity email — would reopen the
  // delete-and-re-register unlimited-free-trial loop the ledger exists to close.
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) throw error;
    return (data.user?.email as string | undefined) ?? null;
  } catch (error) {
    console.error('Failed to resolve authoritative email for trial ledger', error);
    return null;
  }
}

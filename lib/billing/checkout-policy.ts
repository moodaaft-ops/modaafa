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
export type TrialIneligibleReason = 'already_used' | 'ads_account_used' | 'disposable_email';

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

  // The two durable ledgers are independent lookups. Both fail CLOSED, and both
  // are skipped when the user's own rows already settle the answer.
  const [emailLedgerUsed, adsAccountUsed] = usedByUser
    ? [true, false]
    : await Promise.all([
        email ? hasLedgerTrialGrant(email, options.admin) : false,
        hasAdsAccountTrial(supabase, userId, options.admin),
      ]);

  let trialIneligibleReason: TrialIneligibleReason | null = null;
  if (usedByUser || emailLedgerUsed) trialIneligibleReason = 'already_used';
  else if (adsAccountUsed) trialIneligibleReason = 'ads_account_used';
  else if (isDisposableEmailDomain(email)) trialIneligibleReason = 'disposable_email';

  return {
    activeSubscriptionId: liveResult.data?.stripe_subscription_id ?? null,
    stripeCustomerId: customerResult.data?.stripe_customer_id ?? null,
    trialEligible: trialIneligibleReason === null,
    trialIneligibleReason,
  };
}

async function hasLedgerTrialGrant(email: string, injectedAdmin?: AdminClientLike) {
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
    return Boolean(data && data.length > 0);
  } catch (error) {
    // Fail CLOSED on a storage problem: the cost of wrongly denying a trial is
    // a support message; the cost of wrongly granting one is unbounded.
    console.error('Trial ledger lookup failed; treating the trial as already used', error);
    return true;
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
 * Ads-account lock: true when any Google Ads account the user has linked already
 * had a free trial under another user. Fail CLOSED on any lookup problem, for the
 * same reason as the email ledger.
 */
async function hasAdsAccountTrial(
  supabase: any,
  userId: string,
  injectedAdmin?: AdminClientLike
) {
  try {
    const customerIds = await loadActiveClientCustomerIds(supabase, userId);
    if (customerIds.length === 0) return false;
    const admin = injectedAdmin ?? createAdminClient();
    const owned = await findTrialCustomerIdsOwnedByOthers(admin, userId, customerIds);
    return owned.length > 0;
  } catch (error) {
    console.error('Trial ads-account lookup failed; treating the trial as already used', error);
    return true;
  }
}

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

  await recordTrialCustomerIds({ supabase, userId, source, admin: injectedAdmin });
}

/**
 * Remember which Google Ads accounts this user took a trial on, so another user
 * cannot take a second trial on the same account. First writer wins
 * (ON CONFLICT DO NOTHING). Non-fatal on error, like the email ledger.
 */
async function recordTrialCustomerIds({
  supabase,
  userId,
  source,
  admin: injectedAdmin,
}: {
  supabase: any;
  userId: string;
  source: string;
  admin?: AdminClientLike;
}) {
  try {
    const customerIds = await loadActiveClientCustomerIds(supabase, userId);
    if (customerIds.length === 0) return;
    const admin = injectedAdmin ?? createAdminClient();
    for (let index = 0; index < customerIds.length; index += CUSTOMER_ID_CHUNK) {
      const rows = customerIds.slice(index, index + CUSTOMER_ID_CHUNK).map((customerId) => ({
        customer_id: customerId,
        first_user_id: userId,
        source,
      }));
      const { error } = await admin
        .from('trial_customer_ledger')
        .upsert(rows, { onConflict: 'customer_id', ignoreDuplicates: true });
      if (error) throw error;
    }
  } catch (error) {
    console.error('Failed to record trial customer-id ledger entries', error);
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

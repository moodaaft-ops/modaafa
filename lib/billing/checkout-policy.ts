import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/server';

export type BillingCheckoutContext = {
  activeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  trialEligible: boolean;
};

const LIVE_STATUSES = ['trialing', 'active', 'past_due', 'paused'];

/**
 * Stable, non-reversible key for the durable trial ledger.
 *
 * `billing_trial_grants` is keyed on `users.id` and cascades away when the
 * account is deleted, so deleting and re-registering with the same Google
 * account produced an unlimited supply of free 14-day trials. The ledger keyed
 * on this hash is never deleted, and stores no plaintext address.
 */
export function trialLedgerKey(email: string) {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export async function getBillingCheckoutContext(
  supabase: any,
  userId: string,
  email?: string | null
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

  const ledgerUsed = email ? await hasLedgerTrialGrant(email) : false;

  return {
    activeSubscriptionId: liveResult.data?.stripe_subscription_id ?? null,
    stripeCustomerId: customerResult.data?.stripe_customer_id ?? null,
    trialEligible: !grantResult.data && !priorTrialResult.data && !ledgerUsed,
  };
}

async function hasLedgerTrialGrant(email: string) {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('billing_trial_ledger')
      .select('email_hash')
      .eq('email_hash', trialLedgerKey(email))
      .maybeSingle();

    if (error) throw error;
    return Boolean(data);
  } catch (error) {
    // Fail CLOSED on a storage problem: the cost of wrongly denying a trial is
    // a support message; the cost of wrongly granting one is unbounded.
    console.error('Trial ledger lookup failed; treating the trial as already used', error);
    return true;
  }
}

export async function recordTrialGrant({
  supabase,
  userId,
  email,
  stripeSubscriptionId,
  source,
}: {
  supabase: any;
  userId: string;
  email?: string | null;
  stripeSubscriptionId?: string | null;
  source: 'checkout_complete' | 'stripe_webhook';
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
  if (!resolvedEmail) return;

  try {
    const admin = createAdminClient();
    const { error: ledgerError } = await admin.from('billing_trial_ledger').upsert(
      { email_hash: trialLedgerKey(resolvedEmail), source },
      { onConflict: 'email_hash', ignoreDuplicates: true }
    );
    if (ledgerError) throw ledgerError;
  } catch (ledgerError) {
    // Non-fatal: the per-user grant above is already recorded, so the only
    // thing lost is protection against delete-and-re-register.
    console.error('Failed to record durable trial ledger entry', ledgerError);
  }
}

async function lookupUserEmail(supabase: any, userId: string) {
  const { data } = await supabase.from('users').select('email').eq('id', userId).maybeSingle();
  return (data?.email as string | undefined) ?? null;
}

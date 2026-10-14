import {
  ACCOUNT_SUSPENDED_MESSAGE,
  getSubscriptionAccess,
  type SubscriptionAccess,
} from '@/lib/billing/entitlements';

/**
 * The one question every cost-bearing route asks first: may this person use
 * the product (the assistant, the voice call, applying a change)?
 *
 * Yes when they have an active Stripe subscription or a live trial, an operator
 * granted them a free plan, or they are a Modaafa operator. No when they have
 * none of those, and never when an operator suspended the account. It reads the
 * same helpers the metered features use (getSubscriptionAccess and the operator
 * overrides under it), so this gate and the metered ones cannot disagree.
 *
 * What stays open without it: registration, the onboarding questions and the
 * single free audit per Google Ads customer id (lib/billing/free-audit.ts).
 * Everything else that can spend model or voice-provider money sits behind this.
 */

/** Active Stripe subscription, live trial, operator free plan or operator. Never a suspended account. */
export function hasProductAccess(access: Pick<SubscriptionAccess, 'active' | 'plan' | 'suspended'>): boolean {
  return Boolean(access.active && access.plan && !access.suspended);
}

export type AccessRefusal =
  | { status: 402; body: { error: 'subscription_required' } }
  | { status: 403; body: { error: 'account_suspended'; message: string } };

export type AccessGate =
  | { ok: true; access: SubscriptionAccess }
  | ({ ok: false; access: SubscriptionAccess } & AccessRefusal);

/** The refusal for an access snapshot already in hand, or null when it may proceed. */
export function accessRefusal(access: Pick<SubscriptionAccess, 'active' | 'plan' | 'suspended'>): AccessRefusal | null {
  if (access.suspended) {
    return { status: 403, body: { error: 'account_suspended', message: ACCOUNT_SUSPENDED_MESSAGE } };
  }
  if (!hasProductAccess(access)) return { status: 402, body: { error: 'subscription_required' } };
  return null;
}

/**
 * Reads the caller's access and decides. A failed read is "no access": the
 * helper under it logs the error and returns the empty access, so a database
 * outage closes the paid features instead of opening them (the cost of being
 * wrong the other way is real money).
 */
export async function checkProductAccess({
  supabase,
  userId,
  userEmail,
  getAccess = getSubscriptionAccess,
}: {
  supabase: any;
  userId: string;
  /** The authenticated server-side user's email, never anything the browser sent. */
  userEmail?: string | null;
  getAccess?: typeof getSubscriptionAccess;
}): Promise<AccessGate> {
  let access: SubscriptionAccess;
  try {
    access = await getAccess(supabase, userId, userEmail);
  } catch (error) {
    console.error('Failed to read product access', error);
    access = { active: false, plan: null, status: null, trialEndsAt: null, currentPeriodEnd: null };
  }
  const refusal = accessRefusal(access);
  return refusal ? { ok: false, access, ...refusal } : { ok: true, access };
}
